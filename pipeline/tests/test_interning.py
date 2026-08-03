"""Tests for the stable ID space (D-025 hazard 1, D-055, D-056).

Interned ids are the client's ids: they are the primary key of every record it
holds, and the whole content of a delta's lookup rows. So the property under
test is narrow and absolute — **rebuilding must not move one** — and the way to
test it is to rebuild corpora that are arranged to provoke movement, then check
the ids by name rather than by position.

Every renumbering test comes in a pair: the unseeded build, which reproduces the
drift and would go on reproducing it silently, and the seeded one, which does
not. Without the first half the second proves only that nothing happened to
change.
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
sys.path.insert(0, HERE)

import apply as apply_module  # noqa: E402
import build  # noqa: E402
import delta  # noqa: E402
import fixtures  # noqa: E402
import ledger  # noqa: E402
import manifest as manifest_module  # noqa: E402
import publish as publish_module  # noqa: E402

LOOKUP_TABLES = tuple(build.LOOKUP_COLUMNS)
RECORD_TABLES = ("cve", "cve_text", "cve_cwe", "cve_prod", "cve_ref", "cve_ver")

# What identifies a value, spelled out rather than imported from
# `build.SEED_KEY`. The identity of a value is the thing these tests are about,
# and a helper that asks the implementation what a value's identity is cannot
# notice the implementation changing its mind — the arity is checked too, since
# these are called against the row's columns positionally.
KEY_OF = {
    "cna": lambda name: name,
    "cwe": lambda cwe, descr: cwe,
    "vendor": lambda name: name,
    "product": lambda vendor_id, name: (vendor_id, name),
    "host": lambda name: name,
    "url": lambda url, host_id: url,
    "vtype": lambda name: name,
}


def _rows(db_path: str, sql: str) -> list:
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        return list(db.execute(sql))
    finally:
        db.close()


def lookup_ids(db_path: str, table: str) -> dict:
    """{interning key: id} for one lookup table.

    Keyed by the value, never by row order: "the id did not move" is a statement
    about what an id means, and comparing rows positionally would pass for two
    artifacts that disagree about every one of them.
    """
    columns = ", ".join(build.LOOKUP_COLUMNS[table])
    return {
        KEY_OF[table](*row[1:]): row[0] for row in _rows(db_path, f"SELECT {columns} FROM {table}")
    }


def record_ids(db_path: str) -> dict:
    return {row[0]: row[1] for row in _rows(db_path, "SELECT cve_id, id FROM cve")}


def meta_of(db_path: str) -> dict:
    return dict(_rows(db_path, "SELECT k, v FROM meta"))


def set_meta(db_path: str, values: dict) -> None:
    """Rewrite `meta` rows; `None` deletes. Damage, or the shape of an artifact
    built before D-056 recorded any of this."""
    db = sqlite3.connect(db_path)
    try:
        for key, value in values.items():
            db.execute("DELETE FROM meta WHERE k = ?", (key,))
            if value is not None:
                db.execute("INSERT INTO meta(k, v) VALUES(?,?)", (key, value))
        db.commit()
    finally:
        db.close()


class Seeding(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="cve-intern-")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.v1 = fixtures.build_artifact(self.root, fixtures.corpus_v1(), "v1", rev=1)

    def assertIdsPreserved(self, before: str, after: str) -> None:
        """Every value the first artifact interned that the second still holds
        means the same id — records included, since `cve.id` is interned too.

        Retirement is legal, so a value the rebuild dropped is not a failure
        here; that a *kept* value did not move is. Tests that also require the
        value to survive assert its presence explicitly.
        """
        for table in LOOKUP_TABLES:
            was, now = lookup_ids(before, table), lookup_ids(after, table)
            for key, row_id in was.items():
                self.assertEqual(now.get(key, row_id), row_id, f"{table} {key!r} moved")
        was, now = record_ids(before), record_ids(after)
        for cve_id, row_id in was.items():
            self.assertEqual(now.get(cve_id, row_id), row_id, f"{cve_id} moved")

    def test_a_seeded_rebuild_of_the_same_corpus_mints_nothing(self):
        """The check on `SEED_KEY`: it recovers each row's interning key from
        its stored columns, and getting one wrong would not raise — it would
        mint a second id for a value that already has one. Rebuilding an
        unchanged corpus is the assertion that catches it, for every table at
        once, because a key stored under one shape and looked up under another
        simply misses."""
        again, stats = fixtures.build_artifact_with_stats(
            self.root, fixtures.corpus_v1(), "again", seed=self.v1
        )
        self.assertEqual(stats["minted"], {table: 0 for table in LOOKUP_TABLES})
        self.assertEqual(stats["new_records"], 0)
        self.assertEqual(stats["retired"], {})
        self.assertEqual(stats["retired_records"], 0)
        self.assertEqual(stats["seed_inferred_floors"], [], "a modern seed infers nothing")
        self.assertIdsPreserved(self.v1, again)
        for table in LOOKUP_TABLES:
            self.assertEqual(
                lookup_ids(self.v1, table), lookup_ids(again, table), f"{table} is not identical"
            )
        self.assertEqual(record_ids(self.v1), record_ids(again))
        self.assertEqual(meta_of(self.v1)["hwm"], meta_of(again)["hwm"])

    def test_one_product_name_under_two_vendors_stays_two_rows(self):
        """`product` is the one composite interning key, and no fixture corpus
        exercised it — every product name appeared under a single vendor, so a
        build that keyed products by name alone would have passed."""
        corpus = fixtures.corpus_v1()
        corpus["CVE-2026-1005"] = {
            "cveMetadata": {"cveId": "CVE-2026-1005", "state": "PUBLISHED"},
            "containers": {
                "cna": {
                    "descriptions": [{"lang": "en", "value": "A different vendor's widget."}],
                    "affected": [{"vendor": "globex", "product": "widget"}],
                }
            },
        }
        collided = fixtures.build_artifact(self.root, corpus, "collide", seed=self.v1)
        products = lookup_ids(collided, "product")
        acme = lookup_ids(collided, "vendor")["acme"]
        globex = lookup_ids(collided, "vendor")["globex"]
        self.assertEqual(products[(acme, "widget")], 1, "the existing row keeps its id")
        self.assertEqual(products[(globex, "widget")], 3, "the same name elsewhere is a new row")

        # And the pairing survives the next rebuild, which is the part that
        # matters: a delta names products by id alone.
        again = fixtures.build_artifact(self.root, corpus, "collide2", seed=collided)
        self.assertEqual(lookup_ids(again, "product"), products)

    def test_an_unseeded_rebuild_renumbers_a_value_a_new_name_sorts_ahead_of(self):
        """The reproduction from D-055: `normalize.projection` sorts each
        record's products, so adding `gadget` to a record that already had
        `gizmo` interned `gadget` first and moved `gizmo` from 2 to 3 — after
        which the delta's rows landed against the wrong product."""
        drifted = fixtures.build_artifact(self.root, fixtures.corpus_v2(), "unseeded")
        was = lookup_ids(self.v1, "product")
        now = lookup_ids(drifted, "product")
        gizmo = next(key for key in was if key[1] == "gizmo")
        self.assertEqual(was[gizmo], 2)
        self.assertEqual(now[gizmo], 3, "the fixture no longer provokes the drift it is here for")

    def test_a_seeded_rebuild_keeps_it_and_appends_the_new_value(self):
        seeded = fixtures.build_artifact(self.root, fixtures.corpus_v2(), "seeded", seed=self.v1)
        self.assertIdsPreserved(self.v1, seeded)
        products = lookup_ids(seeded, "product")
        gizmo = next(key for key in products if key[1] == "gizmo")
        gadget = next(key for key in products if key[1] == "gadget")
        self.assertEqual(products[gizmo], 2)
        self.assertEqual(products[gadget], 3, "a new value appends above the high-water mark")

    def test_an_unseeded_rebuild_renumbers_records_inserted_ahead_of_others(self):
        """`cve.id` was a bare walk counter, and the walk is sorted by file
        name: one record added at the front renumbered every record behind it,
        and the delta then carried each of them at its neighbour's id — which
        apply refuses, so sync wedges until a full re-download."""
        corpus = fixtures.corpus_v1()
        corpus["CVE-2026-1000"] = {
            "cveMetadata": {"cveId": "CVE-2026-1000", "state": "PUBLISHED"},
            "containers": {"cna": {"descriptions": [{"lang": "en", "value": "First."}]}},
        }
        drifted = fixtures.build_artifact(self.root, corpus, "records-unseeded")
        self.assertEqual(record_ids(self.v1)["CVE-2026-1001"], 1)
        self.assertEqual(record_ids(drifted)["CVE-2026-1001"], 2)

        seeded = fixtures.build_artifact(self.root, corpus, "records-seeded", seed=self.v1)
        self.assertIdsPreserved(self.v1, seeded)
        self.assertEqual(record_ids(seeded)["CVE-2026-1001"], 1)
        self.assertEqual(record_ids(seeded)["CVE-2026-1000"], 3)

    def test_a_value_the_first_record_stops_using_does_not_move(self):
        """The other direction of encounter order: when the record that first
        interned a value stops using it, the next record to use it inherits the
        id (D-055 hit this while writing `corpus_v3`)."""
        v2 = fixtures.build_artifact(self.root, fixtures.corpus_v2(), "v2", rev=2, seed=self.v1)
        drifted = fixtures.build_artifact(self.root, fixtures.corpus_drift(), "drift-unseeded")
        self.assertEqual(lookup_ids(v2, "cwe")["CWE-79"], 1)
        self.assertEqual(
            lookup_ids(drifted, "cwe")["CWE-79"], 2, "the fixture no longer provokes the drift"
        )

        seeded = fixtures.build_artifact(self.root, fixtures.corpus_drift(), "drift", seed=v2)
        self.assertIdsPreserved(v2, seeded)
        # Explicitly present, not merely unmoved: `assertIdsPreserved` tolerates
        # retirement, so on its own it would pass for a build that dropped them.
        self.assertEqual(lookup_ids(seeded, "cwe")["CWE-79"], 1)
        self.assertEqual(lookup_ids(seeded, "cwe")["CWE-787"], 2)
        # The url only that record cited is retired instead — and its id stays
        # reserved, which is the floor not moving.
        self.assertNotIn("javascript:alert(1)", lookup_ids(seeded, "url"))
        self.assertEqual(fixtures.floors(seeded)["url"], fixtures.floors(v2)["url"])


