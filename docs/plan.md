# Plan

**This is a living document.** Milestones will be re-scoped, re-ordered, split,
or added as work and findings come in. That churn is expected; what is *not*
allowed is silent change. Scope changes get a decision-log entry; progress is
reflected here by checking boxes and updating status lines as work lands.

Check a box only when the item is done and verified; partially done items stay
unchecked, optionally with a note.

Per D-029, open questions may cross milestone boundaries so long as they stay
recorded — a milestone closes on what it can honestly settle, not on everything
it touched.

**Status legend:** `pending` · `in progress` · `done` · `parked`

## M0 — Plan the plan  `done`

Goal: settle vision, feature matrix, architecture, and the milestone ladder,
through planning conversations plus targeted research where a decision needs
evidence.

- [x] Repo scaffolding for the AI-directed workflow, including the CORS and
      repository-size measurements that forced D-005 and D-006.
- [x] **Feature triage.** All 55 ledger rows resolved (D-009 – D-013, D-025).
- [x] **Provision the corpus on `plex`.** Shallow clone at
      `cve.data/git/cvelistV5` (D-018, D-021) — 68 s, 280 MiB pack, 372,092
      records. Measured corpus facts in [architecture.md](architecture.md).
- [x] **Spike: normalization.** 2,934 MB of raw JSON → a 272.8 MB queryable
      database, 72.1 MB brotli, built in 19 s (D-023, D-024). Delta economics
      measured alongside: median day 0.17 MB.
- [x] **Settle the data-delivery architecture.** Bulk import with explicit
      Download and Sync, snapshot rebuilt weekly with catch-up deltas
      (D-025, D-026).
- [x] **Research: corpus redistribution terms.** Permissive grant, single notice
      obligation (D-008).
- [x] **Research: browser support floor.** Chrome/Edge 108+, Firefox 111+,
      Safari 16.4+ (D-016).
- [x] **Toolchain decisions.** React 19 on Next.js 16 static export, TypeScript
      strict, Vitest + Playwright, ESLint + Prettier, pnpm, plain PHP 8.4;
      OSS-only UI components (D-017, D-027, D-028).
- [x] **Research: server configuration baseline.** Read from `plex` — brotli
      modules loaded, COOP/COEP already served, php-fpm as `pmeenan` (D-030).
      Answers most of Q-005.
- [x] **Design: the delta protocol.** Server-assigned revisions over per-record
      content hashes, whole-record JSON merged by range query, applied in one
      idempotent transaction (D-031) — measured against a real 21.4-hour
      upstream window rather than designed on paper. D-025's four hazards and
      D-026's three additions are all discharged. Answers Q-001, and led to
      D-032: the data plane is static files with no request handler.
- [x] **Decide: schema completeness.** Version ranges and references in, five
      sections out, FTS over references replaced by host interning (D-033,
      amending D-011). Every candidate was built against the full corpus and
      priced in compressed bytes. Answers Q-002. Superseded in part the same
      week by D-035, which moved index building to the client and took the
      download to **62.6 MB at brotli -q10**.
- [x] **Design: data-plane hardening.** One nginx location, no CORS headers as
      the actual same-origin control, immutable cache policy, and integrity
      hashes in the manifest — with `Sec-Fetch-Site` blocking rejected as
      theater (D-034) and origin rate limiting since removed in favour of
      Cloudflare (D-039). Closes Q-005.
- [x] **First full draft of [architecture.md](architecture.md)**, replacing the
      skeleton: overview, server pipeline, published contract, client, schema
      DDL, trust boundaries, failure modes, and every measurement in one place.

**Exit criteria met 2026-08-01:** every item checked, decision entries recorded
for the significant calls (D-001 – D-042), and architecture.md's first full
draft reviewed and accepted by the project owner. Per D-029, Q-003 and Q-004
were **not** M0 exit criteria — they need a running browser and are answered
here in M1.

## M1 — Scaffolding, one end-to-end path, and the browser measurements  `in progress`

