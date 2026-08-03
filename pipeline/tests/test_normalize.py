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