class Retirement(unittest.TestCase):
    """A value the corpus stops using loses its row but keeps its id forever.

    Carrying dead rows forward instead was the alternative, and it costs the
    largest table in the corpus: `url` only ever grows. Retiring is safe because
    an id can only be *referenced* while its value has been interned
    continuously since it was minted — a value that comes back after being
    dropped is not in the seed, so it mints a new id rather than resurrecting
    the old one.
    """

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="cve-retire-")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.v1 = fixtures.build_artifact(self.root, fixtures.corpus_v1(), "v1", rev=1)

    def _without_gizmo(self) -> dict:
        corpus = fixtures.corpus_v1()
        corpus["CVE-2026-1002"]["containers"]["cna"]["affected"] = [
            {"vendor": "acme", "product": "widget"}
        ]
        return corpus

    def test_the_row_goes_and_the_id_stays_reserved(self):
        self.assertEqual(lookup_ids(self.v1, "product")[(1, "gizmo")], 2)
        pruned, stats = fixtures.build_artifact_with_stats(
            self.root, self._without_gizmo(), "pruned", seed=self.v1
        )
        self.assertEqual(stats["retired"], {"product": 1})
        self.assertNotIn((1, "gizmo"), lookup_ids(pruned, "product"))
        self.assertEqual(
            _rows(pruned, "SELECT coalesce(max(id), 0) FROM product")[0][0], 1, "the row is gone"
        )
        self.assertEqual(json.loads(meta_of(pruned)["hwm"])["product"], 2, "the id is not")
        self.assertEqual(fixtures.floors(pruned)["product"], 2, "and the floor is the reserved id")

    def test_the_next_value_does_not_inherit_a_retired_id(self):
        """The hazard behind recording the high-water mark instead of
        recomputing `max(id)`: retiring the *highest* row lowers the maximum, so
        a rebuild that trusted it would hand a retired id to a different value
        while clients still hold the old one — and no delta would ship the
        correction, because the id is below their floor."""
        pruned = fixtures.build_artifact(self.root, self._without_gizmo(), "pruned", seed=self.v1)
        corpus = self._without_gizmo()
        corpus["CVE-2026-1002"]["containers"]["cna"]["affected"].append(
            {"vendor": "acme", "product": "sprocket"}
        )
        grown = fixtures.build_artifact(self.root, corpus, "grown", seed=pruned)
        self.assertEqual(lookup_ids(grown, "product")[(1, "sprocket")], 3)

    def test_a_returning_value_gets_a_new_id_rather_than_its_old_one(self):
        """Which is what makes retirement safe: an id that has been out of the
        artifact cannot come back meaning what it used to, so a client holding
        the stale row can never be told to use it again."""
        pruned = fixtures.build_artifact(self.root, self._without_gizmo(), "pruned", seed=self.v1)
        back = fixtures.build_artifact(self.root, fixtures.corpus_v1(), "back", seed=pruned)
        self.assertEqual(lookup_ids(back, "product")[(1, "gizmo")], 3)

    def test_a_retired_record_id_is_reserved_and_counted(self):
        corpus = {k: v for k, v in fixtures.corpus_v1().items() if k != "CVE-2026-1002"}
        pruned, stats = fixtures.build_artifact_with_stats(self.root, corpus, "one", seed=self.v1)
        self.assertEqual(int(meta_of(pruned)["cve_hwm"]), 2)
        # The tombstone guard's input (D-042): records the seed had and this
        # build does not.
        self.assertEqual(stats["retired_records"], 1)
        corpus["CVE-2026-1004"] = {
            "cveMetadata": {"cveId": "CVE-2026-1004", "state": "PUBLISHED"},
            "containers": {"cna": {"descriptions": [{"lang": "en", "value": "Later."}]}},
        }
        grown = fixtures.build_artifact(self.root, corpus, "two", seed=pruned)
        self.assertEqual(record_ids(grown)["CVE-2026-1004"], 3)


