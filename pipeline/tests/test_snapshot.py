"""Tests for the monthly snapshot (D-042, D-060).

Four properties, and the last two are the ones the design turns on:

  1. **The rotation publishes what the head means.** The bytes served are the
     artifact the ingest last built, reassembled chunk by chunk — not a
     rebuild, and not anything else.
  2. **Retention buys what D-042 says it buys.** The previous generation and
     every delta back to it survive, so a client one generation behind catches
     up from the chunks it actually downloaded instead of re-downloading; the
     generation before that goes, and its deltas go one rotation later.
  3. **Landing at head is checked, not assumed.** A snapshot at the head
     revision reaches nobody who has already synced, so publishing different
     content there is refused — including by a *sibling* artifact of the same
     corpus, which shares its ID space and is invisible to every other guard.
  4. **The two crons compose.** One lock, separate outcome records, a crashed
     rotation that resumes, and a daily ingest that carries on afterwards.
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
import threading
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
sys.path.insert(0, HERE)

import apply as apply_module  # noqa: E402
import build  # noqa: E402
import delta  # noqa: E402
import fixtures  # noqa: E402
import ingest  # noqa: E402
import ledger  # noqa: E402
import manifest as manifest_module  # noqa: E402
import publish as publish_module  # noqa: E402
import snapshot as snapshot_module  # noqa: E402
import state as state_module  # noqa: E402
import test_ingest  # noqa: E402

RECORD_TABLES = test_ingest.RECORD_TABLES


def a_day_of_changes(day: int) -> dict:
    """One record's `dateUpdated` moved — 63% of real upstream changes (D-031).

    Distinct per day, so consecutive runs each mint a revision rather than
    reporting "nothing changed".
    """
    records = fixtures.corpus_v2()
    records["CVE-2026-1001"]["cveMetadata"]["dateUpdated"] = f"2026-04-{day:02d}T00:00:00Z"
    return records


class Rotation(test_ingest.Plane):
    """The `Plane` the daily ingest is tested against, rotated monthly."""

    def snapshot_run(self, **kwargs):
        kwargs.setdefault("quality", 1)
        kwargs.setdefault("jobs", 1)
        return snapshot_module.run(self.pub, self.state_dir, **kwargs)

    def day(self, number: int):
        test_ingest.write_tree(self.clone, a_day_of_changes(number))
        return self.ingest_run()

    def manifest(self) -> dict:
        return manifest_module.load(self.pub)

    def generations(self) -> list:
        return sorted(
            int(name.split("-")[1])
            for name in os.listdir(self.pub)
            if publish_module.GENERATION_DIR.match(name)
        )

    def delta_files(self) -> list:
        directory = os.path.join(self.pub, "deltas")
        return sorted(os.listdir(directory)) if os.path.isdir(directory) else []

    def downloaded(self, name: str, generation: dict | None = None) -> str:
        """The database a client gets by fetching a generation's chunks.

        Decompressed and written at each chunk's own offset, which is what the
        client does (D-041) — so this is the served bytes rather than the
        artifact they were cut from.
        """
        published = self.manifest()
        generation = generation or published["snapshot"]
        target = os.path.join(self.root, name)
        with open(target, "wb") as out:
            for chunk in generation["chunks"]:
                path = os.path.join(self.pub, generation["path"], chunk["name"])
                done = subprocess.run(
                    ["brotli", "-d", "-c", path], capture_output=True, check=True
                )
                out.seek(chunk["offset"])
                out.write(done.stdout)
        return target

    def sync(self, database: str, entries: list) -> str:
        """Apply a chain of published deltas to a database, as a client would."""
        db = sqlite3.connect(database)
        try:
            for entry in entries:
                payload = test_ingest.read_delta(self.pub, entry["from"], entry["to"])
                apply_module.apply(db, payload)
        finally:
            db.close()
        return database

    def assert_manifest_is_deliverable(self) -> None:
        """Nothing the manifest names may be missing — the failure retention is
        most likely to cause, and the one a client meets as a 404 mid-sync."""
        published = self.manifest()
        generation = os.path.join(self.pub, published["snapshot"]["path"])
        for chunk in published["snapshot"]["chunks"]:
            self.assertTrue(os.path.exists(os.path.join(generation, chunk["name"])), chunk["name"])
        for entry in published["deltas"]:
            name = manifest_module.delta_name(entry)
            path = os.path.join(self.pub, "deltas", name)
            self.assertTrue(os.path.exists(path), name)
            # The bytes, not just the name. `manifest.save` already runs
            # `assert_tiling` on everything it writes, so re-asserting that here
            # could not fail — but nothing checks that a *retained* entry still
            # describes the file retention left behind.
            with open(path, "rb") as handle:
                blob = handle.read()
            self.assertEqual(len(blob), entry["bytes"], name)
            self.assertEqual(hashlib.sha256(blob).hexdigest(), entry["sha256"], name)


class Publishing(Rotation):
    def test_a_rotation_serves_the_artifact_the_head_was_cut_from(self):
        self.day(1)
        report = self.snapshot_run()

        self.assertEqual(report["result"], "published")
        published = self.manifest()
        self.assertEqual(published["snapshot"]["rev"], 2)
        self.assertEqual(published["rev"], 2, "a rotation does not advance the head")
        with open(self.rebuilt(), "rb") as handle:
            artifact = handle.read()
        with open(self.downloaded("fresh.sqlite"), "rb") as handle:
            self.assertEqual(handle.read(), artifact, "the served bytes are the artifact's")
        self.assert_manifest_is_deliverable()

    def test_a_fresh_download_matches_a_client_that_synced_to_the_same_head(self):
        """M2's exit criterion in miniature, and the thing landing at head has
        to be true for: the generation published there is what every client
        already sitting at that watermark holds, which is why none of them is
        told to fetch it."""
        self.day(1)
        synced = self.sync(self.downloaded("gen-1.sqlite"), [{"from": 1, "to": 2}])
        self.snapshot_run()
        rotated = self.downloaded("gen-2.sqlite")
        for table in RECORD_TABLES:
            self.assertEqual(
                test_ingest.rows(rotated, table), test_ingest.rows(synced, table), table
            )

    def test_a_quiet_month_publishes_nothing(self):
        self.day(1)
        self.snapshot_run()
        with open(manifest_module.path(self.pub), "rb") as handle:
            before = hashlib.sha256(handle.read()).hexdigest()

        report = self.snapshot_run()
        self.assertEqual(report["result"], "snapshot already at head")
        with open(manifest_module.path(self.pub), "rb") as handle:
            self.assertEqual(hashlib.sha256(handle.read()).hexdigest(), before)
        self.assertEqual(self.generations(), [1, 2])

    def test_a_dry_run_reports_the_rotation_without_making_it(self):
        self.day(1)
        report = self.snapshot_run(dry_run=True)

        self.assertEqual(report["would_publish"]["rev"], 2)
        self.assertEqual(self.generations(), [1])
        self.assertIsNone(state_meta_outcome(self.state_dir))


class Retention(Rotation):
    def test_a_client_a_generation_behind_catches_up_rather_than_re_downloading(self):
        """What retention is *for* (D-042), and what the manifest could not
        express until the tiling rule was relaxed: the deltas kept across a
        rotation all start below the new snapshot's revision."""
        self.day(1)
        self.snapshot_run()
        behind = self.downloaded("behind.sqlite")
        self.day(2)
        self.day(3)
        self.snapshot_run()

        published = self.manifest()
        self.assertEqual(published["snapshot"]["rev"], 4)
        kept = [(entry["from"], entry["to"]) for entry in published["deltas"]]
        self.assertEqual(kept, [(2, 3), (3, 4)], "back to the previous generation, no further")
        self.assertTrue(
            all(entry["from"] < published["snapshot"]["rev"] for entry in published["deltas"]),
            "every retained delta starts below the snapshot it chains into",
        )
        self.assert_manifest_is_deliverable()

        # And the chain works from the bytes that client actually downloaded.
        self.sync(behind, published["deltas"])
        current = self.downloaded("current.sqlite")
        for table in RECORD_TABLES:
            self.assertEqual(
                test_ingest.rows(behind, table), test_ingest.rows(current, table), table
            )

    def test_the_generation_before_last_is_deleted_and_its_deltas_one_rotation_later(self):
        """Not the moment a successor appears: a client that read the manifest
        ten minutes ago is still fetching from the generation it named, and
        from the deltas that manifest listed."""
        self.day(1)
        self.snapshot_run()
        self.assertEqual(self.generations(), [1, 2])
        self.assertEqual(self.delta_files(), ["1-2.json.br"])

        self.day(2)
        self.snapshot_run()
        self.assertEqual(self.generations(), [2, 3], "the original generation is retired")
        self.assertEqual(
            self.delta_files(),
            ["1-2.json.br", "2-3.json.br"],
            "its deltas stay one more rotation, for a client still reading the old manifest",
        )
        self.assertEqual([(d["from"], d["to"]) for d in self.manifest()["deltas"]], [(2, 3)])

        self.day(3)
        self.snapshot_run()
        self.assertEqual(self.generations(), [3, 4])
        self.assertEqual(self.delta_files(), ["2-3.json.br", "3-4.json.br"])
        self.assert_manifest_is_deliverable()

    def test_a_crashed_rotation_does_not_widen_the_next_one_s_retention(self):
        """A rotation that died before the manifest leaves a generation on disk
        that nothing ever advertised. Deriving the delta cut from what is *on
        disk* then deleted a file the new manifest still named — the manifest
        advertised a 404 for every client one generation behind. Reproduced;
        the cut is bounded by the retention floor now."""
        self.day(1)
        with mock.patch.object(manifest_module, "save", side_effect=RuntimeError("crash")):
            with self.assertRaises(RuntimeError):
                self.snapshot_run()
        self.assertEqual(
            self.generations(), [1, 2], "chunks landed, the manifest never named them"
        )
        self.assertEqual(self.manifest()["snapshot"]["rev"], 1)

        self.day(2)
        report = self.snapshot_run()
        self.assertEqual(report["snapshot"]["retired"]["deltas"], [], "nothing is below the floor")
        kept = [(d["from"], d["to"]) for d in self.manifest()["deltas"]]
        self.assertEqual(kept, [(1, 2), (2, 3)])
        self.assert_manifest_is_deliverable()

    def test_a_crashed_rotation_does_not_shorten_the_grace_period_a_rotation_later(self):
        """One rotation further than the test above, which is where it broke.
        The crashed generation is retired at the *next* rotation, and the cut
        was taken from it — deleting a delta the manifest live sixty seconds
        earlier had named, in the operation that stopped naming it. The cut is
        bounded by the previous manifest's own floor now, so the grace period
        is what the previous manifest advertised rather than what is on disk."""
        self.day(1)
        with mock.patch.object(manifest_module, "save", side_effect=RuntimeError("crash")):
            with self.assertRaises(RuntimeError):
                self.snapshot_run()
        self.day(2)
        self.snapshot_run()
        self.day(3)
        # What a client could have read a moment before the next rotation.
        offered = self.manifest()
        self.assertEqual(
            [(d["from"], d["to"]) for d in offered["deltas"]], [(1, 2), (2, 3), (3, 4)]
        )

        report = self.snapshot_run()
        self.assertEqual(
            sorted(report["snapshot"]["retired"]["generations"]), ["snapshot-1", "snapshot-2"]
        )
        for entry in offered["deltas"]:
            name = manifest_module.delta_name(entry)
            self.assertTrue(
                os.path.exists(os.path.join(self.pub, "deltas", name)),
                f"{name} was named by the manifest that was live a moment ago",
            )
        self.assert_manifest_is_deliverable()

    def test_a_lost_manifest_retires_nothing(self):
        """Retention is defined by what the previous manifest advertised, so
        with no manifest there is no evidence and nothing to act on. Falling
        back to "everything below this revision" deleted both generations and
        the whole catch-up chain at the moment the pipeline knew least — and a
        lost `manifest.json` is a plausible thing to be recovering from."""
        self.day(1)
        self.day(2)
        self.snapshot_run()
        self.day(3)
        os.remove(manifest_module.path(self.pub))

        report = publish_module.publish(self.rebuilt(), self.pub, quality=1, jobs=1)
        self.assertEqual(report["retired"]["generations"], [])
        self.assertEqual(report["retired"]["deltas"], [])
        self.assertEqual(self.generations(), [1, 3, 4])
        self.assertEqual(sorted(self.delta_files()), ["1-2.json.br", "2-3.json.br", "3-4.json.br"])

    def test_a_legacy_manifest_keeps_its_generation_through_a_rotation(self):
        """A manifest written before `snapshot.rev` existed (D-055) carries no
        deltas either, so its top-level `rev` *is* its snapshot's — the fallback
        `head_rev` and `ledger._seed` already use. Without it the floor became
        the revision being published and the rotation deleted the generation the
        live manifest was still naming, on the one publish where that manifest
        is all a mid-download client has."""
        # The shape as it was: no `snapshot.rev`, and no deltas either — the
        # two went in together — so the top-level `rev` is the only thing that
        # says which generation is being served.
        legacy = manifest_module.load(self.pub)
        legacy["snapshot"].pop("rev")
        self.assertEqual(legacy["deltas"], [])
        self.assertEqual(legacy["rev"], 1)
        with open(manifest_module.path(self.pub), "w", encoding="utf-8") as handle:
            json.dump(legacy, handle)

        rebuilt = fixtures.build_artifact(
            self.root,
            a_day_of_changes(1),
            "legacy-next",
            rev=2,
            generated=fixtures.FIXED_GENERATED + 31,
            seed=self.snapshot,
        )
        report = publish_module.publish(rebuilt, self.pub, quality=1, jobs=1)

        self.assertEqual(report["retired"]["generations"], [])
        self.assertEqual(self.generations(), [1, 2])
        self.assert_manifest_is_deliverable()

    def test_a_generation_above_this_one_is_reported_rather_than_deleted(self):
        """Its bytes are the byte-identical resume evidence an interrupted
        publish needs (D-047), so sweeping it up would take away the only way to
        finish that run without `--force`."""
        self.day(1)
        self.day(2)
        os.makedirs(os.path.join(self.pub, "snapshot-9"), exist_ok=True)
        report = self.snapshot_run()

        self.assertEqual(report["snapshot"]["retired"]["unplaced"], ["snapshot-9"])
        self.assertIn(9, self.generations())
        self.assert_manifest_is_deliverable()

    def test_republishing_the_current_generation_does_not_destroy_retention(self):
        """The floor comes from the ledger because the manifest *moves*: read
        from the manifest it had already rotated, so a re-run at the same
        revision made the floor the revision being published — dropping every
        retained delta and deleting the previous generation in one operation."""
        self.day(1)
        self.day(2)
        self.snapshot_run()
        before = [(d["from"], d["to"]) for d in self.manifest()["deltas"]]

        publish_module.publish(self.rebuilt(), self.pub, quality=1, jobs=1)
        self.assertEqual([(d["from"], d["to"]) for d in self.manifest()["deltas"]], before)
        self.assertEqual(self.generations(), [1, 3])
        self.assert_manifest_is_deliverable()

    def test_retention_never_deletes_a_file_the_manifest_still_names(self):
        for day in (1, 2, 3, 4):
            self.day(day)
            self.snapshot_run()
            self.assert_manifest_is_deliverable()

    def test_a_rotation_leaves_the_ledger_able_to_refuse_a_rewrite(self):
        """Deleting a generation must not make its URLs re-cuttable — which is
        exactly the hole `ledger.py` exists to close (D-055 §7)."""
        self.day(1)
        self.snapshot_run()
        self.day(2)
        self.snapshot_run()

        self.assertNotIn(1, self.generations())
        self.assertTrue(ledger.snapshot_published(self.pub, 1))
        self.assertIn("1-2.json.br", ledger.load(self.pub)["deltas"])
        # And it is the *refusal* that matters, not the record: the directory is
        # gone, so nothing on disk remembers rev 1 was ever served.
        with self.assertRaisesRegex(SystemExit, "roll it backwards"):
            publish_module.publish(self.snapshot, self.pub, quality=1, jobs=1)
        self.assertNotIn(1, self.generations())


