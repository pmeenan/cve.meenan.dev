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
| Corpus integrity check | `confirmed` | Shipped in M2. Per-chunk SHA-256 checked before decompression, the chunks proven to cover the byte range exactly, and a promotion gate over the assembled copy (D-061) — so a corrupted chunk refuses the download by name, leaves the live copy untouched, and is refetched on the retry (`tests/e2e/staged.spec.ts`). |
| "N new CVEs since your last sync" summary | `confirmed` | Shipped in M2. Near-free as predicted: `inserts` falls out of the ID-pairing preflight apply already runs (D-063), so a sync reports new CVEs apart from revisions of records the copy already held. |
| Notice carried by every served artifact | `confirmed` | D-008 requires MITRE's copyright designation and license text in any copy; in-band where the format allows. Not discretionary. |
| Scheduled server-side `git fetch` | `confirmed` | D-042. Daily cron under `flock`; monthly snapshot rebuild. Failure leaves the previous generation serving; staleness reaches users through the manifest, not a second channel. |
| Explicit "Download data" action | `confirmed` | D-025, D-026. Cached monthly snapshot (D-042) *plus* every delta since it was taken, so download leaves the client current. **62.6 MB brotli -q10** for the whole corpus (D-035, D-038). Shipped in M2: staged replacement for the snapshot half (D-061), and the download ends by catching up (D-063), so a fresh copy lands at head rather than at `snapshot.rev`. |
| Explicit "Sync" action applying a delta | `confirmed` | D-025. Median day 0.17 MB, busiest observed 0.78 MB — ~574× cheaper than re-downloading. Same apply path as download (D-026). |
| Monthly snapshot rebuild with cached compressed chunks | `confirmed` | D-042, refining D-026. A month of catch-up is ~31 daily deltas and ~2.6 MB against 62.6 MB — about 4%. |
| Merged deltas per watermark range | `confirmed` | D-026, D-031. A range query over per-record revisions returns final state by construction. Daily ingest (D-042) means one file per day and no rollup. |
| Resumable / interruptible download | `confirmed` | D-041, implemented in D-061. A property of the format rather than a feature: independently-compressed 32 MB chunks make resume a bitmap of what is already written. Measured at full scale: an interrupted re-download resumes by fetching 11 of 12 chunks, and the previous copy is untouched throughout. |
| Server-assigned stable IDs for interned lookups | `confirmed` | D-025 hazard 1. Deltas reference CWE/CNA/vendor/product by integer, so the server must own that ID space permanently and ship new lookup rows with the deltas that use them. |
| FTS index maintenance on delta apply | `confirmed` | D-025 hazard 2. External-content FTS5 does not self-update; a missed `'delete'` silently desynchronizes search from the data. |
| Tombstones for removed records | `confirmed` | D-025 hazard 3. Without them an upstream removal persists in every client forever. |
| Visible staleness indicator | `confirmed` | Shipped in M2 (D-064). Reads the data's own build stamp — `meta.generated`, which travels with every delta — so it is an *age*, not a comparison against the origin's head: `status` makes no network request, which is what keeps an offline reopen working (D-048). Past two days it says the copy is behind unless the origin has stopped publishing, and points at Sync. |
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
| CPE applicability | `rejected (D-033, re-confirmed D-070)` | 2.2% at D-033. Re-measured 2026-08-06 by year: 46.0% (2024), 3.9% (2025), 10.2% (2026) — non-monotonic, so a time series through a CPE filter tracks Vulnrichment's backfill, not the corpus. Worse than the original objection, because it looks like a trend. |
| Credits, timeline, solutions, workarounds, exploits | `rejected (D-033)` | 0.3–20.1% prevalence; per-record prose no confirmed aggregate consumes. Re-confirmed by D-070 for the dates question: none of them carries a patch or mitigation *date*, so they cannot answer "public before patched". |
| SSVC decision points (exploitation, automatable, technical impact) | `confirmed (D-070)` | M5. From CISA's Vulnrichment ADP: 48.1% corpus-wide but 91–99% since 2023. `poc` 39,874 / `active` 1,666 — the corpus's only structured exploitation signal. Three small ints; NULL means *not assessed* and is shown as its own band. |
| Reserved date (`dateReserved`) | `confirmed (D-070)` | M5. 100% coverage, one integer. The only date supporting a reserved → published lag. |
| Affected-container `defaultStatus` | `confirmed (D-070)` | M5. A correctness fix, not enrichment: without it `cve_ver` is ambiguous for the 71,421 containers defaulting to `affected`, where listed `unaffected` versions are the *fixed* ones. |
| Per-record title (`cna.title`) | `confirmed (D-070)` | M5. 38.6% overall, 80.2% for 2026. Owner call 2026-08-06: the 2.58 MB compressed is worth it, and not contingent on the build's number. 83.3% of titles are not a substring of their own description — they carry the sink and vulnerability class the prose buries. |
| Rejection reason (`rejectedReasons`) | `confirmed (D-070)` | M5. 0.07 MB compressed. 0% of REJECTED records carry an English description, so D-022's filterable rejected records render blank today. |
| Discovery / mitigation / patch dates | `rejected (D-070)` | Not in the record format. Discovery survives only as `timeline` free text (7.8%, ~1.0% discovery-ish); no dated patch or mitigation field exists at all — a `patch`-tagged reference (2.7%) and a fixed version (31.2%) are both undated. Revision history does not rescue it: the clone is `--depth 1`, and cvelistV5's history would date the CNA's edit, not the vendor's fix. |
| Disclosure-to-catalog lag (`datePublished − cna.datePublic`) | `proposed` | `datePublic` is on 43.9% of published records; median lag 3 days, 6.7% negative (embargo dates filed ahead). One nullable integer. The closest answerable relative of the patch-lag question — not in D-070's bundle; raise if the reporting work wants it. |
| CAPEC, `source.discovery`, `packageName`/`collectionURL`, `cna.tags` | `rejected (D-070)` | 7.3% / 21.6% (but `UNKNOWN` swamps it) / ~6% and CNA-skewed / 1.8%. `cna.tags` is the likeliest to be revisited — `disputed` is a flag, not a filter axis, so it avoids the silent-discard hazard. |
| Interned lookup tables for CWE, CNA, vendor, product | `confirmed` | D-024. 797 CWEs and 479 CNAs replace text repeated across 372k records; the corpus drops 16× to 272.8 MB. |
| Published and last-modified dates | `confirmed` | D-020. Sourced from `cveMetadata.datePublished` / `dateUpdated` in the record JSON — 98.4% / 100% coverage — not from git. |
| Record state (`PUBLISHED` / `REJECTED`) as a queryable column | `confirmed` | D-022. ~4.9% of the corpus is REJECTED; excluded from counts by default, filterable on request. |
| Per-record revision count | `rejected (D-020)` | No confirmed feature queries it, and it was the only consumer of git history. |
| Schema versioning with invalidation and explicit re-download | `confirmed` | Shipped in M3 (D-068). The manifest's `schema` field gates use (`assertUsable`) and a local copy of another version is announced with both numbers, not queried, and **kept** until a download replaces it — D-013 licenses replacing the cache, not deleting it silently. There is no in-place migration, deliberately. `?schema=N` rehearses the bump, which otherwise needs two builds of the app. |
| Year-partitioned download with on-demand backfill | `rejected (D-038)` | Would have saved 24.6 MB on a first download in exchange for coverage becoming a thing the whole product reasons about. D-035 had already banked the larger saving. |
| Client-side brotli decompression in WASM, streamed into OPFS | `confirmed` | D-040, D-041. Opaque `.br` chunks decoded and written positionally, so peak memory is the four chunks in flight (D-049) and no intermediary can re-encode. |
| Query statistics shipped with the artifact | `confirmed` | D-067. `ANALYZE` runs in the build — 21 rows, a few kilobytes — because deriving the same rows in the browser costs 20.4 s of OPFS reads for identical plans. The client falls back to collecting its own only for a generation published without them. |
| Storage quota handling and `navigator.storage.persist()` | `confirmed` | Shipped in M5. Persistence is requested from the Download click (Firefox prompts, and a prompt outside a user gesture is dismissed) and its **answer** is surfaced, not the fact that the call succeeded. A preflight after the manifest budgets **two generations** when a copy is already present — staged replacement holds both (D-061) — so a doomed download is refused up front instead of dying at 90%. An unknown quota proceeds rather than blocking; an evicted copy at reopen is an honest empty origin. |
| Import/export of the whole local database | `rejected (D-013)` | The local database is a rebuildable cache, not a user asset. |

