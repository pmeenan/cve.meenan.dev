"""The hosted query tier's database (D-084): corpus + FTS + KEV, in one file.

`api/sql.php` answers a visitor who has no local copy by running their
compiled SQL against a server-side copy of the same database the client
would have built. That copy is this module's output: the ingest's own
artifact (`rev-N.sqlite`), plus the two things the *client* normally builds
for itself after import —

  - the three external-content fts5 indexes (`lib/search.ts`, D-035), and
  - the CISA KEV overlay table with its `meta` keys (`lib/kev.ts`, D-076).

The statements here mirror those two files exactly, and
`tests/unit/hosted-parity.test.ts` fails the build when they drift: a hosted
tier whose `kev` table or fts columns differ from the local tier's is two
products answering one question differently.

**Replacement is by atomic rename, never in place.** PHP cannot express an
`immutable=1` SQLite URI (RE-036), so the endpoint uses a plain read-only open;
`os.replace` still guarantees that readers hold the old, unchanged inode and
new requests open the finished replacement. The scratch file is pid-qualified
and unlinked on any failure — the publish directory here is *not* web-reachable
(D-053), so a stray `.tmp` is disk noise rather than the cache poisoning
`kev.py` guards against, but it is still noise.

**Two crons write this file, so it has its own lock.** The daily ingest
rebuilds it whole; the 6-hourly KEV job refreshes only the `kev` table (by
copy-and-replace, per the immutability promise). `hosted.lock` lives beside
the output; neither caller holds the pipeline lock or the KEV lock while
taking it, and a held lock is a skip, not a failure — the next cron covers
it (D-042's shape).

Failure domain: deliberately *advisory* for both callers. A delta that
published and a hosted rebuild that failed is a working data plane with a
stale hosted tier — the callers log it and exit clean, and `hosted.py build`
run by hand is the repair.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import shutil
import sqlite3
import sys
import time

import kev as kev_module
import state as state_module

EXIT_OK = 0
EXIT_FAIL = 1

LOCK_NAME = "hosted.lock"

# --- mirrors of lib/search.ts (SEARCH_INDEXES / indexSql) --------------------
#
# (fts table, content table, content rowid, indexed columns). Column order is
# load-bearing there for the incremental 'delete' protocol (RE-005); it is
# kept identical here so the two tiers' MATCH results agree.

FTS_INDEXES = (
    ("fts", "cve_text", "cve_id", ("descr", "title")),
    ("fts_vendor", "vendor", "id", ("name",)),
    ("fts_product", "product", "id", ("name",)),
)


def _fts_statements(fts: str, content: str, rowid: str, columns: tuple[str, ...]) -> list[str]:
    cols = ", ".join(columns)
    return [
        f"DROP TABLE IF EXISTS {fts}",
        (
            f"CREATE VIRTUAL TABLE {fts} USING fts5("
            f"{cols}, content='{content}', content_rowid='{rowid}')"
        ),
        f"INSERT INTO {fts}(rowid, {cols}) SELECT {rowid}, {cols} FROM {content}",
    ]


# --- mirrors of lib/kev.ts (KEV_DDL / KEV_INSERT / KEV_META) ------------------

KEV_DDL = (
    """CREATE TABLE IF NOT EXISTS kev(
     cve        TEXT PRIMARY KEY,
     cve_id     INTEGER,
     vendor     TEXT,
     product    TEXT,
     name       TEXT,
     descr      TEXT,
     action     TEXT,
     added      TEXT,
     added_at   INTEGER,
     due        TEXT,
     due_at     INTEGER,
     ransomware INTEGER,
     notes      TEXT,
     cwes       TEXT
   )""",
    "CREATE INDEX IF NOT EXISTS i_kev_cve ON kev(cve_id)",
)

KEV_INSERT = (
    "INSERT INTO kev(cve, cve_id, vendor, product, name, descr, action, added, added_at, "
    "due, due_at, ransomware, notes, cwes) "
    "VALUES(?, (SELECT id FROM cve WHERE cve_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
)

KEV_META = {
    "version": "kev_version",
    "released": "kev_released",
    "releasedAt": "kev_released_at",
    "fetched": "kev_fetched",
    "entries": "kev_entries",
    "unmatched": "kev_unmatched",
}


def _day_seconds(day: str) -> int:
    """`YYYY-MM-DD` as unix seconds at UTC midnight — `lib/kev.ts daySeconds`."""
    parsed = datetime.datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=datetime.timezone.utc)
    return int(parsed.timestamp())


def _ransomware_code(value: str) -> int | None:
    """`lib/kev.ts ransomwareCode`: Known 1, Unknown 0, anything else NULL —
    an unrecognised upstream value is *kept visible* as "not stated", never
    folded into a finding."""
    word = value.strip().lower()
    if word == "known":
        return 1
    if word == "unknown":
        return 0
    return None


def _apply_kev(con: sqlite3.Connection, catalog: dict, fetched_at: int) -> dict:
    """The server-side twin of the Worker's `applyKev`: one transaction for the
    table, the rows and the `meta` keys, so a failure leaves whatever was
    there before intact and consistent."""
    released_at = kev_module._released_at(str(catalog["dateReleased"]))
    if released_at is None:  # validate() already refused this; belt only.
        raise kev_module.Refuse("catalog dateReleased is not a timestamp")
    entries = catalog["vulnerabilities"]
    with con:
        con.execute("DROP TABLE IF EXISTS kev")
        for statement in KEV_DDL:
            con.execute(statement)
        for entry in entries:
            cve = str(entry["cveID"])
            con.execute(
                KEV_INSERT,
                (
                    cve,
                    cve,
                    str(entry["vendorProject"]),
                    str(entry["product"]),
                    str(entry["vulnerabilityName"]),
                    str(entry["shortDescription"]),
                    str(entry["requiredAction"]),
                    str(entry["dateAdded"]),
                    _day_seconds(str(entry["dateAdded"])),
                    str(entry["dueDate"]),
                    _day_seconds(str(entry["dueDate"])),
                    _ransomware_code(str(entry.get("knownRansomwareCampaignUse", ""))),
                    str(entry["notes"]),
                    json.dumps(entry.get("cwes", [])),
                ),
            )
        (unmatched,) = con.execute("SELECT count(*) FROM kev WHERE cve_id IS NULL").fetchone()
        meta = {
            KEV_META["version"]: str(catalog["catalogVersion"]),
            KEV_META["released"]: str(catalog["dateReleased"]),
            KEV_META["releasedAt"]: int(released_at),
            KEV_META["fetched"]: int(fetched_at),
            KEV_META["entries"]: len(entries),
            KEV_META["unmatched"]: int(unmatched),
        }
        for key, value in meta.items():
            con.execute("INSERT OR REPLACE INTO meta(k, v) VALUES(?, ?)", (key, value))
    return {"entries": len(entries), "unmatched": int(unmatched)}


def _assert_fts5(con: sqlite3.Connection) -> None:
    """Fail closed if this Python's SQLite has no fts5 — a hosted DB without
    the indexes would make every full-text query on the hosted tier fail."""
    try:
        con.execute("CREATE VIRTUAL TABLE temp.fts5_probe USING fts5(x)")
        con.execute("DROP TABLE temp.fts5_probe")
    except sqlite3.OperationalError as error:
        raise RuntimeError(f"this Python's SQLite cannot build fts5 indexes: {error}") from error


def _read_catalog(pub_dir_or_file: str) -> dict:
    """The published `kev.json`, re-validated. It was validated on the way out
    (`kev.py`), but this reader may run months later against a file something
    else replaced — both ends check, as `lib/kev.ts` puts it."""
    path = (
        pub_dir_or_file
        if pub_dir_or_file.endswith(".json")
        else kev_module.published_path(pub_dir_or_file)
    )
    with open(path, "rb") as handle:
        blob = handle.read(kev_module.MAX_BYTES + 1)
    return kev_module.validate(blob)


def _replace(scratch: str, out: str) -> None:
    """fsync + atomic rename, `kev.py publish`'s shape: after this returns the
    new file is durably at `out`, and any reader that already opened the old
    inode keeps reading its unchanged bytes."""
    directory = os.path.dirname(os.path.abspath(out))
    with open(scratch, "rb") as handle:
        os.fsync(handle.fileno())
    os.chmod(scratch, 0o644)
    os.replace(scratch, out)
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _scratch_for(out: str) -> str:
    return f"{out}.{os.getpid()}.tmp"


def build(artifact: str, pub_dir: str, out: str) -> dict:
    """Full rebuild: copy the built artifact, add FTS, add KEV, rename in.

    `pub_dir` is where `kev.json` is served from; a missing or invalid catalog
    builds the database *without* a `kev` table, which the tiers already know
    how to be honest about — a KEV question is refused, never answered as
    "not exploited" (D-077).
    """
    started = time.time()
    os.makedirs(os.path.dirname(os.path.abspath(out)), mode=0o755, exist_ok=True)
    with state_module.lock(os.path.dirname(os.path.abspath(out)), name=LOCK_NAME):
        scratch = _scratch_for(out)
        try:
            shutil.copyfile(artifact, scratch)
            con = sqlite3.connect(scratch)
            try:
                con.execute("PRAGMA journal_mode=MEMORY")
                _assert_fts5(con)
                for fts, content, rowid, columns in FTS_INDEXES:
                    with con:
                        for statement in _fts_statements(fts, content, rowid, columns):
                            con.execute(statement)
                kev_report: dict | str
                try:
                    catalog = _read_catalog(pub_dir)
                    kev_report = _apply_kev(con, catalog, int(started))
                except FileNotFoundError:
                    kev_report = "no kev.json published; built without the overlay"
                except kev_module.Refuse as refusal:
                    kev_report = f"kev.json refused ({refusal}); built without the overlay"
            finally:
                con.close()
            _replace(scratch, out)
        except BaseException:
            try:
                os.unlink(scratch)
            except FileNotFoundError:
                pass
            raise
    return {
        "action": "hosted-build",
        "out": os.path.abspath(out),
        "bytes": os.path.getsize(out),
        "kev": kev_report,
        "seconds": round(time.time() - started, 1),
    }


def refresh_kev(pub_dir: str, out: str) -> dict:
    """Refresh only the `kev` table: copy the live file, rewrite the overlay,
    rename in. A copy rather than an in-place write keeps every inode held by
    an endpoint reader unchanged while the replacement is built."""
    started = time.time()
    if not os.path.exists(out):
        # Nothing to refresh: the first daily build will carry this catalog.
        return {"action": "hosted-kev", "out": os.path.abspath(out), "skipped": "no hosted db yet"}
    catalog = _read_catalog(pub_dir)
    with state_module.lock(os.path.dirname(os.path.abspath(out)), name=LOCK_NAME):
        scratch = _scratch_for(out)
        try:
            shutil.copyfile(out, scratch)
            con = sqlite3.connect(scratch)
            try:
                con.execute("PRAGMA journal_mode=MEMORY")
                applied = _apply_kev(con, catalog, int(started))
            finally:
                con.close()
            _replace(scratch, out)
        except BaseException:
            try:
                os.unlink(scratch)
            except FileNotFoundError:
                pass
            raise
    return {
        "action": "hosted-kev",
        "out": os.path.abspath(out),
        "catalogVersion": str(catalog["catalogVersion"]),
        **applied,
        "seconds": round(time.time() - started, 1),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    builder = sub.add_parser("build", help="Full rebuild from a built artifact.")
    builder.add_argument("artifact", help="A rev-N.sqlite the ingest built.")
    builder.add_argument("pub_dir", help="Where kev.json is served from (cve.pub/data).")
    builder.add_argument("out", help="The hosted database path (cve.data/hosted/hosted.sqlite).")

    refresher = sub.add_parser("kev", help="Refresh only the KEV overlay in the hosted database.")
    refresher.add_argument("pub_dir")
    refresher.add_argument("out")

    args = parser.parse_args()
    try:
        if args.command == "build":
            report = build(args.artifact, args.pub_dir, args.out)
        else:
            report = refresh_kev(args.pub_dir, args.out)
    except state_module.Busy as busy:
        print(f"skipped: {busy}", file=sys.stderr)
        return EXIT_OK
    except (kev_module.Refuse, RuntimeError, OSError, sqlite3.Error) as failure:
        print(f"error: {failure}", file=sys.stderr)
        return EXIT_FAIL

    print(json.dumps(report, indent=2))
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
