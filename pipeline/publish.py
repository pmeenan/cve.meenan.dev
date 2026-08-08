"""Chunk, compress and publish an artifact, then write the manifest.

    python3 pipeline/publish.py <in.sqlite> <pub-dir> [--quality 10] [--jobs N]

Chunks are 32 MiB slices of the *uncompressed* database, each compressed
independently at brotli -q10 (D-041). Independence is the point: brotli is a
stream format, so a range-resumed monolith cannot be decoded from an arbitrary
offset. Chunked, resumption is a bitmap of what has already been written, and
each chunk decompresses straight into its own byte offset in OPFS.

Measured on the 391.3 MB artifact: 12 chunks totalling 63.3 MB, 1.1% larger
than a monolith at 62.6 MB, compressed in 101 s across 24 cores against 351 s
single-threaded.

Publication is an atomic rename, so a half-written generation is never
reachable (D-042).

It is also where **retention** happens, because retention is a decision about
generations and the manifest is rewritten here anyway: the previous generation
and every delta back to it are kept, and what falls out the far end is deleted
after the manifest has stopped naming it (D-060). The monthly cron that drives
this is `snapshot.py`.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import shutil
import subprocess
import sqlite3
import tempfile
import time

import build
import ledger
import manifest as manifest_module

CHUNK_BYTES = 32 * 1024 * 1024
FORMAT_VERSION = 1
# JSON numbers are IEEE doubles by the time a browser sees them (`delta.py`
# carries the same bound for the same reason).
MAX_SAFE_INT = 2**53 - 1

# The two published file shapes, matched rather than parsed loosely: retention
# deletes, and a regex that matched `.staging-3` or a hand-dropped file would
# delete something else. Both mirror what this module and `manifest.py` write.
GENERATION_DIR = re.compile(r"^snapshot-(\d+)$")
DELTA_FILE = re.compile(r"^(\d+)-(\d+)\.json\.br$")


def sha256_file(path: str) -> str:
    return build.digest_file(path)


def read_meta(db_path: str) -> dict:
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        return dict(db.execute("SELECT k, v FROM meta"))
    finally:
        db.close()


def _same_bytes(final: str, chunks: list) -> bool:
    """Whether a published generation is byte-for-byte what was just staged."""
    if not os.path.isdir(final):
        return False
    published = sorted(name for name in os.listdir(final) if name.endswith(".br"))
    if published != sorted(chunk["name"] for chunk in chunks):
        return False
    return all(
        sha256_file(os.path.join(final, chunk["name"])) == chunk["sha256"] for chunk in chunks
    )


def retained_deltas(previous: dict, pub_dir: str, rev: int, floor: int) -> list:
    """Which of the previous manifest's deltas survive into the new one.

    An entry has to clear three things. It starts at or above the retention
    floor — the *previous* snapshot's revision, the oldest watermark D-042
    promises to carry forward — and its file is still on disk; and then the two
    walks below, which between them are the manifest's tiling invariant applied
    before the manifest is written rather than after.

    The walks exist because a snapshot lands in two different places. The
    monthly rotation lands **at** head, so the deltas worth keeping run *up to*
    it from below. A republish of the generation already being served lands
    **behind** head, so the deltas worth keeping run *forward* from it. So:
    first find where a client that downloads this snapshot ends up (forward
    from `rev`, which is head itself in the rotation case), then keep every
    delta that can still reach there.

    The same walk is what retires an old ID space without a second rule for it:
    `--new-id-space` lands above every revision the old deltas can carry a
    client to, so nothing is forward-reachable, the head is the snapshot's own
    revision, and the whole list drops. Same for a rebuild published above head
    — until a bridging delta for that range is published, a client below it has
    no chain, and the manifest says so honestly instead of advertising a path
    `planSync` would refuse.
    """
    candidates = [
        entry
        for entry in previous.get("deltas", [])
        if int(entry["from"]) >= floor
        and os.path.exists(os.path.join(pub_dir, "deltas", manifest_module.delta_name(entry)))
    ]

    def walk(seed: set, edge) -> set:
        reached = set(seed)
        changed = True
        while changed:
            changed = False
            for entry in candidates:
                start, end = edge(entry)
                if start in reached and end not in reached:
                    reached.add(end)
                    changed = True
        return reached

    forward = walk({int(rev)}, lambda e: (int(e["from"]), int(e["to"])))
    reaches = walk({max(forward)}, lambda e: (int(e["to"]), int(e["from"])))
    return [entry for entry in candidates if int(entry["to"]) in reaches]


def retire(pub_dir: str, rev: int, floor: int, previous_floor: int | None) -> dict:
    """Delete what retention no longer covers — **after** the manifest is saved.

    D-042 keeps two generations: this one and the one it replaces. Everything
    older goes, and with it the deltas that only ever served clients below the
    oldest generation being removed — one full rotation *after* the manifest
    stopped listing them. That grace period is the whole point of retention: a
    client that read the previous manifest ten minutes ago is still fetching
    from a generation that is still here, and from deltas that are still here.
    A day's delta is ~70–90 KB (D-042, D-058), so a month of extra grace costs
    a couple of megabytes against the 63 MB generation it protects.

    The invariant is **nothing either manifest named is deleted** — not the one
    just written, and not the one that was live a moment ago. The first half is
    ordering: the manifest is rewritten before any of this runs. The second half
    is that what gets deleted is defined by the two floors rather than by what
    happens to be on disk, and both halves were learned the same way.

    A generation directory can exist that was never advertised — a publish
    killed between `os.rename(staging, final)` and the manifest write leaves
    exactly that. Deriving the delta cut from the newest directory being removed
    put it *above* this manifest's floor, sweeping up files the manifest had
    just been rewritten to keep (reproduced from a crashed rotation and from a
    crashed manual rebuild above head). Deleting only generations strictly below
    the floor fixed that half — and left the other: one rotation later the same
    orphan is retired, and the cut taken from it landed above the *previous*
    manifest's floor, deleting a delta a client had been offered sixty seconds
    earlier. Hence `previous_floor`, which is the grace period itself rather
    than a refinement of it.

    A directory *above* this revision is reported rather than deleted: it is a
    crashed publish, and its bytes are the byte-identical resume evidence its
    retry needs (D-047).

    Retention is deliberately not a separate job. A standalone pruner would
    delete files the live manifest still lists, and `manifest.py` has no way to
    drop an entry outside a republish, so the window between the two would
    advertise 404s. Doing it here means the entries and the files go in one
    operation, in the safe order.

    Nothing here raises. The publication is already complete and correct by the
    time this runs, so a directory that cannot be removed is reported — a green
    publish reported as a failed one would be the wrong direction to fail in,
    given `ingest.py status` is the only alerting this machine has (D-058).
    """
    removed: dict = {"generations": [], "deltas": [], "unplaced": [], "unremovable": []}
    retired_revs = []
    for name in sorted(os.listdir(pub_dir)):
        match = GENERATION_DIR.match(name)
        if not match:
            continue
        found = int(match.group(1))
        # Never the generation just published, whatever the floor says. Nothing
        # reachable can put `floor` above `rev` today — `assert_continues`
        # refuses a publish behind the advertised generation even under
        # `--force` — but this function deletes directories, and "safe because
        # of a check three modules away" is not the guarantee to rest that on.
        if found == int(rev):
            continue
        if found >= int(floor):
            if found > int(rev):
                removed["unplaced"].append(name)
            continue
        try:
            shutil.rmtree(os.path.join(pub_dir, name))
        except OSError as error:
            removed["unremovable"].append(f"{name}: {error}")
            continue
        retired_revs.append(found)
        removed["generations"].append(name)

    # Nothing retired means nothing to cut: a data plane on its first rotation
    # keeps every delta it has, which is what lets a client sitting at the
    # original snapshot still catch up.
    #
    # Bounded by the **previous manifest's own floor**, which is the whole grace
    # period. Every retired revision is below this manifest's floor, so a cut
    # taken from them alone is already below every *retained* entry — but that
    # is the weaker claim. The one that matters is that a file the manifest
    # live sixty seconds ago named is not deleted in the operation that stops
    # naming it, and an unadvertised generation between the two floors (a
    # rotation killed before its manifest write leaves one) pushed the cut past
    # exactly that. Reproduced: crash, rotate, a day, rotate again, and the
    # delta a client at rev 1 had just been offered was gone.
    cut = max(retired_revs, default=0)
    if previous_floor is not None:
        cut = min(cut, int(previous_floor))
    deltas = os.path.join(pub_dir, "deltas")
    if cut and os.path.isdir(deltas):
        for name in sorted(os.listdir(deltas)):
            match = DELTA_FILE.match(name)
            # `to <= cut` — entirely below the oldest generation just removed.
            # A pending run's file ends above head and cannot match, so a
            # crashed ingest's pinned bytes are never swept up here.
            if match and int(match.group(2)) <= cut:
                try:
                    os.remove(os.path.join(deltas, name))
                except OSError as error:
                    removed["unremovable"].append(f"{name}: {error}")
                    continue
                removed["deltas"].append(name)
    return removed


def compress_chunk(job: tuple[str, str, int]) -> dict:
    """Slice [offset, offset+CHUNK_BYTES) out of the source and brotli it."""
    source, out_path, offset = job
    with open(source, "rb") as handle:
        handle.seek(offset)
        raw = handle.read(CHUNK_BYTES)

    with tempfile.NamedTemporaryFile(delete=False) as scratch:
        scratch.write(raw)
        scratch_path = scratch.name
    try:
        subprocess.run(
            ["brotli", "-q", str(compress_chunk.quality), "-f", "-o", out_path, scratch_path],
            check=True,
        )
    finally:
        os.unlink(scratch_path)

    # brotli inherits the temp file's restrictive mode; served files need to be
    # readable by the web server regardless of who runs the pipeline.
    os.chmod(out_path, 0o644)

    return {
        "offset": offset,
        "raw_bytes": len(raw),
        "bytes": os.path.getsize(out_path),
        "sha256": sha256_file(out_path),
    }


compress_chunk.quality = 10


def publish(
    db_path: str,
    pub_dir: str,
    quality: int,
    jobs: int,
    force: bool = False,
    new_id_space: bool = False,
    adopt_id_space: bool = False,
) -> dict:
    compress_chunk.quality = quality
    meta = read_meta(db_path)
    rev = int(meta.get("rev", 1))
    # The client refuses a revision JSON cannot carry intact (`isRevision` in
    # `lib/protocol.ts`), and a manifest it refuses is a data plane it cannot
    # use at all. SQLite will store an int64 happily, so the bound has to be
    # asserted where the number enters the contract.
    if not 0 <= rev <= MAX_SAFE_INT:
        raise SystemExit(
            f"error: {db_path} is stamped rev {rev}, which is outside the range a JSON "
            f"number survives intact (0..{MAX_SAFE_INT}); the client refuses the manifest"
        )
    total = os.path.getsize(db_path)

    # D-008 is a condition of the grant, and this is the largest copy of CVE
    # data we publish. `delta.extract` refuses an artifact with no notice; this
    # refused nothing at all, which is the asymmetry that matters.
    if not str(meta.get("notice") or "").strip():
        raise SystemExit(f"error: {db_path} carries no MITRE notice (D-008); refusing to publish")

    # And the schema, which `delta.extract` has always checked and this — the
    # publisher of the *larger* artifact — did not, defaulting a missing value
    # to 1. The bump runbook's step 0 is `git pull`, so building before pulling
    # and publishing after is an easy order slip; it would have published a
    # schema-1 artifact under a schema-1 manifest while retiring the old ID
    # space and every pre-bump delta, and the schema-2 app would then refuse the
    # plane it had just replaced. Found by M5's data-plane review.
    stamped = meta.get("schema")
    if stamped is None or int(stamped) != build.SCHEMA_VERSION:
        raise SystemExit(
            f"error: {db_path} is schema {stamped!r} but this pipeline publishes schema "
            f"{build.SCHEMA_VERSION}; the artifact and the code that publishes it have to "
            "agree, or the manifest describes a shape the artifact does not have"
        )

    # The ID space this artifact's ids belong to (D-056). A snapshot from a
    # different lineage is publishable — clients re-download rather than sync —
    # but only deliberately, and never alongside deltas cut against the old one.
    token = str(meta.get("idspace") or "")
    if not new_id_space:
        ledger.assert_idspace(pub_dir, token, adopt=adopt_id_space)

    # Publication is what the manifest says, not what the filesystem holds: a
    # generation whose directory was removed still has URLs that caches may
    # hold for a year (D-034, D-047).
    previous = manifest_module.load(pub_dir) or {}
    # The ledger, not the manifest, is what remembers: a manifest describes only
    # the current generation, so a rotated-away revision looked unpublished and
    # could be re-cut over its own immutable URLs. It seeds itself from the
    # manifest, so a data plane published before it existed is covered too.
    published_head = max(
        manifest_module.head_rev(previous) if previous else 0,
        ledger.highest_published(pub_dir),
    )
    space = build.id_space(db_path)
    seed_rev = space["seed_rev"]

    # What this artifact's ID space *is*, computed once and compared whole
    # wherever it is needed. Built here rather than below because the head guard
    # has to be able to recognise a resume, and a resume is exactly "the ledger
    # already records this revision as this ID space".
    candidate = {"marks": build.id_marks(space), "fingerprint": build.fingerprint(db_path)}
    recorded = ledger.space_at(pub_dir, rev)
    # True when this very publication already got as far as the ledger. A
    # `--new-id-space` run writes the ledger *before* the manifest, so a crash
    # between the two — ENOSPC on a directory that just took 63 MB, an OOM, a
    # power cut — leaves `published_head` reading the ledger's new revision
    # while the manifest still advertises the old one. The retry then met the
    # guard below and was refused at the revision it had itself just published,
    # with both crons stopped and no exit but hand-editing the ledger. The
    # byte-identity resume that exists for this crash (`_same_bytes`) sits 170
    # lines further down and was never reached. Found by M5's data-plane review;
    # this is the schema-bump runbook's own step 2.
    resuming_publication = recorded is not None and recorded == candidate

    if new_id_space or adopt_id_space:
        if not token:
            raise SystemExit(f"error: {db_path} records no ID space to publish (D-056)")
        # "Every client re-downloads" is only true if the manifest stops
        # offering them a no-op. `planSync` returns "already current" whenever
        # the client's watermark equals head, so retiring or adopting an ID
        # space *at* head — the legal monthly-rebuild landing — left every
        # synced client on the old ids, and the next delta then applied to them.
        # Adoption cannot prove equivalence either: a legacy data plane has no
        # recorded fingerprint to compare against, which is why it is adoption.
        if rev <= published_head and published_head and not resuming_publication:
            what = "retiring" if new_id_space else "adopting"
            raise SystemExit(
                f"error: {what} an ID space needs a revision above the published head "
                f"({published_head}); at rev {rev} every client already at that watermark "
                "sees nothing to do and keeps the old ids"
            )
        if adopt_id_space and seed_rev is None:
            # Adoption says "these ids continue what you published"; a bootstrap
            # continues nothing, so the flag would be asserting something the
            # artifact contradicts. `--new-id-space` is the flag for that.
            raise SystemExit(
                "error: --adopt-id-space needs an artifact that continues the published "
                "ids, and a bootstrap continues nothing. Rebuild with --seed from the live "
                "artifact, or use --new-id-space to retire the old ID space deliberately."
            )

    # What an id *means* at a published revision is as immutable as the bytes at
    # its URL, and for the same reason: clients hold it. So a revision that has
    # been published may only be published again by the same ID space — checked
    # here rather than at the ledger write, which is after the generation
    # directory has already been renamed into place.
    #
    # The candidate is built once and compared whole, then handed to the ledger
    # unchanged. Comparing a *part* of it here while the ledger compared all of
    # it was worse than not checking at all: an artifact whose recorded marks
    # differed but whose rows did not passed this check, was renamed into place,
    # and was then rejected by the ledger — leaving the immutable URL occupied
    # by bytes nothing had registered, which blocked the correct artifact.
    # (Both are computed above, because the head guard needs them too.)
    if recorded is not None and recorded != candidate:
        raise SystemExit(
            f"error: rev {rev} was published with a different ID space "
            f"(fingerprint {recorded.get('fingerprint')} / marks {recorded.get('marks')}, "
            f"now {candidate['fingerprint']} / {candidate['marks']}); publishing this "
            "artifact there would redefine ids that clients already hold. Publish it at a "
            "new revision."
        )

    # A snapshot published *at* the head revision is the monthly landing (D-042,
    # D-055), and it is the one publication that asks nothing of anyone: every
    # synced client is already at that watermark, `planSync` reports "already
    # current", and not one byte of it is ever re-fetched. So different content
    # there is invisible and permanent — the hole D-056 named and left for this
    # task. The rule (D-060): a snapshot at head must be *the artifact head's
    # content came from*, by digest. The monthly cron satisfies it by
    # construction, because it publishes the artifact the ingest state points at
    # rather than a fresh build; a rebuild that genuinely changes content has to
    # land above head, where clients are told to re-download.
    #
    # Fails closed on a missing record, for the reason D-056 gives about gaps: a
    # revision whose artifact was never written down cannot be compared, and
    # "nothing to check" is exactly what a wrong artifact needs. Waiting for the
    # next delta is the cheap fix, and the message says so.
    #
    # The *mismatch* half is checked here and ungated by `--force`, for the same
    # reason the ID-space comparison above is: `ledger._record_artifact` refuses
    # it too, but that runs after the generation directory has been renamed into
    # place, so the failure would land with new chunks on disk and the old
    # digests still in the manifest. Reproduced with `--force` and a sibling
    # build. The cost is real and deliberate: `--force` can no longer replace
    # what a recorded revision's content *is*. Publish at a new revision, or —
    # in a throwaway `pub` directory — remove its ledger, which is the local
    # iteration `--force` is documented for.
    artifact_digest = build.digest_file(db_path)
    recorded_artifact = ledger.artifact_at(pub_dir, rev)
    if recorded_artifact is not None and recorded_artifact != artifact_digest:
        raise SystemExit(
            f"error: rev {rev}'s content came from artifact {recorded_artifact}, but this is "
            f"{artifact_digest}; what a published revision *is* cannot be rewritten, because "
            "clients already hold it. Publish this at a new revision."
        )
    # Ungated by `--force` as well, and for a reason `--force` cannot address.
    # The flag says "replace the bytes at these URLs deliberately"; the hazard
    # here is not the bytes but that **nobody at head is ever told to re-fetch
    # them**, so a forced publish reaches new arrivals only and leaves every
    # synced client on the old content, silently and permanently. Gating this
    # half on `force` let exactly that through — remove the ledger's record (or
    # publish onto a data plane that predates it) and any content at all could
    # land at head.
    if published_head and rev == published_head and recorded_artifact is None:
        raise SystemExit(
            f"error: rev {rev} is the published head, but this data plane has no record of "
            "the artifact its content came from — so nothing here can confirm that "
            "publishing this one leaves every synced client holding what it already has, "
            "and none of them will be told to re-fetch it. Publish at a revision above "
            "head, or ingest one delta first (which records it) and snapshot that."
        )

    if published_head and not new_id_space:
        # The lineage token cannot see a build seeded from the wrong ancestor —
        # two children of one artifact share it, and both mint the same ids for
        # different values. The revision the build continued can, and the
        # fingerprint of the ID space it grew from separates two builds stamped
        # at one revision (D-056).
        ledger.assert_continues(pub_dir, space)
        if seed_rev is None:
            # A bootstrap continues nothing. Over an established data plane that
            # makes it either a mistake or a deliberate reset, and the reset has
            # its own flag — so the only bootstrap allowed here is the one whose
            # ID space this revision already carries (checked above).
            if recorded is None and ledger.idspace(pub_dir):
                raise SystemExit(
                    "error: this artifact records no ancestry, so nothing here can place it "
                    "in the ID space this data plane publishes. Rebuild with --seed from the "
                    "most recent artifact, or use --new-id-space to retire the old ID space "
                    "deliberately."
                )
        elif seed_rev != published_head and rev != published_head:
            # `rev == published_head` is the exception the monthly rebuild needs
            # and the one a retry needs: the artifact the last delta was cut
            # from is stamped at head and was seeded from head-1, so requiring
            # it to *continue* head would refuse the very artifact clients are
            # synced to. It is safe because the ids at that revision are pinned:
            # a *different* ID space at head is refused above.
            raise SystemExit(
                f"error: this artifact was seeded from rev {seed_rev} but the data plane is "
                f"at rev {published_head}; ids minted between the two exist only in the "
                "artifact this one was not built from. Reseed from the most recent build."
            )

    # Per-process, because nothing here takes a lock (only the two crons do) and
    # the name used to be `.staging-<rev>` for everyone. Two publishes of one
    # revision then shared it, and the second's unconditional `rmtree` deleted
    # the first's compressed chunks between it recording their digests and
    # renaming the directory into place — publishing a manifest naming twelve
    # files that were not there. Found by M5's data-plane review.
    staging = os.path.join(pub_dir, f".staging-{rev}-{os.getpid()}")
    final = os.path.join(pub_dir, f"snapshot-{rev}")
    shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(staging, mode=0o755, exist_ok=True)

    offsets = list(range(0, total, CHUNK_BYTES))
    work = [
        (db_path, os.path.join(staging, f"{index:03d}.br"), offset)
        for index, offset in enumerate(offsets)
    ]

    started = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
        chunks = list(pool.map(compress_chunk, work))
    elapsed = time.time() - started

    for index, chunk in enumerate(chunks):
        chunk["name"] = f"{index:03d}.br"

    # The digest above named a *path*, and the workers reopened that path to
    # read the bytes now staged. Anything that replaced the file in between —
    # a hand-run `build.py` during recovery, which `pipeline/README.md` documents
    # as a real operation and which takes no lock — would have the ledger record
    # one artifact while the chunks reconstruct another, with every manifest
    # digest agreeing so no integrity check notices. Re-read before any of it
    # becomes visible; the staged bytes came from this file, so if the file is
    # still the one that was hashed, so are they. 0.18 s over 377 MB.
    if build.digest_file(db_path) != artifact_digest:
        shutil.rmtree(staging, ignore_errors=True)
        raise SystemExit(
            f"error: {db_path} changed while it was being published — it hashed as "
            f"{artifact_digest} before compression and differs now, so the staged chunks "
            "describe bytes this run cannot vouch for. Nothing was published; re-run against "
            "a source nothing else is writing."
        )

    # D-047: a published generation is immutable — its URLs carry an immutable
    # cache policy (D-034), so rewriting one serves stale-vs-new mixes from
    # caches. Same-rev republish is therefore refused; --force (local iteration
    # only) swaps via rename, which is brief but *not* atomic — there is no
    # portable directory swap — so a client fetching a chunk in that instant
    # gets a 404 and retries.
    #
    # Re-publishing *the same bytes* is not a rewrite, though, and that is the
    # difference between an immutability violation and a resumed run: the file
    # rename happens before the ledger and manifest writes, so a crash in
    # between leaves a generation on disk that nothing has registered. Byte
    # identity is checkable, so the retry completes the run instead of needing
    # `--force` — which is documented as local iteration precisely because it
    # *can* replace bytes. Same rule as a delta's (D-055).
    resuming = _same_bytes(final, chunks)
    retired = None
    # Revisions only move forward. Deleting a retired generation's directory used
    # to be enough to let an *older* artifact be republished, which rolled the
    # manifest backwards — clients that had already synced past it then see an
    # origin behind their own watermark, and the reused `snapshot-<rev>` URLs
    # serve different bytes under an immutable cache policy. `rev ==
    # published_head` stays legal: that is the monthly rebuild landing at the
    # revision the deltas have already reached.
    #
    # **Outside the `resuming` exemption, deliberately.** Byte identity answers
    # "are these the same bytes as what is already at this URL"; it says nothing
    # about "is this revision behind head", and the two are independent. Under
    # retention an older generation's directory is *still on disk*, so a flagless
    # re-run of that generation's artifact — a plausible shell-history repeat,
    # and exactly what the schema-bump runbook leaves lying around — matched
    # here, skipped this check, and rewrote the manifest at the old revision with
    # every delta dropped. Reproduced three ways, including on the monthly
    # rotation's own shape; found by M5's data-plane review.
    if not force and rev < published_head:
        shutil.rmtree(staging)
        raise SystemExit(
            f"error: the data plane is at rev {published_head}; publishing rev {rev} "
            "would roll it backwards"
        )
    if not force and not resuming:
        if ledger.snapshot_published(pub_dir, rev) or os.path.exists(final):
            shutil.rmtree(staging)
            raise SystemExit(
                f"error: snapshot-{rev} is already published and generations are "
                "immutable (D-047); bump the revision, or --force for local "
                "iteration"
            )
    if os.path.exists(final):
        retired = os.path.join(pub_dir, f".retired-{rev}-{os.getpid()}")
        os.rename(final, retired)
    os.rename(staging, final)
    # `makedirs(mode=...)` is masked by the caller's umask, so set it outright:
    # under a hardened umask nginx cannot traverse the directory and every
    # artifact 403s while the manifest looks perfectly healthy.
    os.chmod(final, 0o755)
    if retired is not None:
        shutil.rmtree(retired)

    # Which deltas survive into the new manifest, and therefore which files
    # retention may delete. The floor is the *previous* snapshot's revision:
    # D-042 keeps every delta back to the older of the two generations it
    # retains, so a client one generation behind catches up instead of
    # re-downloading. `retained_deltas` then drops anything that cannot reach
    # this snapshot's revision, which is what keeps a kept entry from being a
    # path `planSync` would refuse.
    #
    # Before D-060 the floor was `rev` itself, which dropped *every* delta on
    # every rotation — the honest answer while nothing could bridge the old
    # revisions to a rebuilt snapshot, but it made retention buy nothing.
    #
    # The floor is what the **previous manifest advertised**, because that is
    # what retention protects: a client reading it ten minutes ago is fetching
    # from that generation and those delta files. Not the ledger — it remembers
    # generations that were published but never advertised (a rotation killed
    # between the rename and the manifest write leaves one), and treating such a
    # generation as the previous one drops the deltas that carry clients out of
    # the generation they actually downloaded.
    #
    # The exception is a republish of the generation *already* being served, a
    # resume among them: `snapshot.rev` is then this revision, and reading the
    # floor from it collapsed retention to one generation — every retained delta
    # dropped and the previous generation deleted in the same operation. The
    # previous manifest's own delta list is where its floor is recorded, so that
    # is where it comes from in that case, and for a manifest written before
    # `snapshot.rev` existed (D-055).
    starts = [int(entry["from"]) for entry in previous.get("deltas", ())]
    previous_floor = min(starts) if starts else None
    advertised = (previous.get("snapshot") or {}).get("rev")
    if advertised is None and previous_floor is None:
        # A manifest written before `snapshot.rev` existed (D-055). It carries no
        # deltas either — that field went in with the same entry — so its
        # top-level `rev` *is* its snapshot's, which is the fallback `head_rev`
        # and `ledger._seed` already use. Without it the floor became this
        # revision and the rotation deleted the generation the live manifest was
        # still naming, on the one publish where that manifest is the only thing
        # a mid-download client has.
        advertised = previous.get("rev")
    if advertised is not None and int(advertised) != int(rev):
        floor = int(advertised)
    elif previous_floor is not None:
        floor = previous_floor
    else:
        floor = int(rev)
    kept = retained_deltas(previous, pub_dir, rev, floor)

    manifest = {
        "format": FORMAT_VERSION,
        "schema": int(meta.get("schema", 1)),
        "rev": rev,
        # `max` for the same reason `register_delta` uses it: a retained delta
        # is newer than the snapshot it chains from, so taking the build time
        # unconditionally would advertise the origin as staler than it is.
        "generated": max(
            int(meta.get("generated", time.time())), int(previous.get("generated", 0))
        ),
        "notice": meta.get("notice", ""),
        "snapshot": {
            "path": f"snapshot-{rev}",
            "rev": rev,
            "raw_bytes": total,
            "chunk_bytes": CHUNK_BYTES,
            "chunks": chunks,
        },
        "deltas": kept,
    }
    # `rev` is the head revision, which a retained delta can put above the
    # snapshot's own (D-055).
    manifest["rev"] = manifest_module.head_rev(manifest)
    # The ledger first: the chunks are already served by the rename above, so
    # what is not yet recorded is already reachable — and if the manifest is
    # written first and this is not, the data plane advertises a revision the
    # ledger has never heard of, which is a state the guards above cannot tell
    # from a wrong-ancestor publish.
    ledger.record_snapshot(pub_dir, rev, len(chunks), token, candidate, artifact_digest)
    manifest_module.save(pub_dir, manifest)

    # Retention runs last, and only after the manifest no longer names any of
    # it (D-042). What goes is every generation below the floor — one nobody
    # has been offered since the last rotation — together with the deltas that
    # only served clients older than the oldest of them.
    #
    # With **no previous manifest there is no evidence about what was
    # advertised**, and retention is defined by that evidence, so it retires
    # nothing rather than falling back to the most destructive reading. A lost
    # `manifest.json` is a plausible recovery step; treating it as "everything
    # below this revision is unreachable" deleted both generations and the whole
    # catch-up chain at the moment the pipeline knew least.
    if previous:
        removed = retire(pub_dir, rev, floor, previous_floor)
    else:
        removed = {"generations": [], "deltas": [], "unplaced": [], "unremovable": []}

    compressed = sum(c["bytes"] for c in chunks)
    return {
        "rev": rev,
        "chunks": len(chunks),
        "raw_bytes": total,
        "compressed_bytes": compressed,
        "ratio": round(total / compressed, 2) if compressed else 0,
        "seconds": round(elapsed, 1),
        "deltas_kept": len(kept),
        "retired": removed,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("db")
    parser.add_argument("pub_dir")
    parser.add_argument("--quality", type=int, default=10)
    parser.add_argument("--jobs", type=int, default=min(24, (os.cpu_count() or 4)))
    parser.add_argument(
        "--force",
        action="store_true",
        help="Replace an already-published generation (local iteration only; "
        "published generations are immutable, D-047).",
    )
    parser.add_argument(
        "--new-id-space",
        action="store_true",
        help="Publish an artifact whose interned ids come from a different "
        "lineage than everything already published (D-056). Needs a revision "
        "above the published head; retires every delta; every client "
        "re-downloads.",
    )
    parser.add_argument(
        "--adopt-id-space",
        action="store_true",
        help="Record this artifact's ID space as the data plane's, for an "
        "origin published before D-056 recorded one. Only correct when the "
        "build was seeded from the live artifact.",
    )
    args = parser.parse_args()

    os.makedirs(args.pub_dir, mode=0o755, exist_ok=True)
    os.chmod(args.pub_dir, 0o755)
    print(
        json.dumps(
            publish(
                args.db,
                args.pub_dir,
                args.quality,
                args.jobs,
                args.force,
                args.new_id_space,
                args.adopt_id_space,
            ),
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
