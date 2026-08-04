"""Build the published SQLite artifact from a cvelistV5 clone.

    python3 pipeline/build.py <clone> <out.sqlite> (--seed prev.sqlite | --bootstrap)
                              [--year-min N] [--limit N]

`--year-min` and `--limit` exist for M1's bounded slice; a production run
passes neither. The full corpus takes ~40 s and produces ~391 MB.

**Every build either seeds from the previous one or explicitly bootstraps a new
ID space** (D-056). There is no default, because the default that reads most
naturally — start empty — is the one failure mode this module exists to
prevent: interned ids are the client's ids, and a build that renumbers them
turns every subsequent delta into silently wrong data.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import sqlite3
import subprocess
import sys
import time

import normalize

SCHEMA_VERSION = 1

# JSON numbers are IEEE doubles by the time a browser sees them, and SQLite will
# store an int64 happily — so the bound belongs wherever a number enters the
# published contract (`delta.py` and `publish.py` carry the same one).
MAX_SAFE_INT = 2**53 - 1

# The interned lookup tables, in the order apply must insert them: `vendor`
# before `product` and `host` before `url`, because those reference them. This
# is the single definition of both the schema's column order and the wire
# order — `delta.LOOKUP_COLUMNS` is this dict (D-055).
LOOKUP_COLUMNS = {
    "cna": ("id", "name"),
    "cwe": ("id", "cwe", "descr"),
    "vendor": ("id", "name"),
    "product": ("id", "vendor_id", "name"),
    "host": ("id", "name"),
    "url": ("id", "url", "host_id"),
    "vtype": ("id", "name"),
}

# How a seeded row's interning key is recovered from its stored columns (the
# row without its id). These must agree exactly with the keys `build` passes to
# each Interner below: a mismatch would not raise, it would mint a second id for
# a value that already has one — so `test_interning.py` checks every table by
# rebuilding a corpus unchanged and requiring zero new ids.
SEED_KEY = {
    "cna": lambda columns: columns[0],
    "cwe": lambda columns: columns[0],
    "vendor": lambda columns: columns[0],
    "product": lambda columns: (columns[0], columns[1]),
    "host": lambda columns: columns[0],
    "url": lambda columns: columns[0],
    "vtype": lambda columns: columns[0],
}

# D-008 / D-047: the canonical notice, carried by every copy of CVE data —
# database, manifest, deltas, UI, exports. The terms require reproducing
# MITRE's copyright designation and the license clause; both are verbatim from
# cve.org's sources (footer and Terms of Use, checked 2026-08-01). Tests
# assert the required components; change this only with D-008 in hand.
NOTICE = (
    f"CVE record content: Copyright © 1999-{time.gmtime().tm_year}, "
    "The MITRE Corporation. CVE is a trademark and the CVE logo is a "
    "registered trademark of The MITRE Corporation. Licensed under the CVE "
    "Program Terms of Use (https://www.cve.org/legal/termsofuse): \"MITRE "
    "hereby grants you a perpetual, worldwide, non-exclusive, no-charge, "
    "royalty-free, irrevocable copyright license to reproduce, prepare "
    "derivative works of, publicly display, publicly perform, sublicense, "
    "and distribute Common Vulnerabilities and Exposures (CVE™). Any "
    "copy you make for such purposes is authorized provided that you "
    "reproduce MITRE's copyright designation and this license in any such "
    "copy.\" Provided \"AS IS\", with all warranties disclaimed."
)


class Interner:
    """Server-owned ID space: append-only, never renumbered (D-025 hazard 1).

    Seeded from the previous build, so an id means the same thing in every
    artifact and every delta (D-056). Three behaviours carry that guarantee:

      * a key the seed already had keeps its id;
      * a new key takes the next id above the **high-water mark**, which is
        carried in the seed's `meta` rather than recomputed as `max(id)` — a
        retired row can be the highest one, and recomputing would hand its id
        to a different value while clients still hold the old meaning;
      * a key the corpus no longer uses is *retired*: its row is not carried
        into the new artifact, and its id is never issued again. Clients that
        still hold the row keep a harmless orphan; nothing can make it resolve
        to something else.

    `cve.id` follows the same three rules — it is a delta's primary key too
    (D-055) — but not through this class: a record's row is written from the
    walk rather than interned on demand, so `build` keeps the id map directly.
    """

    def __init__(self) -> None:
        self._ids: dict = {}
        # Seeded rows not yet used by this build. Popping on first use both
        # marks the row used and frees the memory, which matters at 1.2M URLs.
        self._unused: dict = {}
        self.rows: list = []
        self.hwm = 0
        self.minted = 0
        # Ids whose content differs from the seed's. Only `cwe.descr` can move
        # (every other lookup's columns *are* its key), and it is what the
        # changeset's `extra` list exists for: a floor cannot see a row that
        # changed under an id the client already has (D-055).
        self.changed: list = []

    def seed(self, key, row_id: int, columns: tuple) -> None:
        self._ids[key] = row_id
        self._unused[row_id] = columns
        if row_id > self.hwm:
            self.hwm = row_id

    def __call__(self, key, *columns):
        found = self._ids.get(key)
        if found is None:
            self.hwm += 1
            self.minted += 1
            found = self.hwm
            self._ids[key] = found
            self.rows.append((found, *columns))
            return found
        seeded = self._unused.pop(found, None)
        if seeded is not None:
            # First use this build: the row has to be written out again, since
            # the artifact is a whole snapshot rather than a diff.
            if seeded != columns:
                self.changed.append(found)
            self.rows.append((found, *columns))
        return found

    @property
    def retired(self) -> int:
        """Seeded rows this build no longer interns; their ids stay reserved."""
        return len(self._unused)

    def __len__(self) -> int:
        return len(self.rows)


def _recorded_hwm(meta: dict, db_path: str) -> dict:
    """The `hwm` map out of an artifact's `meta`, or `{}` for a legacy one.

    Anything between those two — unparseable, not an object, a non-integer
    value — is a damaged record, not an old one, and guessing which is which is
    how a wrong floor gets published. Raise with the artifact named (D-047):
    every one of these shapes previously either crashed with a bare
    `JSONDecodeError`/`TypeError` naming no file, or silently fell back to
    `max(id)` and looked exactly like a pre-D-056 artifact.
    """
    raw = meta.get("hwm")
    if raw is None or raw == "":
        return {}
    try:
        recorded = json.loads(raw)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{db_path}: meta.hwm is not readable JSON ({error})") from error
    if not isinstance(recorded, dict):
        raise ValueError(f"{db_path}: meta.hwm is {type(recorded).__name__}, expected an object")
    for table, value in recorded.items():
        if table not in LOOKUP_COLUMNS:
            raise ValueError(f"{db_path}: meta.hwm names an unknown lookup table {table!r}")
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError(f"{db_path}: meta.hwm[{table!r}] is {value!r}, expected a count")
    missing = sorted(set(LOOKUP_COLUMNS) - set(recorded))
    if missing:
        raise ValueError(
            f"{db_path}: meta.hwm is missing {missing}; a partial record cannot be told from "
            "an artifact that predates it, and the difference is a wrong floor"
        )
    return recorded


def id_space(db_path: str) -> dict:
    """What the ID space looked like when this artifact was built.

    `floors` is exactly the changeset's `floors` map (D-055): the highest id
    each lookup table had *issued* at this artifact's revision, which is what
    the next delta must ship above. It is read from `meta` rather than
    recomputed, because retirement means the highest id *issued* and the highest
    id still *present* differ — and that difference is a window in which a
    client keeps one value under an id the server has since given to another.

    An artifact built before this existed (the generation live on 2026-08-02)
    records none of it, and is recognised by having no `idspace` at all. Its
    `max(id)` *is* its high-water mark, because an unseeded build never retires
    anything, so falling back to it is exact rather than a guess — `inferred`
    names what it was used for, `cve` included. An artifact that *does* record a
    lineage must record the rest of it too.
    """
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        meta = dict(db.execute("SELECT k, v FROM meta"))
        idspace = str(meta.get("idspace") or "")
        recorded = _recorded_hwm(meta, db_path)
        if idspace and not recorded:
            raise ValueError(
                f"{db_path} records ID space {idspace} but no high-water marks; it was built "
                "with them, so this artifact is damaged rather than old"
            )
        floors, fallbacks = {}, []
        for table in LOOKUP_COLUMNS:
            top = int(db.execute(f"SELECT coalesce(max(id), 0) FROM {table}").fetchone()[0])
            if table in recorded:
                # Rows above the recorded mark mean the record is wrong, and the
                # two uses of this number want opposite repairs: as a *mint*
                # floor the safe move is the higher value, as a *delta* floor it
                # is the lower one. One number cannot be conservative both ways,
                # so it is an error rather than a choice.
                if int(recorded[table]) < top:
                    raise ValueError(
                        f"{db_path}: {table} holds id {top} above its recorded high-water mark "
                        f"{recorded[table]}; the ID-space record does not describe this artifact"
                    )
                floors[table] = int(recorded[table])
            else:
                floors[table] = top
                fallbacks.append(table)
        cve_top = int(db.execute("SELECT coalesce(max(id), 0) FROM cve").fetchone()[0])
        if "cve_hwm" in meta:
            cve_hwm = int(meta["cve_hwm"])
            if cve_hwm < cve_top:
                raise ValueError(
                    f"{db_path}: cve holds id {cve_top} above its recorded high-water mark "
                    f"{cve_hwm}; the ID-space record does not describe this artifact"
                )
        elif idspace:
            raise ValueError(f"{db_path} records ID space {idspace} but no meta.cve_hwm")
        else:
            cve_hwm = cve_top
            fallbacks.append("cve")
        # Provenance is all-or-nothing: an artifact either continues a
        # revision and says everything about which one, or it is a bootstrap and
        # says nothing. A half-set is a record that has been edited, and every
        # missing piece silently disables the check that reads it.
        seed_rev = meta.get("seed_rev")
        seed_marks = meta.get("seed_marks")
        seed_fingerprint = meta.get("seed_fingerprint")
        provenance = [seed_rev, seed_marks, seed_fingerprint]
        if any(value is not None for value in provenance) and not all(
            value is not None for value in provenance
        ):
            raise ValueError(
                f"{db_path} records an incomplete ancestry (seed_rev={seed_rev!r}, "
                f"seed_marks={'set' if seed_marks else None}, "
                f"seed_fingerprint={seed_fingerprint!r}); every part of it is what one of "
                "the publishers' checks reads, so a missing one disables that check"
            )
        return {
            "floors": floors,
            "cve_hwm": cve_hwm,
            "idspace": idspace,
            "rev": int(meta.get("rev", 0)),
            "seed_rev": None if seed_rev is None else int(seed_rev),
            # The seed's *own* marks, which is what makes "seeded from the wrong
            # ancestor" checkable beyond the revision number: two artifacts can
            # be stamped at one revision, and a build seeded from the one that
            # was not published mints different values at the same ids.
            "seed_marks": None if seed_marks is None else json.loads(seed_marks),
            "seed_fingerprint": seed_fingerprint,
            "schema": meta.get("schema"),
            # Provenance rather than ID space, but this is the one place that
            # already has `meta` open: the tree the artifact was built from,
            # which `ingest.py init` checks a clone against, and when it was
            # built, which the delta cut from it carries so that one revision
            # has one freshness rather than two (D-060).
            "commit": str(meta.get("commit") or ""),
            "generated": None if meta.get("generated") is None else int(meta["generated"]),
            "inferred": sorted(fallbacks),
        }
    finally:
        db.close()


def id_marks(space: dict) -> dict:
    """The ID space's extent: every high-water mark, in one comparable value."""
    return {"floors": dict(space["floors"]), "cve_hwm": int(space["cve_hwm"])}


