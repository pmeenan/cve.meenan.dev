"""The record of what has ever been published, and at which bytes.

Every artifact URL under `/data/` is immutable (D-034, D-047): once a client
could have fetched it, it must never return different bytes. The manifest
cannot enforce that, because the manifest only describes the *current*
generation — retention removes old delta entries and deletes their files, and
after that nothing on disk remembers the URL existed. Two reviews found the
same shape of bug through that gap: an older snapshot revision republished over
a rotated-away generation, and a retired delta range rewritten with different
content at the URL it already had.

So this is a separate, append-only ledger, and it is deliberately **not** in
`pub_dir`: it lives beside it (`cve.pub/published.json` next to `cve.pub/data/`),
where nginx has no location that reaches it (D-053). It is pipeline state, not
part of the published contract, and the client never sees it.

Seeded from the manifest on first use, so a data plane published before this
existed is covered from its next publish rather than from a clean slate.
"""

from __future__ import annotations

import json
import os

import manifest as manifest_module


def path(pub_dir: str) -> str:
    """A sibling of the published directory, never under it."""
    return os.path.join(os.path.dirname(os.path.abspath(pub_dir)), "published.json")


def _seed(pub_dir: str) -> dict:
    """What the current manifest proves was published, for a first run."""
    ledger = {"snapshots": {}, "deltas": {}}
    manifest = manifest_module.load(pub_dir)
    if manifest is None:
        return ledger
    snapshot = manifest.get("snapshot") or {}
    rev = snapshot.get("rev", manifest.get("rev"))
    if rev is not None:
        ledger["snapshots"][str(int(rev))] = {"chunks": len(snapshot.get("chunks", []))}
    for entry in manifest.get("deltas", []):
        ledger["deltas"][manifest_module.delta_name(entry)] = {
            "sha256": entry.get("sha256"),
            "bytes": entry.get("bytes"),
        }
    return ledger


def load(pub_dir: str) -> dict:
    try:
        with open(path(pub_dir), encoding="utf-8") as handle:
            ledger = json.load(handle)
    except FileNotFoundError:
        return _seed(pub_dir)
    ledger.setdefault("snapshots", {})
    ledger.setdefault("deltas", {})
    return ledger


def save(pub_dir: str, ledger: dict) -> None:
    target = path(pub_dir)
    scratch = f"{target}.{os.getpid()}.tmp"
    with open(scratch, "w", encoding="utf-8") as handle:
        json.dump(ledger, handle, indent=2, sort_keys=True)
    os.replace(scratch, target)


def highest_snapshot(pub_dir: str) -> int:
    revisions = [int(rev) for rev in load(pub_dir)["snapshots"]]
    return max(revisions) if revisions else 0


def snapshot_published(pub_dir: str, rev: int) -> bool:
    return str(int(rev)) in load(pub_dir)["snapshots"]


def delta_published(pub_dir: str, entry: dict) -> dict | None:
    """What was published for this range, if anything ever was."""
    return load(pub_dir)["deltas"].get(manifest_module.delta_name(entry))


def record_snapshot(pub_dir: str, rev: int, chunks: int) -> None:
    ledger = load(pub_dir)
    ledger["snapshots"][str(int(rev))] = {"chunks": int(chunks)}
    save(pub_dir, ledger)


def record_delta(pub_dir: str, entry: dict) -> None:
    ledger = load(pub_dir)
    ledger["deltas"][manifest_module.delta_name(entry)] = {
        "sha256": entry["sha256"],
        "bytes": entry["bytes"],
    }
    save(pub_dir, ledger)