The smallest change that exercises every risky layer for real, plus the two
deferred measurements. Deliberately narrow and deliberately complete.

Scope: Next.js 16 + React 19 project with `output: 'export'`, `distDir: 'dist'`,
`trailingSlash: true` (D-027, D-030); TypeScript strict, Vitest, Playwright,
ESLint + Prettier, pnpm; license-audit script (D-002); `rsync` deploy script;
the nginx changes from D-030 and D-034 (`trailingSlash`, and the `^~ /data/`
location aliasing `cve.data/pub/`), plus the Cloudflare cache rules honoring
origin headers (D-039); a **bounded slice** of the
corpus published there as a static file; SQLite/WASM in a Worker persisting to
OPFS; one query rendered in the UI carrying the D-008 notice.

- [x] **Scaffolding.** Next.js 16 + React 19 static export, TypeScript strict,
      Vitest, Playwright, ESLint, Prettier, pnpm, license audit, deploy script,
      and a local server that reproduces production headers. `pnpm check` and
      `pnpm e2e` both green.
- [x] **The pipeline's first half** (D-043): `schema.sql`, `normalize.py`,
      `build.py`, `publish.py`. Produces the bounded slice — 39,196 records for
      2026, 51.9 MB expanding from 9.9 MB in 2 chunks.
- [x] **The end-to-end path.** Manifest → chunked fetch → WASM brotli →
      positional OPFS writes → client-built FTS → a real aggregate rendered with
      the D-008 notice, covered by one Playwright test.
- [x] **Q-003, first numbers.** Recorded in [features.md](features.md).
      Transport is a rounding error; **index building is 91% of import**.
- [x] Confirmed Next copies `public/` into the export root — closes D-027's
      open caveat.
- [ ] **Q-003 at full scale.** The slice is a tenth of the corpus. Needs the
      full artifact: import wall-clock, peak memory, OPFS footprint, query
      latency, and how many chunks to decompress concurrently (D-041).
- [ ] **Q-004:** `opfs` vs `opfs-sahpool`. The `opfs` VFS works; the comparison
      and multi-tab behaviour are unmeasured.
- [ ] **Deploy.** nginx `^~ /data/` location, Cloudflare cache rules, first
      rsync to `cve.meenan.dev`.

**Exit criteria:** the deployed site loads from `cve.meenan.dev`, fetches the
published chunks, decompresses them itself, writes them into OPFS, and renders
one real query result; Q-003 numbers recorded and vision criteria 1 and 3 given
real budgets; Q-004 decided and recorded; checks run green in CI-equivalent
form. **Locally green as of 2026-08-01**; what remains is full-scale
measurement, Q-004, and the deploy.

## M2 — Full-corpus Download and Sync  `pending`

Scope: the two cron jobs (daily ingest, monthly chunked snapshot) under `flock`
with the tombstone guard, atomic publish, and one-generation retention (D-042);
the D-031 delta generator; the Download action fetching snapshot chunks and
catch-up deltas, decompressing each in WASM and writing it positionally into
OPFS, resumable by chunk bitmap (D-040, D-041); client-side construction of the
full-text indexes over descriptions, vendors and products (D-035), surfaced in
the same progress display; the Sync action applying merged deltas
non-destructively; FTS maintenance verified with `integrity-check` at
`rank = 1` (RE-005); the visible staleness indicator.

**Exit criteria:** a browser downloads all 372,092 records, decompresses them
itself, builds its indexes, and queries the result — with one honest progress
display across all three stages, and peak memory bounded by chunks in flight
rather than by the corpus; the database is verified identical to a freshly built
one; a sync applies a real day of upstream changes; killing the download partway
and resuming refetches only the missing chunks; an interrupted sync leaves a
usable prior state and re-running is safe; a snapshot rotation during a download
does not strand the client.

## M3 — Schema and query  `pending`