def _digest_rows(digest, db: sqlite3.Connection) -> None:
    """Feed every interned row into a hash, in id order.

    Ordered explicitly because the digest has to be reproducible by a different
    process reading a different file, and `surrogatepass` because record text is
    attacker-influenced and need not be encodable UTF-8 (RE-015) — a fingerprint
    that raises on a legal record would be worse than no fingerprint.
    """
    for table, columns in LOOKUP_COLUMNS.items():
        digest.update(table.encode("ascii"))
        for row in db.execute(f"SELECT {', '.join(columns)} FROM {table} ORDER BY id"):
            digest.update(repr(row).encode("utf-8", "surrogatepass"))
    digest.update(b"cve")
    for row in db.execute("SELECT id, cve_id FROM cve ORDER BY id"):
        digest.update(repr(row).encode("utf-8", "surrogatepass"))


def digest_file(path: str) -> str:
    """SHA-256 of a file's bytes, in blocks — an artifact is ~377 MB.

    Not the same question as `fingerprint`, which is about what the ids *mean*
    and is reproducible from a rebuild. This is "is this the same file", which
    is what a revision's content is pinned by (D-060): two builds of one corpus
    differ here (`meta.generated` alone would do it) and that is the point.
    """
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def fingerprint(db_path: str) -> str:
    """What this artifact's ID space *is*, not merely how far it extends.

    Two builds stamped at one revision can have the same high-water marks and
    still disagree about what an id means — one of them was published and the
    other was not. Comparing the whole assignment is the only thing that
    separates them, so the ledger records this for the revision it publishes and
    the next build records the one it grew from (D-056).
    """
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        digest = hashlib.sha256()
        _digest_rows(digest, db)
        return digest.hexdigest()[:16]
    finally:
        db.close()


