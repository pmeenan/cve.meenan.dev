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
import math
import re
from datetime import datetime
from typing import Any

STATE = {"PUBLISHED": 1, "REJECTED": 2}
SEVERITY = {"NONE": 0, "LOW": 1, "MEDIUM": 2, "HIGH": 3, "CRITICAL": 4}
VERSION_STATUS = {"affected": 1, "unaffected": 2, "unknown": 3}

# `affected[].defaultStatus`, most conservative first (D-070). The projection
# dedups `(vendor, product)` pairs, so two `affected` entries can collide on one
# `cve_prod` row carrying different defaults -- 13,628 of them in the corpus,
# measured 2026-08-08. Taking the first would be a coin flip on a correctness
# field, so the tie-break is this order, and it is explicit rather than implied.
DEFAULT_STATUS_PRECEDENCE = ("affected", "unknown", "unaffected")

# SSVC's three decision points, contributed by CISA's Vulnrichment ADP (D-070).
# Keyed by the lowercased option name as it appears in `content.options`, whose
# entries are single-key objects: `{"Exploitation": "poc"}`.
#
# The corpus carries exactly these three names and exactly these six values
# (scanned in full, 2026-08-08: 374,269 records, 172,041 ssvc blocks, no other
# key or value anywhere). An unrecognised one is dropped rather than stored as a
# code we would have to invent -- absence is a state this schema can express.
SSVC_OPTIONS = {
    "exploitation": ("ssvc_expl", {"none": 0, "poc": 1, "active": 2}),
    "automatable": ("ssvc_auto", {"no": 0, "yes": 1}),
    "technical impact": ("ssvc_impact", {"partial": 0, "total": 1}),
}

SSVC_COLUMNS = ("ssvc_expl", "ssvc_auto", "ssvc_impact")

# Preference order, best first: v4.0 over v3.1 over v3.0 over v2.0. The second
# element is the *stored* version code, which is not ordered (31 > 4) — never
# compare codes to pick a winner; compare positions in this tuple. adp
# containers are mined for these and then discarded (D-024).
CVSS_KEYS = (("cvssV4_0", 4), ("cvssV3_1", 31), ("cvssV3_0", 30), ("cvssV2_0", 2))

_HOST = re.compile(r"[a-zA-Z][a-zA-Z0-9+.\-]*://([^/?#]*)")

# The canonical CVE ID shape, copied from the official CVE Record Format's own
# `cveId` pattern -- `^CVE-[0-9]{4}-[0-9]{4,19}$`, read from
# CVEProject/cve-schema on 2026-08-02. Do not tighten it: a home-made 12-digit
# cap would mark valid 13-19 digit records unusable and abort a whole ingest
# (D-047 fails the build closed).
#
# It is a *bound* rather than pedantry: `cveId` is publisher-supplied text
# (rule 5), and an unbounded one flows into the published database, every delta
# that touches the record, and the client's wire validator -- which caps it, so
# one 300-character id would make every client reject every delta carrying it,
# forever. Measured, not predicted: a record with a 300-digit id built and
# shipped cleanly before this existed. At the schema's maximum an id is 28
# characters, comfortably inside the wire format's 64.
_CVE_ID = re.compile(r"^CVE-[0-9]{4}-[0-9]{4,19}$")


def valid_cve_id(value: Any) -> bool:
    return isinstance(value, str) and _CVE_ID.match(value) is not None


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


