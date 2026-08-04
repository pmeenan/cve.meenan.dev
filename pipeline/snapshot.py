"""The monthly snapshot: publish the artifact the head revision was cut from.

    python3 pipeline/snapshot.py <pub-dir> --state <state-dir> [--dry-run]

D-042 describes this job as "rebuild the database, chunk it, compress the chunks
in parallel, publish, then retire the previous generation". **The rebuild is
already done.** The daily ingest walks the whole corpus and writes a complete
artifact every time it runs (D-058) — the delta is only the wire file it emits
afterwards — so there is a fresh, full rebuild sitting in the state's artifacts
directory. Building a second one here would cost another 24.2 s (D-058) to
produce a different file with the same content, and it is the *difference* that
is dangerous: see below.

So this job is the other four verbs. It takes D-042's `flock`, finishes any
crashed ingest, and publishes the artifact `ingest.py` last built — at the
revision that artifact is stamped with, which must be the published head —
after which `publish.py` retains the previous generation and its deltas and
deletes what falls out the far end (D-060).

**Landing at head is what makes this safe, and publishing the ingest's own
artifact is what makes landing at head honest.** A snapshot at the head
revision asks nothing of anyone: every synced client is already at that
watermark, `planSync` returns "already current", and not one byte of the new
generation is ever fetched by them. Publishing *different* content there would
therefore reach only new arrivals, silently and permanently — the hazard D-056
recorded and left open. Publishing the artifact head was cut from cannot do
that, and `publish.py` checks rather than trusts it: the ledger records the
digest of the artifact behind each revision, and a snapshot at head must match
it.

What this job deliberately does **not** do:

  * **fetch or build.** A monthly job that fetched could abort on the tombstone
    guard, and then a month would pass with no new generation — a failure in
    the freshness path taking out the rotation path with it. Its output is as
    fresh as the head is, which is what the manifest already advertises.
  * **mint a revision.** Nothing changed, so there is nothing to mint (D-031).
    A rebuild that genuinely changes content — a normalization change, a schema
    bump — is a different, manual operation: it lands *above* head, every
    client re-downloads, and `pipeline/README.md` carries the sequence.

Exit codes: 0 published, nothing to do, or the lock was held; 1 aborted.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

import build
import delta
import ingest
import ledger
import manifest as manifest_module
import publish as publish_module
import state as state_module

from ingest import Abort, EXIT_OK

QUALITY = 10

# How long the rotation waits for the daily to finish rather than skipping a
# month (D-060). Bounded, because a cron job that blocks forever on a wedged
# process is worse than one that gives up: fifteen minutes covers a ~55 s daily
# run many times over, and anything longer is a problem the *daily's* own
# outcome record already reports.
LOCK_WAIT = 900.0


def _cycle(
    state: state_module.State,
    pub_dir: str,
    summary: dict,
    *,
    quality: int,
    jobs: int,
    dry_run: bool,
) -> dict:
    """One monthly cycle, with the lock held and the state open."""
    if not state.initialized:
        raise Abort(
            f"{state.path} describes no revision yet. Run `ingest.py init` against the "
            "artifact this data plane was published from before rotating it"
        )

    # A crashed ingest is finished here rather than waited out. The alternative
    # — refuse and tell the operator to run the daily — costs a month, because
    # that is when this job next runs; and `resume` is the same call under the
    # same lock that the daily would make.
    if state.pending is not None:
        if dry_run:
            # Report what can be read without finishing the pending run, rather
            # than only that there is one: a dry run is how an operator asks
            # "would the rotation work?", and a crashed daily is exactly when
            # they ask. What it cannot answer is the head — that is what
            # finishing the pending run decides.
            published = manifest_module.load(pub_dir)
            summary["pending"] = state.pending["rev"]
            summary["state_rev"] = state.rev
            summary["artifact"] = state.artifact
            summary["head"] = manifest_module.head_rev(published) if published else None
            summary["result"] = (
                "pending run; --dry-run changes nothing. A real run finishes it first, and "
                "the head it lands on is decided by that"
            )
            return summary
        summary["resumed"] = ingest.resume(state, pub_dir, delta.QUALITY)
        print(json.dumps({"resumed": summary["resumed"]}), file=sys.stderr)

    head = ingest.published_head(pub_dir)
    if head != state.rev:
        raise Abort(
            f"the data plane is at rev {head} but the ingest state describes rev "
            f"{state.rev}. Something else advanced the head; re-point the state at what "
            "was published before rotating the generation"
        )
    summary["head"] = head

    manifest = manifest_module.load(pub_dir) or {}
    current = (manifest.get("snapshot") or {}).get("rev")
    if current is not None and int(current) == head:
        # The generation already *is* the head, so a rotation would republish
        # identical bytes at the same URLs for no reader. This is the ordinary
        # outcome of a quiet month, not a failure.
        summary["result"] = "snapshot already at head"
        summary["snapshot_rev"] = head
        return summary

    artifact = state.artifact
    if not os.path.exists(artifact):
        raise Abort(
            f"the artifact rev {head} was built from is gone ({artifact}); this job publishes "
            "the corpus behind the head revision, and nothing else can stand in for it"
        )
    # Cheap, and it is the assumption everything below rests on: a state
    # pointing at some other build would publish that build's content at head.
    # `publish.py` compares the file against the ledger's record too — this one
    # names the problem before 100 s of compression.
    stamped = int(build.id_space(artifact)["rev"])
    if stamped != head:
        raise Abort(
            f"{artifact} is stamped rev {stamped}, but the state says the head it describes is "
            f"{head}; publishing it would put one revision's content at another's"
        )
    summary["artifact"] = artifact

    # Asked here as well as in `publish.py`, so a dry run answers it and a real
    # run does not spend 100 s of compression to find out. It is the expected
    # state exactly once — on a data plane that published its head before D-060
    # recorded artifacts — and one daily run that mints a revision clears it.
    recorded = ledger.artifact_at(pub_dir, head)
    if recorded is None:
        raise Abort(
            f"nothing records which artifact rev {head}'s content came from, so a snapshot "
            "landing there cannot be shown to be what synced clients already hold (D-060) — "
            "and they are never told to re-fetch it. Let one daily run publish a delta, which "
            "records it, and rotate after that."
        )
    # Compared, not merely present. Checking only for the record answered a
    # different question than the one a dry run is asked: a state pointing at a
    # same-revision sibling reported "dry run; nothing published" with a
    # `would_publish` block, and the real run then refused it. 0.18 s.
    digest = build.digest_file(artifact)
    if digest != recorded:
        raise Abort(
            f"rev {head}'s content came from artifact {recorded}, but the state points at "
            f"{artifact}, which is {digest}. Publishing it would put content at head that no "
            "synced client is ever told to fetch; re-point the state at the artifact this "
            "revision was built from"
        )

    if dry_run:
        summary["result"] = "dry run; nothing published"
        summary["would_publish"] = {"rev": head, "artifact": artifact, "replaces": current}
        return summary

    started = time.time()
    published = publish_module.publish(artifact, pub_dir, quality=quality, jobs=jobs)
    summary["result"] = "published"
    summary["snapshot"] = published
    summary["seconds"] = round(time.time() - started, 1)
    return summary


def run(
    pub_dir: str,
    state_dir: str,
    *,
    quality: int = QUALITY,
    jobs: int | None = None,
    dry_run: bool = False,
    lock_wait: float = LOCK_WAIT,
) -> dict:
    jobs = jobs or min(24, (os.cpu_count() or 4))
    summary: dict = {"action": "snapshot", "started": int(time.time())}

    with state_module.lock(state_dir, wait=lock_wait):
        with state_module.State(os.path.join(state_dir, state_module.STATE_NAME)) as state:
            try:
                report = _cycle(
                    state, pub_dir, summary, quality=quality, jobs=jobs, dry_run=dry_run
                )
            except BaseException as failure:
                # Recorded under the lock, for the same reason the daily does it
                # (D-058): this machine has no MTA and D-009 forbids telemetry,
                # so `ingest.py status` is the only alerting there is — and a
                # monthly failure is the one that most needs to be findable,
                # because the next attempt is a month away.
                if state.initialized and not dry_run:
                    state.record_outcome(False, f"{type(failure).__name__}: {failure}", "snapshot")
                raise
            if not dry_run:
                state.record_outcome(True, "", "snapshot")
            return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pub_dir")
    parser.add_argument("--state", required=True, help="Directory holding the ingest state.")
    parser.add_argument("--quality", type=int, default=QUALITY)
    parser.add_argument("--jobs", type=int, default=None)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would be published without publishing it or touching state.",
    )
    parser.add_argument(
        "--lock-wait",
        type=float,
        default=LOCK_WAIT,
        help="Seconds to wait for the pipeline lock before giving up (default "
        f"{LOCK_WAIT:.0f}). Unlike the daily, this job loses a month by skipping "
        "and nothing by waiting for one to finish.",
    )
    args = parser.parse_args()

    try:
        report = run(
            args.pub_dir,
            args.state,
            quality=args.quality,
            jobs=args.jobs,
            dry_run=args.dry_run,
            lock_wait=args.lock_wait,
        )
    except state_module.Busy as busy:
        # Only after waiting `LOCK_WAIT` for it, so this is not "the daily is
        # running" — that resolves in about a minute — but something holding the
        # lock for a quarter of an hour. Nothing was published, and the next
        # attempt is a month away, so say so loudly: this is the one outcome
        # this job cannot record, because recording it needs the lock.
        print(f"skipped: {busy}", file=sys.stderr)
        return EXIT_OK
    except Abort as abort:
        print(f"error: {abort}", file=sys.stderr)
        return abort.code

    print(json.dumps(report, indent=2))
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