class LandingAtHead(Rotation):
    def test_a_sibling_artifact_at_head_is_refused(self):
        """The hazard D-056 left open. This build is legitimate, of the same
        corpus, seeded from the same ancestor — same lineage token, same
        `seed_rev`, same ID-space fingerprint — so nothing but the recorded
        artifact digest can tell it from the one the head was cut from. Published
        at head it would reach only clients that have never synced."""
        self.day(1)
        sibling = fixtures.build_artifact(
            self.root,
            a_day_of_changes(1),
            "sibling",
            rev=2,
            generated=fixtures.FIXED_GENERATED + 99,
            seed=self.snapshot,
        )
        self.assertEqual(build.fingerprint(sibling), build.fingerprint(self.rebuilt()))
        set_state_meta(self.state_dir, artifact=sibling)

        # The preflight catches it before 100 s of compression, and says so in
        # a dry run too — which is the question a dry run is actually asked.
        with self.assertRaisesRegex(ingest.Abort, "content came from artifact"):
            self.snapshot_run(dry_run=True)
        with self.assertRaisesRegex(ingest.Abort, "content came from artifact"):
            self.snapshot_run()
        self.assertEqual(self.generations(), [1])
        self.assertEqual(self.manifest()["snapshot"]["rev"], 1)

        # And `publish.py` refuses it independently, which is what makes the
        # preflight a diagnostic rather than the guard.
        with self.assertRaisesRegex(SystemExit, "cannot be rewritten"):
            publish_module.publish(sibling, self.pub, quality=1, jobs=1)
        self.assertEqual(self.generations(), [1])

    def test_force_cannot_replace_what_a_published_revision_s_content_is(self):
        """The refusal has to land *before* the generation directory is swapped
        in. `ledger._record_artifact` refuses it too, but that runs after the
        rename — which left new chunks on disk under a manifest still
        advertising the old digests, a client-visible corruption produced by the
        flag documented as local iteration."""
        self.day(1)
        self.snapshot_run()
        sibling = fixtures.build_artifact(
            self.root,
            a_day_of_changes(1),
            "forced",
            rev=2,
            generated=fixtures.FIXED_GENERATED + 11,
            seed=self.snapshot,
        )
        published = self.manifest()

        with self.assertRaisesRegex(SystemExit, "cannot be rewritten"):
            publish_module.publish(sibling, self.pub, quality=1, jobs=1, force=True)

        self.assertEqual(self.manifest(), published, "the manifest is untouched")
        # And the served bytes still are what it advertises.
        self.assert_manifest_is_deliverable()
        with open(self.rebuilt(), "rb") as handle:
            artifact = handle.read()
        with open(self.downloaded("still.sqlite"), "rb") as handle:
            self.assertEqual(handle.read(), artifact)

    def test_force_cannot_land_at_head_where_the_content_is_unrecorded_either(self):
        """The absence half, ungated as well. `--force` says "replace these
        bytes deliberately"; it cannot say "and tell every synced client",
        which is what landing at head would need. Gating this on `force` let
        any content at all land at head on a data plane whose record was
        missing — a plane published before D-060, or a ledger edited by hand."""
        self.day(1)
        recorded = ledger.load(self.pub)
        del recorded["artifacts"]["2"]
        ledger.save(self.pub, recorded)
        sibling = fixtures.build_artifact(
            self.root,
            a_day_of_changes(1),
            "forced-absent",
            rev=2,
            generated=fixtures.FIXED_GENERATED + 13,
            seed=self.snapshot,
        )

        with self.assertRaisesRegex(SystemExit, "no record of the artifact"):
            publish_module.publish(sibling, self.pub, quality=1, jobs=1, force=True)
        self.assertEqual(self.generations(), [1])
        self.assertEqual(self.manifest()["snapshot"]["rev"], 1)

    def test_a_bridge_cannot_redefine_a_published_revision_whose_artifact_is_unrecorded(self):
        """`None` is a gap, not a free revision. A plane published before D-060
        records no artifact for its head, and a bridge landing there from a
        sibling would leave fresh clients on one content and bridged clients on
        another, both calling it the same revision."""
        self.day(1)
        self.snapshot_run()
        recorded = ledger.load(self.pub)
        del recorded["artifacts"]["2"]
        ledger.save(self.pub, recorded)
        sibling = fixtures.build_artifact(
            self.root,
            a_day_of_changes(1),
            "bridge-sibling",
            rev=2,
            generated=fixtures.FIXED_GENERATED + 17,
            seed=self.snapshot,
        )

        with self.assertRaisesRegex(SystemExit, "already published, but nothing records"):
            delta.publish(
                sibling,
                self.pub,
                {
                    "from": 1,
                    "to": 2,
                    "upsert": ["CVE-2026-1001"],
                    "delete": [],
                    "floors": fixtures.floors(self.snapshot),
                    "generated": fixtures.FIXED_GENERATED + 17,
                },
                quality=1,
                force=True,
            )
        self.assertIsNone(ledger.artifact_at(self.pub, 2))

    def test_an_artifact_replaced_during_compression_is_refused(self):
        """The digest names a path; the chunks are read from that path
        afterwards. A file swapped in between would have the ledger record one
        artifact while the published chunks reconstruct another — and every
        manifest digest would agree, so nothing downstream notices."""
        self.day(1)
        sibling = fixtures.build_artifact(
            self.root,
            a_day_of_changes(5),
            "swapped",
            rev=2,
            generated=fixtures.FIXED_GENERATED + 23,
            seed=self.snapshot,
        )
        target = self.rebuilt()
        real = publish_module.compress_chunk

        def swap(job):
            result = real(job)
            shutil.copyfile(sibling, target)
            return result

        with mock.patch.object(publish_module, "compress_chunk", side_effect=swap):
            with self.assertRaisesRegex(SystemExit, "changed while it was being published"):
                self.snapshot_run()
        self.assertEqual(self.generations(), [1])
        self.assertFalse(
            any(name.startswith(".staging-") for name in os.listdir(self.pub)),
            "the staged chunks are cleaned up",
        )

    def test_an_artifact_replaced_between_digest_and_extract_is_refused(self):
        """The delta path has the same hash-then-reopen window the snapshot path
        does: `extract` reopens the file the digest named, so a swap in between
        would record one artifact while the payload came from another."""
        self.day(1)
        sibling = fixtures.build_artifact(
            self.root,
            a_day_of_changes(6),
            "swapped-delta",
            rev=3,
            generated=fixtures.FIXED_GENERATED + 29,
            seed=self.rebuilt(),
        )
        target = os.path.join(self.artifacts, "rev-3.sqlite")
        real = delta.extract

        def swap(*args, **kwargs):
            payload = real(*args, **kwargs)
            shutil.copyfile(sibling, target)
            return payload

        test_ingest.write_tree(self.clone, a_day_of_changes(2))
        with mock.patch.object(delta, "extract", side_effect=swap):
            with self.assertRaisesRegex(SystemExit, "changed while this delta was being"):
                self.ingest_run()
        self.assertFalse(os.path.exists(os.path.join(self.pub, "deltas", "2-3.json.br")))
        self.assertIsNone(ledger.artifact_at(self.pub, 3))

    def test_an_artifact_stamped_at_another_revision_is_refused_before_compressing(self):
        self.day(1)
        elsewhere = fixtures.build_artifact(
            self.root, a_day_of_changes(1), "elsewhere", rev=9, seed=self.snapshot
        )
        set_state_meta(self.state_dir, artifact=elsewhere)

        with self.assertRaisesRegex(ingest.Abort, "stamped rev 9"):
            self.snapshot_run()
        self.assertEqual(self.generations(), [1])

    def test_a_missing_artifact_stops_the_rotation(self):
        self.day(1)
        os.remove(self.rebuilt())
        with self.assertRaisesRegex(ingest.Abort, "is gone"):
            self.snapshot_run()

    def test_a_head_with_no_recorded_artifact_is_refused_rather_than_guessed_at(self):
        """The data plane published before D-060 recorded artifacts. A gap
        reads as "nothing to check", which is exactly what a wrong artifact
        needs — so it fails closed, and the next delta fixes it."""
        self.day(1)
        recorded = ledger.load(self.pub)
        del recorded["artifacts"]["2"]
        ledger.save(self.pub, recorded)

        with self.assertRaisesRegex(ingest.Abort, "nothing records which artifact"):
            self.snapshot_run()
        self.assertEqual(self.generations(), [1])

        # And `publish.py` refuses it too, which is what makes the check above a
        # diagnostic rather than the guard: a hand-run rotation bypasses the
        # first and still cannot land at head.
        with self.assertRaisesRegex(SystemExit, "no record of the artifact"):
            publish_module.publish(self.rebuilt(), self.pub, quality=1, jobs=1)
        self.assertEqual(self.generations(), [1])


