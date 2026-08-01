# Feature matrix

The scope ledger. Tiers:

- **Confirmed** — in scope. Milestone assignment happens in [plan.md](plan.md).
- **Proposed** — candidate additions awaiting a yes/no from the project owner.
- **Rejected** — decided against, with the decision entry that explains why.

Status legend: `confirmed` · `proposed` · `rejected (D-NNN)`

**Triage status:** the first full pass ran 2026-07-30 (D-009 through D-013), and
D-025 subsequently resolved the four rows that had been gated on the data-delivery
architecture. **Every row is now resolved.** Additions after this point go through
the decision log, not by editing a row.

## Data acquisition & sync

| Feature | Status | Notes |
| --- | --- | --- |
| Server-side git clone of cvelistV5 as source of record | `confirmed` | D-005. Server runs git; the browser never does. |
| Same-origin data delivery, corpus data only | `confirmed` | D-006, and D-032 made it static files rather than a PHP endpoint — the client sends no parameters. |
| Endpoint hardening — same-origin browser callers, no open-proxy behavior | `confirmed` | D-006. Owner-stated requirement, not polish. D-032 moves enforcement into nginx, since there is no handler to harden. |
| Get corpus data into local storage | `confirmed` | The cold-start path; 372,092 records. Settled as a full bulk import by D-025. |
| Incremental update of the local copy | `confirmed` | Owner-stated: "downloading and updating the list as needed." |
| Server-side cache of derived baseline/delta artifacts | `confirmed` | Owner-stated; avoids re-deriving from git per request. |
| Sync watermark so the client requests only what it lacks | `confirmed` | D-031: a server-assigned revision number over per-record content hashes. Stored inside the local database and advanced in the same transaction as the rows. |
| Corpus integrity check | `confirmed` | Detects truncated or corrupted data before a user builds analysis on it. Cheap insurance against the worst failure mode. |
| "N new CVEs since your last sync" summary | `confirmed` | Turns an invisible background chore into the reason to open the app; near-free once a watermark exists. |
| Notice carried by every served artifact | `confirmed` | D-008 requires MITRE's copyright designation and license text in any copy; in-band where the format allows. Not discretionary. |
| Scheduled server-side `git fetch` | `confirmed` | D-042. Daily cron under `flock`; monthly snapshot rebuild. Failure leaves the previous generation serving; staleness reaches users through the manifest, not a second channel. |
| Explicit "Download data" action | `confirmed` | D-025, D-026. Cached weekly snapshot *plus* every delta since it was taken, so download leaves the client current. **62.6 MB brotli -q10** for the whole corpus (D-035, D-038). |
| Explicit "Sync" action applying a delta | `confirmed` | D-025. Median day 0.17 MB, busiest observed 0.78 MB — ~574× cheaper than re-downloading. Same apply path as download (D-026). |
| Monthly snapshot rebuild with cached compressed chunks | `confirmed` | D-042, refining D-026. A month of catch-up is ~31 daily deltas and ~2.6 MB against 62.6 MB — about 4%. |
| Merged deltas per watermark range | `confirmed` | D-026, D-031. A range query over per-record revisions returns final state by construction. Daily ingest (D-042) means one file per day and no rollup. |
| Resumable / interruptible download | `confirmed` | D-041. A property of the format rather than a feature: independently-compressed 32 MB chunks make resume a bitmap of what is already written. |
| Server-assigned stable IDs for interned lookups | `confirmed` | D-025 hazard 1. Deltas reference CWE/CNA/vendor/product by integer, so the server must own that ID space permanently and ship new lookup rows with the deltas that use them. |
| FTS index maintenance on delta apply | `confirmed` | D-025 hazard 2. External-content FTS5 does not self-update; a missed `'delete'` silently desynchronizes search from the data. |
| Tombstones for removed records | `confirmed` | D-025 hazard 3. Without them an upstream removal persists in every client forever. |
| Visible staleness indicator | `confirmed` | Follows from sync being manual: a silently month-old corpus producing confident counts is its own form of quiet wrongness. |
| Demand-driven cache that expands with exploration | `rejected (D-025)` | Candidate (b). Its cold-start advantage evaporated once D-024 measured the full corpus at 98.7 MB gzipped. |
| Cache coverage tracking with loud failure on gaps | `rejected (D-025)` | Moot under bulk import — the client either has the whole corpus or has not downloaded it. This is the debt D-015 took on, now discharged. |
| Layout tuned for partial fetch (partitioning, covering indexes) | `rejected (D-025)` | No partial fetch to tune for. |

## Storage & schema

