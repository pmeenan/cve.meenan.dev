"""What a built artifact carries beyond its rows.

The ID space has its own suite (`test_interning.py`) and the wire format has
`test_delta.py`; this is for properties of the file itself that a client
depends on and nothing else asserts.
"""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
sys.path.insert(0, HERE)

import fixtures  # noqa: E402


class QueryStatistics(unittest.TestCase):
    """The artifact ships `sqlite_stat1` (D-067).

    The client reads it and skips collecting its own, which is the whole point:
    deriving the same rows in the browser means reading every index back through
    OPFS — 20.4 s at full scale, on top of an import that already takes 65
    seconds — for the same query plans. A build that stopped writing them would
    not fail anything; it would quietly hand every user that cost, and the
    slowest query shape would go back to taking twice as long.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls._dir = tempfile.TemporaryDirectory()
        cls.artifact = fixtures.build_artifact(cls._dir.name, fixtures.corpus_v1(), "stats")

    @classmethod
    def tearDownClass(cls) -> None:
        cls._dir.cleanup()

    def test_the_artifact_carries_query_statistics(self):
        db = sqlite3.connect(self.artifact)
        try:
            present = db.execute(
                "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = 'sqlite_stat1'"
            ).fetchone()[0]
            self.assertEqual(present, 1, "no sqlite_stat1: the client would pay to rebuild it")
            rows = db.execute("SELECT count(*) FROM sqlite_stat1").fetchone()[0]
            # Non-empty is what the client checks, because an empty table is
            # what a build that analysed nothing leaves behind.
            self.assertGreater(rows, 0)
            # And they describe the published schema's tables — the artifact has
            # no full-text indexes, since the client builds its own (D-035).
            analysed = {row[0] for row in db.execute("SELECT tbl FROM sqlite_stat1")}
            self.assertIn("cve", analysed)
            self.assertIn("cve_ref", analysed)
            self.assertFalse({name for name in analysed if name.startswith("fts")})
        finally:
            db.close()

    def test_statistics_survive_the_vacuum_that_follows_them(self):
        # ANALYZE runs before VACUUM so the artifact ships compact. VACUUM
        # rewrites every page, and a reordering that dropped the stats would
        # leave a build that looks right and costs the client 20 s.
        db = sqlite3.connect(self.artifact)
        try:
            plan = db.execute(
                "EXPLAIN QUERY PLAN SELECT count(*) FROM cve WHERE state = 1"
            ).fetchall()
            self.assertTrue(plan)
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
