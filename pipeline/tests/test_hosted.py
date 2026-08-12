"""The hosted-tier database build (D-084): corpus + FTS + KEV, atomically.

What matters here is what `api/sql.php` will see: the fts5 indexes must cover
exactly the content tables' rows, the `kev` table and its `meta` keys must
match what the *client's* apply would have written (the parity test holds the
SQL equal; this holds the behaviour), and replacement must be by rename with
nothing left behind — every inode an endpoint reader holds must remain
unchanged while a replacement is built.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fixtures  # noqa: E402
import hosted  # noqa: E402
import kev as kev_module  # noqa: E402


def _query(path: str, sql: str, params: tuple = ()) -> list[tuple]:
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        return con.execute(sql, params).fetchall()
    finally:
        con.close()


def _one(path: str, sql: str, params: tuple = ()):
    rows = _query(path, sql, params)
    return rows[0][0] if rows else None


class HostedBuildTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.artifact = fixtures.build_artifact(self.root.name, fixtures.corpus_v1(), "v1", rev=1)
        self.pub = os.path.join(self.root.name, "pub")
        os.makedirs(self.pub)
        kev_module.sample(self.artifact, os.path.join(self.pub, "kev.json"), limit=10)
        self.out = os.path.join(self.root.name, "hosted", "hosted.sqlite")

    def build(self) -> dict:
        return hosted.build(self.artifact, self.pub, self.out)

    def test_fts_indexes_cover_their_content_tables(self) -> None:
        self.build()
        for fts, content, _rowid, _cols in hosted.FTS_INDEXES:
            self.assertEqual(
                _one(self.out, f"SELECT count(*) FROM {fts}"),
                _one(self.out, f"SELECT count(*) FROM {content}"),
                f"{fts} does not cover {content}",
            )
        # A MATCH actually answers — the RE-033 shape, through plain SQL.
        rows = _query(self.out, "SELECT count(*) FROM fts WHERE fts MATCH 'the'")
        self.assertEqual(len(rows), 1)

    def test_kev_overlay_matches_the_catalog(self) -> None:
        self.build()
        with open(os.path.join(self.pub, "kev.json"), "rb") as handle:
            catalog = json.loads(handle.read())
        entries = catalog["vulnerabilities"]
        self.assertEqual(_one(self.out, "SELECT count(*) FROM kev"), len(entries))
        meta = dict(_query(self.out, "SELECT k, v FROM meta WHERE k LIKE 'kev_%'"))
        self.assertEqual(meta["kev_version"], catalog["catalogVersion"])
        self.assertEqual(meta["kev_released"], catalog["dateReleased"])
        self.assertEqual(int(meta["kev_entries"]), len(entries))
        # The sample deliberately carries ids the corpus lacks (D-076): kept,
        # null cve_id, counted.
        unmatched = _one(self.out, "SELECT count(*) FROM kev WHERE cve_id IS NULL")
        self.assertGreater(unmatched, 0)
        self.assertLess(unmatched, len(entries))
        self.assertEqual(int(meta["kev_unmatched"]), unmatched)
        # And the matched half resolved against the corpus's interned ids.
        joined = _one(
            self.out,
            "SELECT count(*) FROM kev JOIN cve ON cve.id = kev.cve_id",
        )
        self.assertEqual(joined, len(entries) - unmatched)

    def test_ransomware_codes_mirror_the_client(self) -> None:
        self.build()
        # sample() writes Known/Unknown only; the mapping is 1/0, never NULL.
        bands = dict(_query(self.out, "SELECT ransomware, count(*) FROM kev GROUP BY 1"))
        self.assertEqual(set(bands), {0, 1})

    def test_replacement_leaves_no_scratch(self) -> None:
        self.build()
        self.build()  # a second run replaces the first
        siblings = [n for n in os.listdir(os.path.dirname(self.out)) if n != "hosted.lock"]
        self.assertEqual(siblings, ["hosted.sqlite"])

    def test_missing_catalog_builds_without_the_overlay(self) -> None:
        os.unlink(os.path.join(self.pub, "kev.json"))
        report = self.build()
        self.assertIn("no kev.json", report["kev"])
        tables = _query(
            self.out, "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'kev'"
        )
        # Absent, not empty: an empty kev table answers "nothing is
        # exploited" where absence refuses the question (D-077).
        self.assertEqual(tables, [])

    def test_refresh_kev_replaces_only_the_overlay(self) -> None:
        self.build()
        before = _one(self.out, "SELECT count(*) FROM cve")
        with open(os.path.join(self.pub, "kev.json"), "rb") as handle:
            catalog = json.loads(handle.read())
        catalog["catalogVersion"] = "2026.08.09"
        catalog["vulnerabilities"] = catalog["vulnerabilities"][:2]
        catalog["count"] = len(catalog["vulnerabilities"])
        with open(os.path.join(self.pub, "kev.json"), "wb") as handle:
            handle.write(json.dumps(catalog).encode("utf-8"))
        report = hosted.refresh_kev(self.pub, self.out)
        self.assertEqual(report["catalogVersion"], "2026.08.09")
        self.assertEqual(_one(self.out, "SELECT count(*) FROM kev"), 2)
        self.assertEqual(
            _one(self.out, "SELECT v FROM meta WHERE k = 'kev_version'"), "2026.08.09"
        )
        self.assertEqual(_one(self.out, "SELECT count(*) FROM cve"), before)

    def test_refresh_kev_without_a_database_skips(self) -> None:
        report = hosted.refresh_kev(self.pub, self.out)
        self.assertIn("skipped", report)
        self.assertFalse(os.path.exists(self.out))

    def test_a_refused_catalog_leaves_the_database_untouched(self) -> None:
        self.build()
        stamp = os.stat(self.out).st_mtime_ns
        with open(os.path.join(self.pub, "kev.json"), "wb") as handle:
            handle.write(b'{"not": "a catalog"}')
        with self.assertRaises(kev_module.Refuse):
            hosted.refresh_kev(self.pub, self.out)
        self.assertEqual(os.stat(self.out).st_mtime_ns, stamp)
        siblings = [n for n in os.listdir(os.path.dirname(self.out)) if n != "hosted.lock"]
        self.assertEqual(siblings, ["hosted.sqlite"])


if __name__ == "__main__":
    unittest.main()
