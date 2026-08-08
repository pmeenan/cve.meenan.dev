"""Tests for the delta wire contract (D-031, D-055).

Three things are checked here, and the third is the one that matters:

  1. **Shape** — the envelope, the lookup ordering, and the rule that an absent
     key means an absent row rather than an unchanged one.
  2. **Guards** — a delta that names a record the artifact does not have, or
     that would reference a lookup row the client will never receive, must fail
     the build rather than ship (D-047).
  3. **Sufficiency** — snapshot N plus the delta reconstructs snapshot N+1
     exactly. A format that types cleanly but loses a column is still wrong,
     and this is the only test that can tell the difference. The reference
     applier lives in `apply.py`.
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
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

RECORD_TABLES = ("cve", "cve_text", "cve_cwe", "cve_prod", "cve_ref", "cve_ver")
LOOKUP_TABLES = tuple(delta.LOOKUP_COLUMNS)

ENVELOPE_KEYS = [
    "format",
    "schema",
    "from",
    "to",
    "generated",
    "notice",
    "lookups",
    "upsert",
    "delete",
]


class Corpus(unittest.TestCase):
    """One build of each fixture corpus, shared by every test below."""

    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="cve-delta-")
        cls.addClassCleanup(shutil.rmtree, cls.root, True)
        cls.v1 = fixtures.build_artifact(cls.root, fixtures.corpus_v1(), "v1", rev=1)
        # Seeded, as every rebuild of a published corpus is (D-056): v2 renames
        # a product ahead of an existing one, so an unseeded rebuild renumbers
        # and every sufficiency test below would be comparing two ID spaces.
        cls.v2 = fixtures.build_artifact(
            cls.root, fixtures.corpus_v2(), "v2", rev=2, seed=cls.v1
        )
        cls.floors_v1 = fixtures.floors(cls.v1)

    def delta_v1_to_v2(self) -> dict:
        return delta.extract(
            self.v2,
            from_rev=1,
            to_rev=2,
            upsert=["CVE-2026-1001", "CVE-2026-1002", "CVE-2026-1003"],
            delete=[],
            floors=self.floors_v1,
            generated=fixtures.FIXED_GENERATED,
        )

    def everything(self, artifact: str) -> dict:
        """A delta that ships the whole artifact — the shape tests read this.

        It is a bootstrap from rev 0 to whatever the artifact is stamped with:
        empty floors mean "the client has nothing", and the range has to end
        where the artifact says it is.
        """
        cve_ids = [row[0] for row in _rows(artifact, "SELECT cve_id FROM cve")]
        rev = int(_rows(artifact, "SELECT v FROM meta WHERE k = 'rev'")[0][0])
        return delta.extract(
            artifact,
            from_rev=0,
            to_rev=rev,
            upsert=cve_ids,
            delete=[],
            floors={},
            generated=fixtures.FIXED_GENERATED,
        )


def _rows(db_path: str, sql: str) -> list:
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        return list(db.execute(sql))
    finally:
        db.close()


class WireShape(Corpus):
    def test_envelope_is_exactly_the_contract(self):
        payload = self.delta_v1_to_v2()
        self.assertEqual(list(payload), ENVELOPE_KEYS)
        self.assertEqual(payload["format"], delta.FORMAT_VERSION)
        self.assertEqual(payload["schema"], build.SCHEMA_VERSION)
        self.assertEqual((payload["from"], payload["to"]), (1, 2))
        self.assertEqual(payload["generated"], fixtures.FIXED_GENERATED)

    def test_lookups_are_ordered_so_apply_can_insert_them_as_they_come(self):
        payload = self.delta_v1_to_v2()
        order = list(payload["lookups"])
        self.assertEqual(order, list(LOOKUP_TABLES))
        self.assertLess(order.index("vendor"), order.index("product"))
        self.assertLess(order.index("host"), order.index("url"))

    def test_only_rows_above_the_floor_ship(self):
        payload = self.delta_v1_to_v2()
        for table, rows in payload["lookups"].items():
            floor = self.floors_v1[table]
            for row in rows:
                self.assertGreater(row[0], floor, f"{table} row {row} is already in the snapshot")
        # v2 adds a vendor (globex) and products, so this is not vacuous.
        self.assertTrue(payload["lookups"]["vendor"])
        self.assertTrue(payload["lookups"]["product"])

    def test_carries_the_notice_in_band(self):
        payload = self.delta_v1_to_v2()
        self.assertIn("The MITRE Corporation", payload["notice"])
        self.assertIn("reproduce MITRE's copyright designation and this license", payload["notice"])

    def test_absent_means_absent_for_a_sparse_record(self):
        """CVE-2026-1002 in v1 has no English description, no CWE, no
        reference, no CVSS, no SSVC assessment and no title — the wire form says
        so by omission (D-031). What it *does* have is a rejection reason, which
        is the only English text any REJECTED record carries (D-070)."""
        record = _record(self.everything(self.v1), "CVE-2026-1002")
        for key in ("descr", "cwe", "ref", "cvss", "upd", "ssvc", "title", "res"):
            self.assertNotIn(key, record)
        self.assertEqual(record["st"], 2)  # REJECTED, imported and filterable (D-022)
        self.assertEqual(record["reason"], "Withdrawn: duplicate of CVE-2026-1001.")
        self.assertIn("prod", record)

    def test_a_full_record_carries_every_section_of_the_schema(self):
        record = _record(self.everything(self.v1), "CVE-2026-1001")
        every_column = ["id", "cve", "y", "st", "cna", "pub", "upd", "res", "cvss", "ssvc"]
        every_column += ["descr", "title", "cwe", "prod", "ref", "ver"]
        # `reason` is the one column no single record can carry beside the rest:
        # only a REJECTED record has one, and this record is PUBLISHED.
        self.assertEqual(sorted(record), sorted(every_column))
        self.assertEqual(record["cvss"][0], 31)
        self.assertEqual(record["cvss"][1], 7.5)
        self.assertEqual(record["cvss"][2], 3)
        self.assertEqual(record["ssvc"], [1, 0, 1])  # poc / no / total
        self.assertEqual(len(record["ver"]), 2)
        self.assertEqual(len(record["ref"]), 2)

    def test_a_partial_ssvc_assessment_keeps_its_gaps(self):
        """CVE-2026-1003 states Exploitation and Technical Impact and not
        Automatable. The gap is NULL on the wire, because "not assessed" and
        `no` are different findings and folding them understates every band
        (D-070)."""
        record = _record(self.everything(self.v2), "CVE-2026-1003")
        self.assertEqual(record["ssvc"], [2, None, 0])  # active / not assessed / partial

    def test_a_products_default_status_rides_with_its_id(self):
        """`cve_prod` gained a column at schema 2, so `prod` carries a pair. The
        two `globex/sprocket` entries collide on one row and the conservative
        default wins — `affected`, not the `unaffected` seen first (D-070)."""
        record = _record(self.everything(self.v2), "CVE-2026-1003")
        self.assertEqual([len(entry) for entry in record["prod"]], [2])
        self.assertEqual(record["prod"][0][1], 1)  # 1 affected, in cve_ver's vocabulary

    def test_cvss_version_codes_are_carried_not_compared(self):
        """v4.0 stores as 4 and v2.0 as 2; the wire carries the stored code, and
        nothing downstream may order them numerically (D-047)."""
        payload = self.everything(self.v2)
        self.assertEqual(_record(payload, "CVE-2026-1003")["cvss"][0], 4)
        self.assertEqual(_record(payload, "CVE-2026-1002")["cvss"][0], 2)

    def test_hostile_text_travels_verbatim(self):
        """Markup, quotes, control characters and non-ASCII are data (rule 5).
        They round-trip through SQLite and JSON without being sanitized here —
        rendering is where escaping belongs, not the wire."""
        record = _record(self.everything(self.v1), "CVE-2026-1001")
        self.assertEqual(record["descr"], fixtures.HOSTILE_TEXT)
        encoded = json.dumps(record, ensure_ascii=False).encode("utf-8")
        self.assertEqual(json.loads(encoded.decode("utf-8"))["descr"], fixtures.HOSTILE_TEXT)

    def test_a_reference_with_no_host_still_interns_one(self):
        """`javascript:alert(1)` has no authority component, so its host is the
        empty string — a real row the delta has to carry, not a null."""
        payload = self.everything(self.v1)
        hosts = {row[0]: row[1] for row in payload["lookups"]["host"]}
        urls = {row[1]: row[2] for row in payload["lookups"]["url"]}
        self.assertIn("javascript:alert(1)", urls)
        self.assertEqual(hosts[urls["javascript:alert(1)"]], "")

    def test_upserts_and_tombstones_are_sorted_and_deduplicated(self):
        payload = delta.extract(
            self.v2,
            from_rev=1,
            to_rev=2,
            upsert=["CVE-2026-1003", "CVE-2026-1002", "CVE-2026-1003"],
            delete=["CVE-2026-9999", "CVE-2026-9998", "CVE-2026-9999"],
            floors=self.floors_v1,
            generated=fixtures.FIXED_GENERATED,
        )
        self.assertEqual([r["cve"] for r in payload["upsert"]], ["CVE-2026-1002", "CVE-2026-1003"])
        self.assertEqual(payload["delete"], ["CVE-2026-9998", "CVE-2026-9999"])

    def test_a_republish_that_moved_only_dateupdated_still_ships_whole(self):
        """The commonest upstream change (D-031). Whole-record replacement means
        the payload is the same size as any other update — which is the cost
        D-031 priced and accepted."""
        record = _record(self.delta_v1_to_v2(), "CVE-2026-1001")
        before = _record(self.everything(self.v1), "CVE-2026-1001")
        self.assertNotEqual(record["upd"], before["upd"])
        self.assertEqual(record["descr"], before["descr"])

    def test_emission_is_deterministic(self):
        """Same changeset, same bytes — which is what makes re-running an
        interrupted ingest checkable rather than hopeful.

        Run in *separate processes with different hash seeds*, because the
        realistic non-determinism here is set iteration order: emitting twice
        in one process compares two runs that share it, and passes even with
        every `ORDER BY` and `sorted()` removed.
        """
        digests = set()
        for seed in ("0", "1"):
            workspace = os.path.join(self.root, f"determinism-{seed}")
            environment = {**os.environ, "PYTHONHASHSEED": seed}
            run = subprocess.run(
                [sys.executable, os.path.join(HERE, "fixture_pub.py"), workspace],
                capture_output=True,
                text=True,
                env=environment,
                check=True,
            )
            entry = json.loads(run.stdout)["delta"]
            digests.add(entry["sha256"])
        self.assertEqual(len(digests), 1, "the same changeset emitted different bytes")


class Guards(Corpus):
    def test_an_upsert_the_artifact_does_not_have_fails_the_build(self):
        with self.assertRaisesRegex(ValueError, "does not contain"):
            delta.extract(
                self.v2,
                from_rev=1,
                to_rev=2,
                upsert=["CVE-2026-4040"],
                delete=[],
                floors=self.floors_v1,
                generated=fixtures.FIXED_GENERATED,
            )

    def test_a_backwards_range_fails(self):
        for bad in ((2, 2), (3, 2)):
            with self.assertRaisesRegex(ValueError, "not increasing"):
                delta.extract(
                    self.v2,
                    from_rev=bad[0],
                    to_rev=bad[1],
                    upsert=[],
                    delete=[],
                    floors={},
                    generated=fixtures.FIXED_GENERATED,
                )

    def test_an_unshipped_lookup_row_is_caught(self):
        """The guard, exercised directly: dropping a lookup row the upserts
        reference is what a future 'only ship what is referenced' optimization
        would get wrong."""
        payload = self.delta_v1_to_v2()
        self.assertTrue(payload["lookups"]["product"])
        payload["lookups"]["product"] = payload["lookups"]["product"][:-1]
        db = sqlite3.connect(f"file:{self.v2}?mode=ro", uri=True)
        try:
            with self.assertRaisesRegex(ValueError, "unshipped product"):
                delta._check_closure(db, payload, self.floors_v1)
        finally:
            db.close()

    def test_a_dangling_reference_is_caught(self):
        payload = self.delta_v1_to_v2()
        payload["upsert"][0]["cwe"] = [9999]
        db = sqlite3.connect(f"file:{self.v2}?mode=ro", uri=True)
        try:
            # Floored above the invented id, so it reads as "the client already
            # has it" — and the existence check is the only thing left to catch it.
            with self.assertRaisesRegex(ValueError, "not in the artifact"):
                delta._check_closure(db, payload, {**self.floors_v1, "cwe": 10_000})
        finally:
            db.close()

    def test_a_non_finite_cvss_score_never_reaches_the_wire(self):
        """JSON permits `1e400`; Python parses it to `inf` and would serialize a
        bare `Infinity` token that no browser's JSON parser accepts — at a URL
        that is immutable once published. Guarded twice: normalization drops it,
        and `write` refuses to serialize one."""
        records = fixtures.corpus_v1()
        records["CVE-2026-1001"]["containers"]["cna"]["metrics"] = [
            {"cvssV3_1": {"baseScore": 1e400, "baseSeverity": "HIGH", "vectorString": "V"}}
        ]
        artifact = fixtures.build_artifact(self.root, records, "inf", rev=1)
        payload = delta.extract(
            artifact,
            from_rev=0,
            to_rev=1,
            upsert=["CVE-2026-1001"],
            delete=[],
            floors={},
            generated=fixtures.FIXED_GENERATED,
        )
        self.assertIsNone(_record(payload, "CVE-2026-1001")["cvss"][1])
        self.assertNotIn("Infinity", json.dumps(payload))

        # And if one ever did get stored, publication stops rather than writing
        # bytes the client cannot parse.
        payload["upsert"][0]["cvss"][1] = float("inf")
        with self.assertRaises(ValueError):
            delta.write(payload, os.path.join(self.root, "pub-inf"))

    def test_a_record_the_wire_cannot_carry_fails_the_build(self):
        """A publisher-supplied id that the client's validator would refuse
        means the client refuses the whole *file*, forever — so it has to be
        caught here (rule 5)."""
        hostile = fixtures.corpus_v1()
        hostile["CVE-2026-1001"]["cveMetadata"]["cveId"] = "CVE-2026-" + "9" * 300
        clone = fixtures.write_corpus(os.path.join(self.root, "long-id"), hostile)
        out = os.path.join(self.root, "long-id.sqlite")
        stats = build.build(clone, out, None, None, bootstrap=True)
        # Falls back to the file name, which is well-formed — so the record is
        # kept under a name the wire can carry rather than lost.
        self.assertEqual(stats["skipped"], [])
        self.assertEqual(
            {row[0] for row in _rows(out, "SELECT cve_id FROM cve")},
            {"CVE-2026-1001", "CVE-2026-1002"},
        )

    def test_a_record_with_no_usable_id_at_all_is_refused(self):
        """Fail closed (D-047): if neither the record's id nor its file name is
        a CVE ID, we cannot name the record and must not publish it."""
        clone = os.path.join(self.root, "nameless", "cves", "2026", "1xxx")
        os.makedirs(clone, exist_ok=True)
        with open(os.path.join(clone, "CVE-not-an-id.json"), "w", encoding="utf-8") as handle:
            json.dump({"cveMetadata": {"cveId": "../../etc/passwd", "state": "PUBLISHED"}}, handle)
        out = os.path.join(self.root, "nameless.sqlite")
        stats = build.build(
            os.path.join(self.root, "nameless"), out, None, None, bootstrap=True
        )
        self.assertEqual(len(stats["skipped"]), 1)
        self.assertEqual(stats["records"], 0)

    def test_a_changeset_naming_an_unknown_lookup_table_is_refused(self):
        """`extra={"cwes": [...]}` — a plausible typo — silently shipped nothing
        and left the client with stale content it could never notice."""
        with self.assertRaisesRegex(ValueError, "do not exist"):
            delta.extract(
                self.v2,
                from_rev=1,
                to_rev=2,
                upsert=[],
                delete=[],
                floors={**self.floors_v1, "vendr": 1},
                generated=fixtures.FIXED_GENERATED,
            )
        with self.assertRaisesRegex(ValueError, "do not exist"):
            delta.extract(
                self.v2,
                from_rev=1,
                to_rev=2,
                upsert=[],
                delete=[],
                floors=self.floors_v1,
                extra={"cwes": [1]},
                generated=fixtures.FIXED_GENERATED,
            )

    def test_a_delta_must_carry_the_revision_its_artifact_is_stamped_with(self):
        """An artifact at rev 2 emitting a 1→999 delta would install rev-2 rows
        and leave the client claiming 999 — asking from then on for deltas that
        do not exist."""
        with self.assertRaisesRegex(ValueError, "artifact is at rev 2"):
            delta.extract(
                self.v2,
                from_rev=1,
                to_rev=999,
                upsert=["CVE-2026-1002"],
                delete=[],
                floors=self.floors_v1,
                generated=fixtures.FIXED_GENERATED,
            )

    def test_an_artifact_from_a_different_schema_is_refused(self):
        """A schema bump cannot be bridged by a delta — the client refuses one
        whose schema is not its own and re-downloads (D-025) — so emitting from
        an artifact this pipeline build did not produce would ship rows in the
        wrong shape inside a file nobody can apply."""
        for stamped in (build.SCHEMA_VERSION + 1, None):
            artifact = os.path.join(self.root, f"schema-{stamped}.sqlite")
            shutil.copy(self.v2, artifact)
            db = sqlite3.connect(artifact)
            try:
                if stamped is None:
                    db.execute("DELETE FROM meta WHERE k = 'schema'")
                else:
                    db.execute("UPDATE meta SET v = ? WHERE k = 'schema'", (stamped,))
                db.commit()
            finally:
                db.close()
            with self.assertRaisesRegex(ValueError, "cannot bridge a schema change"):
                delta.extract(
                    artifact,
                    from_rev=1,
                    to_rev=2,
                    upsert=[],
                    delete=[],
                    floors=self.floors_v1,
                    generated=fixtures.FIXED_GENERATED,
                )

    def test_an_empty_floors_map_is_only_a_bootstrap(self):
        """`floors={}` means "the client has nothing", which only rev 0 can
        mean; anywhere else it silently ships every lookup table."""
        with self.assertRaisesRegex(ValueError, "gives no floor"):
            delta.extract(
                self.v2,
                from_rev=1,
                to_rev=2,
                upsert=[],
                delete=[],
                floors={},
                generated=fixtures.FIXED_GENERATED,
            )

    def test_an_extra_id_that_does_not_exist_is_refused(self):
        """`extra` re-ships a row whose content changed. An id the artifact does
        not have cannot do that, and dropping it silently leaves the client with
        stale content and no way to notice."""
        with self.assertRaisesRegex(ValueError, "do not exist"):
            delta.extract(
                self.v2,
                from_rev=1,
                to_rev=2,
                upsert=[],
                delete=[],
                floors=self.floors_v1,
                extra={"cwe": [9999]},
                generated=fixtures.FIXED_GENERATED,
            )

    def test_an_empty_tombstone_is_refused(self):
        """The client rejects it, and it rejects the whole file with it."""
        with self.assertRaisesRegex(ValueError, "CVE ID is empty"):
            delta.extract(
                self.v2,
                from_rev=1,
                to_rev=2,
                upsert=[],
                delete=[""],
                floors=self.floors_v1,
                generated=fixtures.FIXED_GENERATED,
            )

    def test_a_changeset_that_both_upserts_and_tombstones_a_record_is_refused(self):
        """The wire format does not order `upsert` against `delete`, so two
        conforming appliers would disagree about the result."""
        with self.assertRaisesRegex(ValueError, "both upserts and tombstones"):
            delta.extract(
                self.v2,
                from_rev=1,
                to_rev=2,
                upsert=["CVE-2026-1002"],
                delete=["CVE-2026-1002"],
                floors=self.floors_v1,
                generated=fixtures.FIXED_GENERATED,
            )

    def test_a_number_json_cannot_carry_intact_is_refused(self):
        """Above 2^53 a JSON number is silently rounded on arrival, so an id or
        timestamp that big would mean something different on the client. The
        check covers nested values too — a lookup id or a version tuple that
        the client would refuse takes the whole file with it."""
        payload = self.delta_v1_to_v2()
        payload["upsert"][0]["pub"] = 2**53 + 1
        with self.assertRaisesRegex(ValueError, "outside the range a JSON number"):
            delta._check_wire_bounds(payload)

        nested = self.delta_v1_to_v2()
        nested["lookups"]["vendor"][0][0] = 2**60
        with self.assertRaisesRegex(ValueError, "lookups.vendor"):
            delta._check_wire_bounds(nested)

        versions = self.delta_v1_to_v2()
        _record(versions, "CVE-2026-1003")["ver"][0][0] = 2**60
        with self.assertRaisesRegex(ValueError, "ver product_id"):
            delta._check_wire_bounds(versions)

    def test_the_bounds_check_mirrors_the_client_field_for_field(self):
        """Size alone is not parity: the client also refuses a negative counter,
        a row id below 1, and an unsafe integer inside the CVSS tuple. Each of
        these passed the emitter and would have been rejected on arrival,
        taking the whole file with it."""
        cases = (
            (lambda d: d.__setitem__("generated", -1), "negative"),
            (lambda d: _record(d, "CVE-2026-1003").__setitem__("id", 0), "not a row id"),
            (lambda d: _record(d, "CVE-2026-1003").__setitem__("y", -1), "negative"),
            (lambda d: _record(d, "CVE-2026-1003").__setitem__("cvss", [2**60, 7.5, 3, "V"]), "cvss version"),
            (lambda d: _record(d, "CVE-2026-1003").__setitem__("cvss", [4, 9.1, -1, "V"]), "cvss severity"),
            (lambda d: _record(d, "CVE-2026-1003").__setitem__("cvss", [4, 9.1, 4, None]), "cvss vector"),
            (lambda d: _record(d, "CVE-2026-1003").__setitem__("descr", ""), "descr"),
            (lambda d: _record(d, "CVE-2026-1003").__setitem__("cwe", [0]), "not a row id"),
            (lambda d: d["lookups"]["vendor"][0].__setitem__(0, 0), "not a row id"),
            (lambda d: d["lookups"]["product"][0].__setitem__(1, 0), "vendor_id"),
        )
        for mutate, expected in cases:
            payload = self.delta_v1_to_v2()
            mutate(payload)
            with self.assertRaisesRegex(ValueError, expected):
                delta._check_wire_bounds(payload)

    def test_a_partial_floors_dict_is_refused(self):
        """A missing floor defaults to 0 and ships the whole table — 164x the
        compressed bytes on a 20,000-record corpus, silently."""
        with self.assertRaisesRegex(ValueError, "gives no floor"):
            delta.extract(
                self.v2,
                from_rev=1,
                to_rev=2,
                upsert=[],
                delete=[],
                floors={"vendor": 1, "product": 1},
                generated=fixtures.FIXED_GENERATED,
            )

    def test_an_artifact_with_no_notice_is_refused(self):
        stripped = os.path.join(self.root, "no-notice.sqlite")
        shutil.copy(self.v2, stripped)
        db = sqlite3.connect(stripped)
        try:
            db.execute("UPDATE meta SET v = '' WHERE k = 'notice'")
            db.commit()
        finally:
            db.close()
        with self.assertRaisesRegex(ValueError, "no MITRE notice"):
            delta.extract(
                stripped,
                from_rev=0,
                to_rev=2,
                upsert=[],
                delete=[],
                floors={},
                generated=fixtures.FIXED_GENERATED,
            )


class Sufficiency(Corpus):
    """Snapshot N + delta == snapshot N+1, table by table."""

    def _applied_copy(self, source: str, payload: dict) -> str:
        target = os.path.join(self.root, f"applied-{payload['from']}-{payload['to']}.sqlite")
        shutil.copy(source, target)
        db = sqlite3.connect(target)
        try:
            apply_module.apply(db, payload)
        finally:
            db.close()
        return target

    def test_upserts_reconstruct_the_next_snapshot_exactly(self):
        applied = self._applied_copy(self.v1, self.delta_v1_to_v2())
        for table in RECORD_TABLES + LOOKUP_TABLES:
            self.assertEqual(
                fixtures.table_rows(applied, table),
                fixtures.table_rows(self.v2, table),
                f"{table} diverged",
            )

    def test_the_watermark_advances_with_the_rows(self):
        applied = self._applied_copy(self.v1, self.delta_v1_to_v2())
        meta = dict(_rows(applied, "SELECT k, v FROM meta"))
        self.assertEqual(int(meta["rev"]), 2)
        self.assertEqual(int(meta["generated"]), fixtures.FIXED_GENERATED)

    def test_a_record_that_loses_sections_loses_them_locally(self):
        """The removal direction of "absent means absent" (D-055): CVE-2026-1003
        drops its description, CWE, reference, CVSS and version rows, and a
        client that applies the delta must end up without them."""
        without = fixtures.build_artifact(
            self.root, fixtures.corpus_v3(), "v3b", rev=3, seed=self.v2
        )
        # Emitted from the *new* build, as the ingest does — the artifact that
        # no longer holds those rows is the one that can describe their absence.
        payload = delta.extract(
            without,
            from_rev=2,
            to_rev=3,
            upsert=["CVE-2026-1003"],
            delete=[],
            floors=fixtures.floors(self.v2),
            generated=fixtures.FIXED_GENERATED,
        )
        # The wire form says it by omission, which is the only signal apply gets.
        record = _record(payload, "CVE-2026-1003")
        for key in ("descr", "cwe", "ref", "cvss", "ver"):
            self.assertNotIn(key, record)

        applied = self._applied_copy(self.v2, payload)
        for table in RECORD_TABLES:
            self.assertEqual(
                fixtures.table_rows(applied, table),
                fixtures.table_rows(without, table),
                f"{table} diverged",
            )

    def test_applying_twice_changes_nothing(self):
        """Replacement semantics make apply idempotent, which is what lets an
        interrupted sync simply be retried (D-031).

        The watermark is rewound between the two applies because apply refuses a
        delta that does not start at it — this is testing the row semantics, not
        the watermark check, which has its own test.
        """
        payload = self.delta_v1_to_v2()
        applied = self._applied_copy(self.v1, payload)
        db = sqlite3.connect(applied)
        try:
            db.execute("UPDATE meta SET v = ? WHERE k = 'rev'", (payload["from"],))
            db.commit()
            apply_module.apply(db, payload)
        finally:
            db.close()
        for table in RECORD_TABLES + LOOKUP_TABLES:
            self.assertEqual(
                fixtures.table_rows(applied, table),
                fixtures.table_rows(self.v2, table),
                f"{table} diverged on the second apply",
            )

    def test_a_tombstone_removes_the_record_and_everything_under_it(self):
        # v2 without its last record: a rebuild that retires the values only
        # that record used (globex, sprocket, its url and host, and the custom
        # version type), which the seeded ID space keeps reserved.
        remaining = {k: v for k, v in fixtures.corpus_v2().items() if k != "CVE-2026-1003"}
        without = fixtures.build_artifact(self.root, remaining, "v3", rev=3, seed=self.v2)
        # From the rev-3 artifact: a delta describes the state of the build it
        # was emitted from, and that is the build the record is gone from.
        payload = delta.extract(
            without,
            from_rev=2,
            to_rev=3,
            upsert=[],
            delete=["CVE-2026-1003"],
            floors=fixtures.floors(self.v2),
            generated=fixtures.FIXED_GENERATED,
        )
        applied = self._applied_copy(self.v2, payload)
        for table in RECORD_TABLES:
            self.assertEqual(
                fixtures.table_rows(applied, table),
                fixtures.table_rows(without, table),
                f"{table} diverged",
            )
        # The rebuild retired the rows only that record used, and the client
        # keeps them: a delta never deletes a lookup row. That is the design
        # (D-056) — the ids stay reserved, so nothing can make the stale rows
        # resolve to something else.
        for table in LOOKUP_TABLES:
            applied_rows = set(fixtures.table_rows(applied, table))
            self.assertTrue(set(fixtures.table_rows(without, table)) <= applied_rows)

    def test_apply_refuses_a_drifted_id_space(self):
        """The tripwire behind D-055's requirement that ids be stable: if the
        delta and the local database disagree about which row a CVE is, syncing
        would silently replace the wrong record."""
        payload = self.delta_v1_to_v2()
        payload["upsert"][0]["id"] += 1000
        target = os.path.join(self.root, "drifted.sqlite")
        shutil.copy(self.v1, target)
        db = sqlite3.connect(target)
        try:
            with self.assertRaisesRegex(ValueError, "ID space has drifted"):
                apply_module.apply(db, payload)
            # Read back through the *same connection*, which is what a client
            # has: the Worker holds one open database for the life of the tab.
            # Two things make this the assertion that can actually fail —
            # checking `cve` alone could not, because the tripwire raises before
            # any record is touched, while the lookup rows were already
            # written; and reopening the file could not either, because closing
            # a connection rolls back an open transaction whether or not apply
            # did.
            for table in LOOKUP_TABLES:
                self.assertEqual(
                    sorted(tuple(row) for row in db.execute(f"SELECT * FROM {table}")),
                    fixtures.table_rows(self.v1, table),
                    f"{table} survived a rolled-back apply",
                )
            self.assertEqual(db.execute("SELECT count(*) FROM cve").fetchone()[0], 2)
        finally:
            db.close()

    def test_apply_refuses_an_upsert_onto_an_occupied_row_id(self):
        """The other direction of the same tripwire, and the one that destroys
        data: a CVE the client has never seen, at a row id it has already given
        to a different record."""
        payload = self.delta_v1_to_v2()
        payload["upsert"] = [{"id": 1, "cve": "CVE-2026-4444", "y": 2026, "st": 1}]
        target = os.path.join(self.root, "occupied.sqlite")
        shutil.copy(self.v1, target)
        db = sqlite3.connect(target)
        try:
            with self.assertRaisesRegex(ValueError, "ID space has drifted"):
                apply_module.apply(db, payload)
        finally:
            db.close()
        self.assertEqual(
            fixtures.table_rows(target, "cve"), fixtures.table_rows(self.v1, "cve")
        )

    def test_apply_refuses_a_delta_that_does_not_start_at_the_watermark(self):
        """A delta is a step from one specific revision (D-031). Applying a 1→2
        delta to a database at rev 2 would rewind its watermark and replay rows
        against a state they were never computed from."""
        payload = self.delta_v1_to_v2()
        target = os.path.join(self.root, "ahead.sqlite")
        shutil.copy(self.v2, target)  # already at rev 2
        db = sqlite3.connect(target)
        try:
            with self.assertRaisesRegex(ValueError, "does not start at this database's watermark"):
                apply_module.apply(db, payload)
            self.assertEqual(int(db.execute("SELECT v FROM meta WHERE k='rev'").fetchone()[0]), 2)
        finally:
            db.close()


class Publication(unittest.TestCase):
    """Each test publishes its own data plane.

    They used to share one, and the suite only stayed green because the test
    that republished a snapshot happened to run before the one asserting the
    manifest's freshness — `-k`, a rename, or a parallel runner would have
    turned it red for a reason unrelated to the code.
    """

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="cve-delta-pub-")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.published = fixtures.publish_fixture(self.root)
        self.pub = self.published["pub"]

    def test_the_entry_describes_the_file_that_was_written(self):
        import hashlib

        entry = self.published["delta"]
        path = os.path.join(self.pub, "deltas", manifest_module.delta_name(entry))
        with open(path, "rb") as handle:
            blob = handle.read()
        self.assertEqual(entry["bytes"], len(blob))
        self.assertEqual(entry["sha256"], hashlib.sha256(blob).hexdigest())
        self.assertEqual(oct(os.stat(path).st_mode & 0o777), oct(0o644))

    def test_the_manifest_lists_the_delta_and_advances_the_head(self):
        with open(manifest_module.path(self.pub), encoding="utf-8") as handle:
            published = json.load(handle)
        self.assertEqual(published["snapshot"]["rev"], 1)
        self.assertEqual(published["rev"], 2)
        self.assertEqual(len(published["deltas"]), 1)
        entry = published["deltas"][0]
        self.assertEqual((entry["from"], entry["to"]), (1, 2))
        self.assertEqual(sorted(entry), ["bytes", "from", "raw_bytes", "sha256", "to"])
        self.assertEqual(published["generated"], fixtures.FIXED_GENERATED)

    def _rebuild(self) -> dict:
        payload = delta.extract(
            self.published["next"],
            from_rev=1,
            to_rev=2,
            upsert=[],
            delete=[],
            floors=self.published["changeset"]["floors"],
            generated=fixtures.FIXED_GENERATED,
        )
        return payload

    def test_republishing_a_different_payload_for_the_same_range_is_refused(self):
        changed = {**self.published["changeset"], "upsert": ["CVE-2026-1002"]}
        with self.assertRaisesRegex(SystemExit, "immutable"):
            delta.publish(self.published["next"], self.pub, changed)

    def test_republishing_the_identical_delta_changes_nothing(self):
        """Immutability is about the bytes at a URL, not about the act: an
        ingest that re-runs the same changeset produces the same file, and
        refusing that would make a crashed run need `--force`."""
        before = self.published["delta"]
        again = delta.publish(self.published["next"], self.pub, self.published["changeset"])
        self.assertEqual(again["entry"]["sha256"], before["sha256"])
        self.assertEqual(len(manifest_module.load(self.pub)["deltas"]), 1)

    def test_a_retired_range_can_never_be_reissued(self):
        """The gap the manifest could not close: retention removes the entry
        *and* the file, after which nothing on disk remembered the URL. The
        ledger does."""
        entry = self.published["delta"]
        manifest = manifest_module.load(self.pub)
        manifest["deltas"] = []
        manifest["rev"] = manifest["snapshot"]["rev"]
        manifest_module.save(self.pub, manifest)
        os.unlink(os.path.join(self.pub, "deltas", manifest_module.delta_name(entry)))

        with self.assertRaisesRegex(SystemExit, "already published with different content"):
            delta.write(self._rebuild(), self.pub)

    def test_a_deleted_delta_file_is_still_published(self):
        """Publication is what the manifest says, not what the filesystem holds.
        D-042's retention deletes old delta files; before this, a same-range
        re-run then rewrote different bytes at a URL caches hold for a year."""
        os.unlink(os.path.join(self.pub, "deltas", "1-2.json.br"))
        with self.assertRaisesRegex(SystemExit, "immutable"):
            delta.write(self._rebuild(), self.pub)

    def _same_changeset(self, generated: int) -> dict:
        changeset = self.published["changeset"]
        return delta.extract(
            self.published["next"],
            from_rev=changeset["from"],
            to_rev=changeset["to"],
            upsert=changeset["upsert"],
            delete=changeset["delete"],
            floors=changeset["floors"],
            generated=generated,
        )

    def test_a_retry_of_the_same_changeset_reproduces_the_same_bytes(self):
        """The recovery case: a run that died between writing the file and
        registering it. Re-running is allowed because the payload is identical
        — which is why the ingest has to pin `generated` per revision rather
        than stamping wall-clock time on every attempt."""
        entry = self.published["delta"]
        rewritten = delta.write(self._same_changeset(fixtures.FIXED_GENERATED), self.pub)
        self.assertEqual(rewritten["sha256"], entry["sha256"])

    def test_a_retry_with_a_new_timestamp_is_refused(self):
        """`generated` is not decoration: apply writes it to `meta.generated`,
        so two payloads differing only there are different content at a URL
        clients cache for a year."""
        with self.assertRaisesRegex(SystemExit, "different content"):
            delta.write(self._same_changeset(fixtures.FIXED_GENERATED + 3600), self.pub)

    def test_registering_the_same_range_twice_replaces_rather_than_duplicates(self):
        """A re-run of an interrupted ingest has to converge, not accumulate."""
        entry = dict(self.published["delta"])
        entry["bytes"] += 1
        published = manifest_module.register_delta(self.pub, entry, fixtures.FIXED_GENERATED)
        self.assertEqual(len(published["deltas"]), 1)
        self.assertEqual(published["deltas"][0]["bytes"], entry["bytes"])

    def test_a_republished_snapshot_keeps_the_deltas_that_chain_from_it(self):
        publish_module.publish(self.published["snapshot"], self.pub, quality=5, jobs=2, force=True)
        published = manifest_module.load(self.pub)
        self.assertEqual(len(published["deltas"]), 1)
        self.assertEqual(published["rev"], 2, "head must stay at the newest delta")
        self.assertEqual(
            published["generated"],
            fixtures.FIXED_GENERATED,
            "a republish must not advertise the origin as staler than its newest delta",
        )

    def test_a_rebuilt_snapshot_drops_deltas_no_client_could_use(self):
        """A delta below the new snapshot's revision belongs to the generation
        this one replaces: no chain reaches head through it, so listing it only
        advertises a catch-up path that does not exist."""
        rebuilt = fixtures.build_artifact(
            self.root,
            fixtures.corpus_v2(),
            "v4",
            rev=4,
            generated=fixtures.FIXED_GENERATED + 1,
            seed=self.published["next"],
        )
        publish_module.publish(rebuilt, self.pub, quality=5, jobs=2)
        published = manifest_module.load(self.pub)
        self.assertEqual(published["snapshot"]["rev"], 4)
        self.assertEqual(published["rev"], 4)
        self.assertEqual(published["deltas"], [])

    def test_a_snapshot_at_head_must_be_the_artifact_head_came_from(self):
        """The hole D-056 recorded and D-060 closes. A snapshot at the head
        revision is the monthly landing, and it is the one publication nobody
        already synced ever fetches — `planSync` tells them they are current —
        so different content there reaches new arrivals only, silently and
        permanently. This sibling is a legitimate build of the same corpus with
        the same ids, so neither the lineage token, nor `seed_rev`, nor the ID
        space's fingerprint can see it; the artifact digest the ledger recorded
        when rev 2 was cut can."""
        sibling = fixtures.build_artifact(
            self.root,
            fixtures.corpus_v2(),
            "sibling",
            rev=2,
            generated=fixtures.FIXED_GENERATED + 1,
            seed=self.published["snapshot"],
        )
        self.assertEqual(
            build.fingerprint(sibling),
            build.fingerprint(self.published["next"]),
            "the ids are identical — this is only visible as content",
        )
        with self.assertRaisesRegex(SystemExit, "content came from artifact"):
            publish_module.publish(sibling, self.pub, quality=5, jobs=2)
        self.assertFalse(os.path.exists(os.path.join(self.pub, "snapshot-2")))
        self.assertEqual(manifest_module.load(self.pub)["snapshot"]["rev"], 1)

    def test_publishing_an_older_revision_is_refused(self):
        """Revisions only move forward. Deleting a retired generation's
        directory used to be enough to let an older artifact be republished,
        which rolled the manifest backwards under clients that had already
        synced past it — and reused its `snapshot-<rev>` URLs for different
        bytes under an immutable cache policy."""
        # The artifact rev 2 was cut from, which is the only one publishable at
        # head (D-060) and exactly what the monthly rotation publishes.
        publish_module.publish(self.published["next"], self.pub, quality=5, jobs=2)
        shutil.rmtree(os.path.join(self.pub, "snapshot-1"), ignore_errors=True)
        with self.assertRaisesRegex(SystemExit, "roll it backwards"):
            publish_module.publish(self.published["snapshot"], self.pub, quality=5, jobs=2)
        self.assertEqual(manifest_module.load(self.pub)["snapshot"]["rev"], 2)

    def test_an_older_revision_is_refused_even_when_its_bytes_are_still_there(self):
        """The same refusal with the old generation's directory **retained**,
        which is the shape retention actually leaves behind.

        The test above deletes `snapshot-1` first, and that deletion is what
        made `_same_bytes` false and let the guard fire. Under retention the
        directory is still on disk holding exactly those bytes, so the resume
        path matched and skipped the whole block — including this check — and a
        flagless re-run of the older artifact rewrote the manifest at the old
        revision with every delta dropped. Byte identity answers "are these the
        same bytes at this URL"; it says nothing about "is this revision behind
        head" (M5's data-plane review).
        """
        publish_module.publish(self.published["next"], self.pub, quality=5, jobs=2)
        self.assertTrue(
            os.path.exists(os.path.join(self.pub, "snapshot-1")),
            "retention should have kept the older generation — otherwise this "
            "test is the one above",
        )
        with self.assertRaisesRegex(SystemExit, "roll it backwards"):
            publish_module.publish(self.published["snapshot"], self.pub, quality=5, jobs=2)
        after = manifest_module.load(self.pub)
        self.assertEqual(after["snapshot"]["rev"], 2)
        self.assertEqual(manifest_module.head_rev(after), 2)

    def test_a_manifest_without_snapshot_rev_still_blocks_republication(self):
        """The generation published before D-055 has no `snapshot.rev`, so the
        manifest alone could not say which revision was live — and with its
        directory rotated away, the same revision was re-cuttable over its own
        immutable URLs. The ledger seeds itself from that manifest."""
        legacy = manifest_module.load(self.pub)
        del legacy["snapshot"]["rev"]
        legacy["deltas"] = []
        legacy["rev"] = 1
        # Written directly: `save` would refuse this shape, which is the point —
        # it is what the origin served before D-055, not something we now emit.
        with open(manifest_module.path(self.pub), "w", encoding="utf-8") as handle:
            json.dump(legacy, handle)
        os.unlink(ledger.path(self.pub))  # as if this data plane predates it
        shutil.rmtree(os.path.join(self.pub, "snapshot-1"))

        # A rebuild seeded from the live snapshot, which is what the D-056
        # migration requires: a ledger-less data plane has no recorded lineage,
        # and only an artifact that *continues* the published ids may adopt it
        # (a bootstrap is refused). This test is about the revision rules
        # underneath that — the re-seeded ledger still knows rev 1 was published.
        rebuilt = fixtures.build_artifact(
            self.root,
            fixtures.corpus_v1(),
            "legacy-rebuild",
            rev=1,
            generated=fixtures.FIXED_GENERATED,
            seed=self.published["snapshot"],
        )
        # Refused, and on a data plane with no recorded lineage the ID-space
        # rules are what catch it first: adopting one has to land above the head
        # a client could be at, which rev 1 is not (D-056). The revision rules
        # underneath are unchanged — either way the generation is not re-cut.
        with self.assertRaisesRegex(
            SystemExit, "immutable|roll it backwards|above the published head"
        ):
            publish_module.publish(rebuilt, self.pub, quality=5, jobs=2, adopt_id_space=True)
        self.assertEqual(manifest_module.load(self.pub)["snapshot"].get("rev"), None)

    def test_an_orphaned_delta_file_is_only_reusable_for_the_same_payload(self):
        """Its URL is deterministic, so anyone who guessed it holds those bytes
        under an immutable cache policy — a retry may resume the file, but not
        change what is at it."""
        entry = self.published["delta"]
        manifest = manifest_module.load(self.pub)
        manifest["deltas"] = []
        manifest["rev"] = manifest["snapshot"]["rev"]
        manifest_module.save(self.pub, manifest)

        different = delta.extract(
            self.published["next"],
            from_rev=entry["from"],
            to_rev=entry["to"],
            upsert=["CVE-2026-1002"],
            delete=[],
            floors=self.published["changeset"]["floors"],
            generated=fixtures.FIXED_GENERATED,
        )
        with self.assertRaisesRegex(SystemExit, "different content"):
            delta.write(different, self.pub)

    def test_a_manifest_that_advertises_an_unreachable_head_is_refused(self):
        """A head no chain reaches tells every client to get somewhere nothing
        can take it — including the no-deltas case, which used to return before
        any check ran."""
        manifest = manifest_module.load(self.pub)
        manifest["deltas"] = []
        with self.assertRaisesRegex(SystemExit, "no client could ever get there"):
            manifest_module.save(self.pub, manifest)

    def test_a_manifest_that_would_strand_a_client_is_refused(self):
        """architecture.md's tiling invariant, enforced: one ingest run that
        mints a revision without publishing its delta would otherwise leave
        every client re-downloading the corpus daily, forever."""
        manifest = manifest_module.load(self.pub)
        manifest["deltas"] = [
            dict(self.published["delta"]),
            {**self.published["delta"], "from": 3, "to": 4},
        ]
        manifest["rev"] = 4
        with self.assertRaisesRegex(SystemExit, "do not tile"):
            manifest_module.save(self.pub, manifest)

    def test_a_manifest_a_fresh_download_could_not_leave_is_refused(self):
        """The anchor that matters most, and the one the stranding test above
        covers only by accident: it uses a snapshot revision that happens to be
        a delta's `from` as well. Here it is neither, so nothing but the
        snapshot anchor itself notices that every client which downloads this
        generation is stranded at it forever."""
        manifest = manifest_module.load(self.pub)
        manifest["snapshot"] = {**manifest["snapshot"], "rev": 4}
        manifest["deltas"] = [
            {**self.published["delta"], "from": 2, "to": 3},
            {**self.published["delta"], "from": 3, "to": 4},
            {**self.published["delta"], "from": 5, "to": 6},
        ]
        manifest["rev"] = 6
        with self.assertRaisesRegex(SystemExit, "do not tile"):
            manifest_module.save(self.pub, manifest)

    def test_a_snapshot_with_no_notice_is_refused(self):
        """D-008 covers the largest copy too, not just deltas."""
        stripped = os.path.join(self.root, "no-notice.sqlite")
        shutil.copy(self.published["snapshot"], stripped)
        db = sqlite3.connect(stripped)
        try:
            db.execute("UPDATE meta SET v = '' WHERE k = 'notice'")
            db.commit()
        finally:
            db.close()
        with self.assertRaisesRegex(SystemExit, "no MITRE notice"):
            publish_module.publish(stripped, self.pub, quality=5, jobs=2, force=True)


def _record(payload: dict, cve_id: str) -> dict:
    for record in payload["upsert"]:
        if record["cve"] == cve_id:
            return record
    raise AssertionError(f"{cve_id} is not in the delta")


if __name__ == "__main__":
    unittest.main()
