# Pipeline

Server-side ingest and publish. Python 3.12, standard library only (D-043).
Runs on `plex`; **never deployed to the docroot** — `scripts/deploy.sh` mirrors
`dist/`, and this has no business being web-reachable.

    # build the artifact from a cvelistV5 clone, continuing the previous
    # build's ID space (--bootstrap only for the very first one, D-056)
    python3 pipeline/build.py /var/www/meenan.dev/cve.data/git/cvelistV5 out.sqlite \
        --seed yesterday.sqlite

    # bounded slice for development (M1). A slice always bootstraps: seeding one
    # would retire every value outside it from the ID space, permanently
    python3 pipeline/build.py <clone> slice.sqlite --year-min 2026 --bootstrap

    # chunk, compress and publish, writing manifest.json
    python3 pipeline/publish.py slice.sqlite pipeline/pub

    # emit a delta from a changeset and register it in the manifest
    python3 pipeline/delta.py next.sqlite pipeline/pub changeset.json

| File | Role |
| --- | --- |
| `schema.sql` | The published schema. Single source of truth for both sides. |
| `normalize.py` | The stored projection — also the definition of "changed" (D-031). |
| `build.py` | Corpus → SQLite. Owns the interned ID space: seeded from the previous artifact or explicitly bootstrapped, never defaulted (D-056). Fails closed on malformed records (D-047); carries the canonical D-008 notice. |
| `publish.py` | SQLite → 32 MB chunks at brotli -q10 + manifest (D-041). Published generations are immutable (D-047), and so is what an id means at a published revision; refuses an artifact from another ID space, grown from the wrong ancestor, or carrying a revision JSON cannot hold. Re-cutting identical bytes resumes an interrupted run without `--force` (D-056). |
| `delta.py` | Changeset + artifact → one delta file at brotli -q5, on the D-055 wire contract. Fails closed on a missing record, an unshipped lookup row, a foreign or wrongly-continued ID space, floors that are not the source's seed, or a manifest that could not hold the entry (D-056). |
| `manifest.py` | The only writer of `manifest.json`: atomic, and the one place that decides what `rev` means. Refuses a manifest whose deltas do not tile the revision space. |
| `ledger.py` | Append-only record of everything ever published, with the SHA-256 served at each URL and the ID space it belongs to. Kept *outside* the published directory (`cve.pub/published.json`); it is pipeline state, not part of the contract. |
| `tests/` | unittest suite (CVSS priority, notice components, hostile shapes, the delta contract with a reference apply, and the ID space's stability under rebuilds) — part of `pnpm check` via `pnpm test:pipeline`. |

A changeset is what the daily ingest computes and `delta.py` serializes:

```json
{"from": 12, "to": 13,
 "upsert": ["CVE-2026-14537"], "delete": [],
 "floors": {"cna": 372, "cwe": 798, "vendor": 24420, "product": 80148,
            "host": 9145, "url": 1204882, "vtype": 6},
 "extra": {"cwe": [798]}}
```

`floors` is each lookup table's highest *issued* id at revision `from` — the ID
space is append-only, so everything above the floor is exactly what the client
lacks (D-055). All seven tables must appear: a missing one defaults to 0 and
ships the whole table, so both mistakes are refused rather than published.
`extra` covers a row whose content changed under an existing id.

Both come out of the build rather than being computed by hand:
`build.id_space(artifact)["floors"]` reads the marks the build recorded in
`meta` (not `max(id)` — a retired row can be the highest one, D-056), and the
build's `extra` field reports the ids whose content moved. Only `cwe.descr` can
do that: it is the one lookup column that is neither part of its own interning
key nor derived from it (`url.host_id` is also a non-key column, but it is a
function of the url text, and host ids are seeded too).

An ID space has a name, minted by `--bootstrap` and inherited by every seeded
build, and each artifact also records the revision it continued (`seed_rev`).
`ledger.py` records the name the data plane was published from, and both
publishers refuse an artifact from a different one — or one grown from the wrong
ancestor, which shares the name. Two deliberate overrides, neither defaultable:

    # the data plane predates all of this and has no recorded ID space; only
    # correct for a build seeded from the live artifact, and only above the
    # published head (nothing here can prove the ids continue, so clients
    # re-download rather than trusting it)
    python3 pipeline/publish.py rebuilt.sqlite <pub> --adopt-id-space

    # retire the ID space (a schema bump forces this, via --bootstrap). Needs a
    # revision above the published head; retires every delta; clients re-download
    python3 pipeline/publish.py fresh.sqlite <pub> --new-id-space

A schema bump chains all three: seeding across one is refused, so the rebuild
bootstraps, which mints a new lineage, which needs `--new-id-space`.

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