class Recorded(unittest.TestCase):
    """What the artifact records about its own ID space, and who reads it."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="cve-idspace-")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.v1 = fixtures.build_artifact(self.root, fixtures.corpus_v1(), "v1", rev=1)

    def _corpus(self, name: str) -> str:
        return fixtures.write_corpus(os.path.join(self.root, name), fixtures.corpus_v1())

    def test_a_revision_json_cannot_carry_is_refused(self):
        """`isRevision` in `lib/protocol.ts` caps a revision at 2^53-1 and the
        client refuses the whole manifest carrying a larger one; SQLite stores
        an int64 without complaint, so the bound belongs where the number enters
        the contract."""
        with self.assertRaisesRegex(ValueError, "outside the range a JSON number"):
            build.build(
                self._corpus("c8"),
                os.path.join(self.root, "big.sqlite"),
                None,
                None,
                bootstrap=True,
                rev=2**53,
            )

    def test_a_half_recorded_ancestry_is_refused(self):
        """Each part of it feeds a different check, so a missing one silently
        disables that check rather than announcing itself."""
        for missing in ("seed_rev", "seed_marks", "seed_fingerprint"):
            with self.subTest(missing=missing):
                seeded = fixtures.build_artifact(
                    self.root, fixtures.corpus_v2(), f"partial-{missing}", rev=2, seed=self.v1
                )
                set_meta(seeded, {missing: None})
                with self.assertRaisesRegex(ValueError, "incomplete ancestry"):
                    build.id_space(seeded)

    def test_a_build_must_choose_seed_or_bootstrap(self):
        """Neither answer is defaultable: starting empty renumbers a published
        corpus, and seeding a bootstrap silently inherits an ID space."""
        clone = self._corpus("c")
        out = os.path.join(self.root, "neither.sqlite")
        with self.assertRaisesRegex(ValueError, "no safe default"):
            build.build(clone, out, None, None)
        with self.assertRaisesRegex(ValueError, "no safe default"):
            build.build(clone, out, None, None, seed=self.v1, bootstrap=True)

    def test_a_seeded_build_cannot_be_relabelled(self):
        """A seeded build's lineage is the seed's by definition; overriding it
        produces the seed's ids under a foreign name, which both publishers then
        refuse."""
        with self.assertRaisesRegex(ValueError, "ID space is the seed's"):
            build.build(
                self._corpus("c2"),
                os.path.join(self.root, "relabelled.sqlite"),
                None,
                None,
                seed=self.v1,
                idspace="deadbeefdeadbeef",
            )

    def test_a_build_cannot_seed_from_the_file_it_writes(self):
        """It works right up until anything fails, and then the ID space is
        gone: the seed is read, the file is truncated, and the marks and lineage
        exist nowhere else."""
        with self.assertRaisesRegex(ValueError, "also the seed"):
            build.build(self._corpus("c3"), self.v1, None, None, seed=self.v1)
        self.assertTrue(meta_of(self.v1)["idspace"], "the seed survived")

    def test_a_bounded_build_cannot_be_seeded(self):
        """A slice retires everything outside its bounds, permanently: the next
        full build re-mints those values at new ids while clients hold the old
        ones. `--year-min`/`--limit` are development options, and development
        bootstraps."""
        for bounds in ({"year_min": 2026}, {"limit": 1}):
            with self.assertRaisesRegex(ValueError, "retires every value outside it"):
                build.build(
                    self._corpus("c4"),
                    os.path.join(self.root, "slice.sqlite"),
                    bounds.get("year_min"),
                    bounds.get("limit"),
                    seed=self.v1,
                )

    def test_two_files_claiming_one_cve_id_fail_the_build_closed(self):
        """Reachable from record content (rule 5): `cveId` is publisher-supplied
        and a corrupted clone can hold a record twice. Both then take the same
        row id, and the artifact died on a UNIQUE violation — or earlier, inside
        the id sort, with a `TypeError` naming nothing."""
        corpus = fixtures.corpus_v1()
        corpus["CVE-2026-1009"] = json.loads(json.dumps(corpus["CVE-2026-1001"]))
        corpus["CVE-2026-1009"]["cveMetadata"]["datePublished"] = None
        clone = fixtures.write_corpus(os.path.join(self.root, "dup"), corpus)
        out = os.path.join(self.root, "dup.sqlite")
        stats = build.build(clone, out, None, None, bootstrap=True)
        self.assertEqual(len(stats["skipped"]), 1)
        self.assertEqual(stats["records"], 2)
        self.assertEqual(len(record_ids(out)), 2)

    def test_a_failed_build_leaves_no_artifact_behind(self):
        """A half-built file is one a later run can seed from or publish,
        carrying an ID space that was never finished.

        The trigger is a lone surrogate in a description — legal JSON that
        `sqlite3` refuses to encode, so the build dies *after* the file exists
        (RE-015). That it dies with a traceback rather than through `skipped` is
        RE-015's problem; that it leaves nothing behind is this one's.
        """
        corpus = fixtures.corpus_v1()
        corpus["CVE-2026-1001"]["containers"]["cna"]["descriptions"] = [
            {"lang": "en", "value": json.loads('"\\ud800"')}
        ]
        out = os.path.join(self.root, "doomed.sqlite")
        with self.assertRaises(UnicodeEncodeError):
            build.build(
                fixtures.write_corpus(os.path.join(self.root, "surrogate"), corpus),
                out,
                None,
                None,
                bootstrap=True,
            )
        self.assertFalse(os.path.exists(out))

    def test_a_damaged_seed_fails_before_anything_is_written(self):
        out = os.path.join(self.root, "not-written.sqlite")
        broken = os.path.join(self.root, "broken-seed.sqlite")
        shutil.copy(self.v1, broken)
        set_meta(broken, {"hwm": "not json"})
        with self.assertRaisesRegex(ValueError, "not readable JSON"):
            build.build(self._corpus("c5"), out, None, None, seed=broken)
        self.assertFalse(os.path.exists(out))

    def test_the_floors_a_delta_needs_are_the_ids_issued_not_the_ids_left(self):
        """The distinction the record exists for, on the artifact where the two
        actually differ: `product` has retired its highest row, so `max(id)` is
        1 while the floor a delta must ship above is 2."""
        corpus = fixtures.corpus_v1()
        corpus["CVE-2026-1002"]["containers"]["cna"]["affected"] = [
            {"vendor": "acme", "product": "widget"}
        ]
        pruned = fixtures.build_artifact(self.root, corpus, "pruned", seed=self.v1)
        self.assertEqual(_rows(pruned, "SELECT coalesce(max(id),0) FROM product")[0][0], 1)
        self.assertEqual(fixtures.floors(pruned)["product"], 2)

    def test_seeding_across_a_schema_change_is_refused(self):
        """Ids are only meaningful against the shape that assigned them, and a
        schema bump makes every client re-download anyway (D-025 hazard 4). The
        consequence is deliberate: a schema bump forces `--bootstrap`, which
        mints a new lineage, which needs `publish.py --new-id-space`."""
        other = os.path.join(self.root, "other-schema.sqlite")
        shutil.copy(self.v1, other)
        set_meta(other, {"schema": 2})
        with self.assertRaisesRegex(ValueError, "not the same ID space"):
            build.build(
                self._corpus("c6"), os.path.join(self.root, "x.sqlite"), None, None, seed=other
            )

    def test_an_artifact_from_before_this_existed_can_still_be_seeded_from(self):
        """The generation live on 2026-08-02 records none of this, and is
        recognised by having no lineage at all. Its `max(id)` *is* its
        high-water mark — an unseeded build never retires anything — so adopting
        it is exact rather than a guess, and the build says what it inferred."""
        legacy = os.path.join(self.root, "legacy.sqlite")
        shutil.copy(self.v1, legacy)
        set_meta(legacy, {"hwm": None, "cve_hwm": None, "idspace": None, "seed_rev": None})
        out = os.path.join(self.root, "adopted.sqlite")
        stats = build.build(
            fixtures.write_corpus(os.path.join(self.root, "c7"), fixtures.corpus_v2()),
            out,
            None,
            None,
            seed=legacy,
        )
        self.assertEqual(stats["seed_inferred_floors"], sorted(LOOKUP_TABLES + ("cve",)))
        self.assertTrue(stats["idspace"], "a lineage is minted for the ids it adopts")
        for table in LOOKUP_TABLES:
            was, now = lookup_ids(legacy, table), lookup_ids(out, table)
            for key, row_id in was.items():
                self.assertEqual(now.get(key, row_id), row_id, f"{table} {key!r} moved")
        self.assertEqual(record_ids(out)["CVE-2026-1001"], 1)

    def test_a_damaged_id_space_record_is_refused_rather_than_inferred(self):
        """Every one of these used to either crash with a bare parse error
        naming no file, or fall back to `max(id)` and look exactly like a
        pre-D-056 artifact — which is a wrong floor, silently."""
        for damage, pattern in (
            ({"hwm": "not json"}, "not readable JSON"),
            ({"hwm": "[1,2,3]"}, "expected an object"),
            ({"hwm": '{"product": "x"}'}, "expected a count"),
            ({"hwm": '{"products": 1}'}, "unknown lookup table"),
            ({"hwm": '{"product": 1}'}, "missing"),
            ({"hwm": None}, "no high-water marks"),
            ({"cve_hwm": None}, "no meta.cve_hwm"),
        ):
            with self.subTest(damage=damage):
                broken = os.path.join(self.root, "broken.sqlite")
                shutil.copy(self.v1, broken)
                set_meta(broken, damage)
                with self.assertRaisesRegex(ValueError, pattern):
                    build.id_space(broken)

    def test_a_record_below_the_ids_it_describes_is_refused(self):
        """Rows above the recorded mark mean the record does not describe the
        artifact. The two uses of that number want opposite repairs — a mint
        floor wants the higher value, a delta floor the lower — so it is an
        error rather than a choice."""
        broken = os.path.join(self.root, "low.sqlite")
        shutil.copy(self.v1, broken)
        marks = json.loads(meta_of(broken)["hwm"])
        marks["product"] = 1
        set_meta(broken, {"hwm": json.dumps(marks)})
        with self.assertRaisesRegex(ValueError, "above its recorded high-water mark"):
            build.id_space(broken)

        shutil.copy(self.v1, broken)
        set_meta(broken, {"cve_hwm": 1})
        with self.assertRaisesRegex(ValueError, "above its recorded high-water mark"):
            build.id_space(broken)

    def test_the_revision_is_stamped_by_the_build(self):
        """A delta must carry the revision its source is stamped with (D-055),
        so the ingest sets it here rather than editing `meta` afterwards — that
        table now holds the ID space's own record."""
        stamped = fixtures.build_artifact(
            self.root, fixtures.corpus_v2(), "r7", rev=7, seed=self.v1
        )
        self.assertEqual(int(meta_of(stamped)["rev"]), 7)
        self.assertEqual(int(meta_of(stamped)["seed_rev"]), 1, "and which revision it continues")
        self.assertIsNone(meta_of(self.v1).get("seed_rev"), "a bootstrap continues nothing")

    def test_floors_that_are_not_the_revision_the_source_continues_are_refused(self):
        """`extract` used to say it could not check whether the floors were the
        right ones. It can: they describe the ID space at `from`, and the
        artifact records the extent it was seeded from. A floor that is too high
        under-ships lookup rows, and `_check_closure` reads the gap as "the
        client already has it"."""
        v2 = fixtures.build_artifact(self.root, fixtures.corpus_v2(), "v2", rev=2, seed=self.v1)
        with self.assertRaisesRegex(ValueError, "are not the ID space at rev 1"):
            delta.extract(
                v2,
                from_rev=1,
                to_rev=2,
                upsert=["CVE-2026-1003"],
                delete=[],
                floors=fixtures.floors(v2),  # rev 2's floors, not rev 1's
                generated=fixtures.FIXED_GENERATED,
            )

    def test_a_content_change_under_an_existing_id_is_reported_for_extra(self):
        """The one thing a floor cannot see (D-055): `cwe.descr` is a column
        that is not part of its own key, so it can move under an id the client
        already holds. (`url.host_id` is not one — it is a function of the url
        text, and host ids are seeded, so it cannot move while the url is
        interned.) The build reports it; the changeset's `extra` ships it."""
        corpus = fixtures.corpus_v1()
        problem = corpus["CVE-2026-1001"]["containers"]["cna"]["problemTypes"]
        problem[0]["descriptions"][0]["description"] = "Cross-site Scripting"
        changed, stats = fixtures.build_artifact_with_stats(
            self.root, corpus, "descr", rev=2, seed=self.v1
        )
        self.assertEqual(stats["extra"], {"cwe": [1]})
        self.assertEqual(lookup_ids(changed, "cwe")["CWE-79"], 1)

        payload = delta.extract(
            changed,
            from_rev=1,
            to_rev=2,
            upsert=["CVE-2026-1001"],
            delete=[],
            floors=fixtures.floors(self.v1),
            extra=stats["extra"],
            generated=fixtures.FIXED_GENERATED,
        )
        self.assertEqual(payload["lookups"]["cwe"], [[1, "CWE-79", "Cross-site Scripting"]])


