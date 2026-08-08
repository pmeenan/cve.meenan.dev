"""Tests for the KEV cron (D-010, D-076).

Everything here is about one property: **nothing reaches the published URL that
was not fully checked first**, and a run that refuses leaves the previous
catalog serving. `kev.json` is mutable and unversioned, so a bad publish is not
a bad file at a new URL that nobody has yet — it is the known-exploited list the
app is showing right now.

So the cases are the refusals, each asserted to leave the published bytes
*unchanged* rather than merely to raise:

  1. **Structural validation** — not JSON, not an object, a missing required
     field, a `count` that disagrees with the list, a malformed or duplicated
     `cveID`, an oversized body.
  2. **The roll-backwards guard** — an older catalog is refused, an equal one is
     accepted (CISA corrects entries in place), and two catalogs that cannot be
     *ordered* are refused rather than waved through, because a guard that
     cannot tell newer from older is not a guard.
  3. **Failure domain and last-good** — a failed fetch publishes nothing, keeps
     the previous catalog, and is still discoverable through `status`.
  4. **Atomicity** — the publish is a rename, so a reader never sees a partial
     catalog.
"""

from __future__ import annotations

import builtins
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
sys.path.insert(0, HERE)

import kev  # noqa: E402


def catalog(
    *,
    version: str = "2026.08.08",
    released: str = "2026-08-08T00:00:00.0000Z",
    entries: int = 3,
    count: int | None = None,
) -> dict:
    rows = []
    for at in range(entries):
        rows.append(
            {
                "cveID": f"CVE-2026-{1000 + at}",
                "vendorProject": "Vendor",
                "product": "Product",
                "vulnerabilityName": "Name",
                "dateAdded": "2026-08-01",
                "shortDescription": "Description.",
                "requiredAction": "Apply updates per vendor instructions.",
                "dueDate": "2026-08-22",
                "knownRansomwareCampaignUse": "Known" if at == 0 else "Unknown",
                "notes": "https://example.invalid/advisory",
                "cwes": ["CWE-79"] if at == 0 else [],
            }
        )
    return {
        "title": "CISA Catalog of Known Exploited Vulnerabilities",
        "catalogVersion": version,
        "dateReleased": released,
        "count": len(rows) if count is None else count,
        "vulnerabilities": rows,
    }


def blob(value: dict) -> bytes:
    return json.dumps(value).encode("utf-8")


