"""A tiny fixture corpus, and the two builds the delta contract is tested across.

Small on purpose and hostile on purpose (AGENTS.md rule 5): the descriptions
carry markup, quotes, control characters and non-ASCII text, one reference is a
`javascript:` URL with no host at all, and one record has no English
description. All of that is data the wire format has to carry unchanged.

The corpora are built as a chain — v2 seeded from v1, v3 from v2 — because that
is what the pipeline does (D-056), and because the ids the delta carries are
only stable if it is.

They are also deliberately arranged to *provoke* renumbering, which is the
opposite of how they started. Encounter order runs through
`normalize.projection`, which sorts each record's products and CWEs, so a value
inserted alphabetically ahead of an existing one used to take its id: adding the
product "gadget" moved `gizmo` from 2 to 3 and broke delta apply outright, and
the fixture was renamed "zephyr" to dodge it. Seeding is what fixes that, so the
name is back — and `test_interning.py` rebuilds these same corpora unseeded to
show the drift is real rather than hypothetical.
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


def _ssvc(**options: str) -> dict:
    """One Vulnrichment SSVC block (D-070), in the shape the corpus carries it.

    `options` is a list of single-key objects rather than one object, which is
    the detail a hand-written extractor gets wrong.
    """
    names = {"expl": "Exploitation", "auto": "Automatable", "impact": "Technical Impact"}
    return {
        "other": {
            "type": "ssvc",
            "content": {
                "role": "CISA Coordinator",
                "options": [{names[key]: value} for key, value in options.items()],
                "version": "2.0.3",
            },
        }
    }


def corpus_v1() -> dict:
    return {
        "CVE-2026-1001": {
            "cveMetadata": {
                "cveId": "CVE-2026-1001",
                "state": "PUBLISHED",
                "assignerShortName": "acme-cna",
                "dateReserved": "2026-01-01T00:00:00Z",
                "datePublished": "2026-01-02T03:04:05.000Z",
                "dateUpdated": "2026-01-03T00:00:00Z",
            },
            "containers": {
                # SSVC arrives in an *adp* container in the real corpus (CISA's
                # Vulnrichment), so it is mined from one here (D-070).
                "adp": [{"metrics": [_ssvc(expl="poc", auto="no", impact="total")]}],
                "cna": {
                    "title": f"Widget path traversal — {HOSTILE_TEXT[:24]}",
                    "descriptions": [
                        {"lang": "en", "value": HOSTILE_TEXT},
                        {"lang": "fr", "value": "ignored — not English (D-023)"},
                    ],
                    "affected": [
                        {
                            "vendor": "acme",
                            "product": "widget",
                            "defaultStatus": "unaffected",
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
        # wire form is mostly *absent* keys. Since schema 2 it is also the record
        # that has a `cve_text` row with **no description in it** — every
        # REJECTED record's only English text is its rejection reason (D-070), so
        # this is the shape that breaks anything assuming `cve_text` implies
        # `descr`, the full-text index included.
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
                    "rejectedReasons": [
                        {"lang": "de", "value": "nicht Englisch"},
                        {"lang": "en-US", "value": "Withdrawn: duplicate of CVE-2026-1001."},
                    ],
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
                    # Sorts *before* `gizmo`, which is the point: without
                    # seeding it takes gizmo's id (D-055, D-056).
                    {
                        "vendor": "acme",
                        "product": "gadget",
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
                "title": "Sprocket remote code execution",
                "descriptions": [{"lang": "en", "value": "A new record, with a new vendor."}],
                "affected": [
                    {
                        "vendor": "globex",
                        "product": "sprocket",
                        "defaultStatus": "unaffected",
                        "versions": [
                            {
                                "status": "affected",
                                "version": "0",
                                "lessThanOrEqual": "4.2",
                                "versionType": "custom",
                            }
                        ],
                    },
                    # The same `(vendor, product)` pair twice with disagreeing
                    # defaults — 13,628 records in the real corpus do this. The
                    # two collide on one `cve_prod` row, and the conservative
                    # value has to win rather than the first one seen (D-070).
                    {"vendor": "globex", "product": "sprocket", "defaultStatus": "affected"},
                ],
                "problemTypes": [{"descriptions": [{"cweId": "CWE-79", "description": "XSS"}]}],
                "references": [{"url": "https://newhost.example.org/x"}],
                "metrics": [
                    _metric("cvssV4_0", 9.1, "CRITICAL", "CVSS:4.0/AV:N"),
                    # A *partial* assessment: `Automatable` is absent, and has to
                    # stay NULL rather than becoming a code (D-070).
                    _ssvc(expl="active", impact="partial"),
                ],
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
                # No English description, no CWE, no reference, no CVSS, no
                # title, no SSVC, no `defaultStatus`, and a product with no
                # versions: eight sections that must disappear.
                "descriptions": [{"lang": "fr", "value": "plus de description anglaise"}],
                "affected": [{"vendor": "globex", "product": "sprocket"}],
            }
        },
    }
    return records


def corpus_drift() -> dict:
    """v2 with the *first* record dropping the CWE and references it interned.

    The other way encounter order renumbers: when the record that first
    interned a value stops using it, the next record to use it inherits the id.
    Rebuilt unseeded this swaps CWE-79 with CWE-787 and moves two urls and two
    hosts — all of them silently, because the `cve` tripwire only covers record
    ids. Seeded, nothing moves. (D-055 hit this while writing `corpus_v3`;
    `test_interning.py` asserts both directions.)
    """
    records = corpus_v2()
    records["CVE-2026-1001"]["cveMetadata"]["dateUpdated"] = "2026-03-05T00:00:00Z"
    container = records["CVE-2026-1001"]["containers"]["cna"]
    del container["problemTypes"]
    del container["references"]
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


def build_artifact_with_stats(
    root: str,
    records: dict,
    name: str,
    rev: int = 1,
    generated: int | None = None,
    seed: str | None = None,
) -> tuple[str, dict]:
    """Build one artifact from a fixture corpus, stamped at `rev`.

    `generated` is settable because the fixtures need a *coherent* timeline —
    a snapshot published before the delta that follows it — and `build.py`
    stamps wall-clock time. `seed` is the previous artifact: pass it for every
    rebuild of a corpus that has already been published, exactly as the pipeline
    does (D-056). Omitting it bootstraps a fresh ID space, which is what the
    drift tests want and what nothing else should.

    The stats come back because they are half of what a build promises — what it
    minted, retired, and had to infer — and a fixture that threw them away left
    those unassertable.
    """
    workspace = os.path.join(root, name)
    os.makedirs(workspace, exist_ok=True)
    clone = write_corpus(workspace, records)
    out = os.path.join(workspace, f"{name}.sqlite")
    stats = build.build(clone, out, None, None, seed=seed, bootstrap=seed is None, rev=rev)
    if stats["skipped"]:
        raise AssertionError(f"fixture corpus failed to parse: {stats['skipped']}")
    if generated is not None:
        db = sqlite3.connect(out)
        try:
            db.execute("UPDATE meta SET v = ? WHERE k = 'generated'", (generated,))
            db.commit()
        finally:
            db.close()
    return out, stats


def build_artifact(
    root: str,
    records: dict,
    name: str,
    rev: int = 1,
    generated: int | None = None,
    seed: str | None = None,
) -> str:
    return build_artifact_with_stats(root, records, name, rev, generated, seed)[0]


def floors(db_path: str) -> dict:
    """The highest id each lookup table had *issued* at this revision — what a
    client at it already has, and therefore what the next delta does not need to
    ship. Read from the artifact's own record rather than recomputed, because
    retirement puts the two apart (D-056)."""
    return build.id_space(db_path)["floors"]


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
    following = build_artifact(
        root, corpus_v2(), "v2", rev=2, generated=FIXED_GENERATED, seed=snapshot
    )

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


def publish_rotated_fixture(root: str) -> dict:
    """The same path, carried through a **monthly rotation** (D-060).

    Snapshot at rev 1, two days of deltas, the generation rotated onto the
    artifact rev 3 was cut from — which lands *at* head, so the deltas that
    carried clients there are retained and start below the new snapshot's
    revision — then a third day and a second rotation, which is the first one
    that retires anything.

    That shape is the one `assert_tiling` refused before D-060, and the reason
    the contract test consumes it: whether the browser's own `planSync` still
    finds a chain across a rotation, and correctly refuses to find one for a
    client below the retention floor, are not questions the pipeline's own tests
    can answer.
    """
    workspace = os.path.join(root, "rotated")
    os.makedirs(workspace, exist_ok=True)
    day = 86_400
    v1 = build_artifact(workspace, corpus_v1(), "v1", rev=1, generated=FIXED_GENERATED - day)
    v2 = build_artifact(workspace, corpus_v2(), "v2", rev=2, generated=FIXED_GENERATED, seed=v1)
    v3 = build_artifact(
        workspace, corpus_v3(), "v3", rev=3, generated=FIXED_GENERATED + day, seed=v2
    )

    pub_dir = os.path.join(workspace, "pub")
    os.makedirs(pub_dir, exist_ok=True)
    publish.publish(v1, pub_dir, quality=5, jobs=2)
    delta.publish(
        v2,
        pub_dir,
        {
            "from": 1,
            "to": 2,
            "upsert": ["CVE-2026-1001", "CVE-2026-1002", "CVE-2026-1003"],
            "delete": [],
            "floors": floors(v1),
            "generated": FIXED_GENERATED,
        },
        quality=5,
    )
    delta.publish(
        v3,
        pub_dir,
        {
            "from": 2,
            "to": 3,
            "upsert": ["CVE-2026-1003"],
            "delete": [],
            "floors": floors(v2),
            "generated": FIXED_GENERATED + day,
        },
        quality=5,
    )
    # The rotation itself: the artifact the head was cut from, republished as a
    # generation. No revision is minted and no client at head is asked for
    # anything (D-060).
    first = publish.publish(v3, pub_dir, quality=5, jobs=2)

    # And a second month, because one rotation retires nothing: the generation
    # this one replaces is the *first* snapshot, so it is the second rotation
    # that first deletes anything, and a plane the contract test can use to ask
    # what happens to a client below the retention floor.
    v4 = build_artifact(
        workspace, corpus_drift(), "v4", rev=4, generated=FIXED_GENERATED + 2 * day, seed=v3
    )
    delta.publish(
        v4,
        pub_dir,
        {
            "from": 3,
            "to": 4,
            "upsert": ["CVE-2026-1001"],
            "delete": [],
            "floors": floors(v3),
            "generated": FIXED_GENERATED + 2 * day,
        },
        quality=5,
    )
    second = publish.publish(v4, pub_dir, quality=5, jobs=2)
    return {
        "pub": pub_dir,
        "snapshot": v4,
        "rotation": second,
        "first_rotation": first,
        "retired": second["retired"],
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
