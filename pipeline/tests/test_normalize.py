"""Regression tests for the stored projection (D-043, D-047).

Run from the repo root:

    python3 -m unittest discover -s pipeline/tests

These exist because the pipeline defines both "what we store" and "what
changed" (D-031): a normalization bug corrupts every downstream analysis and
every delta. The CVSS-priority cases are a real regression — version *codes*
(4, 31, 30, 2) are not ordered, and comparing them numerically made v3.1 beat
v4.0 in every record that carried both.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import build  # noqa: E402
import normalize  # noqa: E402


def metric(key: str, score: float, severity: str, vector: str = "V") -> dict:
    return {key: {"baseScore": score, "baseSeverity": severity, "vectorString": vector}}


class CvssPriority(unittest.TestCase):
    def test_v4_beats_v31_in_one_metric_entry(self):
        """The regression: 31 > 4 numerically, but v4.0 must win."""
        cna = {"metrics": [{**metric("cvssV3_1", 7.5, "HIGH"), **metric("cvssV4_0", 9.1, "CRITICAL")}]}
        version, score, severity, _ = normalize.cvss(cna, [])
        self.assertEqual(version, 4)
        self.assertEqual(score, 9.1)
        self.assertEqual(severity, normalize.SEVERITY["CRITICAL"])

    def test_v4_beats_v31_across_metric_entries(self):
        cna = {"metrics": [metric("cvssV3_1", 7.5, "HIGH"), metric("cvssV4_0", 5.0, "MEDIUM")]}
        self.assertEqual(normalize.cvss(cna, [])[0], 4)

    def test_v31_beats_v30_and_v2(self):
        cna = {
            "metrics": [
                metric("cvssV2_0", 10.0, "HIGH"),
                metric("cvssV3_0", 9.8, "CRITICAL"),
                metric("cvssV3_1", 6.1, "MEDIUM"),
            ]
        }
        version, score, _, _ = normalize.cvss(cna, [])
        self.assertEqual(version, 31)
        self.assertEqual(score, 6.1)

    def test_adp_v4_beats_cna_v31(self):
        """Priority is by version preference, not container order."""
        cna = {"metrics": [metric("cvssV3_1", 7.5, "HIGH")]}
        adp = [{"metrics": [metric("cvssV4_0", 8.8, "HIGH", "V4VEC")]}]
        version, _, _, vector = normalize.cvss(cna, adp)
        self.assertEqual(version, 4)
        self.assertEqual(vector, "V4VEC")

    def test_equal_versions_keep_cna_over_adp(self):
        cna = {"metrics": [metric("cvssV3_1", 7.5, "HIGH", "CNA")]}
        adp = [{"metrics": [metric("cvssV3_1", 9.9, "CRITICAL", "ADP")]}]
        self.assertEqual(normalize.cvss(cna, adp)[3], "CNA")

    def test_no_metrics_is_none(self):
        self.assertIsNone(normalize.cvss({}, []))

    def test_hostile_shapes_are_safe(self):
        """Rule 5: wrong types anywhere must degrade, not raise."""
        cna = {
            "metrics": [
                "not a dict",
                {"cvssV4_0": "not a dict"},
                {"cvssV3_1": {"baseScore": "9.8", "baseSeverity": 3, "vectorString": None}},
            ]
        }
        version, score, severity, vector = normalize.cvss(cna, [])
        self.assertEqual(version, 31)
        self.assertIsNone(score)  # string score is not a number
        self.assertIsNone(severity)  # non-string severity
        self.assertEqual(vector, "")


class ScoreRange(unittest.TestCase):
    """Hostile numbers, which JSON permits and the wire format cannot carry."""

    def test_infinity_is_dropped_rather_than_serialized(self):
        """`1e400` parses to `inf`, which `json.dumps` writes as a bare
        `Infinity` token that no browser's JSON parser accepts."""
        cna = {"metrics": [{"cvssV3_1": {"baseScore": 1e400, "baseSeverity": "HIGH"}}]}
        self.assertIsNone(normalize.cvss(cna, [])[1])

    def test_an_integer_too_large_to_be_a_float_does_not_raise(self):
        """`math.isfinite(10**1000)` raises rather than answering: JSON has no
        integer ceiling, so the conversion has to be guarded, not the check."""
        cna = {"metrics": [{"cvssV3_1": {"baseScore": 10**1000, "baseSeverity": "HIGH"}}]}
        self.assertIsNone(normalize.cvss(cna, [])[1])

    def test_a_boolean_is_not_a_score(self):
        cna = {"metrics": [{"cvssV3_1": {"baseScore": True, "baseSeverity": "HIGH"}}]}
        self.assertIsNone(normalize.cvss(cna, [])[1])


