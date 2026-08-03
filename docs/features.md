# Feature matrix

The scope ledger. Tiers:

- **Confirmed** — in scope. Milestone assignment happens in [plan.md](plan.md).
- **Proposed** — candidate additions awaiting a yes/no from the project owner.
- **Rejected** — decided against, with the decision entry that explains why.

Status legend: `confirmed` · `proposed` · `rejected (D-NNN)`

**Triage status:** the first full pass ran 2026-07-30 (D-009 through D-013), and
D-025 subsequently resolved the four rows that had been gated on the data-delivery
architecture. **Every row is now resolved.** Additions after this point go through
the decision log, not by editing a row. The AI chat layer section was added
2026-08-01 through D-044 – D-046, per that rule.

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
| Explicit "Download data" action | `confirmed` | D-025, D-026. Cached monthly snapshot (D-042) *plus* every delta since it was taken, so download leaves the client current. **62.6 MB brotli -q10** for the whole corpus (D-035, D-038). |
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
| Schema versioning with invalidation and explicit re-download | `confirmed` | The manifest's `schema` field gates use (`assertUsable`); a bump forces an announced full re-download. The local database is a rebuildable cache (D-013) — there is no in-place migration, deliberately. |
| Year-partitioned download with on-demand backfill | `rejected (D-038)` | Would have saved 24.6 MB on a first download in exchange for coverage becoming a thing the whole product reasons about. D-035 had already banked the larger saving. |
| Client-side brotli decompression in WASM, streamed into OPFS | `confirmed` | D-040, D-041. Opaque `.br` chunks decoded and written positionally, so peak memory is the four chunks in flight (D-049) and no intermediary can re-encode. |
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

## AI chat layer

Added 2026-08-01 (D-044, D-045, D-046); tier order revised 2026-08-03 (D-057).
Chat augments the deterministic UI and never replaces it: every surface below
works with no model configured, and the model drives the same report
definitions the fixed UI renders.