class Guards(Rotation):
    """The refusals that had no test until a review deleted each one and watched
    the suite stay green (the D-056 standard)."""

    def test_a_rotation_before_init_is_refused(self):
        empty = os.path.join(self.root, "unstarted")
        with self.assertRaisesRegex(ingest.Abort, "describes no revision yet"):
            snapshot_module.run(self.pub, empty, quality=1, jobs=1)

    def test_a_dry_run_leaves_a_pending_run_pending(self):
        """The one write a dry run could make. `--dry-run` promises not to touch
        state, and finishing a crashed daily is very much touching it."""
        test_ingest.write_tree(self.clone, a_day_of_changes(1))
        with mock.patch.object(
            manifest_module, "register_delta", side_effect=RuntimeError("crash")
        ):
            with self.assertRaises(RuntimeError):
                self.ingest_run()
        pending = self.pending()
        self.assertIsNotNone(pending)

        report = self.snapshot_run(dry_run=True)
        self.assertEqual(report["pending"], pending["rev"])
        self.assertIn("pending run", report["result"])
        self.assertEqual(self.pending(), pending, "the pending run is untouched")
        self.assertEqual(self.generations(), [1])

    def test_a_revision_s_artifact_record_cannot_be_rewritten(self):
        """What a revision's content *is* is as immutable as the bytes at its
        URL. Overwriting the record would erase the only evidence of it."""
        self.day(1)
        other = fixtures.build_artifact(
            self.root,
            a_day_of_changes(1),
            "other",
            rev=2,
            generated=fixtures.FIXED_GENERATED + 7,
            seed=self.snapshot,
        )
        entry = {"from": 1, "to": 2, "sha256": "0" * 64, "bytes": 1}
        with self.assertRaisesRegex(SystemExit, "cannot be rewritten"):
            ledger.record_delta(self.pub, entry, None, build.digest_file(other))
        self.assertEqual(
            ledger.artifact_at(self.pub, 2), build.digest_file(self.rebuilt()), "unchanged"
        )

    def test_a_resumed_ingest_still_records_which_artifact_the_revision_came_from(self):
        """The reuse path finishes a publication from bytes already on disk, and
        used to register everything about them *except* their content — after
        which the rotation refused to land at that head for a month."""
        test_ingest.write_tree(self.clone, a_day_of_changes(1))
        with mock.patch.object(ledger, "record_delta", side_effect=RuntimeError("crash")):
            with self.assertRaises(RuntimeError):
                self.ingest_run()
        self.assertIsNotNone(self.pending())
        self.assertIsNone(ledger.artifact_at(self.pub, 2), "nothing was recorded yet")

        report = self.snapshot_run()
        self.assertEqual(report["resumed"]["action"], "republished")
        self.assertEqual(ledger.artifact_at(self.pub, 2), build.digest_file(self.rebuilt()))
        self.assertEqual(report["result"], "published")
        self.assert_manifest_is_deliverable()

    def test_the_generation_just_published_is_never_retired(self):
        """`retire` deletes directories, so it does not get to rely on a guard
        three modules away for the one directory the manifest now names. No
        reachable publish puts the floor above the revision — `assert_continues`
        refuses a publish behind the advertised generation even under `--force`
        — which is exactly why this is asserted directly."""
        self.day(1)
        self.snapshot_run()
        removed = publish_module.retire(self.pub, rev=2, floor=5, previous_floor=None)

        self.assertNotIn("snapshot-2", removed["generations"])
        self.assertIn(2, self.generations())
        self.assert_manifest_is_deliverable()

    def test_a_pending_run_pins_the_artifact_it_was_cut_from_by_content(self):
        """The pending run pins a *path*; this pins what is in it. A resume
        against a replaced file would record the wrong artifact as the
        revision's content — permanently, since the ledger will not correct it
        — and leave the state seeding from it. `_pin` cannot see it: a change
        *outside* the pinned upsert set reproduces the delta bytes exactly."""
        test_ingest.write_tree(self.clone, a_day_of_changes(1))
        with mock.patch.object(ledger, "record_delta", side_effect=RuntimeError("crash")):
            with self.assertRaises(RuntimeError):
                self.ingest_run()
        pending = self.pending()
        truth = pending["artifact_sha"]
        self.assertEqual(
            truth,
            build.digest_file(pending["artifact"]),
            "pinned from the build that produced this revision, not from the state's seed",
        )

        # An impostor at the same path, exactly as a recovery rebuild leaves.
        impostor = fixtures.build_artifact(
            self.root,
            a_day_of_changes(9),
            "impostor",
            rev=2,
            generated=fixtures.FIXED_GENERATED + 42,
            seed=self.snapshot,
        )
        shutil.copyfile(impostor, pending["artifact"])

        with self.assertRaisesRegex(ingest.Abort, "was cut from an artifact that hashed"):
            self.ingest_run()
        self.assertIsNotNone(self.pending(), "left intact for the artifact to be restored")
        self.assertIsNone(ledger.artifact_at(self.pub, 2), "and nothing was recorded from it")

    def test_a_restored_artifact_lets_the_pending_run_finish(self):
        """The other side of it: the refusal is about the *content*, so putting
        the right bytes back at that path is all the recovery it asks for."""
        test_ingest.write_tree(self.clone, a_day_of_changes(1))
        with mock.patch.object(ledger, "record_delta", side_effect=RuntimeError("crash")):
            with self.assertRaises(RuntimeError):
                self.ingest_run()
        pending = self.pending()
        keep = os.path.join(self.root, "kept.sqlite")
        shutil.copyfile(pending["artifact"], keep)
        shutil.copyfile(
            fixtures.build_artifact(
                self.root,
                a_day_of_changes(9),
                "impostor2",
                rev=2,
                generated=fixtures.FIXED_GENERATED + 42,
                seed=self.snapshot,
            ),
            pending["artifact"],
        )
        with self.assertRaises(ingest.Abort):
            self.ingest_run()

        shutil.copyfile(keep, pending["artifact"])
        self.ingest_run()
        self.assertIsNone(self.pending())
        self.assertEqual(ledger.artifact_at(self.pub, 2), pending["artifact_sha"])

    def test_a_pending_run_contradicted_at_its_own_revision_aborts_with_a_diagnosis(self):
        """`_record_artifact` raises `SystemExit`, which leaves `main` without
        the diagnosis and repeats identically on every later run — freezing the
        pending forever, which is the mode `resume`'s abandon path exists to
        prevent and which a pinned entry withdraws the proof for."""
        test_ingest.write_tree(self.clone, a_day_of_changes(1))
        with mock.patch.object(ledger, "record_delta", side_effect=RuntimeError("crash")):
            with self.assertRaises(RuntimeError):
                self.ingest_run()
        # Something else defines rev 2's content in the meantime.
        recorded = ledger.load(self.pub)
        recorded.setdefault("artifacts", {})["2"] = "f" * 64
        ledger.save(self.pub, recorded)

        with self.assertRaisesRegex(ingest.Abort, "already defined what this revision"):
            self.ingest_run()
        self.assertIsNotNone(self.pending(), "left for a human rather than discarded")

    def test_one_revision_has_one_generated_value(self):
        """`generated` is revision content, not decoration (D-055): apply writes
        it into the client's `meta`, and the worker surfaces it as freshness. A
        second clock reading for the delta made a synced client and a freshly
        downloaded one report different freshness at the same revision — by the
        build's own duration, since the artifact is stamped before `VACUUM`."""
        # The artifact is stamped with a value the clock cannot produce, so
        # "they agree" cannot pass by both landing in the same wall-clock
        # second — which is what made the first version of this test vacuous.
        # Patching `time.time` does not work here: `build` and `ingest` share
        # the module, so moving it moves both.
        stamp = fixtures.FIXED_GENERATED
        real_build = build.build

        def stamped(*args, **kwargs):
            stats = real_build(*args, **kwargs)
            set_artifact_meta(args[1], generated=stamp)
            stats["bytes"] = os.path.getsize(args[1])
            return stats

        test_ingest.write_tree(self.clone, a_day_of_changes(1))
        with mock.patch.object(ingest.build, "build", side_effect=stamped):
            self.ingest_run()
        payload = test_ingest.read_delta(self.pub, 1, 2)
        artifact_meta = publish_module.read_meta(self.rebuilt())
        self.assertEqual(int(artifact_meta["generated"]), stamp, "the artifact carries the stamp")
        self.assertEqual(payload["generated"], stamp, "and so does the delta cut from it")

        synced = self.applied(self.snapshot, payload)
        for key in ("rev", "generated"):
            self.assertEqual(
                str(read_meta(synced)[key]),
                str(artifact_meta[key]),
                f"a synced client and the artifact disagree about meta.{key}",
            )

    def test_a_replaced_artifact_is_refused_on_the_commit_only_path_too(self):
        """The branch that republishes nothing still commits, and `commit_run`
        records the artifact as the next build's seed. It reached that without
        the check — everything downstream then failed closed, which is the right
        direction but leaves the pipeline stuck on a seed it cannot build on."""
        test_ingest.write_tree(self.clone, a_day_of_changes(1))
        crash = RuntimeError("crash")
        with mock.patch.object(state_module.State, "commit_run", side_effect=crash):
            with self.assertRaises(RuntimeError):
                self.ingest_run()
        pending = self.pending()
        self.assertTrue(
            manifest_module.lists_delta(self.pub, {"from": 1, "to": 2}),
            "the publication completed; only the state write was lost",
        )
        shutil.copyfile(
            fixtures.build_artifact(
                self.root,
                a_day_of_changes(9),
                "impostor3",
                rev=2,
                generated=fixtures.FIXED_GENERATED + 51,
                seed=self.snapshot,
            ),
            pending["artifact"],
        )

        with self.assertRaisesRegex(ingest.Abort, "was cut from an artifact that hashed"):
            self.ingest_run()
        self.assertIsNotNone(self.pending(), "left intact for the artifact to be restored")
        self.assertEqual(
            state_meta_value(self.state_dir, "artifact"),
            self.snapshot,
            "and the state still seeds from the artifact it was on",
        )

    def test_a_publication_finished_before_the_state_backfills_its_artifact_record(self):
        """The one path that reaches `commit_run` without recording anything: a
        run interrupted before this field existed, whose publication completed
        under the old code. Committing over that leaves the gap permanently —
        only a delta writes the record, a corpus that stops changing cuts no
        more deltas, and every rotation is blocked on it."""
        test_ingest.write_tree(self.clone, a_day_of_changes(1))
        crash = RuntimeError("crash")
        with mock.patch.object(state_module.State, "commit_run", side_effect=crash):
            with self.assertRaises(RuntimeError):
                self.ingest_run()
        pending = self.pending()
        self.assertIsNotNone(pending)
        self.assertTrue(manifest_module.lists_delta(self.pub, {"from": 1, "to": 2}))
        # As a pre-D-060 run would have left it: published, but no record.
        recorded = ledger.load(self.pub)
        del recorded["artifacts"]["2"]
        ledger.save(self.pub, recorded)

        report = self.ingest_run()
        self.assertEqual(report["resumed"]["action"], "committed")
        self.assertEqual(ledger.artifact_at(self.pub, 2), pending["artifact_sha"])
        self.assertIsNone(self.pending())
        # And the rotation is no longer blocked on it.
        self.assertEqual(self.snapshot_run()["result"], "published")

    def test_a_retained_delta_whose_file_vanished_drops_out_of_the_manifest(self):
        """The last thing between a hand-deleted file and a manifest naming a
        404. It matters more since retention started keeping entries across
        rotations at all."""
        self.day(1)
        self.day(2)
        os.remove(os.path.join(self.pub, "deltas", "1-2.json.br"))
        self.snapshot_run()

        self.assertEqual([(d["from"], d["to"]) for d in self.manifest()["deltas"]], [(2, 3)])
        self.assert_manifest_is_deliverable()

    def test_status_reports_how_far_the_generation_has_fallen_behind(self):
        self.day(1)
        self.snapshot_run()
        self.day(2)
        self.day(3)

        reported = ingest.status(self.pub, self.state_dir)
        self.assertEqual(reported["snapshot_rev"], 2)
        self.assertEqual(reported["head"], 4)
        self.assertEqual(reported["deltas"], 3)