class Lineage(unittest.TestCase):
    """The name of an ID space, the revision it continues, and the publishers
    that check both.

    Nothing on the wire carries either (D-055 deliberately left an ID-space
    marker out of `FORMAT_VERSION` 1): the client cannot tell a renumbered ID
    space from a correct one except by the `cve` tripwire, which covers records
    and not lookups. So the checks are the publisher's, against the ledger,
    where a mismatch is still fixable.
    """

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="cve-lineage-")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.published = fixtures.publish_fixture(self.root)
        self.pub = self.published["pub"]

    def test_the_token_travels_with_the_ids(self):
        snapshot, following = self.published["snapshot"], self.published["next"]
        self.assertTrue(meta_of(snapshot)["idspace"])
        self.assertEqual(meta_of(snapshot)["idspace"], meta_of(following)["idspace"])
        self.assertEqual(ledger.idspace(self.pub), meta_of(snapshot)["idspace"])

        fresh = fixtures.build_artifact(self.root, fixtures.corpus_v1(), "fresh")
        self.assertNotEqual(meta_of(fresh)["idspace"], meta_of(snapshot)["idspace"])

    def test_publishing_a_snapshot_from_another_id_space_is_refused(self):
        """The easy mistake, and the expensive one: a rebuild that forgot to
        seed publishes cleanly, and every client's rows then mean something
        else."""
        unseeded = fixtures.build_artifact(
            self.root, fixtures.corpus_v2(), "unseeded", rev=3, generated=fixtures.FIXED_GENERATED
        )
        with self.assertRaisesRegex(SystemExit, "everything published here belongs to"):
            publish_module.publish(unseeded, self.pub, quality=5, jobs=2)
        self.assertEqual(manifest_module.load(self.pub)["snapshot"]["rev"], 1)

    def test_a_delta_from_another_id_space_is_refused(self):
        unseeded = fixtures.build_artifact(self.root, fixtures.corpus_v2(), "unseeded-delta", rev=2)
        with self.assertRaisesRegex(SystemExit, "everything published here belongs to"):
            delta.publish(unseeded, self.pub, self.published["changeset"], quality=5)

    def test_a_snapshot_seeded_from_the_wrong_ancestor_is_refused(self):
        """The break the lineage token cannot see: two builds from one ancestor
        share it, and each mints the same ids for different values. The
        revision the build continued is what tells them apart."""
        stale = fixtures.build_artifact(
            self.root,
            fixtures.corpus_v2(),
            "stale",
            rev=3,
            generated=fixtures.FIXED_GENERATED,
            seed=self.published["snapshot"],  # rev 1, while the head is 2
        )
        with self.assertRaisesRegex(SystemExit, "seeded from rev 1 but the data plane is at rev 2"):
            publish_module.publish(stale, self.pub, quality=5, jobs=2)
        self.assertEqual(manifest_module.load(self.pub)["snapshot"]["rev"], 1)

    def test_a_delta_whose_source_continues_another_revision_is_refused(self):
        """The same break on the delta side, where `extra` makes it worse: the
        set of ids whose content moved is computed against the seed, so a
        payload spanning a revision it was not built from omits them silently."""
        stale = fixtures.build_artifact(
            self.root, fixtures.corpus_v3(), "stale-delta", rev=3, seed=self.published["snapshot"]
        )
        with self.assertRaisesRegex(ValueError, "continues rev 1 but the changeset starts at 2"):
            delta.extract(
                stale,
                from_rev=2,
                to_rev=3,
                upsert=["CVE-2026-1003"],
                delete=[],
                floors=fixtures.floors(self.published["next"]),
                generated=fixtures.FIXED_GENERATED,
            )

    def test_retiring_an_id_space_needs_a_revision_above_the_head(self):
        """"Every client re-downloads" is only true if the manifest stops
        offering them a no-op: `planSync` reports "already current" whenever the
        watermark equals head, so retiring an ID space *at* head — the legal
        monthly-rebuild landing — left every synced client on the old ids, and
        the next delta then applied to them."""
        at_head = fixtures.build_artifact(
            self.root,
            fixtures.corpus_v2(),
            "at-head",
            rev=2,
            generated=fixtures.FIXED_GENERATED + 1,
        )
        with self.assertRaisesRegex(SystemExit, "above the published head"):
            publish_module.publish(at_head, self.pub, quality=5, jobs=2, new_id_space=True)
        self.assertEqual(manifest_module.load(self.pub)["rev"], 2)
        self.assertEqual(ledger.idspace(self.pub), meta_of(self.published["snapshot"])["idspace"])

    def test_retiring_an_id_space_retires_its_deltas_with_it(self):
        fresh = fixtures.build_artifact(
            self.root,
            fixtures.corpus_v2(),
            "fresh-space",
            rev=3,
            generated=fixtures.FIXED_GENERATED + 1,
        )
        publish_module.publish(fresh, self.pub, quality=5, jobs=2, new_id_space=True)
        published = manifest_module.load(self.pub)
        self.assertEqual(published["snapshot"]["rev"], 3)
        self.assertEqual(published["rev"], 3, "head is above every watermark a client can hold")
        self.assertEqual(published["deltas"], [])
        self.assertEqual(ledger.idspace(self.pub), meta_of(fresh)["idspace"])

    def test_an_artifact_that_records_no_id_space_is_never_published(self):
        """Fail closed (D-047): an unrecorded lineage cannot be checked against
        what clients already hold, so it is refused rather than assumed to be
        the current one."""
        anonymous = os.path.join(self.root, "anonymous.sqlite")
        shutil.copy(self.published["next"], anonymous)
        set_meta(anonymous, {"idspace": None})
        with self.assertRaisesRegex(SystemExit, "records no ID space"):
            publish_module.publish(anonymous, self.pub, quality=5, jobs=2, force=True)
        with self.assertRaisesRegex(SystemExit, "records no ID space"):
            delta.publish(anonymous, self.pub, self.published["changeset"], quality=5)

    def test_an_unknown_lineage_over_a_published_data_plane_is_not_adopted_silently(self):
        """The migration window, and the one publish that will actually happen
        next: the live generation predates all of this, so the ledger has no
        token to compare against. Adopting whatever arrives would bless an
        unseeded rebuild that renumbered every deployed client, so adoption over
        published artifacts is an explicit act."""
        os.unlink(ledger.path(self.pub))  # as if this data plane predates the ledger
        self.assertEqual(ledger.idspace(self.pub), "")
        self.assertTrue(ledger.anything_published(self.pub))

        rebuilt = fixtures.build_artifact(
            self.root,
            fixtures.corpus_v2(),
            "rebuilt",
            rev=3,
            generated=fixtures.FIXED_GENERATED + 1,
            seed=self.published["next"],
        )
        with self.assertRaisesRegex(SystemExit, "--adopt-id-space"):
            publish_module.publish(rebuilt, self.pub, quality=5, jobs=2)
        publish_module.publish(rebuilt, self.pub, quality=5, jobs=2, adopt_id_space=True)
        self.assertEqual(ledger.idspace(self.pub), meta_of(rebuilt)["idspace"])

    def test_adoption_must_land_above_the_head_it_cannot_prove_it_continues(self):
        """A legacy data plane has no recorded fingerprint, so adoption cannot
        *prove* the ids continue what clients hold — it is an operator's word.
        Landing above head is what makes being wrong survivable: every client
        re-downloads instead of silently keeping ids that now mean something
        else."""
        os.unlink(ledger.path(self.pub))
        at_head = fixtures.build_artifact(
            self.root,
            fixtures.corpus_v2(),
            "adopt-at-head",
            rev=2,
            generated=fixtures.FIXED_GENERATED + 1,
            seed=self.published["snapshot"],
        )
        with self.assertRaisesRegex(SystemExit, "adopting an ID space needs a revision above"):
            publish_module.publish(
                at_head, self.pub, quality=5, jobs=2, force=True, adopt_id_space=True
            )

    def test_a_delta_never_establishes_a_lineage(self):
        """It cannot prove which ID space the snapshot its clients downloaded
        belongs to, so adopting on its say-so would bless whatever arrived
        first — including the unseeded rebuild that this window exists because
        of."""
        os.unlink(ledger.path(self.pub))
        with self.assertRaisesRegex(SystemExit, "--adopt-id-space"):
            delta.publish(self.published["next"], self.pub, self.published["changeset"], quality=5)
        self.assertEqual(ledger.idspace(self.pub), "")

    def test_the_lineage_lands_in_the_same_write_as_the_snapshot(self):
        """They describe one event. As two writes, a crash between them left the
        manifest serving a new ID space while the ledger still named the retired
        one — after which a delta from the old space was accepted, because it
        matched what the ledger said.

        Asserting the end state cannot tell one write from two, so this counts
        them: the guarantee is atomicity, not the contents afterwards.
        """
        elsewhere = os.path.join(self.root, "elsewhere")
        os.makedirs(elsewhere, exist_ok=True)
        saves = []
        real_save = ledger.save
        ledger.save = lambda pub_dir, data: saves.append(json.loads(json.dumps(data)))
        try:
            ledger.record_snapshot(
                elsewhere, 3, 2, "tokentokentoken", {"marks": {}, "fingerprint": "abc"}
            )
        finally:
            ledger.save = real_save
        self.assertEqual(len(saves), 1, "the snapshot and its lineage are one write")
        self.assertEqual(saves[0]["idspace"], "tokentokentoken")
        self.assertIn("3", saves[0]["snapshots"])
        self.assertIn("3", saves[0]["space"])

    def test_what_an_id_means_at_a_published_revision_cannot_be_rewritten(self):
        """The `rev == published_head` exception is only safe because of this:
        a sibling stamped at head used to be accepted *and* to overwrite the
        recorded fingerprint, after which its own descendants passed the check
        that should have caught them — the thing being compared against had
        moved."""
        sibling = fixtures.build_artifact(
            self.root,
            fixtures.corpus_drift(),
            "sibling-at-head",
            rev=2,
            generated=fixtures.FIXED_GENERATED + 1,
            seed=self.published["snapshot"],
        )
        before = ledger.space_at(self.pub, 2)["fingerprint"]
        self.assertNotEqual(build.fingerprint(sibling), before)
        with self.assertRaisesRegex(SystemExit, "published with a different ID space"):
            publish_module.publish(sibling, self.pub, quality=5, jobs=2)
        self.assertEqual(ledger.space_at(self.pub, 2)["fingerprint"], before)
        # Refused *before* anything irreversible: the ledger would catch it at
        # the end too, but by then the generation directory has been renamed
        # into place. Same shape as the delta's pre-write tiling check.
        self.assertFalse(os.path.exists(os.path.join(self.pub, "snapshot-2")))

    def test_the_whole_recorded_id_space_is_compared_not_part_of_it(self):
        """Comparing a *part* of the record before publishing while the ledger
        compared all of it was worse than not checking here at all: an artifact
        whose recorded marks differ but whose rows do not passed, was renamed
        into place, and was then rejected by the ledger — leaving the immutable
        URL occupied by bytes nothing had registered, which blocked the correct
        artifact from ever being published there."""
        tampered = os.path.join(self.root, "tampered-marks.sqlite")
        shutil.copy(self.published["next"], tampered)
        marks = json.loads(meta_of(tampered)["hwm"])
        marks["product"] += 1
        set_meta(tampered, {"hwm": json.dumps(marks, sort_keys=True)})
        self.assertEqual(
            build.fingerprint(tampered),
            ledger.space_at(self.pub, 2)["fingerprint"],
            "the rows are untouched — only the recorded extent moved",
        )

        with self.assertRaisesRegex(SystemExit, "published with a different ID space"):
            publish_module.publish(tampered, self.pub, quality=5, jobs=2)
        self.assertFalse(os.path.exists(os.path.join(self.pub, "snapshot-2")))
        # And the correct artifact is still publishable there, which is what the
        # occupied URL took away.
        publish_module.publish(self.published["next"], self.pub, quality=5, jobs=2)
        self.assertEqual(manifest_module.load(self.pub)["snapshot"]["rev"], 2)

        # And the ledger refuses to be talked into it directly, which is what
        # makes a byte-identical delta retry safe rather than merely usual.
        with self.assertRaisesRegex(SystemExit, "cannot be rewritten"):
            ledger.record_delta(
                self.pub,
                dict(self.published["delta"]),
                {"marks": {}, "fingerprint": "0000000000000000"},
            )

    def test_a_revision_whose_id_space_was_never_recorded_is_not_built_on(self):
        """A run that died between exposing a revision and recording its ID
        space leaves a gap, and a gap used to read as "nothing to check" — which
        is the one state in which a descendant of the wrong sibling gets in."""
        with open(ledger.path(self.pub), encoding="utf-8") as handle:
            recorded = json.load(handle)
        del recorded["space"]["2"]
        with open(ledger.path(self.pub), "w", encoding="utf-8") as handle:
            json.dump(recorded, handle)

        third = fixtures.build_artifact(
            self.root,
            fixtures.corpus_v3(),
            "third",
            rev=3,
            generated=fixtures.FIXED_GENERATED + 1,
            seed=self.published["next"],
        )
        with self.assertRaisesRegex(SystemExit, "no record of the ID space"):
            delta.publish(
                third,
                self.pub,
                {
                    "from": 2,
                    "to": 3,
                    "upsert": ["CVE-2026-1003"],
                    "delete": [],
                    "floors": fixtures.floors(self.published["next"]),
                    "generated": fixtures.FIXED_GENERATED + 1,
                },
                quality=5,
            )

    def test_floors_are_checked_against_the_ledger_not_the_artifact(self):
        """The artifact's own record of its seed is self-authenticating: editing
        it moves the floor the emitter trusts. Raising the product floor by one
        produced a delta referencing a product row it did not ship, which
        `_check_closure` reads as "the client already has it"."""
        tampered = os.path.join(self.root, "tampered.sqlite")
        shutil.copy(self.published["next"], tampered)
        marks = json.loads(meta_of(tampered)["seed_marks"])
        marks["floors"]["product"] = marks["floors"]["product"] + 1
        set_meta(tampered, {"seed_marks": json.dumps(marks, sort_keys=True)})
        with self.assertRaisesRegex(SystemExit, "are not the ID space this data plane published"):
            delta.publish(
                tampered,
                self.pub,
                {**self.published["changeset"], "floors": marks["floors"]},
                quality=5,
                force=True,
            )

    def test_an_interrupted_snapshot_resumes_on_identical_bytes(self):
        """The rename lands before the ledger and manifest writes, so a crash in
        between leaves a generation on disk that nothing registered. Re-cutting
        the same bytes is not a rewrite, so the retry completes the run — rather
        than needing `--force`, which is local-iteration precisely because it
        *can* replace bytes."""
        rebuilt = fixtures.build_artifact(
            self.root,
            fixtures.corpus_v2(),
            "resume",
            rev=3,
            generated=fixtures.FIXED_GENERATED + 1,
            seed=self.published["next"],
        )
        real_save = manifest_module.save
        manifest_module.save = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("crash"))
        try:
            with self.assertRaises(RuntimeError):
                publish_module.publish(rebuilt, self.pub, quality=5, jobs=2)
        finally:
            manifest_module.save = real_save

        publish_module.publish(rebuilt, self.pub, quality=5, jobs=2)
        self.assertEqual(manifest_module.load(self.pub)["snapshot"]["rev"], 3)

        # A *different* artifact at that revision is still refused, which is the
        # difference between resuming and rewriting.
        different = fixtures.build_artifact(
            self.root,
            fixtures.corpus_v3(),
            "different",
            rev=3,
            generated=fixtures.FIXED_GENERATED + 2,
            seed=self.published["next"],
        )
        with self.assertRaisesRegex(SystemExit, "different ID space|immutable"):
            publish_module.publish(different, self.pub, quality=5, jobs=2)

    def test_a_delta_landing_on_a_recorded_revision_must_agree_with_it(self):
        """A second delta can reach a revision another already published — a
        chain skipping an intermediate one, which `planSync` searches for and
        D-055 says the format allows. If it lands there from a different ID
        space, clients that took the two routes end up disagreeing about what an
        id means, so it is refused before the file is written rather than by the
        ledger after it."""
        third = fixtures.build_artifact(
            self.root,
            fixtures.corpus_v3(),
            "third",
            rev=3,
            generated=fixtures.FIXED_GENERATED + 1,
            seed=self.published["next"],
        )
        delta.publish(
            third,
            self.pub,
            {
                "from": 2,
                "to": 3,
                "upsert": ["CVE-2026-1003"],
                "delete": [],
                "floors": fixtures.floors(self.published["next"]),
                "generated": fixtures.FIXED_GENERATED + 1,
            },
            quality=5,
        )
        # A different artifact, also at rev 3, also legitimately continuing rev 1
        # — so every other check passes and only the landing revision's recorded
        # ID space separates them.
        other = fixtures.build_artifact(
            self.root,
            fixtures.corpus_drift(),
            "other-third",
            rev=3,
            generated=fixtures.FIXED_GENERATED + 2,
            seed=self.published["snapshot"],
        )
        self.assertNotEqual(build.fingerprint(other), ledger.space_at(self.pub, 3)["fingerprint"])
        with self.assertRaisesRegex(SystemExit, "published with a different ID space"):
            delta.publish(
                other,
                self.pub,
                {
                    "from": 1,
                    "to": 3,
                    "upsert": ["CVE-2026-1001"],
                    "delete": [],
                    "floors": fixtures.floors(self.published["snapshot"]),
                    "generated": fixtures.FIXED_GENERATED + 2,
                },
                quality=5,
            )
        self.assertFalse(os.path.exists(os.path.join(self.pub, "deltas", "1-3.json.br")))

    def test_the_recorded_fingerprint_is_the_one_the_next_build_records(self):
        """The check is only meaningful if both sides compute the same value:
        the seed's, folded into the pass that loads it, and the artifact's, read
        back in a separate process at publish time."""
        child = fixtures.build_artifact(
            self.root, fixtures.corpus_v3(), "child", rev=3, seed=self.published["next"]
        )
        self.assertEqual(
            meta_of(child)["seed_fingerprint"], build.fingerprint(self.published["next"])
        )
        self.assertEqual(
            ledger.space_at(self.pub, 2)["fingerprint"], build.fingerprint(self.published["next"])
        )

    def test_a_publish_interrupted_before_the_manifest_can_be_re_run(self):
        """The ledger is written first, because the chunks are already served by
        then. If the manifest went first and the ledger never landed, the data
        plane advertised a revision the ledger had never heard of — and every
        recovery path was refused by a guard the failed attempt had created."""
        rebuilt = fixtures.build_artifact(
            self.root,
            fixtures.corpus_v2(),
            "interrupted",
            rev=3,
            generated=fixtures.FIXED_GENERATED + 1,
            seed=self.published["next"],
        )
        real_save = manifest_module.save
        manifest_module.save = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("crash"))
        try:
            with self.assertRaises(RuntimeError):
                publish_module.publish(rebuilt, self.pub, quality=5, jobs=2)
        finally:
            manifest_module.save = real_save

        # The ledger knows; the manifest does not. Re-running the same publish
        # completes it rather than being refused.
        self.assertTrue(ledger.snapshot_published(self.pub, 3))
        publish_module.publish(rebuilt, self.pub, quality=5, jobs=2, force=True)
        self.assertEqual(manifest_module.load(self.pub)["snapshot"]["rev"], 3)

    def test_a_bootstrap_can_never_adopt_a_published_id_space(self):
        """The hole `--adopt-id-space` opened: a bootstrap continues nothing, so
        adopting on its behalf blesses exactly the unseeded rebuild the flag
        exists to keep out — and at `rev == head` the clients it renumbers are
        told they are already current."""
        os.unlink(ledger.path(self.pub))
        unseeded = fixtures.build_artifact(
            self.root,
            fixtures.corpus_v2(),
            "bootstrap-adopt",
            rev=3,
            generated=fixtures.FIXED_GENERATED + 1,
        )
        with self.assertRaisesRegex(SystemExit, "a bootstrap continues nothing"):
            publish_module.publish(unseeded, self.pub, quality=5, jobs=2, adopt_id_space=True)
        self.assertEqual(manifest_module.load(self.pub)["snapshot"]["rev"], 1)

    def test_a_sibling_of_the_published_artifact_is_refused(self):
        """Two builds can be stamped at one revision — a re-run after a failure,
        a local iteration — and they share a lineage token while minting
        different values at the same ids. `seed_rev` alone cannot separate them;
        the extent of the ID space each grew from can."""
        sibling = fixtures.build_artifact(
            self.root,
            fixtures.corpus_drift(),  # a different rev-2 build of the same corpus
            "sibling",
            rev=2,
            generated=fixtures.FIXED_GENERATED,
            seed=self.published["snapshot"],
        )
        grandchild = fixtures.build_artifact(
            self.root,
            fixtures.corpus_v2(),
            "grandchild",
            rev=3,
            generated=fixtures.FIXED_GENERATED + 1,
            seed=sibling,
        )
        changeset = {
            "from": 2,
            "to": 3,
            "upsert": ["CVE-2026-1001"],
            "delete": [],
            "floors": fixtures.floors(sibling),
            "generated": fixtures.FIXED_GENERATED + 1,
        }
        with self.assertRaisesRegex(SystemExit, "but not the artifact published there"):
            delta.publish(grandchild, self.pub, changeset, quality=5)
        with self.assertRaisesRegex(SystemExit, "but not the artifact published there"):
            publish_module.publish(grandchild, self.pub, quality=5, jobs=2)

    def test_the_artifact_the_last_delta_came_from_can_be_published_at_head(self):
        """The monthly rebuild lands at `rev == published_head` (D-055), and the
        artifact that produced head was seeded from head-1 — so requiring every
        snapshot to *continue* head would refuse the one artifact clients are
        actually synced to."""
        published = publish_module.publish(self.published["next"], self.pub, quality=5, jobs=2)
        self.assertEqual(published["rev"], 2)
        self.assertEqual(manifest_module.load(self.pub)["snapshot"]["rev"], 2)

    def test_the_head_the_deltas_reached_survives_a_lost_manifest(self):
        """`published_head` used to come from the snapshot revisions alone, so a
        missing manifest lowered it — and `--new-id-space` at a revision clients
        were already at became legal again."""
        self.assertEqual(ledger.highest_published(self.pub), 2)
        os.unlink(manifest_module.path(self.pub))
        fresh = fixtures.build_artifact(
            self.root,
            fixtures.corpus_v2(),
            "after-loss",
            rev=2,
            generated=fixtures.FIXED_GENERATED + 1,
        )
        with self.assertRaisesRegex(SystemExit, "above the published head"):
            publish_module.publish(fresh, self.pub, quality=5, jobs=2, new_id_space=True)


