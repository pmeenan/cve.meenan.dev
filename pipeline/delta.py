"""Emit one delta file for the published wire contract (D-031, D-055).

    python3 pipeline/delta.py <artifact.sqlite> <pub-dir> <changeset.json>

The changeset is what the daily ingest computes (M2) and what this module
serializes:

    {"from": 12, "to": 13,
     "upsert": ["CVE-2026-14537"],
     "delete": ["CVE-2026-9999"],
     "floors": {"cna": 372, "cwe": 798, "vendor": 24420, "product": 80148,
                "host": 9145, "url": 1204882, "vtype": 6},
     "extra":  {"cwe": [798]}}

The numbers in that example are illustrative, not measured -- the real
cardinalities are in D-024 and D-033, and the floors a run actually uses come
from `build.id_space(artifact)["floors"]`.

`floors` is the highest id each lookup table had *issued* at revision `from` --
which is not the highest it still holds, because a value the corpus stops using
is retired while its id stays reserved (D-056). Because the ID space is
server-owned, append-only and never renumbered (D-025 hazard 1), "the lookup
rows a client at `from` does not have" is exactly "the rows above those floors"
-- so D-031's range query needs no per-row revision column, only one integer per
table per revision. `extra` covers the case floors cannot see: a row whose
*content* changed under an id the client already holds.

Every table must appear: a missing floor would default to 0 and quietly ship
the entire table (measured at 164x the compressed bytes on a 20,000-record
corpus), and an unknown key is a typo whose rows then never ship at all.

Two invariants are enforced here rather than left to the client, because a
delta that violates either is a pipeline bug and the client's only remedy would
be a 63 MB re-download (D-047, fail closed):

  * every lookup id an upsert references either exists in the artifact and sits
    at or below its floor, or ships in this delta;
  * every CVE ID in `upsert` is actually in the artifact.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import tempfile
import time

import build
import ledger
import manifest as manifest_module

FORMAT_VERSION = 1
QUALITY = 5

# Bounds the client also enforces (`lib/delta.ts`). They are repeated here
# because the client's only remedy is refusing the whole file — and a published
# delta is immutable, so a single out-of-range record would wedge every client's
# sync until the next snapshot. Fail closed on the server, where it is fixable.
MAX_CVE_ID = 64
# JSON numbers are IEEE doubles by the time a browser sees them, so anything
# above 2^53-1 is silently rounded on arrival. SQLite will happily store an
# int64 that big.
MAX_SAFE_INT = 2**53 - 1

# Apply order, and the order the tables are emitted in: `vendor` before
# `product` and `host` before `url`, because those reference them (D-055). One
# definition, in the module that owns the ID space — two copies of a column
# order that has to agree positionally is a bug waiting for a schema change.
LOOKUP_COLUMNS = build.LOOKUP_COLUMNS

# SQLite 3.32+ defaults to 32,766 bound parameters (999 before that, and a
# build can still lower it), so batching is compatibility rather than necessity
# — verified against the local 3.45.1, which binds 40,000 without complaint.
BATCH = 900


def _in_batches(db: sqlite3.Connection, prefix: str, suffix: str, ids: list) -> list:
    """Run `prefix IN (?,?,...) suffix` over an id list, in batches.

    The only thing interpolated into the SQL is a run of `?` placeholders and
    identifiers this module owns -- never a value, and never anything derived
    from record content (AGENTS.md rule 5).
    """
    out = []
    for start in range(0, len(ids), BATCH):
        batch = ids[start : start + BATCH]
        marks = ",".join("?" * len(batch))
        out.extend(db.execute(f"{prefix} ({marks}) {suffix}", batch))
    return out


def _lookup_rows(db: sqlite3.Connection, table: str, floor: int, extra: list[int]) -> list[list]:
    """Rows above the floor, plus any explicitly requested id, ordered by id."""
    columns = ", ".join(LOOKUP_COLUMNS[table])
    rows = {
        row[0]: list(row)
        for row in db.execute(f"SELECT {columns} FROM {table} WHERE id > ?", (floor,))
    }
    wanted = [value for value in extra if value not in rows]
    if wanted:
        for row in _in_batches(db, f"SELECT {columns} FROM {table} WHERE id IN", "", wanted):
            rows[row[0]] = list(row)
        # `extra` exists to re-ship a row whose *content* changed under an id
        # the client already holds. An id that is not in the artifact cannot do
        # that, and dropping it silently leaves the client with stale content
        # and no way to notice — so it is a changeset bug, not a no-op.
        absent = sorted(value for value in wanted if value not in rows)
        if absent:
            raise ValueError(f"changeset asks for {table} row(s) that do not exist: {absent[:5]}")
    return [rows[key] for key in sorted(rows)]


def _record(db: sqlite3.Connection, cve_id: str) -> dict:
    """One whole record, in wire shape. Absent means absent (D-031)."""
    row = db.execute(
        "SELECT id, cve_id, year, state, cna_id, published, updated, "
        "cvss_ver, cvss_score, cvss_sev, cvss_vec, reserved, "
        "ssvc_expl, ssvc_auto, ssvc_impact FROM cve WHERE cve_id = ?",
        (cve_id,),
    ).fetchone()
    if row is None:
        raise ValueError(f"upsert names a record the artifact does not contain: {cve_id!r}")

    (
        rowid,
        canonical,
        year,
        state,
        cna_id,
        published,
        updated,
        cvss_ver,
        cvss_score,
        cvss_sev,
        cvss_vec,
        reserved,
        ssvc_expl,
        ssvc_auto,
        ssvc_impact,
    ) = row

    out: dict = {"id": rowid, "cve": canonical, "y": year, "st": state}
    if cna_id is not None:
        out["cna"] = cna_id
    if published is not None:
        out["pub"] = published
    if updated is not None:
        out["upd"] = updated
    if reserved is not None:
        out["res"] = reserved
    if cvss_ver is not None:
        vector = cvss_vec if isinstance(cvss_vec, str) else ""
        out["cvss"] = [cvss_ver, cvss_score, cvss_sev, vector]
    # One tuple rather than three keys, and present only when *something* was
    # assessed. Inside it a null is a decision point nobody stated, which is not
    # the same as `none` (D-070) — so the nulls are carried rather than dropped.
    if (ssvc_expl, ssvc_auto, ssvc_impact) != (None, None, None):
        out["ssvc"] = [ssvc_expl, ssvc_auto, ssvc_impact]

    text = db.execute(
        "SELECT descr, title, reason FROM cve_text WHERE cve_id = ?", (rowid,)
    ).fetchone()
    if text:
        for key, value in zip(("descr", "title", "reason"), text):
            # An empty string would insert a row that says something different
            # from "this record has no title", so the key is omitted instead —
            # and `lib/delta.ts` refuses an empty one for the same reason.
            if value:
                out[key] = value

    # Ordered so that re-emitting the same changeset produces the same bytes,
    # which is what makes a re-run of an interrupted ingest checkable.
    for key, sql in (
        ("cwe", "SELECT cwe_id FROM cve_cwe WHERE cve_id = ? ORDER BY cwe_id"),
        ("ref", "SELECT url_id FROM cve_ref WHERE cve_id = ? ORDER BY url_id"),
    ):
        values = [row[0] for row in db.execute(sql, (rowid,))]
        if values:
            out[key] = values

    # `prod` carries a pair since schema 2: `cve_prod` gained a column, and a
    # bare id list could no longer reproduce the row.
    products = [
        list(r)
        for r in db.execute(
            "SELECT product_id, default_status FROM cve_prod WHERE cve_id = ? ORDER BY product_id",
            (rowid,),
        )
    ]
    if products:
        out["prod"] = products

    versions = [
        list(r)
        for r in db.execute(
            "SELECT product_id, status, version, lt, lte, vtype FROM cve_ver "
            "WHERE cve_id = ? ORDER BY product_id, status, version, lt, lte, vtype",
            (rowid,),
        )
    ]
    if versions:
        out["ver"] = versions

    return out


def _cve_id_bound(value, where: str) -> None:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{where}: CVE ID is empty, which the client refuses")
    if len(value) > MAX_CVE_ID:
        raise ValueError(
            f"{where}: CVE ID is {len(value)} characters, over the {MAX_CVE_ID} the wire "
            "format accepts"
        )


def _signed(value, where: str) -> None:
    """Any integer JSON carries intact. Timestamps may be negative."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{where}: expected an integer, got {type(value).__name__}")
    if abs(value) > MAX_SAFE_INT:
        raise ValueError(f"{where}: {value} is outside the range a JSON number survives intact")


