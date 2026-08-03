"""The published manifest — the one mutable file in the data plane (D-034).

Both writers go through here: `publish.py` when a snapshot generation lands and
`delta.py` when a delta file does. One definition of the file's shape, one
atomic write, and one place that decides what `rev` means.

`rev` is the *head* revision — the newest state the data plane can bring a
client to, which is the last delta's `to`, or the snapshot's own revision when
no delta has been published since (D-055). `snapshot.rev` is the snapshot's,
and the two are equal only until the first delta lands.

Writes assume the caller holds D-042's `flock`: `register_delta` is a
read-modify-write, and two concurrent runs would lose an entry.
"""

from __future__ import annotations

import json
import os

FORMAT_VERSION = 1


def path(pub_dir: str) -> str:
    return os.path.join(pub_dir, "manifest.json")


def load(pub_dir: str) -> dict | None:
    try:
        with open(path(pub_dir), encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return None


def assert_tiling(manifest: dict) -> None:
    """Refuse a manifest that could strand a client at some watermark.

    architecture.md states the invariant — delta files must tile the revision
    space, or a client finds no covering chain and can never sync again — and
    nothing enforced it. One ingest run that mints a revision without
    publishing its delta (D-042's tombstone guard aborting mid-run is a
    plausible way) leaves a hole, and every client re-downloads the corpus,
    lands back where it started, and does it again tomorrow.

    The property checked is reachability in both directions: every revision a
    client can be sitting at — the snapshot's, and every delta's `to` — must
    have a chain forward to head, and every delta must start from a revision a
    client can actually be at. The advertised `rev` must also *be* that head:
    a manifest claiming rev 999 over a 1→2 chain (or over no deltas at all)
    tells every client to reach a revision nothing can deliver. Fail closed
    (D-047): the manifest is not written.
    """
    deltas = manifest.get("deltas") or []
    head = head_rev(manifest)
    advertised = int(manifest.get("rev", head))
    if advertised != head:
        raise SystemExit(
            f"error: manifest advertises rev {advertised} but its snapshot and deltas reach "
            f"{head}; no client could ever get there"
        )
    if not deltas:
        return

    snapshot_rev = int((manifest.get("snapshot") or {}).get("rev", manifest.get("rev", 1)))
    edges: dict[int, set[int]] = {}
    for entry in deltas:
        start, end = int(entry["from"]), int(entry["to"])
        if end <= start:
            raise SystemExit(f"error: delta {start}-{end} does not advance the revision")
        edges.setdefault(start, set()).add(end)

    forward = {snapshot_rev}
    queue = [snapshot_rev]
    while queue:
        at = queue.pop()
        for nxt in edges.get(at, ()):
            if nxt not in forward:
                forward.add(nxt)
                queue.append(nxt)

    orphans = sorted({int(e["from"]) for e in deltas} - forward)
    if orphans:
        raise SystemExit(
            f"error: deltas starting at {orphans} are unreachable from snapshot rev "
            f"{snapshot_rev}; a client can never use them"
        )
    # Walk backwards from head to find every revision that can still get there.
    reaches_head = {head}
    changed = True
    while changed:
        changed = False
        for entry in deltas:
            start, end = int(entry["from"]), int(entry["to"])
            if end in reaches_head and start not in reaches_head:
                reaches_head.add(start)
                changed = True
    stranded = sorted(forward - reaches_head)
    if stranded:
        raise SystemExit(
            f"error: a client at rev {stranded} has no chain to head {head}; the delta "
            "files do not tile the revision space"
        )


def save(pub_dir: str, manifest: dict) -> None:
    """Write the manifest atomically: readers see the old file or the new one.

    Never a partial one -- it is fetched with `no-cache`, so a client can read
    it at any instant, including this one.
    """
    assert_tiling(manifest)
    target = path(pub_dir)
    # pid-qualified: a fixed name lets a second process delete the scratch file
    # this one is about to rename.
    scratch = f"{target}.{os.getpid()}.tmp"
    with open(scratch, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
    os.chmod(scratch, 0o644)
    os.replace(scratch, target)


def head_rev(manifest: dict) -> int:
    """The newest revision this manifest can carry a client to."""
    snapshot = manifest.get("snapshot") or {}
    revisions = [int(snapshot.get("rev", manifest.get("rev", 1)))]
    revisions += [int(delta["to"]) for delta in manifest.get("deltas", [])]
    return max(revisions)


def delta_name(entry: dict) -> str:
    """The published file name. The client derives the same string from the
    same two numbers rather than reading one out of the manifest (D-055)."""
    return f"{int(entry['from'])}-{int(entry['to'])}.json.br"


def lists_delta(pub_dir: str, entry: dict) -> bool:
    """Whether this range is *published* — which the manifest decides, not the
    filesystem. Retention deletes delta files (D-042); a deleted file is still
    a published URL that caches may hold for a year (D-034)."""
    manifest = load(pub_dir) or {}
    wanted = (int(entry["from"]), int(entry["to"]))
    return any(
        (int(existing["from"]), int(existing["to"])) == wanted
        for existing in manifest.get("deltas", [])
    )


def register_delta(pub_dir: str, entry: dict, generated: int) -> dict:
    """Add a published delta to the manifest and advance the head revision.

    Called after the file itself is in place, so the manifest never names a
    file that is not there. Re-registering the same range replaces its entry
    rather than duplicating it, which is what makes a re-run of an interrupted
    ingest converge instead of corrupting the list.
    """
    manifest = load(pub_dir)
    if manifest is None:
        raise SystemExit(f"error: no manifest in {pub_dir}; publish a snapshot first")

    deltas = [
        existing
        for existing in manifest.get("deltas", [])
        if (int(existing["from"]), int(existing["to"])) != (int(entry["from"]), int(entry["to"]))
    ]
    deltas.append(entry)
    deltas.sort(key=lambda item: (int(item["from"]), int(item["to"])))

    manifest["deltas"] = deltas
    manifest["rev"] = head_rev(manifest)
    # The manifest's own freshness is the data plane's, which the delta just
    # advanced; the client's staleness indicator reads its *local* copy's from
    # the database (D-031), and these two disagreeing is exactly the gap the
    # indicator exists to show. `max` because re-registering an older delta
    # must not make the origin look staler than it is.
    manifest["generated"] = max(int(manifest.get("generated", 0)), int(generated))
    save(pub_dir, manifest)
    return manifest