## Search, query & reporting

Bounding the "analytics/reporting tools" scope: candidates qualify only if they
(a) answer a question about the corpus itself, (b) are computable from data the
client already holds, and (c) need no additional network source. Anything
failing (c) is an overlay and is triaged separately below. **This list is closed
as of the 2026-07-30 triage** — additions go through the decision log.

| Feature | Status | Notes |
| --- | --- | --- |
| Search across CVE records | `confirmed` | Stated in the repository description. Shipped in M3: full-text over descriptions plus every filter axis, through one shared query layer (`lib/filters.ts`). |
| Structured filtering (date, severity, CNA, CWE, product) | `confirmed` | The concrete form of "analyzing"; the axes follow from the extraction rows above. **Queryable as of M3** — every axis compiles to bound parameters with D-022's default inside the compiler, and counts by any dimension come from the same predicate. The filtering *UI* is M4; M3 ships a plain form over it. |
| Aggregate reporting and trend views over time | `confirmed` | The main thing a local corpus enables over a search box — the reason the project exists. |
| Charting for report output | `confirmed` | D-073. Aggregates without visualization push users back to a spreadsheet. Hand-rolled SVG, no dependency; severity is an ordinal ramp checked against both themes by test, and every chart ships its numbers as a table. |
| Raw SQL console | `confirmed` | Nearly free given D-004, and the escape hatch for every question the UI did not anticipate. Shipped in M3 (D-065): read-only by SQLite authorizer rather than by inspecting the text, capped at 1,000 rows, and cancellable. |
| Saved queries and query history | `confirmed` | D-072. Analysis is iterative; losing a refined query on reload is a real cost. In `localStorage`, never in the SQLite copy — that copy is a rebuildable cache a schema bump destroys (D-013, D-068). |
| Shareable query/report permalinks (query only, never data) | `confirmed` | Supports vision criterion 6 while preserving the privacy property. |
| Export result sets (CSV / JSON) | `confirmed` | D-071. Makes the tool a step in a workflow rather than a dead end. Exports are "copies" under D-008, so the notice travels with them — a writer cannot be built without one. Whole match set to a disclosed 50,000-record cap, formula injection neutralized, control characters stripped. |
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
| CISA KEV overlay | `built (M6)` | D-010; terms and wire shape in D-076 — CC0 1.0, no notice owed. 1,662 entries / 1,577,762 bytes, updated ~business-daily (re-fetched 2026-08-08, byte-identical from both sources). Still sends no CORS header, so it routes through the existing server; CISA's own `cisagov/kev-data` mirror is the sanctioned server-side fallback and was exercised. Membership and ransomware use are filter axes *and* report dimensions, `dateAdded`/`dueDate` are date ranges, and the complement is a labelled bucket rather than an absence band. |
| EPSS score overlay | `rejected (D-010)` | Daily-changing scores across the whole corpus — a recurring sync problem for a secondary signal. |
| NVD enrichment overlay | `rejected (D-010)` | Would mean operating a second mirror; rate limits make client-side full-corpus enrichment impractical. |