def _seed_from(db_path: str, interners: dict) -> dict:
    """Load a previous artifact's ID space into the interners.

    Returns the `cve` id map and the rest of `id_space`. The seed's schema has
    to be this pipeline's: ids are only meaningful against the shape that
    assigned them, and a schema bump makes every client re-download anyway
    (D-025 hazard 4), so seeding across one would be carrying stability nobody
    can use.
    """
    space = id_space(db_path)
    if space["schema"] is None or int(space["schema"]) != SCHEMA_VERSION:
        raise ValueError(
            f"{db_path} is schema {space['schema']!r} but this pipeline builds schema "
            f"{SCHEMA_VERSION}; ids from another schema are not the same ID space"
        )

    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        # The seed's fingerprint comes out of the same pass that loads it, so it
        # costs a hash update per row rather than a second scan.
        digest = hashlib.sha256()
        for table, columns in LOOKUP_COLUMNS.items():
            interner = interners[table]
            key_of = SEED_KEY[table]
            names = ", ".join(columns)
            digest.update(table.encode("ascii"))
            for row in db.execute(f"SELECT {names} FROM {table} ORDER BY id"):
                digest.update(repr(row).encode("utf-8", "surrogatepass"))
                interner.seed(key_of(row[1:]), row[0], tuple(row[1:]))
            interner.hwm = max(interner.hwm, int(space["floors"][table]))
        digest.update(b"cve")
        cve_ids = {}
        for row_id, cve_id in db.execute("SELECT id, cve_id FROM cve ORDER BY id"):
            digest.update(repr((row_id, cve_id)).encode("utf-8", "surrogatepass"))
            cve_ids[cve_id] = row_id
    finally:
        db.close()
    space["cve_ids"] = cve_ids
    space["fingerprint"] = digest.hexdigest()[:16]
    return space


