"""Extraction of the published projection from a cvelistV5 record.

This module is the definition of "what we store", which makes it also the
definition of "what changed": the ingest pipeline hashes exactly this
projection to decide whether a record needs a delta (D-031).

CVE records are attacker-influenced input (AGENTS.md rule 5). Every accessor
here assumes the shape may be wrong -- wrong type, missing key, null where an
object belongs -- and returns something safe rather than raising.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from typing import Any

STATE = {"PUBLISHED": 1, "REJECTED": 2}
SEVERITY = {"NONE": 0, "LOW": 1, "MEDIUM": 2, "HIGH": 3, "CRITICAL": 4}
VERSION_STATUS = {"affected": 1, "unaffected": 2, "unknown": 3}

# Preference order, best first: v4.0 over v3.1 over v3.0 over v2.0. The second
# element is the *stored* version code, which is not ordered (31 > 4) — never
# compare codes to pick a winner; compare positions in this tuple. adp
# containers are mined for these and then discarded (D-024).
CVSS_KEYS = (("cvssV4_0", 4), ("cvssV3_1", 31), ("cvssV3_0", 30), ("cvssV2_0", 2))

_HOST = re.compile(r"[a-zA-Z][a-zA-Z0-9+.\-]*://([^/?#]*)")


def _dicts(value: Any) -> list[dict]:
    """Every list-of-objects accessor in the corpus goes through here."""
    if not isinstance(value, list):
        return []
    return [v for v in value if isinstance(v, dict)]


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _epoch(value: Any) -> int | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def _is_english(entry: dict) -> bool:
    return _text(entry.get("lang")).lower().startswith("en")


def containers(record: dict) -> tuple[dict, list[dict]]:
    node = record.get("containers")
    node = node if isinstance(node, dict) else {}
    cna = node.get("cna")
    return (cna if isinstance(cna, dict) else {}), _dicts(node.get("adp"))


def cvss(cna: dict, adp: list[dict]) -> tuple[int, float | None, int | None, str] | None:
    """Highest-priority CVSS across cna and adp, or None.

    Priority is position in CVSS_KEYS (strictly better replaces; ties keep the
    first seen, so cna beats adp at equal version). The stored version code is
    deliberately not the sort key: 31 (v3.1) > 4 (v4.0) numerically.
    """
    best = None  # (preference, stored tuple)
    for source in (cna, *adp):
        for metric in _dicts(source.get("metrics")):
            for preference, (key, version) in enumerate(CVSS_KEYS):
                block = metric.get(key)
                if not isinstance(block, dict):
                    continue
                if best is None or preference < best[0]:
                    score = block.get("baseScore")
                    best = (
                        preference,
                        (
                            version,
                            float(score) if isinstance(score, (int, float)) else None,
                            SEVERITY.get(_text(block.get("baseSeverity")).upper()),
                            _text(block.get("vectorString")),
                        ),
                    )
    return best[1] if best else None


def cwes(cna: dict, adp: list[dict]) -> set[tuple[str, str]]:
    out: set[tuple[str, str]] = set()
    for source in (cna, *adp):
        for problem in _dicts(source.get("problemTypes")):
            for entry in _dicts(problem.get("descriptions")):
                cwe_id = _text(entry.get("cweId"))
                if cwe_id:
                    out.add((cwe_id, _text(entry.get("description"))))
    return out


def affected(cna: dict) -> list[tuple[str, str, list[dict]]]:
    """(vendor, product, versions) triples. Either name may be empty, not both."""
    out = []
    for entry in _dicts(cna.get("affected")):
        vendor, product = _text(entry.get("vendor")), _text(entry.get("product"))
        if vendor or product:
            out.append((vendor, product, _dicts(entry.get("versions"))))
    return out


def version_row(version: dict) -> tuple[int, str, str, str, str]:
    """(status, version, lessThan, lessThanOrEqual, versionType)."""
    return (
        VERSION_STATUS.get(_text(version.get("status")), 0),
        _text(version.get("version")),
        _text(version.get("lessThan")),
        _text(version.get("lessThanOrEqual")),
        _text(version.get("versionType")),
    )


def references(cna: dict, adp: list[dict]) -> set[str]:
    """Distinct URLs. 43% of raw reference entries are duplicated between the
    cna and adp containers, so dedup here rather than in the database."""
    out: set[str] = set()
    for source in (cna, *adp):
        for entry in _dicts(source.get("references")):
            url = _text(entry.get("url"))
            if url:
                out.add(url)
    return out


def host_of(url: str) -> str:
    match = _HOST.match(url)
    return match.group(1).lower() if match else ""


def description(cna: dict) -> str:
    """English descriptions only (D-023)."""
    parts = [_text(d.get("value")) for d in _dicts(cna.get("descriptions")) if _is_english(d)]
    return "\n".join(p for p in parts if p)


def projection(record: dict, fallback_id: str) -> dict:
    """The complete stored projection of one record, in a form that is stable
    to serialize. This is what gets hashed."""
    meta = record.get("cveMetadata")
    meta = meta if isinstance(meta, dict) else {}
    cna, adp = containers(record)

    cve_id = _text(meta.get("cveId")) or fallback_id
    try:
        year = int(cve_id.split("-")[1])
    except (IndexError, ValueError):
        year = 0

    products = [(v, p) for v, p, _ in affected(cna)]
    versions = [
        (v, p, version_row(ver)) for v, p, vers in affected(cna) for ver in vers
    ]

    return {
        "cve_id": cve_id,
        "year": year,
        "state": STATE.get(_text(meta.get("state")).upper(), 0),
        "cna": _text(meta.get("assignerShortName")),
        "published": _epoch(meta.get("datePublished")),
        "updated": _epoch(meta.get("dateUpdated")),
        "cvss": cvss(cna, adp),
        "cwes": sorted(cwes(cna, adp)),
        "products": sorted(set(products)),
        "versions": sorted(versions),
        "refs": sorted(references(cna, adp)),
        "descr": description(cna),
    }


def content_hash(proj: dict) -> str:
    """The change signal (D-031). Hashes the projection, not the file: what the
    client stores is what "changed" has to mean.

    Note the measured caveat -- this filters nothing in practice, because
    `updated` is part of the projection and 63% of upstream updates change
    nothing else. It is still the right thing to hash."""
    canonical = json.dumps(proj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]