def _score(value: Any) -> float | None:
    """A CVSS base score we can store and serialize, or None.

    Two ways this goes wrong, both reachable from a hostile record (rule 5):
    `1e400` parses to `inf`, which `json.dumps` writes as a bare `Infinity`
    token no browser's JSON parser accepts; and `10**1000` is a perfectly legal
    JSON integer that cannot become a float at all, so even asking
    `math.isfinite` about it raises. Convert first, defensively, then check.
    """
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    try:
        numeric = float(value)
    except (OverflowError, ValueError):
        return None
    return numeric if math.isfinite(numeric) else None


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
                    best = (
                        preference,
                        (
                            version,
                            _score(block.get("baseScore")),
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


def affected(cna: dict) -> list[tuple[str, str, str, list[dict]]]:
    """(vendor, product, defaultStatus, versions). Either name may be empty, not both.

    `defaultStatus` is the raw upstream string, lowercased, or `""`. It is
    resolved to a stored code by `default_statuses`, which is where the collision
    across deduped `(vendor, product)` pairs has to be settled.
    """
    out = []
    for entry in _dicts(cna.get("affected")):
        vendor, product = _text(entry.get("vendor")), _text(entry.get("product"))
        if vendor or product:
            out.append(
                (
                    vendor,
                    product,
                    _text(entry.get("defaultStatus")).lower(),
                    _dicts(entry.get("versions")),
                )
            )
    return out


def default_statuses(entries: list[tuple[str, str, str, list[dict]]]) -> dict[tuple[str, str], int]:
    """The stored `cve_prod.default_status` per deduped `(vendor, product)` pair.

    Resolved toward the conservative value -- affected beats unknown beats
    unaffected -- because two `affected` entries for one pair may disagree, and
    "this product might be vulnerable" is the answer that costs a reader a second
    look rather than a missed vulnerability (D-070). A pair no entry states a
    default for is absent from the map entirely: absent is not a value, and NULL
    is how the schema says so.
    """
    best: dict[tuple[str, str], int] = {}
    # Walked most-conservative first, so the first writer of a key is the winner
    # and the weaker ranks below must not overwrite it.
    for name in DEFAULT_STATUS_PRECEDENCE:
        code = VERSION_STATUS[name]
        for vendor, product, status, _ in entries:
            if status == name:
                best.setdefault((vendor, product), code)
    return best


def ssvc(cna: dict, adp: list[dict]) -> dict[str, int]:
    """SSVC decision points as stored codes, keyed by column name (D-070).

    A decision point no block states is absent from the map, which is what makes
    "not assessed" distinguishable from `none`.

    164 records in the corpus carry more than one `ssvc` block -- a CNA's beside
    CISA's -- so the merge rule has to be stated rather than discovered: the
    first block to supply a decision point wins, scanning **adp first**.

    That is the opposite of `cvss`'s precedence, deliberately. A CVSS score is
    the CNA's own assessment of its own product and the ADP's is a second
    opinion, so cna-first is right there. SSVC is not: it exists in this corpus
    only as CISA's Vulnrichment enrichment, `containers.cna` is written by the
    assigning CNA -- usually the affected vendor -- and a vendor block saying
    `Exploitation: none` beside CISA's `active` would let the party with the
    incentive to downplay exploitation overwrite the corpus's only structured
    exploitation signal, with nothing on screen saying the two disagreed.
    """
    out: dict[str, int] = {}
    for source in (*adp, cna):
        for metric in _dicts(source.get("metrics")):
            other = metric.get("other")
            if not isinstance(other, dict) or _text(other.get("type")).lower() != "ssvc":
                continue
            content = other.get("content")
            if not isinstance(content, dict):
                continue
            for option in _dicts(content.get("options")):
                for name, value in option.items():
                    entry = SSVC_OPTIONS.get(_text(name).lower())
                    if entry is None:
                        continue
                    column, codes = entry
                    code = codes.get(_text(value).lower())
                    if code is not None:
                        out.setdefault(column, code)
    return out


def title(cna: dict) -> str:
    """`containers.cna.title` -- the sink and the vulnerability class the prose
    buries. 83.3% of titled records have a title that is not a substring of
    their own description (D-070)."""
    return _text(cna.get("title"))


def rejection(cna: dict) -> str:
    """The first English `rejectedReasons[]` value, English by D-023's rule.

    Every REJECTED record has its text only here -- none of the 17,822 carries
    an English description -- so without this the detail view renders them blank
    (D-070).
    """
    for entry in _dicts(cna.get("rejectedReasons")):
        if _is_english(entry):
            value = _text(entry.get("value"))
            if value:
                return value
    return ""


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

    # The record's own id when it is well-formed, otherwise the file name it
    # was read from — which `build.record_paths` already constrained to
    # `CVE-*.json`. A record that satisfies neither is refused by `build.py`
    # rather than stored under a name we cannot trust.
    claimed = _text(meta.get("cveId"))
    cve_id = claimed if valid_cve_id(claimed) else fallback_id
    try:
        year = int(cve_id.split("-")[1])
    except (IndexError, ValueError):
        year = 0

    entries = affected(cna)
    defaults = default_statuses(entries)
    # Sorted on the `(vendor, product)` key alone: the third element is an
    # `int | None`, which Python refuses to order against itself. Sorting the
    # keys is also the stable thing to hash — the status is a function of the
    # pair, so it cannot reorder anything.
    products = [(v, p, defaults.get((v, p))) for v, p in sorted({(v, p) for v, p, _, _ in entries})]
    versions = [(v, p, version_row(ver)) for v, p, _, vers in entries for ver in vers]

    return {
        "cve_id": cve_id,
        "year": year,
        "state": STATE.get(_text(meta.get("state")).upper(), 0),
        "cna": _text(meta.get("assignerShortName")),
        "published": _epoch(meta.get("datePublished")),
        "updated": _epoch(meta.get("dateUpdated")),
        "reserved": _epoch(meta.get("dateReserved")),
        "cvss": cvss(cna, adp),
        "ssvc": ssvc(cna, adp),
        "cwes": sorted(cwes(cna, adp)),
        "products": products,
        "versions": sorted(versions),
        "refs": sorted(references(cna, adp)),
        "descr": description(cna),
        "title": title(cna),
        "reason": rejection(cna),
    }


def storable(proj: dict) -> bool:
    """Whether every string in a projection can reach SQLite (RE-015).

    `json.loads` accepts an unpaired surrogate escape and produces a `str` with
    no UTF-8 encoding at all, so the failure surfaces at *insert* time as a
    `UnicodeEncodeError` naming a codec rather than a record — one hostile
    record halting a build over 372k of them with nothing to point at.

    The daily ingest catches it in the hash pass it already runs (D-058), but a
    direct `build.py` computes no hash, and that is the path the schema-bump
    runbook uses. Schema 2 widens the surface: `title` and `reason` are two more
    attacker-influenced text columns per record.

    Cheap enough to run unconditionally — encoding is C-speed and the strings
    are being read anyway — and cheaper than the alternative of hashing every
    projection just to find out.
    """
    try:
        _encode_strings(proj)
    except UnicodeEncodeError:
        return False
    return True


def _encode_strings(value: Any) -> None:
    """Encode every string reachable in a projection, or raise."""
    if isinstance(value, str):
        value.encode("utf-8")
    elif isinstance(value, dict):
        for key, item in value.items():
            _encode_strings(key)
            _encode_strings(item)
    elif isinstance(value, (list, tuple, set)):
        for item in value:
            _encode_strings(item)


def content_hash(proj: dict) -> str:
    """The change signal (D-031). Hashes the projection, not the file: what the
    client stores is what "changed" has to mean.

    Note the measured caveat -- this filters nothing in practice, because
    `updated` is part of the projection and 63% of upstream updates change
    nothing else. It is still the right thing to hash."""
    canonical = json.dumps(proj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]