def _counter(value, where: str) -> None:
    """A count or code: `lib/delta.ts` refuses a negative one."""
    _signed(value, where)
    if value < 0:
        raise ValueError(f"{where}: {value} is negative, which the client refuses")


def _row_id(value, where: str) -> None:
    """A row out of the interned ID space: `lib/delta.ts` requires >= 1."""
    _signed(value, where)
    if value < 1:
        raise ValueError(f"{where}: {value} is not a row id (interning starts at 1)")


def _check_wire_bounds(delta: dict) -> None:
    """Refuse a payload the client's validator would reject — all of it.

    The client refuses the *file*, not the offending row, so shipping one bad
    value stops sync for everyone until the next snapshot, and the delta cannot
    be withdrawn (D-047). This mirrors `lib/delta.ts` field for field, including
    its sign conventions: row ids start at 1, counts and codes are non-negative,
    and only the two timestamps may be negative. Checking scalars for size alone
    was not enough — a `generated` of -1, a CVSS version of 2^60 and a row id of
    0 all passed here and would each have been refused on arrival.
    """
    for key in ("format", "schema", "from", "to", "generated"):
        _counter(delta[key], f"envelope.{key}")
    if not str(delta.get("notice") or "").strip():
        raise ValueError("envelope.notice: empty, which the client refuses (D-008)")

    for table, rows in delta["lookups"].items():
        for row in rows:
            _row_id(row[0], f"lookups.{table} id")
            if table == "product":
                _row_id(row[1], f"lookups.product[{row[0]}] vendor_id")
            if table == "url":
                _row_id(row[2], f"lookups.url[{row[0]}] host_id")

    for record in delta["upsert"]:
        _cve_id_bound(record.get("cve"), f"upsert id {record.get('id')}")
        where = record["cve"]
        _row_id(record["id"], f"{where}.id")
        for key in ("y", "st"):
            _counter(record[key], f"{where}.{key}")
        if "cna" in record:
            _row_id(record["cna"], f"{where}.cna")
        for key in ("pub", "upd", "res"):
            if key in record:
                _signed(record[key], f"{where}.{key}")
        for key in ("descr", "title", "reason"):
            if record.get(key) == "":
                raise ValueError(f"{where}.{key}: empty, which the client refuses — omit it instead")
        if "ssvc" in record:
            points = record["ssvc"]
            if not isinstance(points, list) or len(points) != 3:
                raise ValueError(f"{where}.ssvc: expected three decision points")
            if all(point is None for point in points):
                # All three null is a record with no assessment, which the
                # emitter expresses by omitting the key. Shipping the tuple would
                # be three bytes saying nothing, and two ways to spell one state.
                raise ValueError(f"{where}.ssvc: no decision point set — omit the key instead")
            for index, point in enumerate(points):
                if point is not None:
                    _counter(point, f"{where}.ssvc[{index}]")
        if "cvss" in record:
            version, score, severity, vector = record["cvss"]
            _counter(version, f"{where}.cvss version")
            if score is not None and (
                isinstance(score, bool) or not isinstance(score, (int, float))
            ):
                raise ValueError(f"{where}.cvss score: expected a number or null")
            if severity is not None:
                _counter(severity, f"{where}.cvss severity")
            if not isinstance(vector, str):
                raise ValueError(f"{where}.cvss vector: expected a string")
        for key in ("cwe", "ref"):
            for value in record.get(key, ()):
                _row_id(value, f"{where}.{key}")
        for entry in record.get("prod", ()):
            if not isinstance(entry, list) or len(entry) != 2:
                raise ValueError(f"{where}.prod: expected [product_id, default_status]")
            _row_id(entry[0], f"{where}.prod product_id")
            if entry[1] is not None:
                _counter(entry[1], f"{where}.prod default_status")
        for version in record.get("ver", ()):
            _row_id(version[0], f"{where}.ver product_id")
            _counter(version[1], f"{where}.ver status")
            if version[5] is not None:
                _row_id(version[5], f"{where}.ver vtype")

    for index, cve_id in enumerate(delta["delete"]):
        _cve_id_bound(cve_id, f"delete[{index}]")


