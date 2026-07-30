# Feature matrix

The scope ledger for the M0 planning conversations. Three tiers:

- **Confirmed** — stated project scope. Milestone assignment happens in
  [plan.md](plan.md) as the plan firms up.
- **Proposed** — candidate additions awaiting a yes/no from the project owner.
- **Open questions** — things that shape architecture and need an answer
  during M0.

Status legend: `confirmed` · `proposed` · `rejected (D-NNN)`

Nothing below is committed to a milestone yet. The `proposed` rows are
candidates only — they are described elsewhere in the docs as conditional, never
as product.

## Data acquisition & sync

| Feature | Status | Notes |
| --- | --- | --- |
| Server-side git clone of cvelistV5 as source of record | `confirmed` | D-005. Server runs git; the browser never does. |
| Same-origin PHP ingest endpoint | `confirmed` | D-006. Sole server component; ships corpus data only. |
| Endpoint hardening — same-origin browser callers, no open-proxy behavior | `confirmed` | D-006. Owner-stated requirement, not polish. |
| Get corpus data into local storage | `confirmed` | The cold-start path; must handle ~300k records. Whether this is a full import or a demand-driven partial cache is open question 1. |
| Incremental update of the local copy | `confirmed` | Owner-stated: "downloading and updating the list as needed." |
| Server-side cache of derived baseline/delta artifacts | `confirmed` | Owner-stated; avoids re-deriving from git per request. |
| Demand-driven cache that expands with exploration | `proposed` | Owner-proposed: fetch only the fields and records the current analysis needs, growing the local cache over time. Trades a large cold start for a more complex sync protocol. Leading candidate in open question 1. |
| Resumable / interruptible bulk import | `proposed` | Only relevant if a bulk import survives triage; a multi-hundred-MB cold start that cannot resume gets abandoned mid-import. |
| Sync watermark so the client requests only what it lacks | `proposed` | Needed for incremental sync to be cheap; the watermark's identity (git SHA vs. timestamp) is open question 6. |
| "N new CVEs since your last sync" summary | `proposed` | Turns an invisible background chore into the reason to open the app. |
| Corpus integrity check after import | `proposed` | Detects a truncated or corrupted import before a user builds analysis on bad data. |
| Notice carried by every served artifact | `proposed` | D-008 requires MITRE's copyright designation and license text in any copy; in-band where the format allows. |

## Storage & schema

| Feature | Status | Notes |
| --- | --- | --- |
| SQLite compiled to WASM as the query engine | `confirmed` | D-004. |
| OPFS persistence of the database | `confirmed` | D-004. |
| Analytics/reporting layer over the local corpus | `confirmed` | Owner-stated. Deliberately unbounded at kickoff — bounded below. |
| Extraction of CVSS metrics (v2 / v3.x / v4) into queryable columns | `proposed` | Records carry several metric formats; severity filtering is unusable until they are normalized. |
| Extraction of CWE, CPE, and affected product/vendor into queryable form | `proposed` | The most common filter axes after severity and date. |
| Full-text search index over descriptions and references | `proposed` | SQLite FTS5 is available; keyword search is table stakes for a search tool. |
| Schema versioning and migration on app update | `proposed` | Without it, every schema change forces users through a full re-import. |
| Storage quota handling and `navigator.storage.persist()` | `proposed` | A corpus this size runs into quota and eviction; silent eviction looks like data loss. |
| Import/export of the whole local database | `proposed` | Lets a user move or back up a costly import instead of re-downloading it. |
| Cache coverage tracking with loud failure on gaps | `proposed` | Mandatory if the demand-driven cache is adopted: a partially populated cache that answers a query it cannot fully cover returns a plausible undercount, which for security analysis is worse than an error. See open question 1. |
| Layout tuned for partial fetch (partitioning, covering indexes) | `proposed` | What makes demand-driven fetching cheap or expensive; a row-oriented layout defeats it, a year-partitioned columnar-ish one makes narrow queries nearly free. |

## Search, query & reporting

Bounding the "analytics/reporting tools" scope: candidates qualify only if they
(a) answer a question about the corpus itself, (b) are computable from data the
client already holds, and (c) need no additional network source. Anything
failing (c) is an overlay and is triaged separately below. The M0 feature-triage
conversation closes this list; additions afterward go through the decision log.

| Feature | Status | Notes |
| --- | --- | --- |
| Search across CVE records | `confirmed` | Stated in the repository description. |
| Structured filtering (date, severity, CNA, CWE, product) | `proposed` | The concrete form of "analyzing"; the axes follow from the extraction rows above. |
| Aggregate reporting and trend views over time | `proposed` | The main thing a local full-corpus copy enables over a search box. |
| Charting for report output | `proposed` | Aggregates without visualization push users back to a spreadsheet. |
| Raw SQL console | `proposed` | Cheap given D-004, and the escape hatch for every question the UI did not anticipate. |
| Saved queries and query history | `proposed` | Analysis is iterative; losing a refined query on reload is a real cost. |
| Shareable query/report permalinks (query only, never data) | `proposed` | Supports vision success criterion 6 while preserving the privacy property. |
| Per-record change history | `proposed` | The server has full git history (D-005), so "what changed in this record and when" is uniquely available here. |
| Export result sets (CSV / JSON) | `proposed` | Makes the tool a step in a workflow rather than a dead end. Exports are "copies" under D-008, so the notice must travel with them. |
| Visible attribution and warranty disclaimer | `proposed` | D-008 obligation plus plain honesty: the terms disclaim all warranties on data people will use for security decisions. |

## Enrichment overlays (each is a separate network source)