Scope: the full schema from Q-002 — CVSS v2/v3.x/v4, CWE, CPE, vendor/product,
references; FTS5 over descriptions and references (D-011, D-023); schema
versioning and migration; indexing tuned against measured latency; the raw SQL
console.

**Exit criteria:** every confirmed filter axis is queryable; query latency meets
the budget set in M1; a schema-version bump triggers a correct re-download.

## M4 — Analysis and reporting  `pending`

Scope: structured filtering UI, aggregate and trend reporting, charting, saved
queries and history, shareable query permalinks, CSV/JSON export carrying the
D-008 notice.

The serializable report definition behind permalinks is now also the contract
the AI chat layer emits (D-044) — design it here as a shared primitive, not a
permalink implementation detail.

**Exit criteria:** the owner's motivating question — counts by vendor, product,
and severity over the last two years (D-046 benchmark item #2) — is answerable
entirely through the UI,
charted and exportable, with REJECTED records excluded by default (D-022).

## M5 — Resilience and public launch  `pending`

Scope: storage quota and eviction handling, multi-tab behavior per the Q-004
outcome, browser capability gating against the D-016 floor, the diagnostics
panel (the only support channel, given D-009), and an adversarial review pass
over the published data plane.

**Exit criteria:** the app degrades honestly on an unsupported browser, under
quota pressure, and in a second tab; the data plane survives an adversarial pass;
public launch.

## M6 — CISA KEV overlay  `pending`

Scope: server-side KEV fetch and cache (D-010), joined to the corpus
client-side. Small and self-contained, which is why it sits last without
blocking anything.

**Exit criteria:** KEV status is a queryable, filterable attribute, and its
staleness is surfaced separately from the corpus's.

## M7 — AI chat layer: tool surface, hosted providers, benchmark  `pending`

The chat loop proven with strong models first, so tool-surface problems are
never mistaken for model-quality problems. Depends on M4's report definitions
and, for the KEV tool, on M6.

Scope: the chat surface; the read-only tool surface over report definitions —
curated high-level tools plus the `SELECT`-only SQL tool (D-044); provider
adapters for user-supplied keys — Gemini, OpenRouter, Anthropic, OpenAI — with
keys stored client-side only and in-browser CORS verified per provider
(D-045); the D-046 benchmark harness with ground-truth questions, the owner's
severity-over-time question first.

**Exit criteria:** with a hosted key, the founding question — stacked CVE
counts by severity over time, all products and per-product (D-046 benchmark
item #1) — is answered end-to-end through chat, rendering via the fixed UI
with the backing queries inspectable; the benchmark runs against at least two
hosted providers and produces a scorecard; a network-panel check confirms chat
traffic goes only browser → provider and keys never reach `cve.meenan.dev`;
and an adversarial pass feeds hostile records — markup, injection payloads,
hostile URLs — through the chat path and shows containment: nothing beyond
the read-only tool surface is reachable, and no record-supplied markup or URL
renders outside the fixed UI's existing treatment.

## M8 — Local model tier  `pending`

The differentiator: AI analysis that never leaves the machine. Gated on M7's
benchmark, which is what selects the model.

Scope: in-browser inference (WASM/WebGPU) with weights downloaded from Hugging
Face into OPFS on explicit user action, lifting webai's acquisition and runtime
plumbing as prior art; Chrome built-in Gemini Nano via the Prompt API as the
zero-setup tier; capability gating for the local tier above the D-016 base
floor; benchmark-driven model shortlist with weight licenses checked
deliberately (D-045, D-046); and the storage story for multi-gigabyte weights —
quota, eviction, and the guarantee that a weight download can never evict the
corpus (weights are D-013-style rebuildable cache).

**Exit criteria:** a shortlisted local model answers the benchmark's core
questions correctly with the network disconnected (corpus and weights already
local); Gemini Nano works where Chrome offers it and degrades honestly where
it does not; an unsupported browser is told at the gate, not mid-download; the
benchmark scorecard for local candidates is recorded and the default model
choice is justified from it.