def _existing_ids(db: sqlite3.Connection, table: str, ids: list[int]) -> set[int]:
    rows = _in_batches(db, f"SELECT id FROM {table} WHERE id IN", "", ids)
    return {row[0] for row in rows}


def _check_closure(db: sqlite3.Connection, delta: dict, floors: dict) -> None:
    """Refuse a delta whose upserts point at rows the client will not have.

    A dangling reference means the artifact is inconsistent; a reference above
    the floor that is not shipped means the floors are wrong. Either way the
    client would end up with a record pointing at a vendor or URL it has never
    seen, and would have no way to notice.
    """
    shipped = {table: {row[0] for row in delta["lookups"][table]} for table in LOOKUP_COLUMNS}
    referenced: dict[str, set[int]] = {table: set() for table in LOOKUP_COLUMNS}

    for record in delta["upsert"]:
        if "cna" in record:
            referenced["cna"].add(record["cna"])
        referenced["cwe"].update(record.get("cwe", ()))
        referenced["product"].update(entry[0] for entry in record.get("prod", ()))
        referenced["url"].update(record.get("ref", ()))
        for version in record.get("ver", ()):
            referenced["product"].add(version[0])
            if version[5] is not None:
                referenced["vtype"].add(version[5])

    # Lookup rows reference lookup rows too, and a shipped product whose vendor
    # stayed below the floor is the normal case -- the unshipped one is not.
    for row in delta["lookups"]["product"]:
        referenced["vendor"].add(row[1])
    for row in delta["lookups"]["url"]:
        referenced["host"].add(row[2])

    for table, wanted in referenced.items():
        if not wanted:
            continue
        floor = int(floors.get(table, 0))
        unshipped = sorted(
            value for value in wanted if value > floor and value not in shipped[table]
        )
        if unshipped:
            raise ValueError(
                f"delta would reference {len(unshipped)} unshipped {table} row(s) above "
                f"floor {floor}: {unshipped[:5]}"
            )
        dangling = sorted(set(wanted) - _existing_ids(db, table, sorted(wanted)))
        if dangling:
            raise ValueError(f"delta references {table} row(s) not in the artifact: {dangling[:5]}")