| Feature | Status | Notes |
| --- | --- | --- |
| CISA KEV overlay | `proposed` | High analytical value; needs a CORS, licensing, and sync answer of its own. |
| EPSS score overlay | `proposed` | Scores change frequently, so it is a recurring sync problem, not a one-time import. |
| NVD enrichment overlay | `proposed` | NVD's API returns `access-control-allow-origin: *` (checked 2026-07-30) but is rate-limited; full-corpus enrichment client-side may be impractical. |

## Operations & resilience

| Feature | Status | Notes |
| --- | --- | --- |
| Rsync deploy from `dist/` | `confirmed` | D-003. |
| Scheduled server-side `git fetch` to keep the clone current | `proposed` | Implied by D-005 but not yet specified: cadence, failure handling, and staleness signalling are undecided. |
| Multi-tab behavior | `proposed` | Forced by D-004: `opfs-sahpool` does not support simultaneous connections, so a second tab needs a defined behavior. |
| Browser support floor and capability gating | `proposed` | An unsupported browser should say so on arrival rather than fail deep inside an import. |
| Diagnostics panel (storage used, last sync, record counts, schema version) | `proposed` | Makes "measure, don't assert" possible for users and for bug reports. |
| Endpoint rate limiting and abuse metrics | `proposed` | D-006 requires the endpoint not become an open endpoint; enforcement needs a concrete mechanism. |

## Open questions (answer during M0)

Ordered by how much rework a late answer would cause.

1. **Which data-delivery architecture?** This is the single highest-leverage
   question — it sets transfer size, cold-start time, schema ownership, sync
   complexity, and how migrations work. Three candidates, to be measured
   head-to-head by the spike in [plan.md](plan.md):

   - **(a) Bulk import.** Server ships the whole corpus (as a prebuilt database
     or as JSON the client inserts); client holds a complete local copy. Simple
     sync, simple correctness, expensive cold start.
   - **(b) Projection API.** Client requests only the fields and partitions its
     current analysis needs; cache grows with exploration. Owner-proposed. Cheap
     cold start, but the client must track what it does and does not have, and
     the endpoint learns something about what is being asked.
   - **(c) Range-request VFS.** Server publishes one read-only SQLite file;
     nginx serves HTTP range requests; a browser-side VFS fetches only the
     database pages a query touches, persisting them to OPFS as a growing cache.
     Achieves (b)'s goal at page granularity with a *dumb* static server. Prior
     art exists — `sql.js-httpvfs` and `sqlite-wasm-http` — but both are
     self-described as experimental/demo-grade, and neither persists its page
     cache to OPFS out of the box, so the persistence layer is ours to build.

   Note that (c) largely dissolves the correctness hazard in (b): SQLite decides
   what pages it needs, so a query cannot silently run against a partial view.
   That is a strong argument, but it is an argument, not a measurement — decide
   on the spike's numbers.

2. **What does the server learn under the chosen architecture?** Directly
   constrains D-007 and success criterion 4 in [vision.md](vision.md). A bulk
   import leaks nothing about queries; a projection API leaks the field set and
   partition range; page-level range requests leak access patterns. Any design
   that pushes *predicates* to the server ("vendor = X", "severity ≥ 7") forfeits
   the property the project exists for and should be rejected on that basis
   alone. Where the acceptable line sits between those is an owner decision.
3. **What is the wire format or artifact layout?** Follows from (1), but needs
   its own answer: compression, partitioning granularity, chunk sizing, and —
   under (c) — SQLite page size and index design, since those determine how much
   a narrow query actually costs.
4. **What are the working-set and latency budgets?** Measured numbers for bytes
   transferred, wall-clock, peak memory, OPFS footprint, and representative
   query latency under each candidate. Gates success criteria 1 and 3 in
   [vision.md](vision.md); the budgets in those criteria come from here.
5. **Which OPFS VFS — `opfs` or `opfs-sahpool`?** Per SQLite's documentation the
   former needs COOP/COEP response headers, which nginx must be configured to
   send; the latter needs no headers but forbids simultaneous connections.
   Determines multi-tab behavior and a server configuration dependency. Under
   candidate (c) there is a second half to this: how a range-request VFS and an
   OPFS-persistence VFS compose, which may mean writing the combination rather
   than picking one.
6. **How does the cache stay correct as upstream changes?** Under (a) this is a
   sync watermark — git SHA (exact, from server-side history) versus timestamp
   (simpler, ambiguous for republished records). Under (b) and (c) it is harder
   and 2-dimensional: a rebuilt artifact can invalidate every cached page a
   client holds, so daily rebuilds could wipe every user's accumulated cache.
   Stable page layout, immutable per-year partitions, or versioned artifacts are
   the candidate mitigations. This is where the owner's anticipated "more effort
   in the sync protocol" actually lands.
7. **How is the ingest endpoint actually locked down?** `Sec-Fetch-Site` and
   `Origin` header checks, rate limiting, bounded responses, strict parameter
   validation — which combination is enforceable in this nginx/PHP setup, and
   what does it do about non-browser callers that can forge headers freely?
   Note that candidate (c) shrinks this problem considerably: a static file with
   range requests has far less attack surface than a query endpoint.
8. **What is the telemetry stance for a public tool?** The privacy property
   argues for none, but that forfeits any signal about whether imports succeed
   in the wild. An explicit owner decision either way, recorded in the log.
9. **What is the browser support floor?** OPFS synchronous access handles
   constrain this. The floor determines both the capability-gating feature and
   what "modern desktop browser" means in the success criteria.

*Answered and removed:* the corpus's redistribution terms, resolved by D-008.