class Composition(Rotation):
    def test_the_daily_ingest_carries_on_after_a_rotation(self):
        self.day(1)
        self.snapshot_run()
        report = self.day(2)

        self.assertEqual(report["result"], "published")
        self.assertEqual(self.head(), 3)
        published = self.manifest()
        self.assertEqual(published["snapshot"]["rev"], 2, "the generation is unchanged")
        self.assertEqual([(d["from"], d["to"]) for d in published["deltas"]], [(1, 2), (2, 3)])
        self.assert_manifest_is_deliverable()

    def test_the_rotation_takes_the_daily_ingest_s_lock(self):
        """D-042's requirement, and the one that is silently satisfiable by
        forgetting it: the monthly job moves the generation the daily is
        publishing a delta against.

        The wait is bounded, so a lock held indefinitely still ends in `Busy`
        rather than a cron job that never returns."""
        self.day(1)
        with state_module.lock(self.state_dir):
            with self.assertRaises(state_module.Busy):
                test_ingest.within(20, lambda: self.snapshot_run(lock_wait=0.2))
        self.assertEqual(self.generations(), [1])

    def test_the_rotation_waits_for_the_daily_rather_than_skipping_a_month(self):
        """The asymmetry D-060 turns on. A daily that finds the monthly running
        has nothing to wait for — the snapshot moves the head it would build
        against — but a monthly that finds the daily running loses a *month* by
        skipping, and loses nothing by waiting: the daily's delta just moves the
        head it lands on. Skipping is also the one outcome it cannot record,
        because recording needs the lock."""
        self.day(1)
        holder = state_module.lock(self.state_dir)
        holder.__enter__()
        released: list = []

        def release():
            time.sleep(0.3)
            released.append(True)
            holder.__exit__(None, None, None)

        waiter = threading.Thread(target=release, daemon=True)
        waiter.start()
        report = test_ingest.within(30, lambda: self.snapshot_run(lock_wait=10))
        waiter.join(5)

        self.assertTrue(released, "the rotation ran before the lock was released")
        self.assertEqual(report["result"], "published")
        self.assertEqual(self.manifest()["snapshot"]["rev"], 2)

    def test_a_pending_ingest_is_finished_before_the_rotation(self):
        """A crashed daily leaves a revision minted and unconfirmed. Refusing
        would cost a month — the next attempt at this job — so it finishes the
        publication the same way the daily would, under the same lock."""
        test_ingest.write_tree(self.clone, a_day_of_changes(1))
        with mock.patch.object(
            manifest_module, "register_delta", side_effect=RuntimeError("crash")
        ):
            with self.assertRaises(RuntimeError):
                self.ingest_run()
        self.assertIsNotNone(self.pending())

        report = self.snapshot_run()
        self.assertEqual(report["resumed"]["action"], "republished")
        self.assertIsNone(self.pending())
        self.assertEqual(self.manifest()["snapshot"]["rev"], 2)
        self.assert_manifest_is_deliverable()

    def test_a_rotation_that_died_before_the_manifest_is_resumed(self):
        """The chunks land by rename before the manifest names them, so a crash
        in between leaves a generation on disk that nothing advertises.
        Re-cutting the same bytes finishes it (D-047, D-056)."""
        self.day(1)
        with mock.patch.object(manifest_module, "save", side_effect=RuntimeError("crash")):
            with self.assertRaises(RuntimeError):
                self.snapshot_run()
        self.assertEqual(self.manifest()["snapshot"]["rev"], 1, "nothing is advertised yet")

        report = self.snapshot_run()
        self.assertEqual(report["result"], "published")
        self.assertEqual(self.manifest()["snapshot"]["rev"], 2)
        self.assert_manifest_is_deliverable()

    def test_a_state_that_does_not_describe_the_head_stops_the_rotation(self):
        self.day(1)
        set_state_meta(self.state_dir, rev=1)
        with self.assertRaisesRegex(ingest.Abort, "the data plane is at rev 2"):
            self.snapshot_run()
        self.assertEqual(self.generations(), [1])

    def test_each_job_records_its_own_outcome(self):
        """A monthly failure hidden under this morning's daily success is a
        month of no rotation and no way to notice — and `status` is the only
        alerting this machine has (D-058)."""
        self.day(1)
        with mock.patch.object(manifest_module, "save", side_effect=RuntimeError("crash")):
            with self.assertRaises(RuntimeError):
                self.snapshot_run()

        reported = ingest.status(self.pub, self.state_dir)
        self.assertTrue(reported["last_run"]["ok"], "the daily is still healthy")
        self.assertFalse(reported["last_snapshot"]["ok"])
        self.assertIn("crash", reported["last_snapshot"]["error"])
        self.assertEqual(reported["snapshot_rev"], 1)

        self.snapshot_run()
        self.assertTrue(ingest.status(self.pub, self.state_dir)["last_snapshot"]["ok"])


