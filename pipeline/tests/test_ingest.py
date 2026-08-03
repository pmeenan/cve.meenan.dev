"""Tests for the daily ingest (D-042, D-058).

Four things are checked, and the last two are the ones a review would ask for:

  1. **The cycle** — a day's changes become one delta that reconstructs the
     rebuild, and a day with no changes mints no revision.
  2. **The guards** — the tombstone guard, malformed records, and a state that
     no longer describes the published head all stop the run before anything is
     published. The tombstone guard's test asserts the *build* never ran, not
     merely that nothing was published: running the guard ahead of the build is
     what the second corpus walk is bought for (D-058 §1), and a test that only
     checks the manifest passes with the two reordered.
  3. **The two walks agree** — the hash pass and the build must refuse exactly
     the same records, and the cross-check that enforces it has to fire.
  4. **Re-run semantics** — a pending run whose range was never published is
     abandoned and re-minted; one that *was* published is republished from the
     pinned changeset, byte for byte, even though the tree has moved on and the
     clock has advanced. Both directions are tested with the tree moved and the
     clock advanced, because without either the two behaviours are
     indistinguishable.
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
sys.path.insert(0, HERE)

import apply as apply_module  # noqa: E402
import build  # noqa: E402
import fixtures  # noqa: E402
import ingest  # noqa: E402
import ledger  # noqa: E402
import manifest as manifest_module  # noqa: E402
import publish as publish_module  # noqa: E402
import state as state_module  # noqa: E402

RECORD_TABLES = ("cve", "cve_text", "cve_cwe", "cve_prod", "cve_ref", "cve_ver")
LOOKUP_TABLES = tuple(build.LOOKUP_COLUMNS)

# A day later, so a retry cannot be mistaken for a rerun inside one wall-clock
# second — which is what made the `generated` pinning assertion vacuous.
A_DAY = 86_400


def write_tree(clone: str, records: dict) -> None:
    """Rewrite the clone's record files, *removing* what is no longer there.

    `fixtures.write_corpus` only ever adds, which cannot express the case the
    tombstone guard exists for.
    """
    directory = os.path.join(clone, "cves", "2026", "1xxx")
    os.makedirs(directory, exist_ok=True)
    for name in os.listdir(directory):
        os.remove(os.path.join(directory, name))
    for cve_id, record in records.items():
        with open(os.path.join(directory, f"{cve_id}.json"), "w", encoding="utf-8") as handle:
            json.dump(record, handle)


def within(seconds: float, call):
    """Run `call` on a thread and fail if it does not finish in time.

    Non-blocking locking is a decision (D-042), and a regression to a blocking
    one would otherwise *hang* the suite rather than fail it — which is exactly
    the failure mode a test is supposed to convert into a message.
    """
    box: dict = {}

    def attempt():
        try:
            box["value"] = call()
        except BaseException as error:  # noqa: BLE001 - recorded, then re-raised
            box["error"] = error

    worker = threading.Thread(target=attempt, daemon=True)
    worker.start()
    worker.join(seconds)
    if worker.is_alive():
        raise AssertionError(f"did not finish within {seconds}s — the lock blocked")
    if "error" in box:
        raise box["error"]
    return box["value"]


@contextlib.contextmanager
def a_day_later():
    """Advance the clock across a retry, so a restamped `generated` differs."""
    real = time.time
    with mock.patch.object(ingest.time, "time", lambda: real() + A_DAY):
        yield


def skewed_build(field: str, by: int):
    """A `build.build` whose reported counts disagree with the corpus it built.

    Which is the only way to reach `_check_build_agrees` — the two walks apply
    the same rules to the same tree, so nothing a corpus can do separates them.
    """
    real = build.build

    def fake(*args, **kwargs):
        stats = real(*args, **kwargs)
        stats[field] = int(stats[field]) + by
        return stats

    return fake


def read_delta(pub_dir: str, from_rev: int, to_rev: int) -> dict:
    path = os.path.join(pub_dir, "deltas", f"{from_rev}-{to_rev}.json.br")
    done = subprocess.run(["brotli", "-d", "-c", path], capture_output=True, check=True)
    return json.loads(done.stdout)


def digest(path: str) -> str:
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def rows(db_path: str, table: str) -> list:
    return fixtures.table_rows(db_path, table)


def state_meta(state_dir: str, key: str):
    db = sqlite3.connect(os.path.join(state_dir, state_module.STATE_NAME))
    try:
        found = db.execute("SELECT v FROM meta WHERE k = ?", (key,)).fetchone()
        return None if found is None else found[0]
    finally:
        db.close()


def set_meta(db_path: str, **values) -> None:
    db = sqlite3.connect(db_path)
    try:
        for key, value in values.items():
            if value is None:
                db.execute("DELETE FROM meta WHERE k = ?", (key,))
            else:
                db.execute(
                    "INSERT INTO meta(k, v) VALUES(?,?) "
                    "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                    (key, value),
                )
        db.commit()
    finally:
        db.close()


class Plane(unittest.TestCase):
    """A published snapshot at rev 1, and an ingest initialized against it."""

    def setUp(self) -> None:
        self.root = tempfile.mkdtemp(prefix="cve-ingest-")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.clone = os.path.join(self.root, "clone")
        self.pub = os.path.join(self.root, "pub")
        self.state_dir = os.path.join(self.root, "state")
        self.artifacts = os.path.join(self.state_dir, "artifacts")
        self.snapshot = os.path.join(self.root, "rev-1.sqlite")
        self._applied = 0

        write_tree(self.clone, fixtures.corpus_v1())
        build.build(self.clone, self.snapshot, None, None, bootstrap=True, rev=1)
        os.makedirs(self.pub, exist_ok=True)
        publish_module.publish(self.snapshot, self.pub, quality=1, jobs=1)
        ingest.init(self.clone, self.pub, self.state_dir, self.snapshot)

    def ingest_run(self, **kwargs):
        kwargs.setdefault("do_fetch", False)
        kwargs.setdefault("quality", 1)
        return ingest.run(self.clone, self.pub, self.state_dir, **kwargs)

    def head(self) -> int:
        return manifest_module.head_rev(manifest_module.load(self.pub))

    def pending(self) -> dict | None:
        raw = state_meta(self.state_dir, "pending")
        return None if raw in (None, "") else json.loads(raw)

    def rebuilt(self) -> str:
        return state_meta(self.state_dir, "artifact")

    def applied(self, source: str, *payloads: dict) -> str:
        """A copy of `source` with each delta applied, as a client would."""
        self._applied += 1
        target = os.path.join(self.root, f"applied-{self._applied}.sqlite")
        shutil.copyfile(source, target)
        db = sqlite3.connect(target)
        try:
            for payload in payloads:
                apply_module.apply(db, payload)
        finally:
            db.close()
        return target

    def assert_nothing_published(self, rev: int = 1) -> None:
        """Every authority, not just the one that is easiest to check."""
        self.assertEqual(self.head(), rev)
        self.assertEqual(ledger.highest_published(self.pub), rev)
        self.assertEqual(state_meta(self.state_dir, "rev"), rev)
        deltas = os.path.join(self.pub, "deltas")
        self.assertEqual(sorted(os.listdir(deltas)) if os.path.isdir(deltas) else [], [])

    def assert_matches_rebuild(self, synced: str) -> None:
        rebuilt = self.rebuilt()
        for table in RECORD_TABLES:
            self.assertEqual(rows(synced, table), rows(rebuilt, table), table)
        for table in LOOKUP_TABLES:
            # A synced client keeps the rows a rebuild retired (D-056), so the
            # rebuild is a subset rather than an equal — which is exactly M2's
            # exit criterion for a *synced* database.
            self.assertLessEqual(set(rows(rebuilt, table)), set(rows(synced, table)), table)


class Cycle(Plane):
    def test_a_days_changes_publish_one_delta_that_reconstructs_the_rebuild(self):
        write_tree(self.clone, fixtures.corpus_v2())
        report = self.ingest_run()

        self.assertEqual(report["result"], "published")
        self.assertEqual(report["rev"], 2)
        self.assertEqual(self.head(), 2)
        self.assert_matches_rebuild(self.applied(self.snapshot, read_delta(self.pub, 1, 2)))

    def test_nothing_changed_mints_no_revision(self):
        report = self.ingest_run()
        self.assertEqual(report["result"], "nothing changed")
        self.assert_nothing_published()

    def test_a_missed_day_is_absorbed_rather_than_replayed(self):
        # Two days of upstream changes with no run in between: still one delta,
        # from the published head to head+1, carrying each record's final state.
        write_tree(self.clone, fixtures.corpus_v2())
        write_tree(self.clone, fixtures.corpus_v3())
        report = self.ingest_run()

        self.assertEqual(report["rev"], 2)
        payload = read_delta(self.pub, 1, 2)
        self.assertEqual((payload["from"], payload["to"]), (1, 2))
        self.assert_matches_rebuild(self.applied(self.snapshot, payload))

    def test_two_runs_tile_the_revision_space(self):
        write_tree(self.clone, fixtures.corpus_v2())
        self.ingest_run()
        write_tree(self.clone, fixtures.corpus_v3())
        self.ingest_run()

        self.assertEqual(self.head(), 3)
        entries = [(d["from"], d["to"]) for d in manifest_module.load(self.pub)["deltas"]]
        self.assertEqual(entries, [(1, 2), (2, 3)])
        self.assert_matches_rebuild(
            self.applied(self.snapshot, read_delta(self.pub, 1, 2), read_delta(self.pub, 2, 3))
        )

    def test_a_lookup_row_whose_content_moved_is_re_shipped(self):
        """`extra`, end to end. A floor cannot see a row that changed *under* an
        id the client already holds, and `cwe.descr` is the one column that can
        (D-056) — so the changeset carries it explicitly or the client keeps the
        old text forever."""
        records = fixtures.corpus_v1()
        for record in records.values():
            for problem in record["containers"]["cna"].get("problemTypes", ()):
                for entry in problem["descriptions"]:
                    if entry["cweId"] == "CWE-79":
                        entry["description"] = "Cross-site Scripting"
        write_tree(self.clone, records)
        report = self.ingest_run()

        self.assertEqual(report["rev"], 2)
        payload = read_delta(self.pub, 1, 2)
        self.assertEqual(payload["lookups"]["cwe"], [[1, "CWE-79", "Cross-site Scripting"]])
        self.assert_matches_rebuild(self.applied(self.snapshot, payload))

    def test_a_tombstone_ships_and_the_record_leaves_the_client(self):
        records = fixtures.corpus_v1()
        del records["CVE-2026-1002"]
        write_tree(self.clone, records)
        # One of two records is far past 0.1%; the limit is raised because the
        # corpus is a fixture, which is the same override an operator would use
        # for a withdrawal confirmed upstream.
        report = self.ingest_run(tombstone_limit=0.5)

        self.assertEqual(report["changed"]["deleted"], 1)
        payload = read_delta(self.pub, 1, 2)
        self.assertEqual(payload["delete"], ["CVE-2026-1002"])
        synced = self.applied(self.snapshot, payload)
        self.assertEqual([row[1] for row in rows(synced, "cve")], ["CVE-2026-1001"])
        self.assertEqual(state_meta(self.state_dir, "rev"), 2)

    def test_a_record_that_returns_after_a_tombstone_takes_a_new_id(self):
        records = fixtures.corpus_v1()
        withdrawn = records.pop("CVE-2026-1002")
        write_tree(self.clone, records)
        self.ingest_run(tombstone_limit=0.5)
        with state_module.State(os.path.join(self.state_dir, state_module.STATE_NAME)) as state:
            self.assertEqual(state.tombstones(), 1)

        highest = max(row[0] for row in rows(self.snapshot, "cve"))
        records["CVE-2026-1002"] = withdrawn
        write_tree(self.clone, records)
        self.ingest_run()

        returned = {row[1]: row[0] for row in rows(self.rebuilt(), "cve")}["CVE-2026-1002"]
        # Retirement is permanent: the id is never reissued, so the record comes
        # back above the high-water mark rather than in its old slot (D-056).
        self.assertGreater(returned, highest)
        with state_module.State(os.path.join(self.state_dir, state_module.STATE_NAME)) as state:
            self.assertEqual(state.rev, 3)
            # And the tombstone *survives* the return. Both facts are true of a
            # client that has not synced since: the row it holds at the retired
            # id is gone, and the record exists again at a new one. Dropping the
            # tombstone would let a bridging delta ship only the upsert, which
            # every such client then refuses on apply.
            self.assertEqual(state.tombstones(), 1)


class Guards(Plane):
    def test_the_tombstone_guard_aborts_before_the_build_runs(self):
        records = fixtures.corpus_v1()
        del records["CVE-2026-1002"]
        write_tree(self.clone, records)

        with self.assertRaises(ingest.Abort) as caught:
            self.ingest_run()
        self.assertEqual(caught.exception.code, ingest.EXIT_GUARD)
        # The guard's whole purpose: a build from a broken tree retires ids
        # permanently (D-056), so "nothing was published" is not enough — the
        # build must not have happened at all.
        self.assertFalse(os.path.exists(self.artifacts))
        self.assert_nothing_published()

    def test_the_guard_boundary_is_exactly_the_fraction_it_names(self):
        records = fixtures.corpus_v1()
        corpus = len(records)
        del records["CVE-2026-1002"]
        write_tree(self.clone, records)

        # One deletion out of `corpus`: the guard trips when 1 > corpus * limit.
        with self.assertRaises(ingest.Abort) as caught:
            self.ingest_run(tombstone_limit=(1 / corpus) * 0.9)
        self.assertEqual(caught.exception.code, ingest.EXIT_GUARD)
        report = self.ingest_run(tombstone_limit=1 / corpus)
        self.assertEqual(report["changed"]["deleted"], 1)

    def test_a_limit_that_would_disable_the_guard_is_refused(self):
        write_tree(self.clone, fixtures.corpus_v2())
        for limit in (float("nan"), -1, 1.5):
            with self.assertRaises(ingest.Abort) as caught:
                self.ingest_run(tombstone_limit=limit)
            self.assertIn("not a fraction", str(caught.exception), limit)
        self.assert_nothing_published()

    def test_a_limit_of_one_is_refused_because_it_cannot_ever_fire(self):
        """At `limit == 1` the threshold is the whole corpus and the test is
        `deleted > corpus`, which even a corpus that vanished entirely cannot
        satisfy. That is the guard switched off, not loosened — and 1 is exactly
        the value someone reaches for after reading "0.1%"."""
        records = fixtures.corpus_v1()
        write_tree(self.clone, {})
        with self.assertRaises(ingest.Abort) as caught:
            self.ingest_run(tombstone_limit=1)
        self.assertIn("disable the guard", str(caught.exception))
        self.assertNotEqual(caught.exception.code, ingest.EXIT_GUARD)
        # The whole corpus really would have disappeared here.
        self.assertEqual(len(records), 2)
        self.assert_nothing_published()

    def test_a_limit_of_zero_is_the_strictest_setting_rather_than_a_mistake(self):
        records = fixtures.corpus_v1()
        del records["CVE-2026-1002"]
        write_tree(self.clone, records)
        with self.assertRaises(ingest.Abort) as caught:
            self.ingest_run(tombstone_limit=0)
        self.assertEqual(caught.exception.code, ingest.EXIT_GUARD)
        # And it is a guard rather than a blanket refusal: with nothing to
        # tombstone the run publishes normally.
        write_tree(self.clone, fixtures.corpus_v2())
        self.assertEqual(self.ingest_run(tombstone_limit=0)["rev"], 2)

    def test_an_unparseable_record_stops_the_run_before_the_build(self):
        write_tree(self.clone, fixtures.corpus_v2())
        with open(
            os.path.join(self.clone, "cves", "2026", "1xxx", "CVE-2026-1099.json"),
            "w",
            encoding="utf-8",
        ) as handle:
            handle.write("{ not json")

        # The run names every unusable record on stderr, which is the point of
        # it — captured here only to keep the test output readable.
        with contextlib.redirect_stderr(io.StringIO()) as noise:
            with self.assertRaises(ingest.Abort) as caught:
                self.ingest_run()
        self.assertIn("CVE-2026-1099.json", noise.getvalue())
        self.assertIn("cannot be published", str(caught.exception))
        self.assertFalse(os.path.exists(self.artifacts))
        self.assert_nothing_published()

    def test_a_record_that_has_no_utf8_encoding_is_named_rather_than_crashing(self):
        """RE-015: a lone surrogate is legal JSON that neither SQLite can store
        nor `content_hash` can hash. The scan is the first thing to touch it,
        and it has the `skipped` channel in hand — so the record is named
        instead of the codec."""
        records = fixtures.corpus_v2()
        records["CVE-2026-1003"]["containers"]["cna"]["descriptions"] = [
            {"lang": "en", "value": json.loads('"\\ud800"')}
        ]
        write_tree(self.clone, records)

        scanned = ingest.scan(self.clone)
        self.assertEqual(len(scanned["skipped"]), 1)
        self.assertIn("CVE-2026-1003.json", scanned["skipped"][0])
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(ingest.Abort):
                self.ingest_run()
        self.assert_nothing_published()

    def test_the_hash_pass_and_the_build_refuse_the_same_records(self):
        """The anti-drift check: two loops, one set of rules (D-047).

        `scan` exists because the guard has to run before the build — but the
        moment there are two walks, the thing that can go wrong is that they
        disagree about which records exist.
        """
        records = fixtures.corpus_v2()
        write_tree(self.clone, records)
        directory = os.path.join(self.clone, "cves", "2026", "1xxx")
        with open(os.path.join(directory, "CVE-2026-1098.json"), "w", encoding="utf-8") as handle:
            handle.write("{ not json")
        with open(os.path.join(directory, "CVE-2026-1097.json"), "w", encoding="utf-8") as handle:
            json.dump([1, 2, 3], handle)
        # A record whose id is neither well-formed in the file nor recoverable
        # from the file name.
        with open(os.path.join(directory, "CVE-2026-nope.json"), "w", encoding="utf-8") as handle:
            json.dump({"cveMetadata": {"state": "PUBLISHED"}}, handle)
        # And two files claiming one CVE ID, which is reachable from record
        # content because `cveId` is publisher-supplied (rule 5).
        with open(os.path.join(directory, "CVE-2026-1096.json"), "w", encoding="utf-8") as handle:
            json.dump(records["CVE-2026-1001"], handle)

        scanned = ingest.scan(self.clone)
        stats = build.build(
            self.clone,
            os.path.join(self.root, "agreement.sqlite"),
            None,
            None,
            bootstrap=True,
            rev=1,
        )
        self.assertEqual(sorted(scanned["skipped"]), sorted(stats["skipped"]))
        self.assertEqual(len(scanned["skipped"]), 4)
        self.assertEqual(len(scanned["hashes"]), stats["records"])

    def test_a_dirty_corpus_stops_the_run_even_with_no_fetch(self):
        """`--no-fetch` skips the clean that makes the tree the commit, so this
        is the only thing between a hand-edited working tree and a published
        delta. `test_corpus_dirt_reports_a_modified_record` covers the detection
        itself against a real git clone; this covers the wiring."""
        write_tree(self.clone, fixtures.corpus_v2())
        with mock.patch.object(ingest, "corpus_dirt", lambda _clone: " M cves/2026/1xxx/x.json"):
            with self.assertRaises(ingest.Abort) as caught:
                self.ingest_run()
        self.assertIn("uncommitted changes", str(caught.exception))
        self.assertFalse(os.path.exists(self.artifacts))
        self.assert_nothing_published()

    def test_a_state_that_no_longer_describes_the_head_stops_the_run(self):
        db = sqlite3.connect(os.path.join(self.state_dir, state_module.STATE_NAME))
        try:
            db.execute("UPDATE meta SET v = 7 WHERE k = 'rev'")
            db.commit()
        finally:
            db.close()

        write_tree(self.clone, fixtures.corpus_v2())
        with self.assertRaises(ingest.Abort) as caught:
            self.ingest_run()
        self.assertIn("rev 7", str(caught.exception))
        self.assertEqual(self.head(), 1)

    def test_a_ledger_ahead_of_the_manifest_stops_the_run(self):
        """The two authorities disagreeing means a publication is half-done, and
        the pending run is what finishes it — so outside a resume this is a
        state nothing should build on (D-058 §5)."""
        book = ledger.load(self.pub)
        book["deltas"]["1-5.json.br"] = {"sha256": "0" * 64, "bytes": 1}
        ledger.save(self.pub, book)

        write_tree(self.clone, fixtures.corpus_v2())
        with self.assertRaises(ingest.Abort) as caught:
            self.ingest_run()
        self.assertIn("ledger records rev 5", str(caught.exception))
        self.assertEqual(self.head(), 1)

    def test_a_missing_seed_stops_the_run_rather_than_bootstrapping(self):
        os.remove(self.snapshot)
        write_tree(self.clone, fixtures.corpus_v2())
        with self.assertRaises(ingest.Abort) as caught:
            self.ingest_run()
        self.assertIn("ID space", str(caught.exception))
        self.assert_nothing_published()

    def test_the_lock_keeps_two_jobs_apart_without_waiting(self):
        """Non-blocking is the decision (D-042): a daily run that finds the
        monthly snapshot in progress has nothing to wait for."""
        with state_module.lock(self.state_dir):
            with self.assertRaises(state_module.Busy):
                within(10, self.ingest_run)

    def test_a_dry_run_builds_and_reports_but_publishes_nothing(self):
        write_tree(self.clone, fixtures.corpus_v2())
        report = self.ingest_run(dry_run=True)

        self.assertEqual(report["result"], "dry run; nothing published")
        self.assertEqual(report["would_publish"]["rev"], 2)
        self.assertEqual(report["would_publish"]["upserts"], 3)
        self.assert_nothing_published()
        self.assertIsNone(self.pending())


class CrossChecks(Plane):
    """The build's counts against the hash pass's (D-058 §1).

    Nothing a corpus can do makes the two walks disagree — they apply the same
    rules to the same tree — so the only way to exercise the check is to make
    the build lie about what it did. That is worth doing: without these, the
    check is invisible to the suite, and the `build.retired_records` defect it
    caught could be reintroduced with every ingest test still green.
    """

    def _expect_disagreement(self, field: str, by: int):
        write_tree(self.clone, fixtures.corpus_v2())
        with mock.patch.object(ingest.build, "build", skewed_build(field, by)):
            with self.assertRaises(ingest.Abort) as caught:
                self.ingest_run()
        self.assertIn("the two walks disagree", str(caught.exception))
        # And the artifact that was already written is cleaned up, rather than
        # left for `--keep` to count.
        self.assertEqual(os.listdir(self.artifacts), [])
        self.assert_nothing_published()

    def test_a_build_that_walked_a_different_number_of_records_aborts(self):
        self._expect_disagreement("records", 1)

    def test_a_build_that_minted_a_different_number_of_records_aborts(self):
        self._expect_disagreement("new_records", -1)

    def test_a_build_that_retired_records_the_diff_did_not_see_aborts(self):
        self._expect_disagreement("retired_records", 1)

    def test_a_build_that_could_not_publish_a_record_aborts_and_leaves_nothing(self):
        write_tree(self.clone, fixtures.corpus_v2())
        real = build.build

        def fake(*args, **kwargs):
            stats = real(*args, **kwargs)
            stats["skipped"] = ["/somewhere/CVE-2026-1234.json"]
            return stats

        with mock.patch.object(ingest.build, "build", fake):
            with self.assertRaises(ingest.Abort) as caught:
                self.ingest_run()
        self.assertIn("could not publish", str(caught.exception))
        self.assertEqual(os.listdir(self.artifacts), [])
        self.assert_nothing_published()


class ReRuns(Plane):
    """What happens when a run dies between minting a revision and the manifest
    naming it. Every one of these is a retry against a URL that can never be
    corrected, so the only acceptable outcomes are byte-identical or nothing.

    Each moves the tree on before retrying, so "resumed the pinned changeset"
    and "recomputed a new one" produce different results — without that, both
    behaviours pass every assertion.
    """

    def crash_before_the_file(self):
        write_tree(self.clone, fixtures.corpus_v2())
        with mock.patch.object(ingest.delta, "publish", side_effect=RuntimeError("crash")):
            with self.assertRaises(RuntimeError):
                self.ingest_run()

    def crash_before_the_ledger(self):
        """The narrowest window: the file is renamed into place and the run dies
        before `delta.write` records it. Only the file on disk knows."""
        write_tree(self.clone, fixtures.corpus_v2())
        with mock.patch.object(
            ingest.delta.ledger, "record_delta", side_effect=RuntimeError("crash")
        ):
            with self.assertRaises(RuntimeError):
                self.ingest_run()

    def crash_before_the_manifest(self):
        write_tree(self.clone, fixtures.corpus_v2())
        with mock.patch.object(
            manifest_module, "register_delta", side_effect=RuntimeError("crash")
        ):
            with self.assertRaises(RuntimeError):
                self.ingest_run()

    def test_a_crash_between_the_file_and_the_ledger_republishes_the_pinned_bytes(self):
        """The window where the file on disk is the *only* authority: the ledger
        has no entry and the manifest lists nothing, so treating "not recorded"
        as "never published" would abandon a range whose bytes are already
        served — and `delta.write` then refuses the re-minted payload at a URL it
        can neither reuse nor correct."""
        self.crash_before_the_ledger()
        pinned = self.pending()
        published = os.path.join(self.pub, "deltas", "1-2.json.br")
        self.assertTrue(os.path.exists(published))
        self.assertIsNone(ledger.delta_published(self.pub, {"from": 1, "to": 2}))
        self.assertEqual(self.head(), 1)
        before = digest(published)

        write_tree(self.clone, fixtures.corpus_v3())
        with a_day_later(), contextlib.redirect_stderr(io.StringIO()):
            report = self.ingest_run()

        self.assertEqual(report["resumed"]["action"], "republished")
        self.assertEqual(digest(published), before)
        self.assertEqual(read_delta(self.pub, 1, 2)["generated"], pinned["generated"])
        self.assertEqual(report["rev"], 3)

    def test_a_pending_run_that_published_nothing_is_abandoned_and_re_minted(self):
        """`begin_run` lands before `delta.publish`, so a *deterministic*
        refusal inside it would otherwise be replayed forever and the data plane
        would never advance again. Re-minting is safe for exactly the reason
        D-047 lets an unpublished range be re-cut."""
        self.crash_before_the_file()
        pinned = self.pending()
        self.assertEqual(pinned["rev"], 2)
        self.assert_nothing_published()

        write_tree(self.clone, fixtures.corpus_v3())
        with a_day_later(), contextlib.redirect_stderr(io.StringIO()):
            report = self.ingest_run()

        self.assertEqual(report["resumed"]["action"], "abandoned")
        self.assertEqual(report["rev"], 2)
        payload = read_delta(self.pub, 1, 2)
        # Re-minted against the tree as it now stands, not the pinned corpus:
        # corpus_v3 strips CVE-2026-1003's CWE, and absent means absent (D-055).
        record = next(r for r in payload["upsert"] if r["cve"] == "CVE-2026-1003")
        self.assertNotIn("cwe", record)
        self.assertGreater(payload["generated"], pinned["generated"])
        self.assertFalse(os.path.exists(os.path.join(self.pub, "deltas", "2-3.json.br")))
        self.assert_matches_rebuild(self.applied(self.snapshot, payload))

    def test_a_crash_after_the_manifest_names_it_only_advances_the_state(self):
        write_tree(self.clone, fixtures.corpus_v2())
        with mock.patch.object(
            state_module.State, "commit_run", side_effect=RuntimeError("crash")
        ):
            with self.assertRaises(RuntimeError):
                self.ingest_run()

        self.assertEqual(self.head(), 2)
        self.assertEqual(state_meta(self.state_dir, "rev"), 1)
        before = digest(os.path.join(self.pub, "deltas", "1-2.json.br"))

        with a_day_later(), contextlib.redirect_stderr(io.StringIO()):
            report = self.ingest_run()
        self.assertEqual(report["resumed"]["action"], "committed")
        self.assertEqual(digest(os.path.join(self.pub, "deltas", "1-2.json.br")), before)
        self.assertEqual(state_meta(self.state_dir, "rev"), 2)
        self.assertEqual(report["result"], "nothing changed")

    def test_a_crash_between_the_file_and_the_manifest_republishes_the_pinned_bytes(self):
        """The case the pinning exists for. The file is already at its immutable
        URL and the ledger has recorded its digest, so the retry must reproduce
        it exactly — with the tree moved on and the clock a day ahead."""
        self.crash_before_the_manifest()
        pinned = self.pending()
        published = os.path.join(self.pub, "deltas", "1-2.json.br")
        self.assertTrue(os.path.exists(published))
        before = digest(published)
        self.assertEqual(self.head(), 1)

        write_tree(self.clone, fixtures.corpus_v3())
        with a_day_later(), contextlib.redirect_stderr(io.StringIO()):
            report = self.ingest_run()

        self.assertEqual(report["resumed"]["action"], "republished")
        self.assertEqual(digest(published), before)
        payload = read_delta(self.pub, 1, 2)
        self.assertEqual(payload["generated"], pinned["generated"])
        # The pinned corpus, not the moved-on tree: corpus_v2's CVE-2026-1003
        # still carries the CWE that corpus_v3 strips.
        record = next(r for r in payload["upsert"] if r["cve"] == "CVE-2026-1003")
        self.assertTrue(record.get("cwe"))
        # And the same invocation catches up rather than costing another day.
        self.assertEqual(report["rev"], 3)
        self.assertEqual(self.head(), 3)
        self.assert_matches_rebuild(
            self.applied(self.snapshot, payload, read_delta(self.pub, 2, 3))
        )

    def test_a_published_delta_whose_file_vanished_is_rewritten_not_re_minted(self):
        """The ledger is the authority the filesystem cannot be. A delta whose
        file is gone but whose bytes the ledger recorded was still served, so
        re-minting the revision against a moved-on tree would put *different*
        bytes at that URL (D-047). The right recovery is to rewrite the same
        ones."""
        self.crash_before_the_manifest()
        pinned = self.pending()
        published = os.path.join(self.pub, "deltas", "1-2.json.br")
        before = digest(published)
        os.remove(published)
        self.assertIsNotNone(ledger.delta_published(self.pub, {"from": 1, "to": 2}))

        write_tree(self.clone, fixtures.corpus_v3())
        with a_day_later(), contextlib.redirect_stderr(io.StringIO()):
            report = self.ingest_run()

        self.assertEqual(report["resumed"]["action"], "republished")
        self.assertEqual(digest(published), before)
        self.assertEqual(read_delta(self.pub, 1, 2)["generated"], pinned["generated"])

    def test_a_resume_finishes_from_the_preserved_bytes_without_the_artifact(self):
        """The bytes were written down before they became visible, so finishing
        the publication needs the *file*, not the artifact that produced it —
        and no recompression happens at all, which is what makes the guarantee
        survive a brotli upgrade."""
        self.crash_before_the_manifest()
        published = os.path.join(self.pub, "deltas", "1-2.json.br")
        before = digest(published)
        os.remove(self.pending()["artifact"])

        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(ingest.Abort) as caught:
                self.ingest_run()

        # The publication completed from the preserved bytes...
        self.assertEqual(digest(published), before)
        self.assertEqual(self.head(), 2)
        self.assertEqual(state_meta(self.state_dir, "rev"), 2)
        self.assertIsNone(self.pending())
        # ...and only the *next* build fails, because its seed is gone (D-056).
        self.assertIn("cannot continue an ID space", str(caught.exception))

    def crash_before_the_ledger_after_the_rename(self):
        """The narrowest window of all: the file is at its URL and the entry is
        pinned, but the ledger has not recorded it yet."""
        write_tree(self.clone, fixtures.corpus_v2())
        with mock.patch.object(
            ingest.delta.ledger, "record_delta", side_effect=RuntimeError("crash")
        ):
            with self.assertRaises(RuntimeError):
                self.ingest_run()

    def test_a_pinned_entry_is_not_re_minted_when_its_file_disappears(self):
        """Abandoning requires proof that nothing was served. A pinned entry
        withdraws that proof — the bytes were decided and the file was at its
        URL — so a vanished file must be rebuilt and compared, never re-minted
        from a moved tree at a fresh digest."""
        self.crash_before_the_ledger_after_the_rename()
        pinned = self.pending()
        published = os.path.join(self.pub, "deltas", "1-2.json.br")
        before = digest(published)
        self.assertEqual(pinned["entry"]["sha256"], before)
        # Nothing recorded it anywhere; the file is the only witness...
        self.assertIsNone(ledger.delta_published(self.pub, {"from": 1, "to": 2}))
        self.assertFalse(manifest_module.lists_delta(self.pub, {"from": 1, "to": 2}))
        # ...and now that witness is gone.
        os.remove(published)

        write_tree(self.clone, fixtures.corpus_v3())
        with a_day_later(), contextlib.redirect_stderr(io.StringIO()):
            report = self.ingest_run()

        self.assertNotEqual(report["resumed"]["action"], "abandoned")
        # Rebuilt from the pinned changeset, and byte-identical to what was
        # served — not the moved tree's content at a new digest.
        self.assertEqual(digest(published), before)
        self.assertEqual(read_delta(self.pub, 1, 2)["generated"], pinned["generated"])
        record = next(
            r for r in read_delta(self.pub, 1, 2)["upsert"] if r["cve"] == "CVE-2026-1003"
        )
        self.assertTrue(record.get("cwe"), "the pinned corpus, not corpus_v3")

    def test_a_pinned_entry_whose_bytes_can_no_longer_be_rebuilt_stops(self):
        """If the compressor moved, the rebuilt payload is refused at the last
        moment it can be — after the digest is known, before the rename."""
        self.crash_before_the_ledger_after_the_rename()
        os.remove(os.path.join(self.pub, "deltas", "1-2.json.br"))

        real = ingest.delta.write

        def different_bytes(*args, **kwargs):
            kwargs["quality"] = 11  # a "different compressor", deterministically
            return real(*args, **kwargs)

        with mock.patch.object(ingest.delta, "write", different_bytes):
            with self.assertRaises(ingest.Abort) as caught:
                self.ingest_run()
        self.assertIn("the compressor moved", str(caught.exception))
        self.assertFalse(os.path.exists(os.path.join(self.pub, "deltas", "1-2.json.br")))
        self.assertIsNotNone(self.pending())
        self.assertEqual(self.head(), 1)

    def test_a_resume_with_neither_the_bytes_nor_the_artifact_stops(self):
        self.crash_before_the_manifest()
        os.remove(os.path.join(self.pub, "deltas", "1-2.json.br"))
        os.remove(self.pending()["artifact"])

        with self.assertRaises(ingest.Abort) as caught:
            self.ingest_run()
        self.assertIn("cannot be reproduced", str(caught.exception))
        # Abandoning is a human decision here: the ledger says those bytes were
        # published, and nothing left can produce them again.
        self.assertIsNotNone(self.pending())
        self.assertEqual(self.head(), 1)
        self.assertEqual(state_meta(self.state_dir, "rev"), 1)

    def test_a_published_file_that_no_longer_matches_its_record_stops(self):
        self.crash_before_the_manifest()
        published = os.path.join(self.pub, "deltas", "1-2.json.br")
        with open(published, "ab") as handle:
            handle.write(b"tampered")

        with self.assertRaises(ingest.Abort) as caught:
            self.ingest_run()
        self.assertIn("not the ones clients may already have fetched", str(caught.exception))
        self.assertEqual(self.head(), 1)

    def test_a_retry_at_a_different_quality_still_reproduces_the_pinned_bytes(self):
        """The changeset decides the JSON; the brotli quality decides the bytes,
        and the bytes are what the URL promises never to change. A hand re-run
        with a different `--quality` must not recompress into a different file
        at a URL that is already served."""
        write_tree(self.clone, fixtures.corpus_v2())
        with mock.patch.object(
            manifest_module, "register_delta", side_effect=RuntimeError("crash")
        ):
            with self.assertRaises(RuntimeError):
                self.ingest_run(quality=1)
        published = os.path.join(self.pub, "deltas", "1-2.json.br")
        before = digest(published)
        self.assertEqual(self.pending()["quality"], 1)

        write_tree(self.clone, fixtures.corpus_v3())
        with a_day_later(), contextlib.redirect_stderr(io.StringIO()):
            report = self.ingest_run(quality=5)

        self.assertEqual(report["resumed"]["action"], "republished")
        self.assertEqual(digest(published), before)

    def test_a_dry_run_leaves_a_pending_run_alone(self):
        self.crash_before_the_manifest()
        report = self.ingest_run(dry_run=True)
        self.assertEqual(report["pending"], 2)
        self.assertEqual(self.head(), 1)
        self.assertEqual(self.pending()["rev"], 2)


class Initialization(Plane):
    def test_init_records_the_corpus_behind_the_head(self):
        report = ingest.init(self.clone, self.pub, self.state_dir, self.snapshot, force=True)
        self.assertEqual(report["rev"], 1)
        self.assertEqual(report["records"], len(fixtures.corpus_v1()))
        self.assertEqual(report["idspace"], build.id_space(self.snapshot)["idspace"])

    def _legacy_copy(self, name: str, **meta) -> str:
        target = os.path.join(self.root, name)
        shutil.copyfile(self.snapshot, target)
        set_meta(target, **meta)
        return target

    def test_init_refuses_a_tree_that_is_not_the_published_corpus(self):
        records = fixtures.corpus_v1()
        records["CVE-2026-1004"] = {
            "cveMetadata": {"cveId": "CVE-2026-1004", "state": "PUBLISHED"},
            "containers": {"cna": {"descriptions": [{"lang": "en", "value": "Later."}]}},
        }
        write_tree(self.clone, records)
        with self.assertRaises(ingest.Abort) as caught:
            ingest.init(self.clone, self.pub, self.state_dir, self.snapshot, force=True)
        self.assertIn("not the same corpus", str(caught.exception))

    def test_init_refuses_a_tree_that_moved_past_the_artifact(self):
        """The id sets can still match while a record's *content* has changed,
        and recording that content as the artifact's drops the edit from every
        future delta. The artifact records the commit it read, so this is
        checked rather than left to the README."""
        artifact = self._legacy_copy("stamped.sqlite", commit="a" * 40)
        with mock.patch.object(ingest.build, "clone_commit", lambda _clone: "b" * 40):
            with self.assertRaises(ingest.Abort) as caught:
                ingest.init(self.clone, self.pub, self.state_dir, artifact, force=True)
        self.assertIn("was built from commit", str(caught.exception))

    def test_init_refuses_when_the_clone_cannot_say_which_commit_it_is(self):
        """The asymmetry has to fail closed: an artifact that names a commit is
        asking to be checked, and "this directory cannot tell me" is the state
        in which the check cannot be made, not a pass."""
        artifact = self._legacy_copy("stamped.sqlite", commit="a" * 40)
        # The fixture clone is a plain directory, so `clone_commit` returns "".
        with self.assertRaises(ingest.Abort) as caught:
            ingest.init(self.clone, self.pub, self.state_dir, artifact, force=True)
        self.assertIn("reports no commit", str(caught.exception))

    def test_init_refuses_a_corpus_with_uncommitted_changes(self):
        """The commit is only half the question: a modified or untracked record
        leaves `HEAD` alone while changing what `scan` hashes, and the id sets
        can still match."""
        with mock.patch.object(ingest, "corpus_dirt", lambda _clone: " M cves/2026/1xxx/x.json"):
            with self.assertRaises(ingest.Abort) as caught:
                ingest.init(self.clone, self.pub, self.state_dir, self.snapshot, force=True)
        self.assertIn("uncommitted changes", str(caught.exception))

    def test_init_refuses_an_artifact_that_records_no_id_space(self):
        legacy = self._legacy_copy("legacy.sqlite", idspace=None)
        with self.assertRaises(ingest.Abort) as caught:
            ingest.init(self.clone, self.pub, os.path.join(self.root, "fresh"), legacy)
        self.assertIn("records no ID space", str(caught.exception))

    def test_init_refuses_an_artifact_from_another_lineage(self):
        foreign = self._legacy_copy("foreign.sqlite", idspace="deadbeefdeadbeef")
        with self.assertRaises(ingest.Abort) as caught:
            ingest.init(self.clone, self.pub, os.path.join(self.root, "fresh"), foreign)
        self.assertIn("belongs to ID space", str(caught.exception))

    def test_init_refuses_an_artifact_stamped_at_another_revision(self):
        elsewhere = self._legacy_copy("elsewhere.sqlite", rev=5)
        with self.assertRaises(ingest.Abort) as caught:
            ingest.init(self.clone, self.pub, os.path.join(self.root, "fresh"), elsewhere)
        self.assertIn("is stamped rev 5", str(caught.exception))

    def test_init_refuses_a_sibling_of_the_artifact_that_was_published(self):
        """Two builds stamped at one revision inherit the lineage token and can
        mint different values at the same ids; only the ledger's fingerprint
        separates them (D-056). Reachable from the documented migration by
        re-running its build step."""
        records = fixtures.corpus_v1()
        records["CVE-2026-1004"] = {
            "cveMetadata": {"cveId": "CVE-2026-1004", "state": "PUBLISHED"},
            "containers": {"cna": {"descriptions": [{"lang": "en", "value": "Sibling."}]}},
        }
        sibling_clone = os.path.join(self.root, "sibling-clone")
        write_tree(sibling_clone, records)
        sibling = os.path.join(self.root, "sibling.sqlite")
        build.build(
            sibling_clone,
            sibling,
            None,
            None,
            bootstrap=True,
            idspace=build.id_space(self.snapshot)["idspace"],
            rev=1,
        )

        with self.assertRaises(ingest.Abort) as caught:
            ingest.init(sibling_clone, self.pub, os.path.join(self.root, "fresh"), sibling)
        self.assertIn("is not the artifact published at rev 1", str(caught.exception))

    def test_re_initializing_an_initialized_state_needs_force(self):
        with self.assertRaises(ingest.Abort) as caught:
            ingest.init(self.clone, self.pub, self.state_dir, self.snapshot)
        self.assertIn("already describes rev 1", str(caught.exception))

    def test_initializing_over_a_pending_run_is_refused_even_with_force(self):
        """`initialize` clears the pending record, and that record is the only
        evidence that a revision was minted — so `--force` must not be a way
        past it."""
        write_tree(self.clone, fixtures.corpus_v2())
        with mock.patch.object(ingest.delta, "publish", side_effect=RuntimeError("crash")):
            with self.assertRaises(RuntimeError):
                self.ingest_run()
        write_tree(self.clone, fixtures.corpus_v1())
        for force in (False, True):
            with self.assertRaises(ingest.Abort) as caught:
                ingest.init(self.clone, self.pub, self.state_dir, self.snapshot, force=force)
            self.assertIn("pending run at rev 2", str(caught.exception))
        self.assertIsNotNone(self.pending())

    def test_running_before_init_is_refused(self):
        with self.assertRaises(ingest.Abort) as caught:
            ingest.run(
                self.clone, self.pub, os.path.join(self.root, "fresh"), do_fetch=False, quality=1
            )
        self.assertIn("init", str(caught.exception))

    def test_status_reports_both_sides_without_taking_the_lock(self):
        write_tree(self.clone, fixtures.corpus_v2())
        self.ingest_run()
        with state_module.lock(self.state_dir):
            report = ingest.status(self.pub, self.state_dir)
        self.assertEqual(report["rev"], 2)
        self.assertEqual(report["head"], 2)
        self.assertEqual(report["ledger_head"], 2)
        self.assertEqual(report["ledger_idspace"], report["idspace"])
        self.assertIsNone(report["pending"])

    def test_status_reports_a_failed_run_so_a_silent_cron_is_discoverable(self):
        """There is no MTA on the production box, so cron mail alerts nobody and
        D-009 forbids telemetry. The state answering "is the ingest healthy?" is
        the alerting that exists (D-058)."""
        records = fixtures.corpus_v1()
        del records["CVE-2026-1002"]
        write_tree(self.clone, records)
        with self.assertRaises(ingest.Abort):
            self.ingest_run()

        failed = ingest.status(self.pub, self.state_dir)["last_run"]
        self.assertFalse(failed["ok"])
        self.assertIn("would be tombstoned", failed["error"])

        write_tree(self.clone, fixtures.corpus_v2())
        self.ingest_run()
        healthy = ingest.status(self.pub, self.state_dir)["last_run"]
        self.assertTrue(healthy["ok"])
        self.assertIsNone(healthy["error"])
        self.assertGreaterEqual(healthy["at"], failed["at"])

    def test_status_does_not_create_the_state_it_reports_on(self):
        elsewhere = os.path.join(self.root, "typo")
        report = ingest.status(self.pub, elsewhere)
        self.assertFalse(report["initialized"])
        self.assertFalse(os.path.exists(elsewhere))


class StateStore(unittest.TestCase):
    def setUp(self) -> None:
        self.root = tempfile.mkdtemp(prefix="cve-ingest-state-")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.path = os.path.join(self.root, state_module.STATE_NAME)

    def test_a_state_from_another_version_is_refused_rather_than_migrated(self):
        with state_module.State(self.path) as state:
            state.initialize(rev=1, artifact="a.sqlite", idspace="x", commit="", hashes={})
        set_meta(self.path, state=99)
        with self.assertRaises(ValueError) as caught:
            state_module.State(self.path)
        self.assertIn("ingest.py init", str(caught.exception))

    def test_initialize_replaces_the_history_a_bridging_delta_would_read(self):
        with state_module.State(self.path) as state:
            state.initialize(rev=1, artifact="a.sqlite", idspace="x", commit="", hashes={"A": "1"})
            state.commit_run(
                {
                    "rev": 2,
                    "artifact": "b.sqlite",
                    "commit": "",
                    "upsert": {},
                    "delete": ["A"],
                }
            )
            self.assertEqual(state.tombstones(), 1)
            state.initialize(rev=2, artifact="b.sqlite", idspace="x", commit="", hashes={"B": "2"})
            self.assertEqual(state.tombstones(), 0)
            self.assertEqual(state.count(), 1)


class Artifacts(Plane):
    def test_pruning_keeps_the_newest_and_never_the_seed(self):
        scratch = os.path.join(self.root, "prune")
        os.makedirs(scratch)
        for rev in (1, 2, 3, 4, 10):
            with open(os.path.join(scratch, f"rev-{rev}.sqlite"), "w") as handle:
                handle.write("x")
        # Something that is not a build, which must be left alone.
        with open(os.path.join(scratch, "notes.txt"), "w") as handle:
            handle.write("x")

        removed = ingest.prune_artifacts(
            scratch, keep=2, protect=os.path.join(scratch, "rev-1.sqlite")
        )
        self.assertEqual(
            sorted(os.listdir(scratch)),
            ["notes.txt", "rev-1.sqlite", "rev-10.sqlite", "rev-4.sqlite"],
        )
        self.assertEqual(len(removed), 2)

    def test_a_run_prunes_older_builds_and_can_still_seed_from_the_newest(self):
        write_tree(self.clone, fixtures.corpus_v2())
        self.ingest_run(keep=1)
        write_tree(self.clone, fixtures.corpus_v3())
        report = self.ingest_run(keep=1)

        self.assertEqual(report["pruned"], [os.path.join(self.artifacts, "rev-2.sqlite")])
        self.assertEqual(os.listdir(self.artifacts), ["rev-3.sqlite"])
        self.assertTrue(os.path.exists(self.rebuilt()))
        # The property that matters: the next run seeds from what survived.
        write_tree(self.clone, fixtures.corpus_v1())
        self.assertEqual(self.ingest_run(keep=1, tombstone_limit=0.5)["rev"], 4)


class Cli(Plane):
    """`main()`'s exit codes are the cron's contract (D-058)."""

    def _main(self, *argv: str) -> int:
        with mock.patch.object(sys, "argv", ["ingest.py", *argv]):
            with contextlib.redirect_stdout(io.StringIO()):
                with contextlib.redirect_stderr(io.StringIO()):
                    return ingest.main()

    def test_a_published_run_exits_zero(self):
        write_tree(self.clone, fixtures.corpus_v2())
        self.assertEqual(
            self._main("run", self.clone, self.pub, "--state", self.state_dir, "--no-fetch"),
            ingest.EXIT_OK,
        )
        self.assertEqual(self.head(), 2)

    def test_a_held_lock_exits_zero_rather_than_alerting(self):
        with state_module.lock(self.state_dir):
            code = within(
                10,
                lambda: self._main(
                    "run", self.clone, self.pub, "--state", self.state_dir, "--no-fetch"
                ),
            )
        self.assertEqual(code, ingest.EXIT_OK)

    def test_the_tombstone_guard_exits_three(self):
        records = fixtures.corpus_v1()
        del records["CVE-2026-1002"]
        write_tree(self.clone, records)
        self.assertEqual(
            self._main("run", self.clone, self.pub, "--state", self.state_dir, "--no-fetch"),
            ingest.EXIT_GUARD,
        )

    def test_any_other_abort_exits_one(self):
        self.assertEqual(
            self._main(
                "run", self.clone, self.pub, "--state", os.path.join(self.root, "fresh"),
                "--no-fetch",
            ),
            ingest.EXIT_ABORT,
        )


class Fetch(unittest.TestCase):
    """The one test that exercises git rather than a directory of files."""

    def setUp(self) -> None:
        self.root = tempfile.mkdtemp(prefix="cve-ingest-git-")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.upstream = os.path.join(self.root, "upstream")
        write_tree(self.upstream, fixtures.corpus_v1())
        self._git(self.upstream, "init", "-q", "-b", "main")
        self._git(self.upstream, "config", "user.email", "pipeline@example.invalid")
        self._git(self.upstream, "config", "user.name", "pipeline")
        self._commit(self.upstream, "first")

        self.clone = os.path.join(self.root, "clone")
        subprocess.run(
            ["git", "clone", "-q", "--depth", "1", f"file://{self.upstream}", self.clone],
            check=True,
            capture_output=True,
        )

    def _git(self, repo: str, *args: str) -> None:
        subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True)

    def _commit(self, repo: str, message: str) -> None:
        self._git(repo, "add", "-A")
        self._git(repo, "commit", "-q", "-m", message)

    def test_fetch_removes_an_untracked_record_rather_than_publishing_it(self):
        """`reset --hard` restores tracked files and deletes nothing untracked,
        so a stray `CVE-*.json` would be walked, hashed and published as though
        upstream had said it. The corpus has to be the tree git says we
        fetched."""
        stray = os.path.join(self.clone, "cves", "2026", "1xxx", "CVE-2026-9999.json")
        with open(stray, "w", encoding="utf-8") as handle:
            json.dump(
                {"cveMetadata": {"cveId": "CVE-2026-9999", "state": "PUBLISHED"}}, handle
            )
        self.assertIn("CVE-2026-9999", ingest.scan(self.clone)["hashes"])

        ingest.fetch(self.clone)

        self.assertFalse(os.path.exists(stray))
        self.assertNotIn("CVE-2026-9999", ingest.scan(self.clone)["hashes"])
        self.assertEqual(ingest.corpus_dirt(self.clone), "")

    def test_corpus_dirt_reports_a_modified_record(self):
        path = os.path.join(self.clone, "cves", "2026", "1xxx", "CVE-2026-1001.json")
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(" ")
        self.assertIn("CVE-2026-1001.json", ingest.corpus_dirt(self.clone))
        # And a directory that is not a git tree is not "dirty", it is unknown.
        self.assertEqual(ingest.corpus_dirt(os.path.join(self.root, "nope")), "")

    def test_fetch_advances_a_shallow_clone_and_returns_the_new_commit(self):
        before = build.clone_commit(self.clone)
        write_tree(self.upstream, fixtures.corpus_v2())
        self._commit(self.upstream, "a day of changes")

        after = ingest.fetch(self.clone)
        self.assertNotEqual(after, before)
        self.assertEqual(after, build.clone_commit(self.clone))
        # And the working tree is what the hash pass will walk.
        scanned = ingest.scan(self.clone)
        self.assertEqual(sorted(scanned["hashes"]), sorted(fixtures.corpus_v2()))
        self.assertEqual(scanned["skipped"], [])

    def test_a_build_records_the_commit_it_read(self):
        artifact = os.path.join(self.root, "from-git.sqlite")
        build.build(self.clone, artifact, None, None, bootstrap=True, rev=1)
        self.assertEqual(build.id_space(artifact)["commit"], build.clone_commit(self.clone))

    def test_a_broken_fetch_aborts_rather_than_publishing_a_truncated_corpus(self):
        shutil.rmtree(self.upstream)
        with self.assertRaises(ingest.Abort):
            ingest.fetch(self.clone)


if __name__ == "__main__":
    unittest.main()