def clone_commit(clone: str) -> str:
    """The commit the clone is sitting at, or `""` if it is not a git tree.

    Recorded in the artifact so "which tree is this?" is answerable from the
    artifact alone. The ingest's `init` reads it back: it re-derives the content
    hashes from a working tree, and a tree that has moved past the artifact
    records post-artifact content as if it were the artifact's — which drops
    those edits from every future delta, silently. Comparing commits turns a
    documented instruction ("do not fetch in between") into a checked one.

    Never a change signal: a shallow clone reports every advance as a forced
    update (RE-006). Soft-failing to `""` because the fixtures build from plain
    directories, and because a missing provenance note must not stop a build.

    `git -C` walks *up* to an enclosing repository, so a corpus directory nested
    inside an unrelated checkout stamps that checkout's commit. Harmless as used
    — `init` compares this function's output against itself on the same
    directory — but it is why the value is provenance rather than an identity.
    """
    try:
        done = subprocess.run(
            ["git", "-C", clone, "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return ""
    return done.stdout.strip()


def record_paths(clone: str):
    """Yield record files, skipping the publishing pipeline's own churn files.

    `cves/delta.json` and `cves/deltaLog.json` are not CVE records, and a naive
    `find cves -name '*.json'` picks them up.
    """
    root = os.path.join(clone, "cves")
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            if name.startswith("CVE-") and name.endswith(".json"):
                yield os.path.join(dirpath, name)


def build(
    clone: str,
    out: str,
    year_min: int | None,
    limit: int | None,
    *,
    seed: str | None = None,
    bootstrap: bool = False,
    idspace: str | None = None,
    rev: int = 1,
) -> dict:
    """Build one artifact. Exactly one of `seed` and `bootstrap` is required.

    The choice is not defaulted anywhere, including here, because both answers
    are destructive when wrong and only the caller knows which is meant: an
    unseeded rebuild of a published corpus renumbers every client's ids, and
    seeding a bootstrap that was supposed to start clean silently inherits an
    ID space (D-056).
    """
    if not 0 <= int(rev) <= MAX_SAFE_INT:
        # The client refuses a revision JSON cannot carry intact (`isRevision`
        # in `lib/protocol.ts`), and it refuses the whole manifest with it.
        raise ValueError(
            f"rev {rev} is outside the range a JSON number survives intact "
            f"(0..{MAX_SAFE_INT}); the client would refuse the manifest carrying it"
        )
    if bool(seed) == bool(bootstrap):
        raise ValueError(
            "a build must either seed from the previous artifact (seed=...) or explicitly "
            "start a new ID space (bootstrap=True); interned ids are the client's ids, so "
            "there is no safe default"
        )
    if seed:
        if idspace:
            raise ValueError(
                "a seeded build's ID space is the seed's; passing idspace= would relabel a "
                "continuing lineage, which both publishers then refuse"
            )
        if os.path.realpath(seed) == os.path.realpath(out):
            # Seeding from the file being written works right up until anything
            # fails, and then the ID space is gone: the seed is read, `out` is
            # truncated, and the previous marks and lineage no longer exist
            # anywhere. Rebuilding in place has a safe spelling — build beside
            # it and rename.
            raise ValueError(
                f"{out} is also the seed; building over the artifact the ID space is read "
                "from destroys it if the build fails. Write elsewhere and rename."
            )
        if year_min is not None or limit is not None:
            # A bounded build retires everything outside its bounds, and
            # retirement is permanent: the next full build re-mints those values
            # at new ids while clients still hold the old ones. The slice
            # options exist for development, where `--bootstrap` is right.
            raise ValueError(
                "--year-min/--limit build a slice, which retires every value outside it "
                "from the seeded ID space permanently; use --bootstrap for a slice"
            )

    interners = {table: Interner() for table in LOOKUP_COLUMNS}
    seeded = _seed_from(seed, interners) if seed else None
    cve_ids: dict = seeded["cve_ids"] if seeded else {}
    # Measured *before* the walk, because the walk adds every newly minted
    # record to this same map — it is the seed's map, not a copy of it, since
    # copying 372k entries to preserve a count is not a trade worth making. The
    # count is what `retired_records` is derived from, and reading it afterwards
    # silently reported `minted` retirements that never happened.
    seed_records = len(cve_ids)
    cve_hwm = seeded["cve_hwm"] if seeded else 0
    # A bootstrap mints a lineage token; a seeded build inherits the seed's. An
    # artifact from before D-056 has none, so seeding from it adopts its ids
    # under a freshly minted token — the ID space is continuous, and the token
    # names it from here on.
    space_id = idspace or (seeded["idspace"] if seeded else "") or secrets.token_hex(8)

    if os.path.exists(out):
        os.remove(out)

    db = sqlite3.connect(out)
    try:
        db.executescript("PRAGMA journal_mode=off; PRAGMA synchronous=off;")
        schema_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema.sql")
        with open(schema_path, encoding="utf-8") as handle:
            db.executescript(handle.read())

        cna, cwe, vendor, product = (interners[t] for t in ("cna", "cwe", "vendor", "product"))
        host, url, vtype = (interners[t] for t in ("host", "url", "vtype"))
        cve_rows, text_rows = [], []
        cwe_link, prod_link, ref_link, ver_rows = [], [], set(), []

        started = time.time()
        records = 0
        minted_records = 0
        skipped: list[str] = []
        seen_ids: set = set()

        for path in record_paths(clone):
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
            # A record we cannot name is a record we cannot publish: the id is the
            # client's primary key, the delta's tombstone, and the thing every
            # report shows. Neither the record's `cveId` nor its file name being
            # well-formed is a corpus we understand, so fail closed (D-047) rather
            # than store an id no downstream consumer will accept.
            if not normalize.valid_cve_id(proj["cve_id"]):
                skipped.append(path)
                continue
            if year_min is not None and proj["year"] < year_min:
                continue

            # Two files claiming one CVE ID is reachable from record content —
            # `cveId` is publisher-supplied (rule 5), and a corrupted clone can
            # hold the same record twice. Both then take the same row id, and
            # the insert dies on a UNIQUE violation, or earlier and more
            # confusingly inside `sorted(cve_rows)` when two rows tie on the
            # leading columns and meet a NULL. Route it through the channel
            # D-047 built for records we cannot publish.
            if proj["cve_id"] in seen_ids:
                skipped.append(path)
                continue
            seen_ids.add(proj["cve_id"])

            # The record's id is interned like everything else: a walk counter
            # renumbered every record after an insertion, and deltas carry the id
            # (D-055, D-056). A record the seed never had appends above the
            # high-water mark, which no retired record's id can be below.
            records += 1
            row_id = cve_ids.get(proj["cve_id"])
            if row_id is None:
                cve_hwm += 1
                minted_records += 1
                row_id = cve_hwm
                cve_ids[proj["cve_id"]] = row_id
            score = proj["cvss"]
            cve_rows.append(
                (
                    row_id,
                    proj["cve_id"],
                    proj["year"],
                    proj["state"],
                    cna(proj["cna"], proj["cna"]),
                    proj["published"],
                    proj["updated"],
                    score[0] if score else None,
                    score[1] if score else None,
                    score[2] if score else None,
                    score[3] if score else None,
                )
            )

            if proj["descr"]:
                text_rows.append((row_id, proj["descr"]))

            for cwe_id, cwe_descr in proj["cwes"]:
                cwe_link.append((row_id, cwe(cwe_id, cwe_id, cwe_descr)))

            for vendor_name, product_name in proj["products"]:
                vendor_id = vendor(vendor_name, vendor_name)
                prod_link.append(
                    (row_id, product((vendor_id, product_name), vendor_id, product_name))
                )

            for vendor_name, product_name, version in proj["versions"]:
                vendor_id = vendor(vendor_name, vendor_name)
                product_id = product((vendor_id, product_name), vendor_id, product_name)
                status, ver, lt, lte, vtype_name = version
                ver_rows.append(
                    (
                        row_id,
                        product_id,
                        status,
                        ver or None,
                        lt or None,
                        lte or None,
                        vtype(vtype_name, vtype_name) if vtype_name else None,
                    )
                )

            for reference in proj["refs"]:
                host_name = normalize.host_of(reference)
                ref_link.add(
                    (row_id, url(reference, reference, host(host_name, host_name)))
                )

            if limit is not None and records >= limit:
                break

        parsed = time.time() - started

        # Sorted by id, because seeding makes use-order and id-order differ: a
        # seeded row is written when the corpus first mentions it, which is not
        # where it was minted. Ids are unique, so nothing past the first element is
        # ever compared. Table names and column counts come from this module's own
        # constant, never from record content (AGENTS.md rule 5).
        for table, columns in LOOKUP_COLUMNS.items():
            marks = ",".join("?" * len(columns))
            db.executemany(f"INSERT INTO {table} VALUES({marks})", sorted(interners[table].rows))
        db.executemany("INSERT INTO cve VALUES(?,?,?,?,?,?,?,?,?,?,?)", sorted(cve_rows))
        db.executemany("INSERT INTO cve_text VALUES(?,?)", text_rows)
        db.executemany("INSERT OR IGNORE INTO cve_cwe VALUES(?,?)", cwe_link)
        db.executemany("INSERT OR IGNORE INTO cve_prod VALUES(?,?)", prod_link)
        db.executemany("INSERT OR IGNORE INTO cve_ref VALUES(?,?)", sorted(ref_link))
        db.executemany("INSERT INTO cve_ver VALUES(?,?,?,?,?,?,?)", ver_rows)

        floors = {table: interners[table].hwm for table in LOOKUP_COLUMNS}
        # D-008: the notice travels with every copy, in-band.
        #
        # `hwm`, `cve_hwm`, `idspace` and `seed_rev` are the ID space's own
        # record (D-056). They are in `meta` rather than a sidecar because the
        # artifact *is* the seed for the next build and the source of the next
        # delta's floors, and a second file to keep alongside it is a second
        # file to lose. The client reads `meta` by key and ignores the rest, so
        # this costs it nothing.
        #
        # `seed_rev` is what makes the seeding discipline checkable rather than
        # advisory: two builds seeded from the same ancestor mint the same id
        # for different values and share a lineage token, so the token alone
        # cannot see it. Naming the revision this build continues lets the
        # publishers refuse an artifact grown from the wrong one.
        space_record = [
            ("idspace", space_id),
            ("hwm", json.dumps(floors, sort_keys=True)),
            ("cve_hwm", cve_hwm),
        ]
        if seeded is not None:
            space_record.append(("seed_rev", seeded["rev"]))
            # And *which* artifact at that revision: a revision number alone
            # cannot tell two builds stamped the same apart, and one of them was
            # never published. The marks it grew from are what the ledger can
            # check against, and what the changeset's floors must equal.
            space_record.append(("seed_marks", json.dumps(id_marks(seeded), sort_keys=True)))
            space_record.append(("seed_fingerprint", seeded["fingerprint"]))
        db.executemany(
            "INSERT INTO meta(k, v) VALUES(?,?)",
            [
                ("schema", SCHEMA_VERSION),
                ("rev", int(rev)),
                ("generated", int(time.time())),
                # Which tree this was built from, for `ingest.py init` to check
                # a clone against. Not part of the ID space, and not hashed into
                # the fingerprint — provenance, not identity.
                ("commit", clone_commit(clone)),
                ("notice", NOTICE),
                *space_record,
            ],
        )
        db.commit()
        db.execute("VACUUM")
        db.close()
    except BaseException:
        # A half-built artifact is worse than none: it is a file a later run
        # can seed from or publish, carrying an ID space that was never
        # finished. Fail closed (D-047) — close the connection and remove it.
        db.close()
        if os.path.exists(out):
            os.remove(out)
        raise

    return {
        "records": records,
        "skipped": skipped,
        "parse_seconds": round(parsed, 1),
        "bytes": os.path.getsize(out),
        "vendors": len(vendor),
        "products": len(product),
        "urls": len(url),
        "hosts": len(host),
        "idspace": space_id,
        "seeded": seed,
        "seed_rev": seeded["rev"] if seeded else None,
        # The floors the next changeset must carry: they describe the revision
        # this build continues, which is exactly the seed's extent.
        "seed_floors": seeded["floors"] if seeded else {},
        # What the next changeset needs: the floors to ship above, the ids whose
        # content moved under an id the client already holds (the `extra` list),
        # and how much of the ID space this build added or stopped using.
        #
        # `extra` is relative to *this build's seed*, so a changeset spanning
        # more than one revision needs the union of every build's since its
        # `from` — which `delta.extract` refuses outright rather than
        # under-shipping silently.
        "floors": floors,
        "cve_hwm": cve_hwm,
        "new_records": minted_records,
        # The record side of retirement, which the ingest's tombstone guard
        # (D-042) is what turns into a decision: records the seed had and this
        # build does not.
        "retired_records": max(0, seed_records - (records - minted_records)) if seeded else 0,
        "minted": {table: interners[table].minted for table in LOOKUP_COLUMNS},
        "retired": {
            table: interners[table].retired
            for table in LOOKUP_COLUMNS
            if interners[table].retired
        },
        "extra": {
            table: sorted(interners[table].changed)
            for table in LOOKUP_COLUMNS
            if interners[table].changed
        },
        "seed_inferred_floors": seeded["inferred"] if seeded else [],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("clone")
    parser.add_argument("out")
    parser.add_argument("--year-min", type=int, default=None)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument(
        "--rev",
        type=int,
        default=1,
        help="The revision to stamp this artifact with. A delta must carry the "
        "revision its source is stamped with (D-055), so the ingest sets this "
        "rather than editing `meta` afterwards — that table now holds the ID "
        "space's own record.",
    )
    space = parser.add_mutually_exclusive_group(required=True)
    space.add_argument(
        "--seed",
        metavar="PREV.SQLITE",
        help="The previous artifact, whose ID space this build continues "
        "(D-056). Seed from the most recent build, not from the last published "
        "snapshot: ids minted by a delta in between are only recorded there.",
    )
    space.add_argument(
        "--bootstrap",
        action="store_true",
        help="Start a new ID space. Every client of the previous one has to "
        "re-download, so this is a deliberate act, not a default.",
    )
    parser.add_argument(
        "--allow-skipped",
        action="store_true",
        help="Deliberate escape hatch for local debugging only: keep the "
        "artifact despite unparseable records.",
    )
    args = parser.parse_args()

    stats = build(
        args.clone,
        args.out,
        args.year_min,
        args.limit,
        seed=args.seed,
        bootstrap=args.bootstrap,
        rev=args.rev,
    )
    skipped = stats["skipped"]
    stats["skipped"] = len(skipped)
    print(json.dumps(stats, indent=2))

    # D-047: fail closed. A record that cannot be parsed must never silently
    # vanish from the published corpus — a handful of losses would sit below
    # the 0.1% tombstone guard and undercount forever (vision criterion 7).
    if skipped:
        for path in skipped:
            print(f"unusable record: {path}", file=sys.stderr)
        if not args.allow_skipped:
            os.remove(args.out)
            print(
                f"error: {len(skipped)} unusable records (unparseable, or an id "
                "that is neither a valid CVE ID nor a usable file name); artifact "
                "deleted (--allow-skipped overrides for local debugging)",
                file=sys.stderr,
            )
            return 1
        print(f"warning: {len(skipped)} unusable records skipped", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