class Cli(Rotation):
    """`main()`'s exit codes are the cron's contract, as they are for the daily
    (D-058) — and this job's `Busy` branch is the one that decides whether a
    skipped month is silent."""

    def _main(self, *argv: str) -> int:
        with mock.patch.object(sys, "argv", ["snapshot.py", *argv]):
            with contextlib.redirect_stdout(io.StringIO()):
                with contextlib.redirect_stderr(io.StringIO()):
                    return snapshot_module.main()

    def test_a_published_rotation_exits_zero(self):
        self.day(1)
        self.assertEqual(
            self._main(self.pub, "--state", self.state_dir, "--quality", "1", "--jobs", "1"),
            snapshot_module.EXIT_OK,
        )
        self.assertEqual(self.manifest()["snapshot"]["rev"], 2)

    def test_nothing_to_do_exits_zero(self):
        self.assertEqual(
            self._main(self.pub, "--state", self.state_dir, "--quality", "1", "--jobs", "1"),
            snapshot_module.EXIT_OK,
        )

    def test_a_lock_held_past_the_wait_exits_zero_rather_than_alerting(self):
        self.day(1)
        with state_module.lock(self.state_dir):
            code = test_ingest.within(
                20,
                lambda: self._main(
                    self.pub, "--state", self.state_dir, "--quality", "1", "--jobs", "1",
                    "--lock-wait", "0.2",
                ),
            )
        self.assertEqual(code, snapshot_module.EXIT_OK)
        self.assertEqual(self.generations(), [1])

    def test_an_abort_exits_one(self):
        self.assertEqual(
            self._main(
                self.pub, "--state", os.path.join(self.root, "fresh"),
                "--quality", "1", "--jobs", "1",
            ),
            ingest.EXIT_ABORT,
        )

    def test_a_refusal_from_publish_still_exits_one_and_is_recorded(self):
        """`publish.py` raises `SystemExit`, which leaves `main` by a different
        path than `Abort` — the interpreter turns a message into status 1, which
        is the code the cron contract promises. What matters more is that the
        outcome is still written down: this is the failure an operator has a
        month to notice."""
        self.day(1)
        # Reached through a refusal the preflight does not make: `publish.py`
        # checks the D-008 notice, and raises `SystemExit` rather than `Abort`.
        stripped = dict(publish_module.read_meta(self.rebuilt()))
        stripped["notice"] = ""
        with mock.patch.object(publish_module, "read_meta", return_value=stripped):
            with self.assertRaises(SystemExit) as raised:
                self._main(self.pub, "--state", self.state_dir, "--quality", "1", "--jobs", "1")
        # A string payload is status 1 (`SystemExit.code` is the message).
        self.assertIsInstance(raised.exception.code, str)
        self.assertIn("no MITRE notice", raised.exception.code)
        self.assertEqual(self.generations(), [1])
        self.assertFalse(ingest.status(self.pub, self.state_dir)["last_snapshot"]["ok"])


def set_artifact_meta(db_path: str, **values) -> None:
    db = sqlite3.connect(db_path)
    try:
        for key, value in values.items():
            db.execute("UPDATE meta SET v = ? WHERE k = ?", (value, key))
        db.commit()
    finally:
        db.close()


def state_meta_value(state_dir: str, key: str):
    return test_ingest.state_meta(state_dir, key)


def read_meta(db_path: str) -> dict:
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        return dict(db.execute("SELECT k, v FROM meta"))
    finally:
        db.close()


def set_state_meta(state_dir: str, **values) -> None:
    db = sqlite3.connect(os.path.join(state_dir, state_module.STATE_NAME))
    try:
        for key, value in values.items():
            db.execute(
                "INSERT INTO meta(k, v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                (key, value),
            )
        db.commit()
    finally:
        db.close()


def state_meta_outcome(state_dir: str):
    return test_ingest.state_meta(state_dir, "last_snapshot")


if __name__ == "__main__":
    unittest.main()