def extract(
    db_path: str,
    *,
    from_rev: int,
    to_rev: int,
    upsert: list[str],
    delete: list[str],
    floors: dict,
    extra: dict | None = None,
    generated: int | None = None,
) -> dict:
    """Build the delta payload from an artifact, or raise (D-047).

    `floors` must name every lookup table: a missing entry would default to 0
    and ship the whole table, and an unknown key is a typo that silently ships
    nothing. Measured on 20,000 synthetic records, the documented two-table
    example produced a 191 KB delta where the correct floors produce 1.2 KB —
    so neither mistake announces itself.

    The floors *are* checked, in two places and against two authorities: here,
    against the extent the artifact recorded when it was seeded from `from`
    (which catches a caller passing the wrong revision's), and in
    `publish` against what the ledger recorded when it published that revision
    (which catches an artifact whose own record was edited). What neither can
    check is a data plane that has no record of `from` at all — a generation
    published before D-056 — where the caller is still trusted.
    """
    if from_rev < 0 or to_rev <= from_rev:
        raise ValueError(f"delta range {from_rev}-{to_rev} is not increasing")

    # A record cannot be both replaced and withdrawn by the same delta: the
    # wire format does not order `upsert` against `delete`, so two conforming
    # appliers would disagree about the result.
    both = sorted(set(upsert) & set(delete))
    if both:
        raise ValueError(f"changeset both upserts and tombstones {both[:5]}")

    extra = extra or {}
    unknown = (set(floors) | set(extra)) - set(LOOKUP_COLUMNS)
    if unknown:
        raise ValueError(f"changeset names lookup tables that do not exist: {sorted(unknown)}")
    missing = set(LOOKUP_COLUMNS) - set(floors)
    if missing and not (from_rev == 0 and not floors):
        # An empty map is the bootstrap — "the client has nothing", which only
        # rev 0 can mean. Anywhere else a missing floor is an omission, and it
        # would ship the whole table rather than the day's handful of rows.
        raise ValueError(
            f"changeset gives no floor for {sorted(missing)}; a missing floor ships the "
            "whole table. Pass 0 per table, or an empty map from rev 0 to bootstrap."
        )

    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        meta = dict(db.execute("SELECT k, v FROM meta"))
        notice = meta.get("notice") or ""
        if not notice.strip():
            # D-008 is a condition of the grant: a copy with no notice attached
            # is one we are not licensed to have published.
            raise ValueError(f"{db_path} carries no MITRE notice")

        # The delta describes the state of *this* artifact, so its `to` is the
        # artifact's own revision — not a number the caller picked. Without
        # this an artifact stamped rev 2 happily emitted a 1→999 delta, which
        # would install rev-2 rows and leave the client claiming rev 999: from
        # then on it asks for deltas that do not exist and never syncs again.
        stamped = int(meta.get("rev", 0))
        if stamped != int(to_rev):
            raise ValueError(
                f"artifact is at rev {stamped} but the changeset ends at {to_rev}; a delta "
                "must carry the revision its source is stamped with"
            )

        # And it must be an artifact this pipeline build actually speaks. A
        # schema bump cannot be bridged by a delta at all — the client refuses
        # one whose schema is not its own and re-downloads (D-025) — so
        # emitting from an artifact built by a different pipeline version would
        # produce rows in the wrong shape and a file nobody can apply. The key
        # has to be *present*: defaulting a missing one to 1 is a guess about
        # the most important thing here.
        # And it must be a *step* from the revision it claims to start at. The
        # artifact records which revision's ID space it continued (D-056), and
        # that has to be `from`: a build seeded from an older ancestor mints the
        # same ids as its sibling for different values — sharing the lineage
        # token, so nothing else can see it — and `extra` is computed against
        # the seed, so a payload spanning two revisions silently omits content
        # that moved in the one it skipped. Both are invisible to
        # `_check_closure`, whose view is one self-consistent artifact.
        if int(from_rev) > 0:
            seeded_from = meta.get("seed_rev")
            if seeded_from is None:
                raise ValueError(
                    f"{db_path} records no seed revision, so it cannot be the source of a "
                    f"delta from rev {from_rev}; only a build that continued that revision is"
                )
            if int(seeded_from) != int(from_rev):
                raise ValueError(
                    f"{db_path} continues rev {seeded_from} but the changeset starts at "
                    f"{from_rev}; a delta is a step from the revision its source was seeded "
                    "from, not a patch that spans several"
                )
            # Which also settles the floors. They describe the ID space at
            # `from`, the artifact was seeded from exactly that revision, and it
            # recorded the extent it grew from — so "are these the right floors"
            # stops being a question this module cannot answer. A floor that is
            # too high under-ships lookup rows and `_check_closure` reads the
            # gap as "the client already has it".
            seed_marks = meta.get("seed_marks")
            if seed_marks is not None:
                expected = json.loads(seed_marks)["floors"]
                if {t: int(v) for t, v in floors.items()} != expected:
                    raise ValueError(
                        f"changeset floors {floors} are not the ID space at rev {from_rev}, "
                        f"which this artifact was seeded from ({expected})"
                    )

        stamped_schema = meta.get("schema")
        if stamped_schema is None or int(stamped_schema) != build.SCHEMA_VERSION:
            raise ValueError(
                f"artifact is schema {stamped_schema!r} but this pipeline builds schema "
                f"{build.SCHEMA_VERSION}; a delta cannot bridge a schema change"
            )

        lookups = {
            table: _lookup_rows(db, table, int(floors.get(table, 0)), list(extra.get(table, ())))
            for table in LOOKUP_COLUMNS
        }

        delta = {
            "format": FORMAT_VERSION,
            "schema": int(stamped_schema),
            "from": int(from_rev),
            "to": int(to_rev),
            "generated": int(generated if generated is not None else time.time()),
            "notice": notice,
            "lookups": lookups,
            "upsert": [_record(db, cve_id) for cve_id in sorted(set(upsert))],
            "delete": sorted(set(delete)),
        }
        _check_wire_bounds(delta)
        _check_closure(db, delta, floors)
        return delta
    finally:
        db.close()