| Feature | Status | Notes |
| --- | --- | --- |
| Free-form chat surface translating questions into local queries | `confirmed` | D-044. Owner pivot; the founding severity-over-time question is the design test case. |
| Presentation via shared report definitions | `confirmed` | D-044. Chat emits the same serializable object the UI builds, renders, and shares — one primitive behind UI, chat, and permalinks. |
| Model orchestrates, never transcribes | `confirmed` | D-044. Aggregates may enter model context; row sets travel as handles rendered straight from SQLite. Numbers come from queries, never token sampling. |
| Curated high-level query tools (search, aggregate, CVE detail, KEV) | `confirmed` | D-044. Tight schemas sized for small local models. |
| `SELECT`-only SQL tool for capable models | `confirmed` | D-044. Row-capped, timed out; schema documented in the system prompt. |
| Site-hosted model tier — Ollama behind a restricted same-origin endpoint | `confirmed` | D-057. **First tier to ship (M7).** Server-pinned model (`gemma4:e4b` today), chat completion only, rate- and concurrency-limited, nothing stored, no body logging. The question and tool results transit our server — disclosed at first use. |
| Local in-browser model as the intended default (WASM/WebGPU, weights in OPFS) | `confirmed` | D-045. Explicit download, like the corpus; private and offline. Selection gated on the D-046 benchmark; ships in M8, after the site-hosted tier (D-057). |
| Chrome built-in Gemini Nano tier (Prompt API) | `confirmed` | D-045. Zero setup — no key, no multi-GB download. Integrated and verified in webai (checked 2026-08-01). M8. |
| BYO API key: Gemini, OpenRouter, Anthropic, OpenAI | `confirmed` | D-045. Keys client-side only; traffic browser → provider, never via this server. Each adapter ships only after in-browser CORS verification (RE-010); Gemini's subscription quota rides the ordinary key. M8. |
| Capability tiering above the D-016 floor | `confirmed` | D-045. Base app keeps the D-016 floor; local tier gated on WebGPU/memory, feature-detected. |
| Tool-calling benchmark and per-model scorecard | `confirmed` | D-046. Ground-truth questions scored by data comparison in Playwright against the real corpus; no LLM judge. |
| Network, write, or URL-fetch tools for the model | `rejected (D-044)` | CVE text is attacker-influenced input to the prompt; the tool surface is read-only and render-only, permanently. |
| Consumer-subscription OAuth passthrough | `rejected (D-045)` | Anthropic bans it outright (2026-04-04); risks users' accounts. Google needs no passthrough — quota attaches to the ordinary key. |
| Third-party model proxying, or a bundled provider key | `rejected (D-045)` | Hosted-provider traffic is browser-direct on the user's own key, never via this server. The blanket "no server-side inference" rejection was narrowed by D-057: the site-hosted tier relays to our own model on our own hardware, and nothing else. |

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
| Multi-tab behavior | `confirmed` | Forced by D-004; D-051 chose `opfs`, where a second tab opens and queries the same database. |
| Activity feedback for anything over ~1 s | `confirmed` | D-052. No operation has a duration ceiling, so this is what stands in for one: past a second the app says what it is doing, with real progress where the work is countable. Import has it (M1); queries got it with D-052; sync is M2. |
| Stall detection, distinct from slowness | `confirmed` | D-052. A long download is fine; one that has stopped advancing is a failure and must be reported as one, not left spinning. M2 owns it for the download path. |
| Cancelling a running query | `confirmed` | D-052 makes long queries legitimate, which makes stopping one a requirement rather than a nicety. M3. |
| Browser support floor and capability gating | `confirmed` | An unsupported browser should say so on arrival, not fail deep inside an import. |
| Diagnostics panel (storage used, last sync, record counts, schema version) | `confirmed` | Makes "measure, don't assert" possible for users, and is the only support channel given D-009. |
| Offline app shell (service worker) | `confirmed` | D-048, owner-confirmed 2026-08-01. Caches the shell, Worker, WASM and decoder so an offline *reopen* works — OPFS preserves the data, this preserves the app. **Network-first with cache fallback, never cache-first** (D-054). Never caches `/data/` (the manifest is the freshness signal) or model weights. Lands in M5. |
| Origin rate limiting and abuse metrics | `rejected (D-039)` | There is no endpoint to protect (D-032) and Cloudflare is meant to absorb abuse; per-IP limits behind a proxy would have throttled everyone through a few edge IPs. **Not yet true in production:** `cve.meenan.dev` is not proxied through Cloudflare as of the first deploy, so neither control is in place. M5. |
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
**Q-003. What are the browser-side budgets?** **Answered 2026-08-01 by D-049**
   — as a measured baseline; D-052 declines to turn any of it into a ceiling —
   at full scale: every record in the clone as of 2026-08-01 (372,322 of them;
   the corpus grows daily), 62.7 MB across the wire in 12 chunks expanding to
   376.7 MB, Chromium via Playwright on Linux, from a local server (so transport
   is a floor, not a forecast). Reproduce with `pnpm measure`
   (`tests/e2e/measure.spec.ts`).

   | Stage | Time | Note |
   | --- | --- | --- |
   | Download, elapsed | 7.2 s | fetch + checksum + decompress + write, wall-clock |
   | — of which fetch | 13.8 s | cumulative across four concurrent chunks, so larger |
   | — checksum (SHA-256) | 0.1 s | likewise cumulative |
   | — decompress (WASM brotli) | 1.9 s | likewise |
   | — write to OPFS | 3.2 s | likewise |
   | Open the database | 31 ms | wall-clock |
   | **Build FTS indexes** | **66.1 s** | wall-clock, serial |
   | **Total** | **73.3 s** | wall-clock |

   Semantics caveat (lib/protocol.ts): the indented per-chunk rows are times
   summed across concurrently-running chunks — work, not elapsed time — so they
   exceed the elapsed download they sit under. Only the un-indented rows are
   wall-clock. Throttled to 50 Mbps / 40 ms, the elapsed download is 13.5 s.

   Footprint and memory, same sweep: **441.1 MB in OPFS** (the 376.7 MB
   database plus 64.4 MB of client-built FTS index), **272 MB** of SQLite WASM
   linear memory after import rising to **392 MB** once queries run, and a
   **682–715 MB** peak resident set for the renderer that hosts the Worker —
   measured from the kernel's own high-water mark, because the standardized
   in-page API does not work here (RE-011).

   The slice measurement predicted index building near 95 s by naive scaling;
   it came in at 66 s, and D-035's "progress-bar concern rather than a gate"
   holds — but only because of the page cache (D-050). At SQLite's stock 2 MiB
   the same index build takes **247 s** and the import 255 s.

   Query latency at full scale, warm, over the ten shapes in `lib/queries.ts`:
   **680–954 ms worst across runs (a full scan of the reference tables),
   4–190 ms for everything else.** At the stock page cache the same set runs
   13 ms – 92 s. Reopening with a local copy reports the corpus in 287 ms but
   takes 9.2 s to render the first query, because the page cache starts cold.
   D-049 records all of this as a **baseline, not a set of thresholds** —
   D-052 removed the ceilings entirely. Work takes as long as it takes; what
   the app owes the user is an operation over a second saying what it is doing,
   and a *stalled* operation being distinguishable from a slow one.

   Every cell is one run on one machine (12-core Linux desktop, Chromium 151,
   server on loopback). Index-build time varied 20% across runs that should
   have been identical, so differences smaller than that are not results —
   D-049 says which conclusions clear that bar.
**Q-004. Which OPFS VFS — `opfs` or `opfs-sahpool`?** **Answered 2026-08-01 by
   D-051: `opfs`.** D-030 had already removed the server-config half —
   `cve.meenan.dev` serves COOP/COEP, so both were available — leaving a
   performance and multi-tab trade, measured rather than argued. `opfs-sahpool`
   builds indexes faster (56.4 s vs 66.1 s) and queries indistinguishably, and
   loses on the two things that matter more: a second tab on `opfs` opens the
   existing database and queries it, while on `opfs-sahpool` it stops
   responding entirely; and its only import path (`importDb`) truncates and
   appends sequentially, which cannot express M2's staged, resumable
   replacement. Full reasoning and numbers in D-051.
**Q-005. How is the data plane locked down, and what else must nginx be configured
   to do?** Originally just hardening: `Sec-Fetch-Site` and `Origin` header
   checks, rate limiting, bounded responses — which combination is enforceable
   here, and what it does about non-browser callers that can forge headers
   freely. D-025 shrank it once; **D-032 shrank it again and changed its
   character**: there is no request handler left to harden. What remains is
   nginx configuration over static files — one `root` location serving
   `cve.pub/data/` read-only (D-053 moved it out of `cve.data/`, which is now
   entirely private), cache headers, and no CORS headers as the same-origin control
   (D-034) — with abuse absorbed by Cloudflare rather than origin limits
   (D-039). KEV (D-010) is another static file under the same treatment.
   **Answered by D-034 and D-039.**

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
