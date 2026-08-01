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

| File | Role |
| --- | --- |
| `schema.sql` | The published schema. Single source of truth for both sides. |
| `normalize.py` | The stored projection — also the definition of "changed" (D-031). |
| `build.py` | Corpus → SQLite. |
| `publish.py` | SQLite → 32 MB chunks at brotli -q10 + manifest (D-041). |

`pub/` is generated output and is not committed.

The daily ingest and delta generator (D-042) land in M2.
