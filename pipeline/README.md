# Pipeline

Server-side ingest and publish. Python 3.12, standard library only (D-043).
Runs on `plex`; **never deployed to the docroot** — `scripts/deploy.sh` mirrors
`dist/`, and this has no business being web-reachable.

    # build the artifact from a cvelistV5 clone
    python3 pipeline/build.py /var/www/meenan.dev/cve.data/git/cvelistV5 out.sqlite

    # bounded slice for development (M1)
    python3 pipeline/build.py <clone> slice.sqlite --year-min 2026

    # chunk, compress and publish, writing manifest.json
    python3 pipeline/publish.py slice.sqlite pipeline/pub

    # emit a delta from a changeset and register it in the manifest
    python3 pipeline/delta.py next.sqlite pipeline/pub changeset.json

| File | Role |
| --- | --- |
| `schema.sql` | The published schema. Single source of truth for both sides. |
| `normalize.py` | The stored projection — also the definition of "changed" (D-031). |
| `build.py` | Corpus → SQLite. Fails closed on malformed records (D-047); carries the canonical D-008 notice. |
| `publish.py` | SQLite → 32 MB chunks at brotli -q10 + manifest (D-041). Published generations are immutable (D-047). |
| `delta.py` | Changeset + artifact → one delta file at brotli -q5, on the D-055 wire contract. Fails closed on a missing record or an unshipped lookup row. |
| `manifest.py` | The only writer of `manifest.json`: atomic, and the one place that decides what `rev` means. Refuses a manifest whose deltas do not tile the revision space. |
| `ledger.py` | Append-only record of everything ever published, with the SHA-256 served at each URL. Kept *outside* the published directory (`cve.pub/published.json`); it is pipeline state, not part of the contract. |
| `tests/` | unittest suite (CVSS priority, notice components, hostile shapes, the delta contract and a reference apply) — part of `pnpm check` via `pnpm test:pipeline`. |

A changeset is what the daily ingest computes and `delta.py` serializes:

```json
{"from": 12, "to": 13,
 "upsert": ["CVE-2026-14537"], "delete": [],
 "floors": {"cna": 372, "cwe": 798, "vendor": 24420, "product": 80148,
            "host": 9145, "url": 1204882, "vtype": 6},
 "extra": {"cwe": [798]}}
```

`floors` is each lookup table's highest id at revision `from` — the ID space is
append-only, so everything above the floor is exactly what the client lacks
(D-055). All seven tables must appear: a missing one defaults to 0 and ships
the whole table, so both mistakes are refused rather than published. `extra`
covers a row whose content changed under an existing id.

`pub/` is generated output and is not committed, and neither is the ledger that
sits beside it — `pipeline/published.json` locally,
`/var/www/meenan.dev/cve.pub/published.json` on `plex`, where no nginx location
reaches it. Deleting it is not free: it is what stops a rotated-away revision
being re-cut over its own immutable URLs, and it can only re-seed from whatever
the current manifest still describes. `tests/fixture_pub.py`
publishes a complete miniature data plane, which is what
`tests/unit/contract.test.ts` validates with the browser's own code.

The daily ingest that computes changesets, and the monthly snapshot cron
(D-042), land next in M2.