| Feature | Status | Notes |
| --- | --- | --- |
| SQLite compiled to WASM as the query engine | `confirmed` | D-004. |
| OPFS persistence of the database | `confirmed` | D-004. |
| Analytics/reporting layer over the local corpus | `confirmed` | Owner-stated. Bounded by the criteria below. |
| Extraction of CVSS metrics (v2 / v3.x / v4) into queryable columns | `confirmed` | Records carry several metric formats; severity filtering is unusable until they are normalized. |
| Extraction of CWE and affected product/vendor into queryable form | `confirmed` | The most common filter axes after severity and date. CPE was dropped by D-033 on 2.2% prevalence. |
| Full-text search (FTS5) over descriptions, vendors and products | `confirmed` | D-035, English-only per D-023. Built in the browser after import, never shipped — the index compresses at 1.7× and cost 35.1 MB, 31% of the download. |
| Filter references by host rather than full-text | `confirmed (amends D-011)` | D-033, D-035. Indexing reference URLs pollutes the term space with hosts, slugs and file names; host interning costs 2.0 MB and answers the question exactly. |
| Affected version ranges | `confirmed` | D-033. 95.0% prevalence, +14.4 MB compressed. |
| References, as interned URLs | `confirmed` | D-033. 95.1% prevalence, +23.0 MB compressed including host interning. |
| CPE applicability | `rejected (D-033)` | Present on 2.2% of records — a filter that would look like it works and silently discard 97.8% of the corpus. |
| Credits, timeline, solutions, workarounds, exploits | `rejected (D-033)` | 0.3–20.1% prevalence; per-record prose no confirmed aggregate consumes. |
| Interned lookup tables for CWE, CNA, vendor, product | `confirmed` | D-024. 797 CWEs and 479 CNAs replace text repeated across 372k records; the corpus drops 16× to 272.8 MB. |
| Published and last-modified dates | `confirmed` | D-020. Sourced from `cveMetadata.datePublished` / `dateUpdated` in the record JSON — 98.4% / 100% coverage — not from git. |
| Record state (`PUBLISHED` / `REJECTED`) as a queryable column | `confirmed` | D-022. ~4.9% of the corpus is REJECTED; excluded from counts by default, filterable on request. |
| Per-record revision count | `rejected (D-020)` | No confirmed feature queries it, and it was the only consumer of git history. |
| Schema versioning and migration on app update | `confirmed` | Without it, every schema change forces users through a full re-import. |
| Year-partitioned download with on-demand backfill | `rejected (D-038)` | Would have saved 24.6 MB on a first download in exchange for coverage becoming a thing the whole product reasons about. D-035 had already banked the larger saving. |
| Client-side brotli decompression in WASM, streamed into OPFS | `confirmed` | D-040, D-041. Opaque `.br` chunks decoded and written positionally, so peak memory is one chunk and no intermediary can re-encode. |
| Storage quota handling and `navigator.storage.persist()` | `confirmed` | A corpus this size runs into quota and eviction; silent eviction looks like data loss. |
| Import/export of the whole local database | `rejected (D-013)` | The local database is a rebuildable cache, not a user asset. |

## Search, query & reporting

Bounding the "analytics/reporting tools" scope: candidates qualify only if they
(a) answer a question about the corpus itself, (b) are computable from data the
client already holds, and (c) need no additional network source. Anything
failing (c) is an overlay and is triaged separately below. **This list is closed
as of the 2026-07-30 triage** — additions go through the decision log.

| Feature | Status | Notes |
| --- | --- | --- |
| Search across CVE records | `confirmed` | Stated in the repository description. |
| Structured filtering (date, severity, CNA, CWE, product) | `confirmed` | The concrete form of "analyzing"; the axes follow from the extraction rows above. |
| Aggregate reporting and trend views over time | `confirmed` | The main thing a local corpus enables over a search box — the reason the project exists. |
| Charting for report output | `confirmed` | Aggregates without visualization push users back to a spreadsheet. |
| Raw SQL console | `confirmed` | Nearly free given D-004, and the escape hatch for every question the UI did not anticipate. |
| Saved queries and query history | `confirmed` | Analysis is iterative; losing a refined query on reload is a real cost. |
| Shareable query/report permalinks (query only, never data) | `confirmed` | Supports vision criterion 6 while preserving the privacy property. |
| Export result sets (CSV / JSON) | `confirmed` | Makes the tool a step in a workflow rather than a dead end. Exports are "copies" under D-008, so the notice travels with them. |
| Visible attribution and warranty disclaimer | `confirmed` | D-008 obligation plus plain honesty: the terms disclaim all warranties on data people use for security decisions. |
| Per-revision diff view | `rejected (D-020)` | Rejected first in D-012 as too heavy, then removed entirely with the revision count. Rebuilding it needs D-021 reopened, since a shallow clone has no history. |

## Enrichment overlays

| Feature | Status | Notes |
| --- | --- | --- |
| CISA KEV overlay | `confirmed` | D-010. 1,656 entries / 1.5 MB, ~daily. Sends no CORS header (checked 2026-07-30), so it routes through the existing server. |
| EPSS score overlay | `rejected (D-010)` | Daily-changing scores across the whole corpus — a recurring sync problem for a secondary signal. |
| NVD enrichment overlay | `rejected (D-010)` | Would mean operating a second mirror; rate limits make client-side full-corpus enrichment impractical. |

