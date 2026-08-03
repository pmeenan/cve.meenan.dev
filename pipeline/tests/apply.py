"""A reference implementation of delta apply — for tests only.

The client's applier is TypeScript over SQLite/WASM and lands with M2's Sync
task. This one exists so the *wire contract* can be tested for sufficiency:
snapshot N plus a delta must reconstruct snapshot N+1 exactly, and the only way
to know that is to do it (D-055). If the two ever disagree, this file is not
the authority — but it is the thing that proves the format carries enough, and
it is where the apply semantics are written down in executable form:

  * the delta's `from` must equal the local watermark — a delta is a step from
    one specific revision, not a patch that fits anywhere;
  * lookups first, `INSERT OR REPLACE`, in `LOOKUP_COLUMNS` order;
  * tombstones next, so a freed id cannot collide with an upsert;
  * each upsert is a *replacement*: drop the record's dependent rows, then
    insert what the delta carries — absent means absent (D-031);
  * the id/CVE-ID pairing is verified **in both directions** before anything is
    written, because a delta that disagrees with the local database about which
    row a CVE is means the server's ID space has drifted and the only safe
    answer is to stop;
  * the watermark advances inside the same transaction as the rows (D-031), so
    a crash leaves the two agreeing.
"""

from __future__ import annotations

import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import delta as delta_module  # noqa: E402

DEPENDENT_TABLES = ("cve_text", "cve_cwe", "cve_prod", "cve_ref", "cve_ver")


def _drop_record(db: sqlite3.Connection, rowid: int) -> None:
    for table in DEPENDENT_TABLES:
        db.execute(f"DELETE FROM {table} WHERE cve_id = ?", (rowid,))
    db.execute("DELETE FROM cve WHERE id = ?", (rowid,))


def apply(db: sqlite3.Connection, payload: dict) -> None:
    """Apply one delta in a single transaction, or leave the database alone."""
    db.execute("BEGIN")
    try:
        watermark = db.execute("SELECT v FROM meta WHERE k = 'rev'").fetchone()
        local = int(watermark[0]) if watermark else None
        if local != int(payload["from"]):
            raise ValueError(
                f"delta {payload['from']}-{payload['to']} does not start at this "
                f"database's watermark ({local})"
            )

        for table, columns in delta_module.LOOKUP_COLUMNS.items():
            rows = payload["lookups"].get(table) or []
            if rows:
                marks = ",".join("?" * len(columns))
                db.executemany(f"INSERT OR REPLACE INTO {table} VALUES({marks})", rows)

        for cve_id in payload["delete"]:
            found = db.execute("SELECT id FROM cve WHERE cve_id = ?", (cve_id,)).fetchone()
            if found:
                _drop_record(db, found[0])

        for record in payload["upsert"]:
            found = db.execute("SELECT id FROM cve WHERE cve_id = ?", (record["cve"],)).fetchone()
            if found and found[0] != record["id"]:
                raise ValueError(
                    f"{record['cve']} is row {found[0]} locally but {record['id']} in the "
                    "delta: the server's ID space has drifted, and this database has to be "
                    "rebuilt rather than synced"
                )
            # The other direction, which is the one that destroys data: an
            # upsert for a CVE this database has never seen, at a row id it has
            # already given to a *different* CVE. Checking only cve→id let the
            # replacement below delete that record with no error and no orphan
            # to notice it by — a silent undercount, which vision criterion 7
            # exists to prevent.
            occupant = db.execute("SELECT cve_id FROM cve WHERE id = ?", (record["id"],)).fetchone()
            if occupant and occupant[0] != record["cve"]:
                raise ValueError(
                    f"row {record['id']} is {occupant[0]} locally but {record['cve']} in the "
                    "delta: the server's ID space has drifted, and this database has to be "
                    "rebuilt rather than synced"
                )
            _drop_record(db, record["id"])

            cvss = record.get("cvss") or (None, None, None, None)
            db.execute(
                "INSERT INTO cve VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (
                    record["id"],
                    record["cve"],
                    record["y"],
                    record["st"],
                    record.get("cna"),
                    record.get("pub"),
                    record.get("upd"),
                    cvss[0],
                    cvss[1],
                    cvss[2],
                    cvss[3],
                ),
            )
            if record.get("descr"):
                db.execute("INSERT INTO cve_text VALUES(?,?)", (record["id"], record["descr"]))
            db.executemany(
                "INSERT INTO cve_cwe VALUES(?,?)",
                [(record["id"], value) for value in record.get("cwe", ())],
            )
            db.executemany(
                "INSERT INTO cve_prod VALUES(?,?)",
                [(record["id"], value) for value in record.get("prod", ())],
            )
            db.executemany(
                "INSERT INTO cve_ref VALUES(?,?)",
                [(record["id"], value) for value in record.get("ref", ())],
            )
            db.executemany(
                "INSERT INTO cve_ver VALUES(?,?,?,?,?,?,?)",
                [(record["id"], *version) for version in record.get("ver", ())],
            )

        db.execute("UPDATE meta SET v = ? WHERE k = 'rev'", (payload["to"],))
        db.execute("UPDATE meta SET v = ? WHERE k = 'generated'", (payload["generated"],))
        db.commit()
    except Exception:
        db.rollback()
        raise