class Sufficiency(unittest.TestCase):
    """The end-to-end proof: snapshot N + delta == snapshot N+1, across a
    rebuild whose ids would otherwise have moved.

    `test_delta.py` proves the wire format carries enough. This proves the ids
    in it still mean the same thing after a rebuild — which is the half that was
    arranged around rather than tested before D-056.
    """

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="cve-suff-")
        self.addCleanup(shutil.rmtree, self.root, True)

    def test_a_drift_provoking_rebuild_still_reconstructs_exactly(self):
        v1 = fixtures.build_artifact(self.root, fixtures.corpus_v1(), "v1", rev=1)
        v2 = fixtures.build_artifact(self.root, fixtures.corpus_v2(), "v2", rev=2, seed=v1)
        # The first record drops the CWE and references it interned — which
        # renumbers unseeded — and gains a new reference, so the delta also
        # carries freshly minted lookup rows rather than only proving that
        # nothing moved.
        corpus = fixtures.corpus_drift()
        corpus["CVE-2026-1001"]["containers"]["cna"]["references"] = [
            {"url": "https://later.example.net/advisory"}
        ]
        v3 = fixtures.build_artifact(self.root, corpus, "v3", rev=3, seed=v2)

        payload = delta.extract(
            v3,
            from_rev=2,
            to_rev=3,
            upsert=["CVE-2026-1001"],
            delete=[],
            floors=fixtures.floors(v2),
            generated=fixtures.FIXED_GENERATED,
        )
        self.assertTrue(payload["lookups"]["url"], "the delta ships a newly minted row")
        applied = os.path.join(self.root, "applied.sqlite")
        shutil.copy(v2, applied)
        db = sqlite3.connect(applied)
        try:
            apply_module.apply(db, payload)
        finally:
            db.close()

        for table in RECORD_TABLES:
            self.assertEqual(
                fixtures.table_rows(applied, table),
                fixtures.table_rows(v3, table),
                f"{table} diverged",
            )
        # Lookups: every row the new snapshot has, the synced client has too —
        # containment rather than equality, because the client keeps the rows
        # this rebuild retired. That is the design (D-056), and it is why M2's
        # "identical to a freshly built one" is a claim about the *downloaded*
        # database.
        for table in LOOKUP_TABLES:
            self.assertLessEqual(
                set(fixtures.table_rows(v3, table)), set(fixtures.table_rows(applied, table))
            )

    def test_a_delta_the_manifest_could_not_hold_is_never_written(self):
        """The bridging delta M2's monthly rebuild needs: emitted from a rebuilt
        snapshot, it starts below that snapshot's revision, and `assert_tiling`
        refuses it. Asked after publication that is unrecoverable — the file is
        served and the ledger has recorded its bytes, so even a corrected
        payload for the range is refused."""
        root = self.root
        v1 = fixtures.build_artifact(root, fixtures.corpus_v1(), "v1", rev=1)
        v2 = fixtures.build_artifact(root, fixtures.corpus_v2(), "v2", rev=2, seed=v1)
        pub = os.path.join(root, "pub")
        os.makedirs(pub, exist_ok=True)
        publish_module.publish(v1, pub, quality=5, jobs=2)
        delta.publish(
            v2,
            pub,
            {
                "from": 1,
                "to": 2,
                "upsert": ["CVE-2026-1003"],
                "delete": [],
                "floors": fixtures.floors(v1),
                "generated": fixtures.FIXED_GENERATED,
            },
            quality=5,
        )
        rebuilt = fixtures.build_artifact(
            root, fixtures.corpus_v2(), "v3", rev=3, generated=fixtures.FIXED_GENERATED + 1, seed=v2
        )
        publish_module.publish(rebuilt, pub, quality=5, jobs=2)

        bridging = {
            "from": 2,
            "to": 3,
            "upsert": [],
            "delete": [],
            "floors": fixtures.floors(v2),
            "generated": fixtures.FIXED_GENERATED + 1,
        }
        with self.assertRaisesRegex(SystemExit, "unreachable|do not tile"):
            delta.publish(rebuilt, pub, bridging, quality=5)
        self.assertFalse(os.path.exists(os.path.join(pub, "deltas", "2-3.json.br")))
        self.assertNotIn("2-3.json.br", ledger.load(pub)["deltas"])


if __name__ == "__main__":
    unittest.main()
