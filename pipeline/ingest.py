"""The daily ingest: fetch, hash, diff, guard, rebuild, publish one delta (D-042).

    python3 pipeline/ingest.py run  <clone> <pub-dir> --state <state-dir>
    python3 pipeline/ingest.py init <clone> <pub-dir> --state <state-dir> \\
                                    --artifact <published.sqlite>
    python3 pipeline/ingest.py status <pub-dir> --state <state-dir>

One run per day means one delta file per day and consecutive revisions, so the
files tile the revision space by construction — there is nothing to roll up and
no invariant to defend (D-042).

**Order is load-bearing: the guard runs before the build, not after.** D-042
only requires that nothing is *published* before the guard, and a build
publishes nothing — but a build from a broken tree is not free either. Seeding
retires every value the tree no longer mentions, permanently (D-056), so a
half-fetched corpus that got as far as `build` would burn several hundred
thousand ids and the only repair is a new ID space and a full re-download for
every client. That is why the run pays for a second walk of the corpus rather
than taking the hashes out of the build it is about to do.

**Re-run semantics.** A revision is minted once, and everything that decides its
bytes — the changeset, the artifact, and `generated` — is written to the state
file *before* the delta is published and cleared only after the manifest names
it. What the next run does with that record depends on one question, asked of
all three authorities: **was anything ever published at this range?**

  * **No** — the ledger has no entry, the manifest does not list it, and no file
    is on disk. Nothing can have reached a client, so the pending run is
    *abandoned* and the fresh cycle re-mints the revision against the tree as it
    now stands. This is the same rule that lets `delta.write` re-cut an
    unpublished range (D-047), and it is what keeps a *deterministic* refusal
    inside `delta.publish` — a wrong seed, a floors mismatch, a manifest that
    cannot hold the entry — from being replayed forever with the data plane
    frozen behind it;
  * **Yes, or unprovably no** — the publication is finished rather than redone.
    The delta's entry (its length and digest) is written into the pending record
    *before* the file becomes visible, so a retry verifies the bytes already on
    disk and registers them; nothing is recompressed, which is what keeps the
    guarantee true across a brotli upgrade. If that file is gone the retry
    rebuilds it from the pinned changeset and the same hook refuses to rename it
    into place unless the digest matches what was published. **A pinned entry is
    therefore never abandoned**: the hook fires just before the rename, so the
    three authorities cannot separate "crashed in the microsecond before the
    file appeared" from "was served for a day and then deleted", and only one of
    those may be re-minted;
  * either way the run then continues into a fresh cycle, so one invocation
    heals and catches up rather than costing a second day of staleness.

The one case that stops for a human is a pending run with neither its published
file nor the artifact that produced it: nothing left can reproduce those bytes,
and discarding the record would lose the only evidence of what is at that URL.

A missed day is not a special case either: `from` is always the published head
and the changeset is the whole diff of the state against the tree, so a run that
never happened is absorbed by the next one as a larger delta.

Exit codes: 0 published, nothing to do, or the lock was held; 1 aborted; 3 the
tombstone guard tripped, which means the fetch broke rather than that the CVE
Program withdrew hundreds of records (D-031).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import time

import build
import delta
import ledger
import manifest as manifest_module
import normalize
import state as state_module

# D-031/D-042: a run that would tombstone more than 0.1% of the corpus (~370
# records) aborts. Upstream has no deletion concept at all — withdrawal is
# `state: REJECTED` (D-022) — so a mass disappearance means our fetch broke.
TOMBSTONE_LIMIT = 0.001

# Daily builds are ~377 MB each, so they cannot simply accumulate. Three is the
# current seed, the one before it, and one spare to diff against by hand when a
# run does something surprising.
ARTIFACT_KEEP = 3

ARTIFACT_NAME = re.compile(r"^rev-(\d+)\.sqlite$")

EXIT_OK = 0
EXIT_ABORT = 1
EXIT_GUARD = 3


class Abort(Exception):
    """The run stops and publishes nothing. The tree, the state and the data
    plane are all left exactly as they were."""

    def __init__(self, message: str, code: int = EXIT_ABORT) -> None:
        super().__init__(message)
        self.code = code


# --- the corpus -----------------------------------------------------------


def corpus_dirt(clone: str) -> str:
    """What `git` says is not the committed tree under `cves/`, or `""`.

    Empty for a clean corpus *and* for a directory that is not a git tree at
    all — the fixtures build from plain directories, and `clone_commit` soft-
    fails the same way. Callers that need to tell those apart check the commit.
    """
    try:
        done = subprocess.run(
            ["git", "-C", clone, "status", "--porcelain", "--", "cves"],
            capture_output=True,
            text=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return ""
    return done.stdout.strip()


def fetch(clone: str) -> str:
    """`git fetch --depth 1 origin main`, then reset *and clean*. Returns the
    new commit.

    `reset --hard` alone is not "make the tree the commit": it restores tracked
    files and deletes nothing untracked, so a stray `CVE-*.json` — a half-
    finished operation, a hand edit, anything — is walked by `record_paths`,
    hashed by `scan`, and published as though upstream had said it. Reproduced:
    an untracked record survives the reset and appears in `scan`'s output. The
    corpus we publish has to be the corpus git says we fetched, so the clean is
    part of the fetch rather than an operator's responsibility.

    Every argument here is a constant. Nothing a record, a manifest or a caller
    supplies reaches a git ref or a URL — D-006's rule applies to the pipeline's
    own subprocesses as much as to a request handler.
    """
    for command in (
        ["git", "-C", clone, "fetch", "--depth", "1", "origin", "main"],
        ["git", "-C", clone, "reset", "--hard", "FETCH_HEAD"],
        # Scoped to `cves` so nothing else in the clone is collateral.
        ["git", "-C", clone, "clean", "-fdq", "--", "cves"],
    ):
        done = subprocess.run(command, capture_output=True, text=True)
        if done.returncode != 0:
            # A failed fetch is an ordinary transient: publish nothing and let
            # the next run cover both days.
            raise Abort(f"{' '.join(command[3:])} failed: {done.stderr.strip() or done.stdout}")
    return build.clone_commit(clone)


def scan(clone: str) -> dict:
    """One content hash per record (D-031), by the same rules `build` walks by.

    Deliberately a second walk rather than a by-product of the build — see the
    module docstring. The two are checked against each other afterwards, because
    two loops over one corpus that disagree about which records exist would
    produce a changeset describing a corpus nobody built.
    """
    hashes: dict = {}
    skipped: list = []
    for path in build.record_paths(clone):
        with open(path, "rb") as handle:
            blob = handle.read()
        try:
            record = json.loads(blob)
        except (ValueError, UnicodeDecodeError):
            skipped.append(path)
            continue
        if not isinstance(record, dict):
            skipped.append(path)
            continue
        proj = normalize.projection(record, os.path.basename(path)[:-5])
        # The same two refusals `build` makes, in the same order: a record we
        # cannot name, and a second file claiming a name we have already seen
        # (D-047). Diverging here would mean hashing a corpus the build then
        # declines to publish.
        if not normalize.valid_cve_id(proj["cve_id"]):
            skipped.append(path)
            continue
        if proj["cve_id"] in hashes:
            skipped.append(path)
            continue
        try:
            hashes[proj["cve_id"]] = normalize.content_hash(proj)
        except UnicodeEncodeError:
            # RE-015: a lone surrogate is legal JSON with no UTF-8 encoding, so
            # the record cannot be stored and cannot be hashed. That finding
            # asked for a projection-level check whose cost was measured first —
            # and this *is* one, already paid for: `content_hash` encodes the
            # whole projection, so the refusal costs nothing beyond the walk the
            # ingest already does, and it names the file instead of a codec.
            skipped.append(path)
            continue
    return {"hashes": hashes, "skipped": skipped}


def file_digest(path: str) -> str:
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def artifact_ids(db_path: str) -> set:
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        return {row[0] for row in db.execute("SELECT cve_id FROM cve")}
    finally:
        db.close()


# --- the data plane -------------------------------------------------------


def published_head(pub_dir: str) -> int:
    """The revision clients are being told to reach, from both authorities.

    The manifest is what clients read; the ledger is what remembers. They can
    only disagree through a crash between publishing a delta and registering it,
    which is what the pending run exists to finish — so outside a resume, a
    disagreement is a state nothing here should build on.
    """
    manifest = manifest_module.load(pub_dir)
    if manifest is None:
        raise Abort(f"no manifest in {pub_dir}; publish a snapshot before ingesting deltas")
    head = manifest_module.head_rev(manifest)
    recorded = ledger.highest_published(pub_dir)
    if recorded != head:
        raise Abort(
            f"the manifest advertises rev {head} but the ledger records rev {recorded} as "
            "published; finish or abandon that publication before ingesting"
        )
    return head


def _changeset(pending: dict) -> dict:
    """The pending run, in the shape `delta.publish` consumes."""
    return {
        "from": int(pending["from"]),
        "to": int(pending["rev"]),
        "upsert": sorted(pending["upsert"]),
        "delete": list(pending["delete"]),
        "floors": dict(pending["floors"]),
        "extra": dict(pending.get("extra") or {}),
        "generated": int(pending["generated"]),
    }


def _publish_pending(pending: dict, pub_dir: str, quality: int, on_written=None) -> dict:
    """Publish the pinned run, at the *pinned* compression setting.

    The changeset decides the JSON; the brotli quality decides the bytes, and it
    is the bytes that are immutable. Taking the retry's `--quality` instead —
    which is what a hand re-run with a different flag supplies — recompresses
    the same payload into a different file and `delta.write` then refuses it at
    a URL that can never be corrected. Reproduced: publish at quality 1, crash,
    retry at 5. Older pending records carry no quality, so the caller's is the
    fallback rather than an error.

    This pins the setting, not the compressor: a brotli upgrade between the
    crash and the retry can still move the bytes. That case fails closed rather
    than publishing — `delta.write` compares its digest against the ledger's,
    and against the file already on disk when the ledger has no entry — so the
    outcome is a stopped run and a message, not a corrupted URL.
    """
    entry = pending.get("entry")
    stub = {"from": int(pending["from"]), "to": int(pending["rev"])}
    published = os.path.join(pub_dir, "deltas", manifest_module.delta_name(stub))
    if entry and os.path.exists(published):
        # The bytes were decided and written down before they became visible, so
        # recovery does not have to *reproduce* them — it can verify the file
        # that is there and finish the publication. This is what makes the
        # guarantee byte-for-byte rather than "byte-for-byte unless the
        # compressor moved": no recompression happens on this path at all.
        actual = file_digest(published)
        if actual != entry["sha256"]:
            raise Abort(
                f"rev {pending['rev']}'s delta is on disk with digest {actual} but was "
                f"published as {entry['sha256']}; those bytes are not the ones clients may "
                "already have fetched, and this needs a human before anything else happens"
            )
        ledger.record_delta(pub_dir, entry, pending.get("space"))
        manifest_module.register_delta(pub_dir, entry, int(pending["generated"]))
        return {"entry": entry, "reused": True}

    artifact = pending["artifact"]
    quality = int(pending.get("quality", quality))
    if not os.path.exists(artifact):
        raise Abort(
            f"rev {pending['rev']} was published from {artifact}, which is gone — so the "
            "bytes already at that URL cannot be reproduced and the run cannot be finished "
            "automatically. Restore that artifact from a backup, or repair the manifest by "
            "hand after checking what the ledger recorded for this range"
        )
    return delta.publish(
        artifact, pub_dir, _changeset(pending), quality=quality, on_written=on_written
    )


def _nothing_was_published(pub_dir: str, entry: dict) -> bool:
    """Whether this range never reached a client, by all three authorities.

    Exactly the test `delta.write` uses to decide that re-cutting a range is
    safe (D-047): the ledger is what remembers a rotated-away generation, the
    manifest is what clients read, and the file is what a crash between the two
    leaves behind. All three clear means the URL was never served.
    """
    if ledger.delta_published(pub_dir, entry) is not None:
        return False
    if manifest_module.lists_delta(pub_dir, entry):
        return False
    return not os.path.exists(
        os.path.join(pub_dir, "deltas", manifest_module.delta_name(entry))
    )


def _pin(state: state_module.State, pending: dict):
    """Record the published bytes into the pending run before they are visible —
    or, on a retry, refuse to publish different ones.

    `delta.write` calls this between deciding the digest and renaming the file
    into place, which is the only moment that can do both jobs. Going in, it is
    where every state in which the file can exist becomes a state where the
    state file already knows what is in it. Coming back, it is the last point at
    which a rebuilt payload can be compared against what was published and
    *stopped* — one line later the bytes are at the URL.
    """
    published = (pending.get("entry") or {}).get("sha256")

    def written(entry: dict, space: dict | None) -> None:
        if published and entry["sha256"] != published:
            raise Abort(
                f"rev {pending['rev']} was published as {published}, but rebuilding the "
                f"pinned changeset now produces {entry['sha256']} — the compressor moved "
                "under a URL that may already have been fetched. Restore the published file, "
                "or repair the manifest by hand from what the ledger recorded"
            )
        state.begin_run({**pending, "entry": entry, "space": space})

    return written


def resume(state: state_module.State, pub_dir: str, quality: int) -> dict:
    """Finish — or discard — the run that minted a revision but never confirmed
    it published.

    Discarding matters as much as finishing. `begin_run` lands before
    `delta.publish`, which is right for a *crash* but wrong for a deterministic
    refusal: `assert_idspace`, `assert_continues`, the floors and landing-space
    comparisons and `assert_tiling` all raise before anything is written, and
    they raise identically on every retry. Resuming unconditionally would then
    replay that failure forever and the data plane would never advance again.
    So a pending run whose range was never published is abandoned and the fresh
    cycle re-mints the revision — which is safe for exactly the reason D-047
    lets `delta.write` re-cut an unpublished range.
    """
    pending = state.pending
    entry = {"from": int(pending["from"]), "to": int(pending["rev"])}
    if manifest_module.lists_delta(pub_dir, entry):
        # The manifest already names it, so publication completed and only the
        # state write was lost. Nothing to republish.
        state.commit_run(pending)
        action = "committed"
    elif pending.get("entry") is None and _nothing_was_published(pub_dir, entry):
        # Abandoning requires *proof* that nothing was served, and a pinned entry
        # withdraws that proof: the hook fires just before the rename, so an
        # entry means the bytes were decided and most likely became visible. The
        # three authorities cannot tell "crashed in the microsecond before the
        # rename" from "was served for a day and then the file was deleted", and
        # only one of those is safe to re-mint. So an entry sends the run down
        # the republish path, where the same hook compares the rebuilt bytes
        # against it and stops if they differ.
        #
        # This does not weaken the deterministic-failure escape: every
        # validation in `delta.publish` raises *before* `delta.write` gets far
        # enough to pin anything, so those runs still carry no entry and are
        # still abandoned.
        state.abandon_run()
        action = "abandoned"
    else:
        _publish_pending(pending, pub_dir, quality, on_written=_pin(state, pending))
        state.commit_run(pending)
        action = "republished"
    return {
        "action": action,
        "rev": int(pending["rev"]),
        "from": int(pending["from"]),
        "upserts": len(pending["upsert"]),
        "deletes": len(pending["delete"]),
    }


# --- artifacts ------------------------------------------------------------


def prune_artifacts(artifacts_dir: str, keep: int, protect: str) -> list:
    """Keep the newest `keep` builds; never the one the state seeds from."""
    if not os.path.isdir(artifacts_dir):
        return []
    protected = os.path.abspath(protect)
    found = []
    for name in os.listdir(artifacts_dir):
        match = ARTIFACT_NAME.match(name)
        if match:
            found.append((int(match.group(1)), os.path.join(artifacts_dir, name)))
    removed = []
    for _rev, path in sorted(found, reverse=True)[keep:]:
        if os.path.abspath(path) == protected:
            continue
        os.remove(path)
        removed.append(path)
    return removed


# --- the run --------------------------------------------------------------


def _guard(deleted: list, corpus: int, limit: float) -> None:
    # Checked rather than trusted, because both ways of getting it wrong disable
    # the guard silently: every comparison with NaN is false, and "1" — the
    # obvious misreading of a help text that says 0.1% — makes the threshold the
    # whole corpus. A guard whose misuse is quiet inverts D-042's "aborting is
    # the success case". NaN fails the range test because every comparison
    # against it is false, which is the same reason it slipped through before.
    #
    # Zero is allowed and is the strictest setting rather than a mistake: the
    # threshold becomes 0 and any disappearance at all aborts. **One is not**,
    # and the first version of this check named it as the dangerous value and
    # then accepted it anyway: at `limit == 1` the threshold is the whole corpus
    # and the comparison is `deleted > corpus`, which even a corpus that
    # vanished entirely cannot satisfy. The guard is not loosened by 1, it is
    # switched off, so the interval is half-open.
    if not 0 <= limit < 1:
        raise Abort(
            f"--tombstone-limit {limit!r} is not a fraction of the corpus in [0, 1); "
            "0.001 is the 0.1% D-031 specifies, and 1 would disable the guard entirely"
        )
    threshold = corpus * limit
    if len(deleted) > threshold:
        raise Abort(
            f"{len(deleted)} records would be tombstoned, above the {limit:.3%} guard "
            f"({threshold:.0f} of {corpus}). Upstream has no deletion concept, so this is "
            "our fetch breaking rather than a withdrawal — nothing was published "
            f"(examples: {deleted[:5]})",
            EXIT_GUARD,
        )


def _check_build_agrees(stats: dict, scanned: dict, diff: dict) -> None:
    """The hash walk and the build walk must have seen the same corpus.

    Every one of these is a comparison between two independent passes over the
    same tree, which is the only thing that can catch the two drifting apart —
    the changeset says which records changed, and the build is what actually
    assigns them ids.
    """
    for label, walked, expected in (
        ("records", stats["records"], len(scanned)),
        ("new records", stats["new_records"], len(diff["added"])),
        ("retired records", stats["retired_records"], len(diff["delete"])),
    ):
        if int(walked) != int(expected):
            raise Abort(
                f"the build saw {walked} {label} but the hash pass says {expected}; the two "
                "walks disagree about the corpus, so the changeset does not describe the "
                "artifact it would be published with"
            )


def run(
    clone: str,
    pub_dir: str,
    state_dir: str,
    *,
    artifacts_dir: str | None = None,
    do_fetch: bool = True,
    tombstone_limit: float = TOMBSTONE_LIMIT,
    dry_run: bool = False,
    quality: int = delta.QUALITY,
    keep: int = ARTIFACT_KEEP,
) -> dict:
    artifacts_dir = artifacts_dir or os.path.join(state_dir, "artifacts")
    summary: dict = {"action": "run", "started": int(time.time())}

    with state_module.lock(state_dir):
        with state_module.State(os.path.join(state_dir, state_module.STATE_NAME)) as state:
            try:
                report = _cycle(
                    state,
                    clone,
                    pub_dir,
                    summary,
                    artifacts_dir=artifacts_dir,
                    do_fetch=do_fetch,
                    tombstone_limit=tombstone_limit,
                    dry_run=dry_run,
                    quality=quality,
                    keep=keep,
                )
            except BaseException as failure:
                # Recorded under the lock, before it is released, so `status`
                # can answer "is the ingest healthy?" without anyone reading a
                # log — which on this machine is the only alerting there is
                # (D-058: no MTA, and D-009 forbids telemetry).
                if state.initialized and not dry_run:
                    state.record_outcome(False, f"{type(failure).__name__}: {failure}")
                raise
            if not dry_run:
                state.record_outcome(True, "")
            return report


def _cycle(
    state: state_module.State,
    clone: str,
    pub_dir: str,
    summary: dict,
    *,
    artifacts_dir: str,
    do_fetch: bool,
    tombstone_limit: float,
    dry_run: bool,
    quality: int,
    keep: int,
) -> dict:
    """One cycle, with the lock held and the state open.

    Split from `run` so the outcome — success or the message a failure carried —
    is recorded around it in one place, rather than at each of the dozen points
    that can abort.
    """
    if not state.initialized:
        raise Abort(
            f"{state.path} describes no revision yet. Run `ingest.py init` against the "
            "artifact this data plane was published from — a delta cut from a state "
            "that does not match the published corpus is not a delta"
        )

    if state.pending is not None:
        if dry_run:
            summary["pending"] = state.pending["rev"]
            summary["result"] = "pending run; --dry-run changes nothing"
            return summary
        summary["resumed"] = resume(state, pub_dir, quality)
        # Printed now rather than only in the final summary: everything
        # after this can abort, and "rev N was published and the head
        # moved" is not something to lose behind a later error.
        print(json.dumps({"resumed": summary["resumed"]}), file=sys.stderr)

    head = published_head(pub_dir)
    if head != state.rev:
        raise Abort(
            f"the data plane is at rev {head} but the ingest state describes rev "
            f"{state.rev}. Something else advanced the head (a snapshot rebuild, or a "
            "delta published by hand); re-point the state at what was published before "
            "ingesting again"
        )
    seed = state.artifact
    if not os.path.exists(seed):
        raise Abort(
            f"the artifact rev {head} was published from is gone ({seed}); a build "
            "cannot continue an ID space it cannot read (D-056)"
        )

    commit = fetch(clone) if do_fetch else build.clone_commit(clone)
    summary["commit"] = commit

    # After a fetch this is clean by construction, which makes it a cheap
    # assertion; with `--no-fetch` it is the only thing standing between a
    # hand-edited working tree and a published delta. Putting it after the
    # branch rather than inside `fetch` is deliberate: the corpus has to be the
    # commit it claims *whenever* we publish, not only when we fetched it.
    # 0.17 s over the real 372k-record tree, measured on `plex`.
    dirt = corpus_dirt(clone)
    if dirt:
        raise Abort(
            f"{clone} has uncommitted changes under cves/, so the corpus is not the commit "
            f"{commit or 'it claims'}:\n{dirt[:500]}\nPublishing from it would ship records "
            "no upstream revision contains"
        )

    scanned = scan(clone)
    if scanned["skipped"]:
        # D-047: a record that cannot be parsed must never silently
        # vanish. A handful of losses would sit below the tombstone
        # guard and undercount forever.
        for path in scanned["skipped"][:20]:
            print(f"unusable record: {path}", file=sys.stderr)
        raise Abort(
            f"{len(scanned['skipped'])} records in the tree cannot be published; "
            "nothing was built or published"
        )
    hashes = scanned["hashes"]
    summary["records"] = len(hashes)

    diff = state.diff(hashes)
    upsert = {**diff["added"], **diff["changed"]}
    deleted = diff["delete"]
    _guard(deleted, state.count(), tombstone_limit)
    summary["changed"] = {
        "added": len(diff["added"]),
        "updated": len(diff["changed"]),
        "deleted": len(deleted),
    }

    if not upsert and not deleted:
        # No change, no revision: a revision is minted by a run that
        # produced one (D-031). The recorded commit stays where it is on
        # purpose — it names the tree the published head was computed
        # from, which is still true.
        summary["result"] = "nothing changed"
        return summary

    to_rev = head + 1
    artifact = os.path.join(artifacts_dir, f"rev-{to_rev}.sqlite")
    os.makedirs(artifacts_dir, mode=0o755, exist_ok=True)
    started = time.time()
    stats = build.build(clone, artifact, None, None, seed=seed, rev=to_rev)
    # Both refusals drop the artifact, for `build`'s own reason: a
    # complete file nothing published is 377 MB that a later run has to
    # reason about, and `prune_artifacts` counts it against `--keep`.
    try:
        if stats["skipped"]:
            raise Abort(
                f"the build could not publish {len(stats['skipped'])} records "
                f"({stats['skipped'][:5]}); nothing was published"
            )
        _check_build_agrees(stats, hashes, diff)
    except Abort:
        os.remove(artifact)
        raise
    summary["build"] = {
        "seconds": round(time.time() - started, 1),
        "bytes": stats["bytes"],
        "minted": {t: n for t, n in stats["minted"].items() if n},
        "retired": stats["retired"],
    }

    pending = {
        "rev": to_rev,
        "from": head,
        # Pinned here and never restamped: the client writes it to
        # `meta.generated` on apply, so a retry that moved it would be
        # different content at an immutable URL (D-055).
        "generated": int(time.time()),
        # Pinned for the same reason and with the same force: the
        # changeset decides the JSON, this decides the bytes, and the
        # bytes are what the URL promises never to change.
        "quality": int(quality),
        "commit": commit,
        "artifact": os.path.abspath(artifact),
        "upsert": upsert,
        "delete": deleted,
        # The ID space at `from`, out of the artifact's own record
        # rather than recomputed (D-056) — `build` reports the extent it
        # was seeded from, which is exactly that revision's.
        "floors": stats["seed_floors"],
        # And the ids whose *content* moved under an id the client
        # already holds, which no floor can see.
        "extra": stats["extra"],
    }
    if dry_run:
        summary["result"] = "dry run; nothing published"
        summary["would_publish"] = {
            "rev": to_rev,
            "from": head,
            "artifact": pending["artifact"],
            "upserts": len(upsert),
            "deletes": len(deleted),
            "floors": pending["floors"],
            "extra": pending["extra"],
        }
        return summary

    state.begin_run(pending)
    published = _publish_pending(pending, pub_dir, quality, on_written=_pin(state, pending))
    state.commit_run(pending)
    summary["result"] = "published"
    summary["delta"] = published["entry"]
    summary["lookups"] = published["lookups"]
    summary["rev"] = to_rev
    summary["pruned"] = prune_artifacts(artifacts_dir, keep, state.artifact)
    return summary


def init(
    clone: str,
    pub_dir: str,
    state_dir: str,
    artifact: str,
    *,
    force: bool = False,
) -> dict:
    """Adopt a published data plane: record the corpus behind its head revision.

    This is also where D-056's migration lands. The live generation was
    published before ID spaces were recorded, and a delta may never adopt one —
    so the sequence is: build seeded from the live artifact at a revision above
    head, `publish.py --adopt-id-space`, then `init` against that artifact.
    Every client re-downloads once, and deltas work from there.
    """
    with state_module.lock(state_dir):
        with state_module.State(os.path.join(state_dir, state_module.STATE_NAME)) as state:
            # The pending check is unconditional, and comes first. A pending run
            # is the *only* record that a revision was minted and may already
            # have bytes at an immutable URL; `initialize` clears it, so
            # `--force` here would discard that record silently. Gating it on
            # `force` also made it unreachable — a pending run implies an
            # initialized state, so the check below always fired first.
            if state.pending is not None:
                raise Abort(
                    f"{state.path} has a pending run at rev {state.pending['rev']}, which may "
                    "already have published bytes this state is the only record of. Run "
                    "`ingest.py run` to finish or discard it before re-initializing"
                )
            if state.initialized and not force:
                raise Abort(
                    f"{state.path} already describes rev {state.rev}; re-initializing would "
                    "replace the record of what clients hold. Pass --force if that is meant"
                )

            space = build.id_space(artifact)
            rev = int(space["rev"])
            if not space["idspace"]:
                raise Abort(
                    f"{artifact} records no ID space (D-056), so no delta can ever be cut from "
                    "it. Rebuild it with --seed from this artifact and publish that with "
                    "`publish.py --adopt-id-space` at a revision above the head first"
                )
            head = published_head(pub_dir)
            if head != rev:
                raise Abort(
                    f"{artifact} is stamped rev {rev} but the data plane's head is {head}; the "
                    "state has to describe the corpus behind the revision clients are told to "
                    "reach"
                )
            token = ledger.idspace(pub_dir)
            if token != space["idspace"]:
                raise Abort(
                    f"{artifact} belongs to ID space {space['idspace']} but this data plane "
                    f"published {token or 'an unrecorded one'}; publish this artifact with "
                    "`publish.py --adopt-id-space` before ingesting against it"
                )
            # And that it is *the* artifact published at that revision, not a
            # sibling of it. The lineage token cannot tell two builds apart —
            # they inherit it — and neither can the revision they are stamped
            # with, so the ledger's fingerprint of the ID space is what
            # separates them (D-056). Reachable from the documented migration:
            # re-running the build step overwrites `rev-2.sqlite` after the
            # ledger recorded the fingerprint of the file that was published.
            recorded = ledger.space_at(pub_dir, rev)
            if recorded is not None:
                candidate = {
                    "marks": build.id_marks(space),
                    "fingerprint": build.fingerprint(artifact),
                }
                if recorded != candidate:
                    raise Abort(
                        f"{artifact} is not the artifact published at rev {rev} (fingerprint "
                        f"{candidate['fingerprint']}, published {recorded.get('fingerprint')}); "
                        "its ids mean something different from the ones clients hold"
                    )

            scanned = scan(clone)
            if scanned["skipped"]:
                for path in scanned["skipped"][:20]:
                    print(f"unusable record: {path}", file=sys.stderr)
                raise Abort(f"{len(scanned['skipped'])} records in the tree cannot be published")
            hashes = scanned["hashes"]

            # The tree has to be the one the artifact was built from, or the
            # first delta silently omits every record that changed in between:
            # those records' hashes would be recorded as if they had always been
            # that way. The artifact records the commit it read (`build.py`), so
            # that is checkable rather than an instruction in the README — and
            # it is the check that catches an edit to a record that kept its id,
            # which comparing id sets cannot. Conditional because a pre-D-056
            # artifact records no commit, and soft on the clone side because a
            # corpus directory that is not a git tree is what the fixtures use.
            built_from = str(space["commit"])
            at = build.clone_commit(clone)
            if built_from and not at:
                # Fail *closed* on the asymmetry rather than skipping the check.
                # An artifact that names a commit is asking to be checked, and
                # "the clone cannot tell me which commit it is" is not an answer
                # — it is the state in which the check cannot be made.
                raise Abort(
                    f"{artifact} was built from commit {built_from}, but {clone} reports no "
                    "commit, so nothing can confirm this is the tree it was built from. Point "
                    "at the git clone the artifact came from"
                )
            if built_from and at and built_from != at:
                raise Abort(
                    f"{artifact} was built from commit {built_from} but the clone is at {at}; "
                    "re-deriving the hashes from this tree would record post-artifact content "
                    "as the artifact's, and every record that changed in between would be "
                    "missing from every future delta. Reset the clone to that commit"
                )
            # And the commit is only half the question: a modified or untracked
            # record leaves `HEAD` alone while changing what `scan` hashes, and
            # the id sets can still match. Both halves have to hold.
            dirt = corpus_dirt(clone)
            if dirt:
                raise Abort(
                    f"{clone} has uncommitted changes under cves/, so its content is not the "
                    f"commit it claims:\n{dirt[:500]}\nRecording these hashes as the "
                    "artifact's would drop those edits from every future delta"
                )
            published_ids = artifact_ids(artifact)
            missing = sorted(published_ids - set(hashes))[:5]
            extra = sorted(set(hashes) - published_ids)[:5]
            if missing or extra:
                raise Abort(
                    f"the clone holds {len(hashes)} records and {artifact} holds "
                    f"{len(published_ids)}; they are not the same corpus (missing here: "
                    f"{missing}, unpublished here: {extra}). Re-run against the tree the "
                    "artifact was built from"
                )

            state.initialize(
                rev=rev,
                artifact=artifact,
                idspace=space["idspace"],
                commit=build.clone_commit(clone),
                hashes=hashes,
            )
            return {
                "action": "init",
                "rev": rev,
                "artifact": os.path.abspath(artifact),
                "idspace": space["idspace"],
                "records": len(hashes),
                "commit": state.commit,
            }


def status(pub_dir: str, state_dir: str) -> dict:
    """What the ingest thinks, and what the data plane says — side by side.

    Read-only and lock-free on purpose: it is the thing to run while wondering
    whether a run is stuck, and taking the lock to answer that would be the one
    way to find out that it is not. Read-only extends to not *creating* the
    state — opening `State` would, and "initialized: false" against a path that
    was never a state directory reads as an answer rather than as a typo.
    """
    manifest = manifest_module.load(pub_dir)
    path = os.path.join(state_dir, state_module.STATE_NAME)
    report: dict = {
        "action": "status",
        "state": path,
        "head": manifest_module.head_rev(manifest) if manifest else None,
        "ledger_head": ledger.highest_published(pub_dir),
        "ledger_idspace": ledger.idspace(pub_dir) or None,
    }
    if not os.path.exists(path):
        report["initialized"] = False
        report["exists"] = False
        return report
    with state_module.State(path) as state:
        if not state.initialized:
            report["initialized"] = False
            return report
        pending = state.pending
        report.update(
            {
                "initialized": True,
                "rev": state.rev,
                "artifact": state.artifact,
                "idspace": state.idspace or None,
                "commit": state.commit or None,
                "records": state.count(),
                "tombstones": state.tombstones(),
                # The closest thing to an alert this machine has (D-058).
                "last_run": state.last_run,
                "pending": None
                if pending is None
                else {
                    "rev": pending["rev"],
                    "from": pending["from"],
                    "upserts": len(pending["upsert"]),
                    "deletes": len(pending["delete"]),
                    "generated": pending["generated"],
                },
            }
        )
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    runner = sub.add_parser("run", help="One daily ingest cycle.")
    runner.add_argument("clone")
    runner.add_argument("pub_dir")
    runner.add_argument("--state", required=True, help="Directory holding the ingest state.")
    runner.add_argument(
        "--artifacts",
        default=None,
        help="Where builds land. Defaults to <state>/artifacts.",
    )
    runner.add_argument(
        "--no-fetch",
        action="store_true",
        help="Ingest the working tree as it stands, without fetching.",
    )
    runner.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch, hash, diff, guard and build, then report the changeset "
        "without publishing it or touching the state.",
    )
    runner.add_argument(
        "--tombstone-limit",
        type=float,
        default=TOMBSTONE_LIMIT,
        help="Fraction of the corpus whose disappearance aborts the run, in "
        f"[0, 1) (default {TOMBSTONE_LIMIT}). Raising it is a deliberate act "
        "for a withdrawal confirmed upstream, not a way past a broken fetch; 1 "
        "is refused because it would disable the guard rather than loosen it.",
    )
    runner.add_argument("--quality", type=int, default=delta.QUALITY)
    runner.add_argument("--keep", type=int, default=ARTIFACT_KEEP)

    starter = sub.add_parser("init", help="Adopt a published data plane.")
    starter.add_argument("clone")
    starter.add_argument("pub_dir")
    starter.add_argument("--state", required=True)
    starter.add_argument(
        "--artifact", required=True, help="The artifact the head revision was published from."
    )
    starter.add_argument("--force", action="store_true")

    reporter = sub.add_parser("status", help="What the ingest and the data plane each think.")
    reporter.add_argument("pub_dir")
    reporter.add_argument("--state", required=True)

    args = parser.parse_args()
    try:
        if args.command == "run":
            report = run(
                args.clone,
                args.pub_dir,
                args.state,
                artifacts_dir=args.artifacts,
                do_fetch=not args.no_fetch,
                tombstone_limit=args.tombstone_limit,
                dry_run=args.dry_run,
                quality=args.quality,
                keep=args.keep,
            )
        elif args.command == "init":
            report = init(args.clone, args.pub_dir, args.state, args.artifact, force=args.force)
        else:
            report = status(args.pub_dir, args.state)
    except state_module.Busy as busy:
        # The monthly snapshot is running, or a previous daily has not finished.
        # Not a failure: tomorrow's run covers two days.
        print(f"skipped: {busy}", file=sys.stderr)
        return EXIT_OK
    except Abort as abort:
        print(f"error: {abort}", file=sys.stderr)
        return abort.code

    print(json.dumps(report, indent=2))
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
