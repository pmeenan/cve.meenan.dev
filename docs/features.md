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
| Same-origin PHP ingest endpoint | `confirmed` | D-006. Sole server component; ships corpus data only. |
| Endpoint hardening — same-origin browser callers, no open-proxy behavior | `confirmed` | D-006. Owner-stated requirement, not polish. |
| Get corpus data into local storage | `confirmed` | The cold-start path; 372,092 records. Settled as a full bulk import by D-025. |
| Incremental update of the local copy | `confirmed` | Owner-stated: "downloading and updating the list as needed." |
| Server-side cache of derived baseline/delta artifacts | `confirmed` | Owner-stated; avoids re-deriving from git per request. |
| Sync watermark so the client requests only what it lacks | `confirmed` | Its identity is Q-001 — a git SHA is unavailable since D-021 made the clone shallow, so the candidates are CNA `dateUpdated` or a server-assigned content-hash sequence. |
| Corpus integrity check | `confirmed` | Detects truncated or corrupted data before a user builds analysis on it. Cheap insurance against the worst failure mode. |
| "N new CVEs since your last sync" summary | `confirmed` | Turns an invisible background chore into the reason to open the app; near-free once a watermark exists. |
| Notice carried by every served artifact | `confirmed` | D-008 requires MITRE's copyright designation and license text in any copy; in-band where the format allows. Not discretionary. |
| Scheduled server-side `git fetch` | `confirmed` | Moved from Operations — it is the head of this pipeline. Cadence, failure handling, and staleness signalling still to specify. |
| Explicit "Download data" action | `confirmed` | D-025, D-026. Cached weekly snapshot *plus* every delta since it was taken, so download leaves the client current. ~72 MB brotli (-q10). |
| Explicit "Sync" action applying a delta | `confirmed` | D-025. Median day 0.17 MB, busiest observed 0.78 MB — ~574× cheaper than re-downloading. Same apply path as download (D-026). |
| Weekly snapshot rebuild with cached compressed artifact | `confirmed` | D-026. Compression is the expensive step (minutes at brotli -q10, vs 19 s to rebuild the database), so it runs weekly rather than per upstream fetch. |
| Merged deltas per watermark range | `confirmed` | D-026. A client catching up a week should get each record's final state, not every intermediate revision. |
| Resumable / interruptible download | `confirmed` | D-025. Made easy by D-026: the snapshot is a static file, so ordinary HTTP range resume works. |
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
| Extraction of CWE, CPE, and affected product/vendor into queryable form | `confirmed` | The most common filter axes after severity and date. |
| Full-text search (FTS5) over descriptions and references | `confirmed` | D-011, English-only per D-023. Measured: descriptions + FTS index are 187 MB of the 273 MB database — the expensive half, and the natural thing to defer if cold start needs to be faster. References are not yet in the spike index. |
| Interned lookup tables for CWE, CNA, vendor, product | `confirmed` | D-024. 797 CWEs and 479 CNAs replace text repeated across 372k records; the corpus drops 16× to 272.8 MB. |
| Published and last-modified dates | `confirmed` | D-020. Sourced from `cveMetadata.datePublished` / `dateUpdated` in the record JSON — 98.4% / 100% coverage — not from git. |
| Record state (`PUBLISHED` / `REJECTED`) as a queryable column | `confirmed` | D-022. ~4.9% of the corpus is REJECTED; excluded from counts by default, filterable on request. |
| Per-record revision count | `rejected (D-020)` | No confirmed feature queries it, and it was the only consumer of git history. |
| Schema versioning and migration on app update | `confirmed` | Without it, every schema change forces users through a full re-import. |
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

**Q-001. What is the delta format, and what identifies a client's watermark?** Now
   the central design question, since D-025 settled everything around it. The
   watermark cannot be a git SHA: D-021 made the clone shallow, so the server
   has no history to diff against. Two candidates:

   - **CNA-supplied `dateUpdated`.** Present on 100% of records (D-023), so it
     is free. But it is written by publishers, not by us — clock skew, stale
     values, and republication without advancing it all produce silently missed
     updates.
   - **A server-assigned monotonic sequence over per-record content hashes.**
     The server rebuilds the artifact after each fetch — 19 s for the whole
     corpus (D-024), so this is cheap — hashes each record, and assigns a
     sequence number to anything that changed. The client's watermark is the
     last sequence it applied. Robust to bad publisher timestamps, at the cost
     of the server storing a hash per record.

   The second looks right, and notably needs no git history at all, which
   independently validates D-021. Confirm before building. The format itself is
   partly settled: D-025 measured positional encoding as no smaller than plain
   JSON after gzip, so send readable JSON.

   D-026 adds three sub-questions to settle here: how deltas are **merged** so a
   client catching up a week receives each record's final state rather than every
   intermediate revision; that the watermark after a download ends at the **last
   delta applied**, not the snapshot's, or the next sync silently re-fetches a
   week; and what the **snapshot cadence** should actually be, weekly being a
   starting point rather than a finding.
**Q-002. What else belongs in the schema beyond the spike floor?** D-024's 272.8 MB
   deliberately omits references (10.6% of corpus bytes), affected version
   ranges, CPE applicability, solutions, credits, and timeline — and D-011
   requires FTS over references, which the spike does not index. Each addition
   grows the download every user takes, so this is the question that decides
   whether ~99 MB stays roughly true.
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
**Q-005. How is the endpoint locked down, and what else must nginx be configured to
   do?** Originally just hardening: `Sec-Fetch-Site` and `Origin` header checks,
   rate limiting, bounded responses — which combination is enforceable here, and
   what it does about non-browser callers that can forge headers freely. D-025
   shrank the hardening half considerably, since the full artifact is a static
   file and only the delta endpoint takes a parameter at all — a watermark, to
   be validated as an opaque token and never allowed near the filesystem (D-006,
   D-018). KEV (D-010) adds a second server-fetched source needing the same
   treatment.

   **The server-configuration half is answered (D-030).** All three dependencies
   were checked on `plex` 2026-07-31 and none of them block M1:

   - **Brotli** — both nginx brotli modules are already loaded; enabling it is
     one line, `brotli_static on;`.
   - **Clean URLs** — solved without touching nginx by setting
     `trailingSlash: true` in Next, so routes emit `/route/index.html` and the
     existing `try_files $uri $uri/ =404;` resolves them.
   - **COOP/COEP** — already served on `cve.meenan.dev`, copied from the
     `webai` and `keepawake` blocks.

   What remains open here is the hardening itself, plus one finding D-030
   surfaced: php-fpm runs as `pmeenan`, the user owning the clone, the artifacts,
   *and* the document root — so a flaw in the endpoint has write access to all
   three, when it only ever needs to read two directories. Narrowing that is a
   hardening item, not a blocker.

*Answered and removed:* corpus redistribution terms (D-008); telemetry stance
(D-009); the privacy envelope (D-014); the range-request VFS candidate (D-015);
browser support floor (D-016); the data-delivery architecture (D-025).
