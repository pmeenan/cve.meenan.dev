"""A tiny fixture corpus, and the two builds the delta contract is tested across.

Small on purpose and hostile on purpose (AGENTS.md rule 5): the descriptions
carry markup, quotes, control characters and non-ASCII text, one reference is a
`javascript:` URL with no host at all, and one record has no English
description. All of that is data the wire format has to carry unchanged.

The second corpus is the first plus one record that sorts *after* every
existing one, plus a modification to the last existing record whose new names
also sort last. That is not cosmetic: `build.py` still assigns ids in encounter
order (Interner seeding is M2's next task), and encounter order runs through
`normalize.projection`, which sorts each record's products and CWEs. Naming the
added product "gadget" rather than "zephyr" was enough to renumber `gizmo` from
2 to 3 in the rebuild and to break delta apply outright — measured, not
predicted. Needing to arrange the fixture around that is the argument for
seeding.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import build  # noqa: E402
import delta  # noqa: E402
import publish  # noqa: E402

# Fixed so that a fixture publication is reproducible: 2026-01-01T00:00:00Z.
FIXED_GENERATED = 1_767_225_600

# Markup, a quoted string, a NUL, a bell, an escape, and non-ASCII — all of
# which survive SQLite and JSON, verified rather than assumed (see the wire
# tests). Nothing here is ever concatenated into SQL or rendered as HTML.
HOSTILE_TEXT = (
    'Heap overflow in <script>alert("xss")</script> & <img src=x onerror=1>'
    "\x00\x07\x1b — détails: 中文"
)


def _metric(key: str, score: float, severity: str, vector: str) -> dict:
    return {key: {"baseScore": score, "baseSeverity": severity, "vectorString": vector}}


def corpus_v1() -> dict:
    return {
        "CVE-2026-1001": {
            "cveMetadata": {
                "cveId": "CVE-2026-1001",
                "state": "PUBLISHED",
                "assignerShortName": "acme-cna",
                "datePublished": "2026-01-02T03:04:05.000Z",
                "dateUpdated": "2026-01-03T00:00:00Z",
            },
            "containers": {
                "cna": {
                    "descriptions": [
                        {"lang": "en", "value": HOSTILE_TEXT},
                        {"lang": "fr", "value": "ignored — not English (D-023)"},
                    ],
                    "affected": [
                        {
                            "vendor": "acme",
                            "product": "widget",
                            "versions": [
                                {
                                    "status": "affected",
                                    "version": "1.0",
                                    "lessThan": "2.0",
                                    "versionType": "semver",
                                },
                                {"status": "unaffected", "version": "0.9"},
                            ],
                        }
                    ],
                    "problemTypes": [
                        {"descriptions": [{"cweId": "CWE-79", "description": "XSS"}]}
                    ],
                    "references": [
                        {"url": "https://example.com/advisory?a=1&b=<2>"},
                        {"url": "javascript:alert(1)"},
                    ],
                    "metrics": [_metric("cvssV3_1", 7.5, "HIGH", "CVSS:3.1/AV:N/AC:L")],
                }
            },
        },
        # No English description, REJECTED, no metrics: the sparse record, whose
        # wire form is mostly *absent* keys.
        "CVE-2026-1002": {
            "cveMetadata": {
                "cveId": "CVE-2026-1002",
                "state": "REJECTED",
                "assignerShortName": "acme-cna",
                "datePublished": "2026-02-01T00:00:00Z",
            },
            "containers": {
                "cna": {
                    "descriptions": [{"lang": "de", "value": "keine englische Beschreibung"}],
                    "affected": [{"vendor": "acme", "product": "gizmo"}],
                }
            },
        },
    }


def corpus_v2() -> dict:
    """v1 with CVE-2026-1001 republished, 1002 rewritten and 1003 added."""
    records = corpus_v1()
    # The commonest real change by a wide margin: 63% of upstream updates move
    # `dateUpdated` and nothing else (D-031). It also puts the hostile
    # description on the wire, since the whole record ships either way.
    records["CVE-2026-1001"]["cveMetadata"]["dateUpdated"] = "2026-02-05T00:00:00Z"
    records["CVE-2026-1002"] = {
        "cveMetadata": {
            "cveId": "CVE-2026-1002",
            "state": "PUBLISHED",
            "assignerShortName": "acme-cna",
            "datePublished": "2026-02-01T00:00:00Z",
            "dateUpdated": "2026-02-02T12:00:00Z",
        },
        "containers": {
            "cna": {
                "descriptions": [{"lang": "en", "value": "Now described, and no longer rejected."}],
                "affected": [
                    {"vendor": "acme", "product": "gizmo"},
                    {
                        "vendor": "acme",
                        "product": "zephyr",
                        "versions": [{"status": "affected", "version": "3.1"}],
                    },
                ],
                "problemTypes": [
                    {"descriptions": [{"cweId": "CWE-787", "description": "OOB write"}]}
                ],
                "references": [{"url": "https://example.com/advisory?a=1&b=<2>"}],
                "metrics": [_metric("cvssV2_0", 10.0, "HIGH", "AV:N/AC:L/Au:N/C:C/I:C/A:C")],
            }
        },
    }
    records["CVE-2026-1003"] = {
        "cveMetadata": {
            "cveId": "CVE-2026-1003",
            "state": "PUBLISHED",
            "assignerShortName": "globex-cna",
            "datePublished": "2026-03-01T00:00:00Z",
            "dateUpdated": "2026-03-01T00:00:00Z",
        },
        "containers": {
            "cna": {
                "descriptions": [{"lang": "en", "value": "A new record, with a new vendor."}],
                "affected": [
                    {
                        "vendor": "globex",
                        "product": "sprocket",
                        "versions": [
                            {
                                "status": "affected",
                                "version": "0",
                                "lessThanOrEqual": "4.2",
                                "versionType": "custom",
                            }
                        ],
                    }
                ],
                "problemTypes": [{"descriptions": [{"cweId": "CWE-79", "description": "XSS"}]}],
                "references": [{"url": "https://newhost.example.org/x"}],
                "metrics": [_metric("cvssV4_0", 9.1, "CRITICAL", "CVSS:4.0/AV:N")],
            }
        },
    }
    return records


def corpus_v3() -> dict:
    """v2 with CVE-2026-1003 *losing* sections.

    The removal direction of "absent means absent" (D-055). Without it every
    fixture change is additive, and an applier that only clears the sections a
    delta happens to carry — the exact bug the rule forbids — passes the whole
    suite.

    It has to be the *last* record that loses them, for the same reason the
    additions had to sort last: interning follows encounter order, so if an
    earlier record stops interning a value, the next record to use it takes its
    id and the rebuild renumbers. Stripping CVE-2026-1001 instead was tried
    first and swapped CWE-79 and CWE-787 — a second reproduction of exactly
    what M2's seeding task is for.
    """
    records = corpus_v2()
    records["CVE-2026-1003"] = {
        "cveMetadata": {
            "cveId": "CVE-2026-1003",
            "state": "PUBLISHED",
            "assignerShortName": "globex-cna",
            "datePublished": "2026-03-01T00:00:00Z",
            "dateUpdated": "2026-04-01T00:00:00Z",
        },
        "containers": {
            "cna": {
                # No English description, no CWE, no reference, no CVSS, and a
                # product with no versions: five sections that must disappear.
                "descriptions": [{"lang": "fr", "value": "plus de description anglaise"}],
                "affected": [{"vendor": "globex", "product": "sprocket"}],
            }
        },
    }
    return records


def write_corpus(root: str, records: dict) -> str:
    """Write the records as a cvelistV5-shaped clone; return the clone path."""
    clone = os.path.join(root, "clone")
    directory = os.path.join(clone, "cves", "2026", "1xxx")
    os.makedirs(directory, exist_ok=True)
    for cve_id, record in records.items():
        with open(os.path.join(directory, f"{cve_id}.json"), "w", encoding="utf-8") as handle:
            json.dump(record, handle)
    return clone


def build_artifact(
    root: str, records: dict, name: str, rev: int = 1, generated: int | None = None
) -> str:
    """Build one artifact from a fixture corpus, stamped at `rev`.

    `generated` is settable because the fixtures need a *coherent* timeline —
    a snapshot published before the delta that follows it — and `build.py`
    stamps wall-clock time.
    """
    workspace = os.path.join(root, name)
    os.makedirs(workspace, exist_ok=True)
    clone = write_corpus(workspace, records)
    out = os.path.join(workspace, f"{name}.sqlite")
    stats = build.build(clone, out, None, None)
    if stats["skipped"]:
        raise AssertionError(f"fixture corpus failed to parse: {stats['skipped']}")
    db = sqlite3.connect(out)
    try:
        db.execute("UPDATE meta SET v = ? WHERE k = 'rev'", (rev,))
        if generated is not None:
            db.execute("UPDATE meta SET v = ? WHERE k = 'generated'", (generated,))
        db.commit()
    finally:
        db.close()
    return out


def floors(db_path: str) -> dict:
    """The highest id each lookup table holds — what a client at this revision
    already has, and therefore what the next delta does *not* need to ship."""
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        return {
            table: db.execute(f"SELECT coalesce(max(id), 0) FROM {table}").fetchone()[0]
            for table in delta.LOOKUP_COLUMNS
        }
    finally:
        db.close()


def publish_fixture(root: str) -> dict:
    """The whole publishing path over the fixture corpus.

    Build v1 and publish it as the snapshot at rev 1; build v2; emit the delta
    that carries a client from rev 1 to rev 2 and register it in the manifest.
    The result is a complete, tiny data plane — which is what the cross-language
    contract test consumes.
    """
    # A day apart, so the manifest's freshness genuinely advances when the
    # delta lands rather than being back-dated by it.
    snapshot = build_artifact(root, corpus_v1(), "v1", rev=1, generated=FIXED_GENERATED - 86_400)
    following = build_artifact(root, corpus_v2(), "v2", rev=2, generated=FIXED_GENERATED)

    pub_dir = os.path.join(root, "pub")
    os.makedirs(pub_dir, exist_ok=True)
    publish.publish(snapshot, pub_dir, quality=5, jobs=2)

    changeset = {
        "from": 1,
        "to": 2,
        "upsert": ["CVE-2026-1001", "CVE-2026-1002", "CVE-2026-1003"],
        # A tombstone for a record this corpus never had, so the published
        # fixture exercises a non-empty `delete` across the wire. Upstream has
        # no deletion concept (D-031) — ours exist because *our* ingest can lose
        # a record — so a tombstone naming something absent is the normal shape.
        "delete": ["CVE-2026-9999"],
        "floors": floors(snapshot),
        "generated": FIXED_GENERATED,
    }
    summary = delta.publish(following, pub_dir, changeset, quality=5)
    return {
        "pub": pub_dir,
        "snapshot": snapshot,
        "next": following,
        "changeset": changeset,
        "delta": summary["entry"],
        "summary": summary,
    }


def table_rows(db_path: str, table: str) -> list:
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = [tuple(row) for row in db.execute(f"SELECT * FROM {table}")]
    finally:
        db.close()
    # Sorted by a null-safe key: `cve_ver` mixes NULL and TEXT in the same
    # column, and plain `sorted` raises TypeError the moment two rows first
    # differ there. The fixture happens to differ on an int column first, which
    # is not something to depend on.
    return sorted(rows, key=lambda row: [(value is None, str(value)) for value in row])