## Operations & resilience

| Feature | Status | Notes |
| --- | --- | --- |
| Rsync deploy from `dist/` | `confirmed` | D-003. |
| Multi-tab behavior | `confirmed` | Forced by D-004: `opfs-sahpool` does not support simultaneous connections, so a second tab needs defined behavior. |
| Browser support floor and capability gating | `confirmed` | An unsupported browser should say so on arrival, not fail deep inside an import. |
| Diagnostics panel (storage used, last sync, record counts, schema version) | `confirmed` | Makes "measure, don't assert" possible for users, and is the only support channel given D-009. |
| Endpoint rate limiting and abuse metrics | `confirmed` | D-006 requires the endpoint not become an open endpoint; enforcement needs a concrete mechanism (Q-005). |
| Client-side telemetry | `rejected (D-009)` | No collection of any kind. |

## Open questions (answer during M0)

**Q-numbers are stable and never reused or renumbered** — answered questions are
struck from the list, not shifted. Earlier decision entries (D-011 and before)
cite open questions by ordinal position, which was renumbered twice before this
convention; read those references as historical.

Ordered by how much rework a late answer would cause.

**Q-001. What is the delta format, and what identifies a client's watermark?**
   **Answered 2026-07-31 by D-031**, measured against a real 21.4-hour upstream
   window: a server-assigned revision number over per-record content hashes,
   whole-record JSON at brotli -q5, merged by range query, applied in one
   idempotent transaction. D-026's three sub-questions — merging, watermark
   placement after download, and snapshot cadence — are answered there too.
   **D-032** follows from it: because a delta is named by its revision range, it
   is a static file, and the sync path needs no request handler at all.
**Q-002. What else belongs in the schema beyond the spike floor?**
   **Answered 2026-07-31 by D-033**, by building every candidate section against
   the full corpus and compressing each cumulative variant. Version ranges and
   references are in, five sections are out, and FTS over references is replaced
   by host interning — an amendment to D-011. The published artifact measures
   **95.4 MB at brotli -q10**, up 32% from the floor. D-035 then removed the
   shipped index, bringing the download to **62.6 MB**.
**Q-003. What are the browser-side budgets?** *Deferred to M1 by D-029 — needs a
   running browser, so it is measured against real scaffolding rather than
   answered on paper.* The D-024 timings are native SQLite on server hardware.
   Needed in a real browser: import wall-clock for the full artifact, peak
   memory, OPFS footprint, and query latency under WASM. Gates vision criteria 1
   and 3, whose budgets come from here. If the numbers come back bad, the
   fallback is already identified in D-024 — ship the ~86 MB of structured data
   first and defer text plus FTS.
**Q-004. Which OPFS VFS — `opfs` or `opfs-sahpool`?** *Deferred to M1 by D-029.*
   Per SQLite's documentation the former needs COOP/COEP response headers and the
   latter forbids simultaneous connections. **D-030 removed the server-config
   half of this question**: `cve.meenan.dev` already serves COOP/COEP, so both
   VFSes are available today and this is now purely a performance and multi-tab
   trade — measured in M1, not argued here. (This also retires D-027's concern
   that Next.js static export cannot emit headers: nginx already does.)
**Q-005. How is the data plane locked down, and what else must nginx be configured
   to do?** Originally just hardening: `Sec-Fetch-Site` and `Origin` header
   checks, rate limiting, bounded responses — which combination is enforceable
   here, and what it does about non-browser callers that can forge headers
   freely. D-025 shrank it once; **D-032 shrank it again and changed its
   character**: there is no request handler left to harden, so what remains is
   nginx configuration over static files — the `alias` exposing `cve.data/pub/`
   read-only,
   cache headers, and whatever same-origin enforcement is worth doing given that
   non-browser callers forge headers freely. KEV (D-010) is a third static file
   under the same treatment.

   **The server-configuration half is answered (D-030).** All three dependencies
   were checked on `plex` 2026-07-31 and none of them block M1:

   - **Brotli** — both nginx brotli modules are already loaded, though D-040
     made `brotli_static` unnecessary for the data plane: artifacts ship as
     opaque `.br` and the client decompresses them itself.
   - **Clean URLs** — solved without touching nginx by setting
     `trailingSlash: true` in Next, so routes emit `/route/index.html` and the
     existing `try_files $uri $uri/ =404;` resolves them.
   - **COOP/COEP** — already served on `cve.meenan.dev`, copied from the
     `webai` and `keepawake` blocks.

   The php-fpm privilege breadth D-030 surfaced — the pool runs as `pmeenan`,
   the user owning the clone, the artifacts, *and* the document root — is now
   dormant rather than urgent: under D-032 no PHP runs in the data path. It
   returns the moment any handler is added.

*Answered and removed:* corpus redistribution terms (D-008); telemetry stance
(D-009); the privacy envelope (D-014); the range-request VFS candidate (D-015);
browser support floor (D-016); the data-delivery architecture (D-025).
