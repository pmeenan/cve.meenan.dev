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


def publish(db_path: str, pub_dir: str, quality: int, jobs: int) -> dict:
    compress_chunk.quality = quality
    meta = read_meta(db_path)
    rev = int(meta.get("rev", 1))
    total = os.path.getsize(db_path)

    staging = os.path.join(pub_dir, f".staging-{rev}")
    final = os.path.join(pub_dir, f"snapshot-{rev}")
    shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(staging, exist_ok=True)

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

    # Atomic swap: build under a dot-prefixed name, then rename into place.
    if os.path.exists(final):
        shutil.rmtree(final)
    os.rename(staging, final)

    manifest = {
        "format": FORMAT_VERSION,
        "schema": int(meta.get("schema", 1)),
        "rev": rev,
        "generated": int(meta.get("generated", time.time())),
        "notice": meta.get("notice", ""),
        "snapshot": {
            "path": f"snapshot-{rev}",
            "raw_bytes": total,
            "chunk_bytes": CHUNK_BYTES,
            "chunks": chunks,
        },
        "deltas": [],
    }

    manifest_path = os.path.join(pub_dir, "manifest.json")
    tmp_manifest = manifest_path + ".tmp"
    with open(tmp_manifest, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
    os.replace(tmp_manifest, manifest_path)

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
    args = parser.parse_args()

    os.makedirs(args.pub_dir, exist_ok=True)
    print(json.dumps(publish(args.db, args.pub_dir, args.quality, args.jobs), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
