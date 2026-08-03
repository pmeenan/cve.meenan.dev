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


def idspace(pub_dir: str) -> str:
    """The ID space every published artifact here belongs to, or `""`.

    Interned ids only mean something relative to the lineage that assigned them
    (D-056), and nothing in the published contract carries that lineage — the
    client learns ids from the snapshot it downloaded and from the deltas it
    applied, and cannot tell a renumbered ID space from a correct one except by
    the `cve` tripwire, which covers records and not lookups. So the check lives
    here, where a mismatch is still fixable.

    `""` means **unknown**, not unconstrained: the manifest carries no lineage,
    so a ledger seeded from one (the data plane published before D-056) starts
    here. `anything_published` is what tells the two apart — see
    `assert_idspace`.
    """
    return str(load(pub_dir).get("idspace") or "")


def anything_published(pub_dir: str) -> bool:
    """Whether this data plane has ever served an artifact."""
    ledger = load(pub_dir)
    return bool(ledger["snapshots"] or ledger["deltas"])


def assert_idspace(pub_dir: str, token: str, *, adopt: bool = False) -> None:
    """Refuse an artifact whose ID space is not this data plane's (D-056).

    The two failure modes are different and only one of them is loud. A *known*
    mismatch is a lineage change, refused unless it is declared. An *unknown*
    lineage over an existing data plane is the migration window — the live
    generation was published before any of this was recorded — and adopting
    silently there would bless whatever arrives, including an unseeded rebuild
    that renumbered every deployed client. Adoption over published artifacts is
    therefore an explicit act; over an empty directory there is nothing to
    contradict, so it is not.
    """
    if not token:
        raise SystemExit(
            "error: this artifact records no ID space; rebuild it with --seed or "
            "--bootstrap (D-056), because an unrecorded lineage cannot be checked "
            "against what clients already hold"
        )
    known = idspace(pub_dir)
    if known and known != token:
        raise SystemExit(
            f"error: this artifact's ids come from ID space {token}, but everything published "
            f"here belongs to {known}; a delta between two ID spaces installs rows under ids "
            "that mean something else, and a snapshot renumbers every client's rows silently. "
            "Rebuild seeded from the artifact this data plane was last published from."
        )
    if not known and anything_published(pub_dir) and not adopt:
        raise SystemExit(
            "error: this data plane was published before ID spaces were recorded, so nothing "
            "here can confirm that this artifact continues it. Build it seeded from the live "
            "artifact and pass --adopt-id-space once; a bootstrap would renumber every "
            "client that has already downloaded."
        )


def space_at(pub_dir: str, rev: int) -> dict | None:
    """The ID space of the artifact published at a revision, if recorded.

    Revisions are reached by snapshots *and* by deltas, so this is keyed by
    revision rather than kept beside either. `None` means "not recorded" — the
    data plane predates this — and is not an assertion that nothing was.
    """
    return load(pub_dir).get("space", {}).get(str(int(rev)))


def anything_recorded(pub_dir: str) -> bool:
    """Whether this data plane records the ID space of anything it published.

    False for the generation published before D-056, which is the only state in
    which a missing record is an absence rather than a gap.
    """
    return bool(load(pub_dir).get("space"))