class CveIdShape(unittest.TestCase):
    """The id bound follows the official CVE Record Format's own `cveId`
    pattern (`^CVE-[0-9]{4}-[0-9]{4,19}$`, read 2026-08-02). Tightening it
    would mark valid records unusable and abort a whole ingest (D-047)."""

    def test_accepts_the_full_official_serial_range(self):
        self.assertTrue(normalize.valid_cve_id("CVE-2026-1234"))
        self.assertTrue(normalize.valid_cve_id("CVE-1999-" + "9" * 19))

    def test_rejects_what_the_wire_format_could_not_carry(self):
        for bad in ("CVE-2026-123", "CVE-26-1234", "CVE-2026-" + "9" * 20, "../../etc/passwd", ""):
            self.assertFalse(normalize.valid_cve_id(bad), bad)

    def test_a_malformed_id_falls_back_to_the_file_name(self):
        record = {"cveMetadata": {"cveId": "CVE-2026-" + "9" * 300, "state": "PUBLISHED"}}
        self.assertEqual(normalize.projection(record, "CVE-2026-1001")["cve_id"], "CVE-2026-1001")


class Notice(unittest.TestCase):
    """D-008 requires MITRE's copyright designation and the license clause in
    every copy; the canonical string lives in build.NOTICE (D-047)."""

    def test_carries_copyright_designation(self):
        self.assertIn("Copyright © 1999-", build.NOTICE)
        self.assertIn("The MITRE Corporation", build.NOTICE)

    def test_carries_license_clause(self):
        self.assertIn("irrevocable copyright license", build.NOTICE)
        self.assertIn(
            "reproduce MITRE's copyright designation and this license", build.NOTICE
        )

    def test_carries_terms_url_and_disclaimer(self):
        self.assertIn("https://www.cve.org/legal/termsofuse", build.NOTICE)
        self.assertIn("AS IS", build.NOTICE)


def ssvc_block(**options: str) -> dict:
    names = {"expl": "Exploitation", "auto": "Automatable", "impact": "Technical Impact"}
    return {
        "other": {
            "type": "ssvc",
            "content": {"options": [{names[k]: v} for k, v in options.items()]},
        }
    }