def _digest(path: str) -> str:
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def write(
    delta: dict,
    pub_dir: str,
    quality: int = QUALITY,
    force: bool = False,
    space: dict | None = None,
    on_written=None,
    artifact: str | None = None,
) -> dict:
    """Compress and publish the delta; return its manifest entry.

    The file lands by atomic rename, and a published delta is immutable for the
    same reason a published snapshot is: its URL carries an immutable cache
    policy, so rewriting one serves a stale-vs-new mix from caches (D-047).

    **Publication is defined by the manifest, not by the filesystem.** Checking
    only for the file was wrong in the one case that matters: D-042's retention
    deletes old delta files, and after that a same-range re-run silently
    rewrote different bytes at a URL clients had cached for a year.

    The manifest cannot answer that question on its own, though: retention
    removes an old delta's entry *and* its file, after which nothing on disk
    remembers the URL ever existed and the range was freely reusable. So the
    authority is `ledger.py`, an append-only record kept outside the served
    directory.

    A range that was ever published may only be rewritten with byte-identical
    content. That includes `generated`: the client writes it to `meta.generated`
    on apply, so two payloads differing only there really are different content
    at a URL clients cache for a year. The ingest therefore has to pin
    `generated` per revision rather than stamping wall-clock time on each retry
    — which is what makes a crashed run recoverable without `--force`.
    """
    # Encoding is strict on purpose, and `allow_nan=False` with it: text out of
    # the artifact is valid UTF-8 by construction, and a non-finite number
    # would serialize as a bare `Infinity` token that no browser's JSON parser
    # accepts. Either way the run must stop rather than publish bytes the
    # client cannot read at a URL that can never be corrected.
    payload = json.dumps(
        delta, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")

    entry_stub = {"from": int(delta["from"]), "to": int(delta["to"])}
    name = manifest_module.delta_name(entry_stub)
    directory = os.path.join(pub_dir, "deltas")
    os.makedirs(directory, mode=0o755, exist_ok=True)
    # Explicit because `makedirs` is subject to the caller's umask, and a cron
    # under a hardened umask would publish a directory nginx cannot traverse —
    # every artifact 403s while the manifest looks perfectly healthy.
    os.chmod(directory, 0o755)
    final = os.path.join(directory, name)

    # Compress first, into a scratch file: the digest of what *would* be
    # published is the only thing that can be compared against what already was.
    with tempfile.NamedTemporaryFile(delete=False) as scratch:
        scratch.write(payload)
        scratch_path = scratch.name
    compressed_path = f"{final}.{os.getpid()}.tmp"
    try:
        subprocess.run(
            ["brotli", "-q", str(quality), "-f", "-o", compressed_path, scratch_path], check=True
        )
    finally:
        os.unlink(scratch_path)

    try:
        digest = _digest(compressed_path)
        if not force:
            recorded = ledger.delta_published(pub_dir, entry_stub)
            if recorded is not None and recorded.get("sha256") != digest:
                raise SystemExit(
                    f"error: delta {name} was already published with different content; that "
                    "URL is immutable (D-047), so this needs a new revision rather than a "
                    "rewrite (--force for local iteration)"
                )
            if recorded is None and os.path.exists(final) and _digest(final) != digest:
                raise SystemExit(
                    f"error: {name} is on disk with different content and was never "
                    "registered; something already at that URL would be replaced. Re-run the "
                    "same changeset, or --force for local iteration"
                )

        entry = {
            "from": int(delta["from"]),
            "to": int(delta["to"]),
            "bytes": os.path.getsize(compressed_path),
            "raw_bytes": len(payload),
            "sha256": digest,
        }
        # The bytes are decided here and become visible on the next line. A
        # caller that must survive a crash in between — the ingest, whose whole
        # re-run story is "reproduce exactly these bytes" — gets one chance to
        # write the entry down *before* anything can observe it. Recording it
        # afterwards leaves a window in which the file exists and nothing knows
        # its digest, and the only way out of that window is recompressing,
        # which a brotli upgrade can silently change.
        if on_written is not None:
            on_written(dict(entry), dict(space) if space else None)

        # brotli inherits the temp file's restrictive mode; nginx has to be able
        # to read what we publish regardless of who ran the pipeline.
        os.chmod(compressed_path, 0o644)
        os.replace(compressed_path, final)
    finally:
        if os.path.exists(compressed_path):
            os.unlink(compressed_path)

    ledger.record_delta(pub_dir, entry, space, artifact)
    return entry


def publish(
    db_path: str,
    pub_dir: str,
    changeset: dict,
    quality: int = QUALITY,
    force: bool = False,
    on_written=None,
) -> dict:
    """Extract, write, and register in the manifest -- in that order, so the
    manifest never names a file that is not on disk."""
    # Every id in this payload is only meaningful inside the ID space that
    # minted it (D-056). A delta cut from an artifact built off a different
    # lineage — an unseeded rebuild being the easy mistake — would install rows
    # under ids that mean something else on every client, and neither the
    # client's `cve` tripwire nor `_check_closure` can see it: both check
    # against the artifact, which is self-consistent. The ledger is the only
    # thing that remembers what was published, so it is where this is caught.
    #
    # A delta never *establishes* a lineage, even on a data plane that records
    # none: it cannot prove what ID space the snapshot clients downloaded
    # belongs to, and adopting on its say-so would bless whatever arrived first.
    # That adoption is `publish.py --adopt-id-space`, on the artifact that can.
    space = build.id_space(db_path)
    ledger.assert_idspace(pub_dir, space["idspace"])
    # And that it grew from the artifact this data plane actually published at
    # the revision it continues — not merely from *an* artifact stamped there.
    ledger.assert_continues(pub_dir, space)

    # The floors, checked against what this data plane recorded at `from` rather
    # than against the artifact's own copy of it. `extract` compares the two
    # locally, which catches a caller's mistake; only the ledger catches an
    # artifact whose recorded marks were edited, and a floor that is too high
    # ships fewer lookup rows while `_check_closure` reads the gap as "the
    # client already has it".
    # The same whole-record comparison for the revision this delta *lands* on:
    # identical bytes at a URL do not imply identical ID spaces behind them, and
    # the ledger's own refusal comes after the file is in place.
    candidate = {"marks": build.id_marks(space), "fingerprint": build.fingerprint(db_path)}
    landing = ledger.space_at(pub_dir, int(changeset["to"]))
    if landing is not None and landing != candidate:
        raise SystemExit(
            f"error: rev {changeset['to']} was published with a different ID space; this "
            "delta would leave clients at a revision whose ids mean something else"
        )

    from_rev = int(changeset["from"])
    published_space = ledger.space_at(pub_dir, from_rev)
    if published_space is not None:
        expected = published_space.get("marks", {}).get("floors")
        given = {table: int(value) for table, value in dict(changeset.get("floors", {})).items()}
        if expected is not None and given != expected:
            raise SystemExit(
                f"error: changeset floors {given} are not the ID space this data plane "
                f"published at rev {from_rev} ({expected})"
            )

    # And the same question about the revision this delta *lands* on, but about
    # its content rather than its ids: `ledger._record_artifact` refuses a second
    # artifact at one revision too, and that runs after `os.replace` has put the
    # file at its public URL. Two deltas can land on one `to` from different
    # artifacts — newly reachable, because a bridging delta may now be published
    # into a revision a rebuilt snapshot already defines (D-060). Ordered after
    # the floors comparison so that a *tampered* artifact is still reported as
    # the floors problem it is, rather than as the digest mismatch it also is.
    artifact_digest = build.digest_file(db_path)
    landing_artifact = ledger.artifact_at(pub_dir, int(changeset["to"]))
    if landing_artifact is not None:
        if landing_artifact != artifact_digest:
            raise SystemExit(
                f"error: rev {changeset['to']}'s content came from artifact {landing_artifact}, "
                f"but this delta is cut from {artifact_digest}; it would leave clients at a "
                "revision holding something other than what was published there"
            )
    elif landing is not None:
        # No digest, but the revision *was* published — `space_at` only records
        # what this data plane put at a revision. Absence is then a gap rather
        # than a free revision, and the gap is exactly what a second artifact
        # needs: land a bridge here from a sibling and clients arriving fresh
        # download one content while clients applying the bridge get another,
        # both calling it rev N. Fail closed, as D-056 does for the same shape.
        raise SystemExit(
            f"error: rev {changeset['to']} was already published, but nothing records which "
            "artifact its content came from — so this delta cannot be shown to land clients "
            "on what is already there. Publish this at a new revision."
        )

    delta = extract(
        db_path,
        from_rev=int(changeset["from"]),
        to_rev=int(changeset["to"]),
        upsert=list(changeset.get("upsert", ())),
        delete=list(changeset.get("delete", ())),
        floors=dict(changeset.get("floors", {})),
        extra=dict(changeset.get("extra", {})),
        generated=changeset.get("generated"),
    )
    # Whether the manifest can *hold* this entry, asked before the file exists.
    # `register_delta` refuses a delta that would strand a client (D-055), and
    # by then the bytes are published and recorded in the ledger — so the URL is
    # burned, and even a corrected payload for that range is refused afterwards.
    # A well-formed bridge into a rebuilt snapshot registers fine since D-060;
    # what is reproduced now is a bridge to the *wrong* revision, which leaves
    # the client at a dead end the manifest will not advertise.
    prospective = {"from": int(delta["from"]), "to": int(delta["to"])}
    manifest_module.assert_tiling(
        manifest_module.plan_delta(pub_dir, prospective, delta["generated"])
    )
    # `extract` reopened the path this was digested from, so the same
    # hash-then-reopen window the snapshot path has applies here: a file
    # replaced in between would have the ledger record one artifact while the
    # payload came from another. Re-read before the bytes become public.
    if build.digest_file(db_path) != artifact_digest:
        raise SystemExit(
            f"error: {db_path} changed while this delta was being extracted — it hashed as "
            f"{artifact_digest} before and differs now, so the payload describes bytes this "
            "run cannot vouch for. Nothing was published."
        )

    entry = write(
        delta,
        pub_dir,
        quality=quality,
        force=force,
        space=candidate,
        on_written=on_written,
        # Which file this revision's content came from. The monthly snapshot
        # lands *at* the head revision and tells no client to re-fetch, so
        # "the same content clients already hold" has to be checkable rather
        # than conventional — and the only moment it is knowable is here
        # (D-060). One pass over the artifact, ~377 MB, already spent above.
        artifact=artifact_digest,
    )
    # The manifest last, because it is what exposes the new head. Recording the
    # bytes and the ID space the delta lands on in the same ledger write, before
    # that, is what stops a crash in between leaving a revision clients can
    # reach whose ID space nothing wrote down — a gap `assert_continues` then
    # had to either fail open on or refuse forever.
    manifest_module.register_delta(pub_dir, entry, delta["generated"])
    # The manifest entry is kept separate from the run's counts on purpose: it
    # is the published contract, and merging the two would let a caller hand a
    # summary back to `register_delta` and quietly publish fields that are not
    # in the format.
    return {
        "entry": entry,
        "upserts": len(delta["upsert"]),
        "deletes": len(delta["delete"]),
        "lookups": {table: len(rows) for table, rows in delta["lookups"].items() if rows},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("db")
    parser.add_argument("pub_dir")
    parser.add_argument("changeset", help="JSON file: from, to, upsert, delete, floors, extra")
    parser.add_argument("--quality", type=int, default=QUALITY)
    parser.add_argument(
        "--force",
        action="store_true",
        help="Replace an already-published delta (local iteration only).",
    )
    args = parser.parse_args()

    with open(args.changeset, encoding="utf-8") as handle:
        changeset = json.load(handle)

    print(json.dumps(publish(args.db, args.pub_dir, changeset, args.quality, args.force), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