def assert_continues(pub_dir: str, space: dict) -> None:
    """Refuse an artifact grown from an ancestor this data plane never served.

    `seed_rev` alone cannot see it: two builds can be stamped at one revision
    while minting different values at the same ids, they inherit the same
    lineage token, and only one of them was published. Nor can their extent —
    two siblings can mint the same *number* of rows and disagree about what each
    id means. The fingerprint is the whole assignment, so it separates them.

    Fails **closed** on a missing record once this data plane records any: a
    revision whose ID space was never written down is a gap (a run that died
    between publishing and recording), and treating a gap as "nothing to check"
    let a descendant of the wrong sibling through the one check that could see
    it.
    """
    if space.get("seed_rev") is None or space.get("seed_fingerprint") is None:
        return
    published = space_at(pub_dir, space["seed_rev"])
    if published is None or published.get("fingerprint") is None:
        if anything_recorded(pub_dir):
            raise SystemExit(
                f"error: this artifact continues rev {space['seed_rev']}, but this data plane "
                "has no record of the ID space it published there — so nothing can confirm "
                "the two are the same. Re-run the publication that minted that revision "
                "before building on it."
            )
        return
    if published["fingerprint"] != space["seed_fingerprint"]:
        raise SystemExit(
            f"error: this artifact continues rev {space['seed_rev']}, but not the artifact "
            "published there — the ID space it grew from is a different one, so ids minted "
            "since mean different values on every client. Reseed from the artifact this data "
            "plane actually published."
        )


def highest_published(pub_dir: str) -> int:
    """The newest revision a client here could be sitting at.

    Snapshot revisions *and* every delta's `to`: a client that applied a delta
    is at its end, and the manifest is not the authority — it forgets a rotated
    generation, and it can be missing entirely while the ledger is not.
    """
    ledger = load(pub_dir)
    revisions = [int(rev) for rev in ledger["snapshots"]]
    revisions += [int(name.split(".", 1)[0].split("-")[1]) for name in ledger["deltas"]]
    return max(revisions) if revisions else 0


def highest_snapshot(pub_dir: str) -> int:
    revisions = [int(rev) for rev in load(pub_dir)["snapshots"]]
    return max(revisions) if revisions else 0


def snapshot_published(pub_dir: str, rev: int) -> bool:
    return str(int(rev)) in load(pub_dir)["snapshots"]


def delta_published(pub_dir: str, entry: dict) -> dict | None:
    """What was published for this range, if anything ever was."""
    return load(pub_dir)["deltas"].get(manifest_module.delta_name(entry))


def _record_space(ledger: dict, rev: int, space: dict) -> None:
    """Pin a revision's ID space, once and for all.

    What an id *means* at a published revision is as immutable as the bytes at
    its URL, and for the same reason: clients hold it. Overwriting the record
    let a sibling artifact republished at head redefine the revision's ids and
    then have its own descendants accepted — the check comparing against it
    still passed, because the thing it compared against had moved.
    """
    recorded = ledger.setdefault("space", {}).get(str(int(rev)))
    if recorded is not None and recorded != space:
        raise SystemExit(
            f"error: rev {rev} was published with a different ID space "
            f"(fingerprint {recorded.get('fingerprint')}, now {space.get('fingerprint')}); "
            "what an id means at a published revision cannot be rewritten, because clients "
            "already hold it"
        )
    ledger["space"][str(int(rev))] = space


def record_snapshot(pub_dir: str, rev: int, chunks: int, token: str, space: dict) -> None:
    """One write, because it is one event.

    The lineage used to land in a second `save` after this one, and a crash in
    between left the manifest serving a new ID space while the ledger still
    named the old — after which a delta from the *retired* space was accepted,
    since it matched what the ledger said.
    """
    ledger = load(pub_dir)
    ledger["snapshots"][str(int(rev))] = {"chunks": int(chunks)}
    ledger["idspace"] = str(token)
    _record_space(ledger, rev, space)
    save(pub_dir, ledger)


def record_delta(pub_dir: str, entry: dict, space: dict | None = None) -> None:
    """Deltas record what they published, and the ID-space extent at the
    revision they reach — but never the lineage: a delta cannot prove which ID
    space the snapshot its clients downloaded belongs to (`assert_idspace`)."""
    ledger = load(pub_dir)
    ledger["deltas"][manifest_module.delta_name(entry)] = {
        "sha256": entry["sha256"],
        "bytes": entry["bytes"],
    }
    if space is not None:
        _record_space(ledger, int(entry["to"]), space)
    save(pub_dir, ledger)