class Ssvc(unittest.TestCase):
    """D-070's exploitation signal. Every shape here was observed in a full scan
    of the corpus on 2026-08-08 (374,269 records, 172,041 blocks) except the
    hostile ones, which are rule 5's floor."""

    def test_all_three_decision_points(self):
        adp = [{"metrics": [ssvc_block(expl="poc", auto="yes", impact="total")]}]
        self.assertEqual(
            normalize.ssvc({}, adp), {"ssvc_expl": 1, "ssvc_auto": 1, "ssvc_impact": 1}
        )

    def test_none_is_a_finding_and_stores_as_zero(self):
        """`Exploitation: none` means someone looked. It must not be confused
        with the 51.9% of the corpus that has no assessment at all, which is why
        it is 0 rather than absent."""
        adp = [{"metrics": [ssvc_block(expl="none", auto="no", impact="partial")]}]
        self.assertEqual(
            normalize.ssvc({}, adp), {"ssvc_expl": 0, "ssvc_auto": 0, "ssvc_impact": 0}
        )

    def test_a_decision_point_nobody_stated_is_absent(self):
        adp = [{"metrics": [ssvc_block(expl="active")]}]
        self.assertEqual(normalize.ssvc({}, adp), {"ssvc_expl": 2})

    def test_no_assessment_at_all_is_an_empty_map(self):
        self.assertEqual(normalize.ssvc({"metrics": [metric("cvssV4_0", 9.1, "HIGH")]}, []), {})

    def test_cisas_assessment_outranks_the_cnas_own(self):
        """164 records carry two blocks — a CNA's beside CISA's — and this is
        the **opposite** precedence from `cvss`, deliberately.

        A CVSS score is the CNA's assessment of its own product and the ADP's is
        a second opinion, so cna-first is right there. SSVC exists in this
        corpus only as CISA's Vulnrichment enrichment, and `containers.cna` is
        written by the assigning CNA — usually the affected vendor. Letting a
        vendor's `Exploitation: none` overwrite CISA's `active` would hand the
        party with the incentive to downplay exploitation control of the
        corpus's only structured exploitation signal, and the app would show the
        result with nothing saying the two disagreed.
        """
        cna = {"metrics": [ssvc_block(expl="none")]}
        adp = [{"metrics": [ssvc_block(expl="active", auto="yes")]}]
        self.assertEqual(normalize.ssvc(cna, adp), {"ssvc_expl": 2, "ssvc_auto": 1})

    def test_a_cna_block_still_fills_a_gap_cisa_left(self):
        """Outranked is not ignored: a decision point only the CNA states is
        still better than no answer."""
        cna = {"metrics": [ssvc_block(expl="none", impact="total")]}
        adp = [{"metrics": [ssvc_block(expl="active")]}]
        self.assertEqual(normalize.ssvc(cna, adp), {"ssvc_expl": 2, "ssvc_impact": 1})

    def test_option_names_and_values_are_matched_case_insensitively(self):
        adp = [
            {
                "metrics": [
                    {
                        "other": {
                            "type": "SSVC",
                            "content": {"options": [{"EXPLOITATION": "PoC"}]},
                        }
                    }
                ]
            }
        ]
        self.assertEqual(normalize.ssvc({}, adp), {"ssvc_expl": 1})

    def test_an_unrecognised_option_or_value_is_dropped(self):
        """Storing an invented code would be worse than absence, which the
        schema can express."""
        adp = [{"metrics": [ssvc_block(expl="totally-owned"), {"other": {"type": "ssvc"}}]}]
        adp[0]["metrics"].append(
            {"other": {"type": "ssvc", "content": {"options": [{"Mission Impact": "high"}]}}}
        )
        self.assertEqual(normalize.ssvc({}, adp), {})

    def test_hostile_shapes_do_not_raise(self):
        """One real record carries `options: null` (rule 5)."""
        adp = [
            {
                "metrics": [
                    {"other": None},
                    {"other": {"type": "ssvc", "content": None}},
                    {"other": {"type": "ssvc", "content": {"options": None}}},
                    {"other": {"type": "ssvc", "content": {"options": ["not a dict"]}}},
                    {"other": {"type": "ssvc", "content": {"options": [{"Exploitation": 7}]}}},
                    {"other": {"type": "cvss", "content": {"options": [{"Exploitation": "poc"}]}}},
                ]
            }
        ]
        self.assertEqual(normalize.ssvc({}, adp), {})