class Validation(unittest.TestCase):
    def test_accepts_a_well_formed_catalog(self):
        parsed = kev.validate(blob(catalog()))
        self.assertEqual(parsed["catalogVersion"], "2026.08.08")
        self.assertEqual(len(parsed["vulnerabilities"]), 3)

    def test_refuses_what_is_not_json(self):
        with self.assertRaises(kev.Refuse):
            kev.validate(b"<html>403 Forbidden</html>")

    def test_refuses_a_json_array(self):
        # The Akamai failure mode D-076 anticipates is an error *page*, but a
        # feed that changed shape to a bare list is the one that would parse.
        with self.assertRaises(kev.Refuse):
            kev.validate(b"[]")

    def test_refuses_an_empty_body(self):
        with self.assertRaises(kev.Refuse):
            kev.validate(b"")

    def test_refuses_a_catalog_with_no_entries(self):
        # "Nothing is known to be exploited" is not a state CISA has published,
        # and it is what a truncated or reset feed would look like.
        empty = catalog(entries=0)
        empty["count"] = 0
        with self.assertRaises(kev.Refuse):
            kev.validate(blob(empty))

    def test_refuses_a_count_that_disagrees(self):
        # The check that catches a body truncated somewhere it still parses.
        with self.assertRaises(kev.Refuse) as caught:
            kev.validate(blob(catalog(entries=3, count=1662)))
        self.assertIn("count", str(caught.exception))

    def test_refuses_a_missing_required_field(self):
        for field in kev.STRING_FIELDS:
            value = catalog()
            del value["vulnerabilities"][1][field]
            with self.assertRaises(kev.Refuse, msg=field) as caught:
                kev.validate(blob(value))
            self.assertIn(field, str(caught.exception))

    def test_refuses_a_field_of_the_wrong_type(self):
        value = catalog()
        value["vulnerabilities"][0]["requiredAction"] = ["apply", "updates"]
        with self.assertRaises(kev.Refuse):
            kev.validate(blob(value))

    def test_refuses_a_malformed_cve_id(self):
        for bad in ("CVE-21-44228", "cve-2021-44228 ", "../../etc/passwd", "CVE-2021-4"):
            value = catalog()
            value["vulnerabilities"][0]["cveID"] = bad
            with self.assertRaises(kev.Refuse, msg=bad):
                kev.validate(blob(value))

    def test_refuses_a_duplicated_cve_id(self):
        # One entry per CVE is what makes the client's join 1:1, and with it
        # every KEV count DISTINCT-safe. A duplicate would double a record in
        # exactly the aggregates this overlay exists to produce.
        value = catalog()
        value["vulnerabilities"][1]["cveID"] = value["vulnerabilities"][0]["cveID"]
        with self.assertRaises(kev.Refuse) as caught:
            kev.validate(blob(value))
        self.assertIn("twice", str(caught.exception))

    def test_refuses_a_malformed_date(self):
        for field in ("dateAdded", "dueDate"):
            value = catalog()
            value["vulnerabilities"][0][field] = "2026/08/01"
            with self.assertRaises(kev.Refuse, msg=field):
                kev.validate(blob(value))

    def test_refuses_cwes_that_are_not_a_list_of_strings(self):
        value = catalog()
        value["vulnerabilities"][0]["cwes"] = "CWE-79"
        with self.assertRaises(kev.Refuse):
            kev.validate(blob(value))
        value["vulnerabilities"][0]["cwes"] = [79]
        with self.assertRaises(kev.Refuse):
            kev.validate(blob(value))

    def test_refuses_an_oversized_body(self):
        with self.assertRaises(kev.Refuse):
            kev.validate(b"{" + b" " * (kev.MAX_BYTES + 1))

    def test_refuses_an_oversized_field(self):
        value = catalog()
        value["vulnerabilities"][0]["shortDescription"] = "x" * (kev.MAX_FIELD_CHARS + 1)
        with self.assertRaises(kev.Refuse):
            kev.validate(blob(value))

    def test_every_accepted_catalog_can_be_ordered(self):
        # A version this build does not read as a dated one is fine; a
        # `dateReleased` that is not a timestamp is not, because it is the
        # fallback basis *and* the provenance line the UI renders. So an
        # accepted catalog always has at least one ordering basis, and the
        # roll-backwards guard never meets a pair it cannot compare.
        value = catalog(version="rolling", released="whenever")
        with self.assertRaises(kev.Refuse) as caught:
            kev.validate(blob(value))
        self.assertIn("not a timestamp", str(caught.exception))
        self.assertIsNotNone(kev._order_key(kev.validate(blob(catalog(version="rolling")))))

    def test_falls_back_to_dateReleased_when_the_version_is_not_numeric(self):
        value = catalog(version="2026-08-08")
        kev.validate(blob(value))
        older = catalog(version="2026-08-07", released="2026-08-07T00:00:00.0000Z")
        self.assertIs(kev.is_newer(older, value), False)
        self.assertIs(kev.is_newer(value, older), True)


class Ordering(unittest.TestCase):
    def test_orders_dotted_versions_numerically(self):
        # `2026.08.10` is newer than `2026.08.09`, which string comparison also
        # gets right — but `2026.8.10` against `2026.08.9` does not, and a
        # same-day second release (`…07.1`) is the shape most likely to appear.
        self.assertIs(kev.is_newer(catalog(version="2026.08.10"), catalog(version="2026.8.9")), True)
        self.assertIs(kev.is_newer(catalog(version="2026.8.9"), catalog(version="2026.08.10")), False)
        self.assertIs(
            kev.is_newer(catalog(version="2026.08.07.1"), catalog(version="2026.08.07")), True
        )

    def test_equal_versions_are_not_backwards(self):
        # CISA corrects entries in place, so the same version with new bytes has
        # to be publishable.
        self.assertIs(kev.is_newer(catalog(), catalog()), True)

    def test_mixed_bases_fall_back_to_dateReleased_rather_than_wedging(self):
        # A version tuple against a unix second is not an ordering; it is a
        # coincidence that happens to be a number. So the two are compared on
        # the basis they *do* share — both went through `validate`, so both have
        # a `dateReleased` that parses. Refusing instead would make a change of
        # version scheme a permanent freeze, which is precisely the failure
        # `_ransomware_counts` is deliberately built to avoid.
        versioned = catalog(version="2026.08.08", released="2026-08-08T00:00:00.0000Z")
        laterDated = catalog(version="2026-08-09", released="2026-08-09T00:00:00.0000Z")
        self.assertIs(kev.is_newer(laterDated, versioned), True)
        self.assertIs(kev.is_newer(versioned, laterDated), False)

    def test_an_unorderable_published_side_is_not_an_ordering(self):
        # The only way `None` survives now: something already at the URL that
        # `validate` never saw. The guard treats it as "no floor" rather than
        # refusing, or the bad file would serve forever.
        self.assertIsNone(kev.is_newer(catalog(), {"catalogVersion": "x"}))


