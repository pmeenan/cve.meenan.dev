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
- [x] **Design: data-plane hardening.** One nginx location, no CORS headers
      as the actual same-origin control, connection and rate limits, immutable
      cache policy, and integrity hashes in the manifest — with `Sec-Fetch-Site`
      blocking explicitly rejected as theater (D-034). Closes Q-005.
- [x] **First full draft of [architecture.md](architecture.md)**, replacing the
      skeleton: overview, server pipeline, published contract, client, schema
      DDL, trust boundaries, failure modes, and every measurement in one place.

**Exit criteria:** every item above is checked, with decision-log entries
for the significant calls; architecture.md's first full draft is reviewed. Per
D-029, Q-003 and Q-004 are **not** M0 exit criteria — they need a running
browser and are answered in M1.

## M1 — Scaffolding, one end-to-end path, and the browser measurements  `pending`

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

- Q-003: import wall-clock, peak memory, OPFS footprint, and WASM query
  latency. Index build time is measured too, but the owner has ruled it a
  progress-bar concern rather than a gate (D-035). The open tuning question is
  how many chunks to decompress concurrently (D-041).
- Q-004: `opfs` vs `opfs-sahpool` — now a pure performance and multi-tab
  question, since D-030 confirmed COOP/COEP are already served.
- Confirm Next copies `public/` into the export root, per D-027's open caveat.

**Exit criteria:** the deployed site loads from `cve.meenan.dev`, fetches the
published slice, stores it in OPFS, and renders one real query
result; Q-003 numbers recorded and vision criteria 1 and 3 given real budgets;
Q-004 decided and recorded; checks run green in CI-equivalent form.

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

**Exit criteria:** the owner's motivating question — counts by vendor, product,
and severity over the last two years — is answerable entirely through the UI,
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