class DefaultStatus(unittest.TestCase):
    """D-070's correctness fix: `cve_ver` cannot be read unambiguously without
    the container default that governs every version *not* listed."""

    def test_the_conservative_value_wins_a_collision(self):
        """13,628 records state two different defaults for one deduped
        `(vendor, product)` pair. Affected beats unknown beats unaffected."""
        cna = {
            "affected": [
                {"vendor": "acme", "product": "widget", "defaultStatus": "unaffected"},
                {"vendor": "acme", "product": "widget", "defaultStatus": "unknown"},
                {"vendor": "acme", "product": "widget", "defaultStatus": "affected"},
            ]
        }
        self.assertEqual(normalize.default_statuses(normalize.affected(cna)), {("acme", "widget"): 1})

    def test_unknown_beats_unaffected(self):
        cna = {
            "affected": [
                {"vendor": "acme", "product": "widget", "defaultStatus": "unaffected"},
                {"vendor": "acme", "product": "widget", "defaultStatus": "unknown"},
            ]
        }
        self.assertEqual(normalize.default_statuses(normalize.affected(cna)), {("acme", "widget"): 3})

    def test_a_pair_with_no_default_is_absent_rather_than_zero(self):
        cna = {"affected": [{"vendor": "acme", "product": "widget"}]}
        self.assertEqual(normalize.default_statuses(normalize.affected(cna)), {})
        products = normalize.projection({"containers": {"cna": cna}}, "CVE-2026-1001")["products"]
        self.assertEqual(products, [("acme", "widget", None)])

    def test_it_rides_with_the_product_in_the_projection(self):
        cna = {"affected": [{"vendor": "acme", "product": "widget", "defaultStatus": "Affected"}]}
        products = normalize.projection({"containers": {"cna": cna}}, "CVE-2026-1001")["products"]
        self.assertEqual(products, [("acme", "widget", 1)])


class RejectionAndTitle(unittest.TestCase):
    def test_the_first_english_rejection_reason_wins(self):
        cna = {
            "rejectedReasons": [
                {"lang": "de", "value": "nicht Englisch"},
                {"lang": "en_US", "value": "the reason"},
                {"lang": "en", "value": "a second English reason"},
            ]
        }
        self.assertEqual(normalize.rejection(cna), "the reason")

    def test_a_record_with_no_english_reason_has_none(self):
        self.assertEqual(normalize.rejection({"rejectedReasons": [{"lang": "fr", "value": "x"}]}), "")
        self.assertEqual(normalize.rejection({}), "")

    def test_a_title_is_stripped_text_or_nothing(self):
        self.assertEqual(normalize.title({"title": "  Path traversal  "}), "Path traversal")
        self.assertEqual(normalize.title({"title": None}), "")
        self.assertEqual(normalize.title({}), "")


class Reserved(unittest.TestCase):
    def test_date_reserved_is_stored_as_unix_seconds(self):
        record = {
            "cveMetadata": {
                "cveId": "CVE-2026-1001",
                "state": "PUBLISHED",
                "dateReserved": "2026-01-01T00:00:00Z",
            }
        }
        self.assertEqual(normalize.projection(record, "CVE-2026-1001")["reserved"], 1_767_225_600)

    def test_an_absent_or_unparseable_date_is_none(self):
        self.assertIsNone(normalize.projection({"cveMetadata": {}}, "CVE-2026-1001")["reserved"])
        record = {"cveMetadata": {"dateReserved": "yesterday"}}
        self.assertIsNone(normalize.projection(record, "CVE-2026-1001")["reserved"])


class ContentHash(unittest.TestCase):
    def test_projection_and_hash_are_deterministic(self):
        record = {
            "cveMetadata": {"cveId": "CVE-2026-1", "state": "PUBLISHED"},
            "containers": {"cna": {"metrics": [metric("cvssV4_0", 9.1, "CRITICAL")]}},
        }
        first = normalize.projection(record, "CVE-2026-1")
        second = normalize.projection(record, "CVE-2026-1")
        self.assertEqual(normalize.content_hash(first), normalize.content_hash(second))
        self.assertEqual(first["cvss"][0], 4)


if __name__ == "__main__":
    unittest.main()
