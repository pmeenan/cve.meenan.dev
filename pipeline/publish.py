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
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import shutil
import subprocess
import sqlite3
import tempfile
import time

import ledger
import manifest as manifest_module

CHUNK_BYTES = 32 * 1024 * 1024
FORMAT_VERSION = 1


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_meta(db_path: str) -> dict:
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        return dict(db.execute("SELECT k, v FROM meta"))
    finally:
        db.close()


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


def publish(db_path: str, pub_dir: str, quality: int, jobs: int, force: bool = False) -> dict:
    compress_chunk.quality = quality
    meta = read_meta(db_path)
    rev = int(meta.get("rev", 1))
    total = os.path.getsize(db_path)

    # D-008 is a condition of the grant, and this is the largest copy of CVE
    # data we publish. `delta.extract` refuses an artifact with no notice; this
    # refused nothing at all, which is the asymmetry that matters.
    if not str(meta.get("notice") or "").strip():
        raise SystemExit(f"error: {db_path} carries no MITRE notice (D-008); refusing to publish")

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
        ledger.highest_snapshot(pub_dir),
    )
    staging = os.path.join(pub_dir, f".staging-{rev}")
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

    # D-047: a published generation is immutable — its URLs carry an immutable
    # cache policy (D-034), so rewriting one serves stale-vs-new mixes from
    # caches. Same-rev republish is therefore refused; --force (local iteration
    # only) swaps via rename, which is brief but *not* atomic — there is no
    # portable directory swap — so a client fetching a chunk in that instant
    # gets a 404 and retries.
    retired = None
    if not force:
        # Revisions only move forward. Deleting a retired generation's directory
        # used to be enough to let an *older* artifact be republished, which
        # rolled the manifest backwards — clients that had already synced past
        # it then see an origin behind their own watermark, and the reused
        # `snapshot-<rev>` URLs serve different bytes under an immutable cache
        # policy. `rev == published_head` stays legal: that is the monthly
        # rebuild landing at the revision the deltas have already reached.
        if rev < published_head:
            shutil.rmtree(staging)
            raise SystemExit(
                f"error: the data plane is at rev {published_head}; publishing rev {rev} "
                "would roll it backwards"
            )
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

    # Which deltas survive into the new manifest: those that still have a file
    # *and* start at or after this snapshot's revision.
    #
    # The second half is the one that was missing. A delta below the new
    # snapshot's revision belongs to the generation this one replaces, and no
    # client can use it: a chain has to reach head, and nothing bridges the old
    # revisions to the new snapshot. Keeping such entries left clients with a
    # manifest advertising a catch-up path that `planSync` correctly refuses —
    # and, when one of their files had been retired, a *freshly downloaded*
    # client with no chain out of its own snapshot, re-downloading forever.
    kept = [
        entry
        for entry in previous.get("deltas", [])
        if int(entry["from"]) >= rev
        and os.path.exists(os.path.join(pub_dir, "deltas", manifest_module.delta_name(entry)))
    ]

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
    manifest_module.save(pub_dir, manifest)
    ledger.record_snapshot(pub_dir, rev, len(chunks))

    compressed = sum(c["bytes"] for c in chunks)
    return {
        "rev": rev,
        "chunks": len(chunks),
        "raw_bytes": total,
        "compressed_bytes": compressed,
        "ratio": round(total / compressed, 2) if compressed else 0,
        "seconds": round(elapsed, 1),
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
    args = parser.parse_args()

    os.makedirs(args.pub_dir, mode=0o755, exist_ok=True)
    os.chmod(args.pub_dir, 0o755)
    print(
        json.dumps(publish(args.db, args.pub_dir, args.quality, args.jobs, args.force), indent=2)
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