## Operations & resilience

| Feature | Status | Notes |
| --- | --- | --- |
| Rsync deploy from `dist/` | `confirmed` | D-003. |
| Multi-tab behavior | `confirmed` | Shipped in M5 as **full support** (owner decision 2026-08-08), not honest degradation. Forced by D-004; D-051 chose `opfs`, where a second tab opens and queries the same database. One writer at a time via a Web Lock, `ifAvailable`, and the refused tab is told *which* operation is running and keeps querying. A promotion is announced on a `BroadcastChannel` so a tab that did not perform the replacement reopens rather than answering from a generation nobody else can see. |
| Activity feedback for anything over ~1 s | `confirmed` | D-052. No operation has a duration ceiling, so this is what stands in for one: past a second the app says what it is doing, with real progress where the work is countable. Import has it (M1); sync reports the revision it is applying and how far through the chain it is (M2); a running query reports its elapsed time from inside SQLite and can be stopped (M3, D-066). |
| Stall detection, distinct from slowness | `confirmed` | Shipped in M2 (D-064). The signal is bytes received, not elapsed time: sixty seconds without one aborts the transfer and says it stalled *rather than being slow*; the local copy is untouched and the staged chunks are still worth resuming. Covers the download and the delta fetches — a query is synchronous in the Worker, and cancelling one is M3. |
| Cancelling a running query | `confirmed` | Shipped in M3 (D-066). D-052 makes long queries legitimate, which makes stopping one a requirement rather than a nicety. SQLite's progress handler reads a `SharedArrayBuffer` the page writes — the only channel that reaches a Worker sitting inside SQLite — and aborts the statement. Where cross-origin isolation is missing the UI says so instead of offering a dead button. |
| Browser support floor and capability gating | `confirmed`, **Safari half unverified** | Shipped in M5 (D-016). Chromium and Firefox run the whole suite; **Playwright's Linux WebKit ships no OPFS at all**, so the Safari half of the floor rests on documented feature availability plus the gate rather than on a run (RE-022). That engine was **removed from the project list** on 2026-08-08 rather than kept and skipped: a project contributing only skips is indistinguishable from a passing one in a summary line, which is how RE-024 stayed hidden. The cost is that no engine in the suite now fails the gate for real — it is exercised only through the forced `?probe=` knob. The probe *calls* a synchronous method and reads what came back, because Safari 15.2–16.3 has `createSyncAccessHandle` and returns Promises from the handle's methods — so every interface check passes and the import dies inside WASM. The gate runs before the manifest, names the specific missing capability *and* the floor, and says nothing was fetched or changed. |
| Diagnostics panel (storage used, last sync, record counts, schema version) | `confirmed` | Makes "measure, don't assert" possible for users, and is the only support channel given D-009. |
| Offline app shell (service worker) | `confirmed` | Shipped in M5. D-048, owner-confirmed 2026-08-01. Caches the shell, Worker, WASM and decoder so an offline *reopen* works — OPFS preserves the data, this preserves the app. **Network-first with cache fallback, never cache-first** (D-054). `/data/` is not merely absent from the precache list: the worker returns without calling `respondWith` for it, so no later branch can reach one of those URLs. Generated from the finished export by `scripts/build-sw.mjs`, versioned by a content hash — a hand-written precache list would silently stop matching Turbopack's chunk names. |
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
   | — write to OPFS | 3.2 s | likewise. **Pre-D-061**: staged replacement adds a `flush()` and a bitmap write per chunk, taking this to 4.7 s. |
   | Open the database | 31 ms | wall-clock |
   | **Build FTS indexes** | **66.1 s** | wall-clock, serial. **Pre-M2**: the build now walks the rowid space in batches so it can report progress through this minute (D-052), which costs about 1% — 58.0/58.3/58.4 s against `'rebuild'`'s 57.3/57.6/57.8 s, three runs each in one later session on this machine. |
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

   **M4's cross-tabs, same corpus and cache** (`tests/e2e/measure.spec.ts`, case
   `M4 report shapes`, 2026-08-07), warm: **116 ms – 1.35 s across the nine
   report shapes the UI offers**, the slowest being reference host × severity.
   Cold, 0.4–13.0 s, which is the page cache filling. Two of those shapes were
   **42 s** until D-074 pinned the link-table join order — a regression
   statistics introduce and the development slice cannot show.

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

   **Re-measured for M3** (2026-08-05, artifact rev 2, same machine and
   session). The rows above were recorded against rev 1 a month earlier, so the
   milestone's "no regression" claim is against a baseline re-run *beside* the
   new numbers rather than against them — `?analyze=0&ops=0` reproduces M1's
   behaviour, and `tests/e2e/measure.spec.ts` carries all three as `m3:*` cases.

   | | import | index build | reference-hosts | cwe-top | everything else |
   | --- | --- | --- | --- | --- | --- |
   | M1 behaviour | 64.6 s | 58.6 s | 605 ms | 88 ms | 5–158 ms |
   | + progress handler (D-066) | 64.3 s | 58.3 s | 608 ms | 86 ms | 5–152 ms |
   | + statistics in the artifact (D-067) | 64.9 s | 58.7 s | **398 ms** | **60 ms** | 5–176 ms |

   Two conclusions clear the noise bar. The progress handler that makes every
   query report itself and be cancellable costs **nothing measurable** — every
   shape lands within ±5%, in both directions. And query statistics cut the
   slowest shape by a third and the CWE aggregate by 30%, at **no cost to the
   import**, because they are collected on the server rather than in the
   browser; deriving them locally was measured at 20.4 s and every cheaper
   variant of that either cost the same or picked a worse plan (D-067).

   Reopening with a local copy, same session: **3.4 s** to report the copy and
   **11.3 s** to rendered results, against M1's 287 ms / 9.2 s. The query itself
   got *faster* (7.9 s against 8.9 s); what grew is discovery, which M2 changed
   — staged replacement opens each slot to decide which is live (D-061), where
   M1 opened one file by name. Tracked, not gated (D-052 §4); M5's diagnostics
   work is where it becomes visible to a user.
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