class Publishing(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.pub = os.path.join(self.tmp.name, "pub")
        self.cache = os.path.join(self.tmp.name, "cache")
        os.makedirs(self.pub)
        self.addCleanup(self.tmp.cleanup)

    def served(self) -> bytes | None:
        try:
            with open(os.path.join(self.pub, "kev.json"), "rb") as handle:
                return handle.read()
        except FileNotFoundError:
            return None

    def run_with(self, value: dict, **kwargs) -> dict:
        payload = blob(value)
        return kev.run(self.pub, self.cache, sources=(), fetcher=lambda: (payload, "test"), **kwargs)

    def test_publishes_verbatim_bytes(self):
        payload = blob(catalog())
        report = kev.run(self.pub, self.cache, sources=(), fetcher=lambda: (payload, "test"))
        self.assertEqual(report["published"], "published")
        # Verbatim: CC0 asks for nothing to travel with the data, and
        # re-serialising would make our copy differ from CISA's for no reason
        # anyone could audit (D-076 §1).
        self.assertEqual(self.served(), payload)

    def test_a_second_run_with_the_same_bytes_is_unchanged(self):
        self.run_with(catalog())
        report = self.run_with(catalog())
        self.assertEqual(report["published"], "unchanged")

    def test_refuses_an_older_catalog_and_keeps_the_published_one(self):
        self.run_with(catalog(version="2026.08.08"))
        before = self.served()
        with self.assertRaises(kev.Refuse) as caught:
            self.run_with(catalog(version="2026.08.01"))
        self.assertIn("backwards", str(caught.exception))
        # The property the guard exists for: what is served did not move.
        self.assertEqual(self.served(), before)

    def test_force_permits_a_deliberate_rollback(self):
        self.run_with(catalog(version="2026.08.08"))
        report = self.run_with(catalog(version="2026.08.01"), force=True)
        self.assertEqual(report["published"], "published")
        self.assertEqual(json.loads(self.served())["catalogVersion"], "2026.08.01")

    def test_a_scheme_change_is_ordered_by_dateReleased(self):
        self.run_with(catalog(version="2026.08.08", released="2026-08-08T00:00:00.0000Z"))
        # Older by release date, under a different version scheme: still refused.
        with self.assertRaises(kev.Refuse):
            self.run_with(catalog(version="2026-08-01", released="2026-08-01T00:00:00.0000Z"))
        # Newer by release date: published.
        report = self.run_with(catalog(version="2026-08-09", released="2026-08-09T00:00:00.0000Z"))
        self.assertEqual(report["published"], "published")

    def test_a_malformed_catalog_leaves_the_published_one_serving(self):
        self.run_with(catalog(version="2026.08.08"))
        before = self.served()
        broken = catalog(version="2026.08.09")
        del broken["vulnerabilities"][0]["requiredAction"]
        with self.assertRaises(kev.Refuse):
            self.run_with(broken)
        self.assertEqual(self.served(), before)

    def test_a_failed_fetch_publishes_nothing_and_is_recorded(self):
        self.run_with(catalog(version="2026.08.08"))
        before = self.served()

        def explode():
            raise kev.Refuse("both sources refused")

        with self.assertRaises(kev.Refuse):
            kev.run(self.pub, self.cache, sources=(), fetcher=explode)
        self.assertEqual(self.served(), before)
        # Discoverable: `plex` has no MTA and D-009 rules out telemetry, so this
        # is the alert (D-058 made the same call for the daily ingest).
        report = kev.status(self.pub, self.cache)
        self.assertIn("both sources refused", report["last_error"])
        self.assertEqual(report["catalogVersion"], "2026.08.08")
        # The failure did not erase the evidence of the last success.
        self.assertIsNotNone(report["last_ok"])

    def test_a_dry_run_publishes_nothing_and_touches_no_state(self):
        report = self.run_with(catalog(), dry_run=True)
        self.assertEqual(report["published"], "would-publish")
        self.assertIsNone(self.served())
        self.assertEqual(kev.load_state(self.cache), {})

    def test_the_publish_never_opens_the_published_name_for_writing(self):
        # This is the atomicity claim, asserted rather than gestured at: a
        # reader sees the old catalog or the new one because the published name
        # is only ever *renamed onto*, never written through. An earlier version
        # of this test checked for leftover files, which a `copyfile` + `unlink`
        # implementation passes while being visibly non-atomic.
        opened: list[tuple[str, str]] = []
        real_open = builtins.open

        def watched(file, mode="r", *args, **kwargs):
            opened.append((str(file), str(mode)))
            return real_open(file, mode, *args, **kwargs)

        with mock.patch("builtins.open", watched):
            self.run_with(catalog(version="2026.08.08"))
        target = os.path.join(self.pub, "kev.json")
        writes = [path for path, mode in opened if "w" in mode or "a" in mode or "+" in mode]
        self.assertNotIn(target, writes)
        self.assertTrue(any(path.startswith(target + ".") for path in writes), writes)
        self.assertEqual(self.served(), blob(catalog(version="2026.08.08")))

    def test_a_failed_publish_leaves_no_scratch_file_in_the_served_directory(self):
        # The publish directory is web-reachable and `^~ /data/` would serve a
        # leftover `.tmp` as `immutable` for a year.
        target = os.path.join(self.pub, "kev.json")
        real_replace = os.replace

        def only_the_catalog(src, dst, *args, **kwargs):
            # Narrow, so the state write that *records* this failure still works
            # — which is the second half of what this test is checking.
            if str(dst) == target:
                raise OSError("no space left on device")
            return real_replace(src, dst, *args, **kwargs)

        with mock.patch("kev.os.replace", only_the_catalog):
            with self.assertRaises(OSError):
                self.run_with(catalog())
        self.assertEqual(os.listdir(self.pub), [])
        # And the failure is still findable, even though it is not a `Refuse`.
        self.assertIn("no space left", kev.status(self.pub, self.cache)["last_error"])

    def test_status_before_anything_is_published(self):
        report = kev.status(self.pub, self.cache)
        self.assertIsNone(report["catalogVersion"])
        self.assertIsNone(report["last_run"])
        self.assertIsNone(report["last_error"])

    def test_status_reports_what_is_served(self):
        self.run_with(catalog(version="2026.08.08"))
        report = kev.status(self.pub, self.cache)
        self.assertEqual(report["catalogVersion"], "2026.08.08")
        self.assertEqual(report["entries"], 3)
        self.assertIsNone(report["last_error"])
        self.assertEqual(report["bytes"], len(self.served()))

    def test_a_corrupt_published_file_does_not_block_a_fresh_catalog(self):
        # Refusing to publish over corruption would leave the corruption
        # serving, which is the opposite of what the guard is for.
        with open(os.path.join(self.pub, "kev.json"), "wb") as handle:
            handle.write(b"not json")
        report = self.run_with(catalog(version="2026.08.08"))
        self.assertEqual(report["published"], "published")

    def test_from_file_runs_the_same_validation(self):
        path = os.path.join(self.tmp.name, "local.json")
        with open(path, "wb") as handle:
            handle.write(blob(catalog(entries=2, count=9)))
        with self.assertRaises(kev.Refuse):
            kev.run(self.pub, self.cache, sources=(), from_file=path)
        self.assertIsNone(self.served())

    def test_the_ransomware_distribution_is_reported_not_enforced(self):
        # A third value must not wedge the cron — but it must not vanish
        # either, so the run reports the distribution and an operator sees it.
        value = catalog()
        value["vulnerabilities"][2]["knownRansomwareCampaignUse"] = "Suspected"
        report = self.run_with(value)
        self.assertEqual(report["ransomware"], {"Known": 1, "Suspected": 1, "Unknown": 1})


class FailureDomain(unittest.TestCase):
    """D-076: the two crons must not be able to block each other.

    These used to compare two module constants and pass `name=` to both sides of
    a lock, which is satisfied whether or not `name` is honored — and it was
    not: `state.lock` ignored the argument and every job took `pipeline.lock`.
    So each test below observes the **file on disk**, and the last one puts the
    two jobs in one directory, which is the only arrangement where an ignored
    `name` is the difference between independent and mutually exclusive.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_the_kev_run_takes_a_lock_named_after_itself(self):
        import state as state_module

        pub = os.path.join(self.tmp.name, "pub")
        cache = os.path.join(self.tmp.name, "cache")
        os.makedirs(pub)
        payload = blob(catalog())
        kev.run(pub, cache, sources=(), fetcher=lambda: (payload, "test"))
        self.assertIn(kev.LOCK_NAME, os.listdir(cache))
        self.assertNotIn(state_module.LOCK_NAME, os.listdir(cache))

    def test_the_two_jobs_do_not_exclude_each_other_even_in_one_directory(self):
        # The property, stated as strongly as it can be: hold the *corpus*
        # pipeline's lock and a KEV run still completes. Sharing the flock
        # helper is not sharing the lock.
        import state as state_module

        pub = os.path.join(self.tmp.name, "pub")
        shared = os.path.join(self.tmp.name, "shared")
        os.makedirs(pub)
        payload = blob(catalog())
        with state_module.lock(shared):
            report = kev.run(pub, shared, sources=(), fetcher=lambda: (payload, "test"))
        self.assertEqual(report["published"], "published")

    def test_a_second_kev_run_skips_rather_than_racing(self):
        import state as state_module

        pub = os.path.join(self.tmp.name, "pub")
        cache = os.path.join(self.tmp.name, "cache")
        os.makedirs(pub)
        payload = blob(catalog())
        with state_module.lock(cache, name=kev.LOCK_NAME):
            with self.assertRaises(state_module.Busy):
                kev.run(pub, cache, sources=(), fetcher=lambda: (payload, "test"))


class HostileUpstream(unittest.TestCase):
    """What a compromised, hijacked or merely broken feed can do.

    The findings these came from compound into one story: without them a single
    bad response freezes the catalog **permanently**, while `kev.py status`, the
    exit code and the cron log all report success.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.pub = os.path.join(self.tmp.name, "pub")
        self.cache = os.path.join(self.tmp.name, "cache")
        os.makedirs(self.pub)
        self.addCleanup(self.tmp.cleanup)

    def publish(self, value: dict, **kwargs) -> dict:
        payload = blob(value)
        return kev.run(self.pub, self.cache, sources=(), fetcher=lambda: (payload, "test"), **kwargs)

    def test_a_far_future_catalog_cannot_be_published(self):
        # Otherwise it is published once and then *defended* by the
        # roll-backwards guard against every genuine catalog, forever — while
        # rendering as fresh, because the same party chose `dateReleased`.
        with self.assertRaises(kev.Refuse) as caught:
            self.publish(catalog(version="2099.12.31", released="2099-12-31T00:00:00.0000Z"))
        self.assertIn("future", str(caught.exception))
        self.assertIsNone(kev.status(self.pub, self.cache)["catalogVersion"])

    def test_an_implausible_version_falls_back_to_dateReleased_instead_of_wedging(self):
        # `20260.08.09` is one fat-finger away from real, and as a version tuple
        # it outranks every genuine catalog until 20260 AD. It must not become
        # an ordering basis — and it must not be *refused* either, because
        # refusing on a version-scheme change is the other wedge.
        self.publish(catalog(version="20260.08.09", released="2026-08-08T00:00:00.0000Z"))
        report = self.publish(catalog(version="2026.08.09", released="2026-08-09T00:00:00.0000Z"))
        self.assertEqual(report["published"], "published")
        self.assertEqual(kev.status(self.pub, self.cache)["catalogVersion"], "2026.08.09")

    def test_a_version_scheme_change_is_not_a_wedge(self):
        # Numeric today, something else tomorrow. Both sides went through
        # `validate`, so both have a `dateReleased` that parses, and that is
        # what orders them.
        self.publish(catalog(version="2026.08.08", released="2026-08-08T00:00:00.0000Z"))
        report = self.publish(catalog(version="v2026-08-09", released="2026-08-09T00:00:00.0000Z"))
        self.assertEqual(report["published"], "published")

    def test_a_published_file_with_nothing_orderable_is_replaced_not_defended(self):
        # `{}` parses, so it is not the "corrupt" case — and refusing over it
        # would leave it serving forever, which is the opposite of the guard's
        # purpose.
        with open(os.path.join(self.pub, "kev.json"), "w", encoding="utf-8") as handle:
            handle.write("{}")
        report = self.publish(catalog(version="2026.08.08"))
        self.assertEqual(report["published"], "published-over-unorderable")
        self.assertEqual(kev.status(self.pub, self.cache)["catalogVersion"], "2026.08.08")

    def test_an_unbounded_catalog_version_is_refused_not_a_traceback(self):
        # CPython refuses to `int()` a digit run over 4,300 characters, which
        # would escape the validator as a `ValueError` — reaching the cron log
        # as a traceback while `status` reported healthy.
        with self.assertRaises(kev.Refuse):
            self.publish(catalog(version="1" * 5000))

    def test_json_constants_a_browser_cannot_parse_are_refused(self):
        # Published verbatim, so `Infinity` anywhere in the document — even in a
        # key nothing here reads — takes the overlay down for every user while
        # the cron reports success. Python parses them; `JSON.parse` does not.
        payload = b'{"title":"t","catalogVersion":"2026.08.08",'
        payload += b'"dateReleased":"2026-08-08T00:00:00.0000Z","count":0,'
        payload += b'"vulnerabilities":[],"score":Infinity}'
        with self.assertRaises(kev.Refuse) as caught:
            kev.validate(payload)
        self.assertIn("Infinity", str(caught.exception))

    def test_text_with_no_utf8_encoding_is_refused(self):
        # RE-015, for the second untrusted source. A lone surrogate is legal
        # JSON and has no UTF-8 encoding, so it cannot be written to SQLite on
        # either side — and finding that out in the browser means finding it out
        # once per entry.
        value = catalog()
        value["vulnerabilities"][0]["shortDescription"] = "lone surrogate: \ud800"
        with self.assertRaises(kev.Refuse) as caught:
            kev.validate(blob(value))
        self.assertIn("RE-015", str(caught.exception))

    def test_a_dateReleased_that_is_not_a_timestamp_is_refused(self):
        # It is what the UI renders as "per CISA, as of …", and it is the
        # ordering basis whenever the version is not a dated one.
        for bad in ("banana", "<img src=x onerror=alert(1)>", "   "):
            value = catalog(released=bad)
            with self.assertRaises(kev.Refuse, msg=bad):
                kev.validate(blob(value))

    def test_the_header_strings_are_bounded(self):
        for key, bad in (
            ("title", "x" * (kev.MAX_HEADER_CHARS + 1)),
            ("catalogVersion", "9" * (kev.MAX_HEADER_CHARS + 1)),
        ):
            value = catalog()
            value[key] = bad
            with self.assertRaises(kev.Refuse, msg=key):
                kev.validate(blob(value))

    def test_a_cwes_item_is_bounded_like_every_other_string(self):
        value = catalog()
        value["vulnerabilities"][0]["cwes"] = ["x" * (kev.MAX_FIELD_CHARS + 1)]
        with self.assertRaises(kev.Refuse):
            kev.validate(blob(value))

    def test_calendar_invalid_dates_are_refused(self):
        # `2026-13-45` matches the pattern and is not a day; the client turns
        # both of these into timestamps.
        for bad in ("2026-13-01", "2026-02-30", "0000-00-00"):
            value = catalog()
            value["vulnerabilities"][0]["dateAdded"] = bad
            with self.assertRaises(kev.Refuse, msg=bad):
                kev.validate(blob(value))

    def test_deeply_nested_json_is_refused_rather_than_crashing(self):
        payload = b"[" * 200_000 + b"]" * 200_000
        with self.assertRaises(kev.Refuse):
            kev.validate(payload)

    def test_a_transport_failure_falls_through_to_the_mirror(self):
        # D-076 §3's whole purpose. `http.client.HTTPException` is not an
        # `OSError`, so without it on the list a truncated response from
        # cisa.gov never reached the mirror.
        import http.client

        payload = blob(catalog())
        calls: list[str] = []

        def flaky(url, timeout=kev.FETCH_TIMEOUT, deadline=kev.MAX_FETCH_SECONDS):
            calls.append(url)
            if url == "first":
                raise http.client.IncompleteRead(b"half a catalog")
            return payload

        with mock.patch("kev.download", flaky):
            body, source = kev.fetch(("first", "second"))
        self.assertEqual(source, "second")
        self.assertEqual(body, payload)
        self.assertEqual(calls, ["first", "second"])

    def test_an_oversized_first_source_still_tries_the_mirror(self):
        payload = blob(catalog())

        def flaky(url, timeout=kev.FETCH_TIMEOUT, deadline=kev.MAX_FETCH_SECONDS):
            if url == "first":
                raise kev.Refuse("response exceeds the byte limit")
            return payload

        with mock.patch("kev.download", flaky):
            _, source = kev.fetch(("first", "second"))
        self.assertEqual(source, "second")


if __name__ == "__main__":
    unittest.main()
