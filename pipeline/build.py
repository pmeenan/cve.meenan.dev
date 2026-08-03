"""Build the published SQLite artifact from a cvelistV5 clone.

    python3 pipeline/build.py <clone> <out.sqlite> [--year-min N] [--limit N]

`--year-min` and `--limit` exist for M1's bounded slice; a production run
passes neither. The full corpus takes ~40 s and produces ~391 MB.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time

import normalize

SCHEMA_VERSION = 1

# D-008 / D-047: the canonical notice, carried by every copy of CVE data —
# database, manifest, deltas, UI, exports. The terms require reproducing
# MITRE's copyright designation and the license clause; both are verbatim from
# cve.org's sources (footer and Terms of Use, checked 2026-08-01). Tests
# assert the required components; change this only with D-008 in hand.
NOTICE = (
    f"CVE record content: Copyright © 1999-{time.gmtime().tm_year}, "
    "The MITRE Corporation. CVE is a trademark and the CVE logo is a "
    "registered trademark of The MITRE Corporation. Licensed under the CVE "
    "Program Terms of Use (https://www.cve.org/legal/termsofuse): \"MITRE "
    "hereby grants you a perpetual, worldwide, non-exclusive, no-charge, "
    "royalty-free, irrevocable copyright license to reproduce, prepare "
    "derivative works of, publicly display, publicly perform, sublicense, "
    "and distribute Common Vulnerabilities and Exposures (CVE™). Any "
    "copy you make for such purposes is authorized provided that you "
    "reproduce MITRE's copyright designation and this license in any such "
    "copy.\" Provided \"AS IS\", with all warranties disclaimed."
)


class Interner:
    """Server-owned ID space: append-only, never renumbered (D-025 hazard 1).

    Seeding from the previous build — so IDs stay stable across snapshots —
    lands with the M2 delta generator and is *not implemented yet*: today every
    build starts empty and assigns encounter-order IDs. Until seeding exists,
    two builds are only ID-compatible if built from the same input in the same
    order.

    Note what is *not* interned: `cve.id` is the bare counter below, so it moves
    whenever a record is added or removed anywhere before the end of the walk.
    Deltas carry that id (D-055), so seeding has to cover the `cve` table too,
    not only the seven lookups.
    """

    def __init__(self) -> None:
        self._ids: dict = {}
        self.rows: list = []

    def __call__(self, key, *columns):
        found = self._ids.get(key)
        if found is not None:
            return found
        found = len(self._ids) + 1
        self._ids[key] = found
        self.rows.append((found, *columns))
        return found

    def __len__(self) -> int:
        return len(self._ids)


def record_paths(clone: str):
    """Yield record files, skipping the publishing pipeline's own churn files.

    `cves/delta.json` and `cves/deltaLog.json` are not CVE records, and a naive
    `find cves -name '*.json'` picks them up.
    """
    root = os.path.join(clone, "cves")
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            if name.startswith("CVE-") and name.endswith(".json"):
                yield os.path.join(dirpath, name)


def build(clone: str, out: str, year_min: int | None, limit: int | None) -> dict:
    if os.path.exists(out):
        os.remove(out)

    db = sqlite3.connect(out)
    db.executescript("PRAGMA journal_mode=off; PRAGMA synchronous=off;")
    schema_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema.sql")
    with open(schema_path, encoding="utf-8") as handle:
        db.executescript(handle.read())

    cna, cwe, vendor, product, host, url, vtype = (Interner() for _ in range(7))
    cve_rows, text_rows = [], []
    cwe_link, prod_link, ref_link, ver_rows = [], [], set(), []

    started = time.time()
    row_id = 0
    skipped: list[str] = []

    for path in record_paths(clone):
        with open(path, "rb") as handle:
            blob = handle.read()
        try:
            record = json.loads(blob)
        except (ValueError, UnicodeDecodeError):
            skipped.append(path)
            continue
        if not isinstance(record, dict):
            skipped.append(path)
            continue

        proj = normalize.projection(record, os.path.basename(path)[:-5])
        # A record we cannot name is a record we cannot publish: the id is the
        # client's primary key, the delta's tombstone, and the thing every
        # report shows. Neither the record's `cveId` nor its file name being
        # well-formed is a corpus we understand, so fail closed (D-047) rather
        # than store an id no downstream consumer will accept.
        if not normalize.valid_cve_id(proj["cve_id"]):
            skipped.append(path)
            continue
        if year_min is not None and proj["year"] < year_min:
            continue

        row_id += 1
        score = proj["cvss"]
        cve_rows.append(
            (
                row_id,
                proj["cve_id"],
                proj["year"],
                proj["state"],
                cna(proj["cna"], proj["cna"]),
                proj["published"],
                proj["updated"],
                score[0] if score else None,
                score[1] if score else None,
                score[2] if score else None,
                score[3] if score else None,
            )
        )

        if proj["descr"]:
            text_rows.append((row_id, proj["descr"]))

        for cwe_id, cwe_descr in proj["cwes"]:
            cwe_link.append((row_id, cwe(cwe_id, cwe_id, cwe_descr)))

        for vendor_name, product_name in proj["products"]:
            vendor_id = vendor(vendor_name, vendor_name)
            prod_link.append(
                (row_id, product((vendor_id, product_name), vendor_id, product_name))
            )

        for vendor_name, product_name, version in proj["versions"]:
            vendor_id = vendor(vendor_name, vendor_name)
            product_id = product((vendor_id, product_name), vendor_id, product_name)
            status, ver, lt, lte, vtype_name = version
            ver_rows.append(
                (
                    row_id,
                    product_id,
                    status,
                    ver or None,
                    lt or None,
                    lte or None,
                    vtype(vtype_name, vtype_name) if vtype_name else None,
                )
            )

        for reference in proj["refs"]:
            host_name = normalize.host_of(reference)
            ref_link.add(
                (row_id, url(reference, reference, host(host_name, host_name)))
            )

        if limit is not None and row_id >= limit:
            break

    parsed = time.time() - started

    db.executemany("INSERT INTO cna VALUES(?,?)", cna.rows)
    db.executemany("INSERT INTO cwe VALUES(?,?,?)", cwe.rows)
    db.executemany("INSERT INTO vendor VALUES(?,?)", vendor.rows)
    db.executemany("INSERT INTO product VALUES(?,?,?)", product.rows)
    db.executemany("INSERT INTO host VALUES(?,?)", host.rows)
    db.executemany("INSERT INTO vtype VALUES(?,?)", vtype.rows)
    # url interns to (id, url, host_id); the interner stored host_id as a column.
    db.executemany("INSERT INTO url VALUES(?,?,?)", url.rows)
    db.executemany("INSERT INTO cve VALUES(?,?,?,?,?,?,?,?,?,?,?)", cve_rows)
    db.executemany("INSERT INTO cve_text VALUES(?,?)", text_rows)
    db.executemany("INSERT OR IGNORE INTO cve_cwe VALUES(?,?)", cwe_link)
    db.executemany("INSERT OR IGNORE INTO cve_prod VALUES(?,?)", prod_link)
    db.executemany("INSERT OR IGNORE INTO cve_ref VALUES(?,?)", sorted(ref_link))
    db.executemany("INSERT INTO cve_ver VALUES(?,?,?,?,?,?,?)", ver_rows)

    # D-008: the notice travels with every copy, in-band.
    db.executemany(
        "INSERT INTO meta(k, v) VALUES(?,?)",
        [
            ("schema", SCHEMA_VERSION),
            ("rev", 1),
            ("generated", int(time.time())),
            ("notice", NOTICE),
        ],
    )
    db.commit()
    db.execute("VACUUM")
    db.close()

    return {
        "records": row_id,
        "skipped": skipped,
        "parse_seconds": round(parsed, 1),
        "bytes": os.path.getsize(out),
        "vendors": len(vendor),
        "products": len(product),
        "urls": len(url),
        "hosts": len(host),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("clone")
    parser.add_argument("out")
    parser.add_argument("--year-min", type=int, default=None)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument(
        "--allow-skipped",
        action="store_true",
        help="Deliberate escape hatch for local debugging only: keep the "
        "artifact despite unparseable records.",
    )
    args = parser.parse_args()

    stats = build(args.clone, args.out, args.year_min, args.limit)
    skipped = stats["skipped"]
    stats["skipped"] = len(skipped)
    print(json.dumps(stats, indent=2))

    # D-047: fail closed. A record that cannot be parsed must never silently
    # vanish from the published corpus — a handful of losses would sit below
    # the 0.1% tombstone guard and undercount forever (vision criterion 7).
    if skipped:
        for path in skipped:
            print(f"unusable record: {path}", file=sys.stderr)
        if not args.allow_skipped:
            os.remove(args.out)
            print(
                f"error: {len(skipped)} unusable records (unparseable, or an id "
                "that is neither a valid CVE ID nor a usable file name); artifact "
                "deleted (--allow-skipped overrides for local debugging)",
                file=sys.stderr,
            )
            return 1
        print(f"warning: {len(skipped)} unusable records skipped", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
