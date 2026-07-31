# Plan

**This is a living document.** Milestones will be re-scoped, re-ordered, split,
or added as planning conversations and findings come in. That churn is
expected; what is *not* allowed is silent change. Scope changes get a
decision-log entry; progress is reflected here by checking boxes and updating
status lines as work lands.

Check a box only when the item is done and verified; partially done items stay
unchecked, optionally with a note.

**Status legend:** `pending` · `in progress` · `done` · `parked`

## M0 — Plan the plan  `in progress`

Goal: turn the initial feature list into a settled vision, feature matrix,
architecture, and milestone ladder — through planning conversations with the
project owner plus targeted research and spikes where a decision needs evidence.

- [x] Repo scaffolding for the AI-directed workflow (this scaffold), including
      the CORS and repository-size measurements that forced D-005 and D-006.
- [x] **Feature triage.** First full pass ran 2026-07-30; the significant calls
      are D-009 through D-013. Two open questions closed (telemetry, and the
      terms question already closed by D-008), and D-011 narrowed the
      data-delivery question from three candidates to two. The four rows it left
      gated were resolved by D-025, so every ledger row is now settled.
- [x] **Provision the corpus on `plex`.** Shallow clone at
      `/var/www/meenan.dev/cve.data/git/cvelistV5` (D-018, D-021) — 68 s,
      280.55 MiB pack, 372,092 records at `a42a2eb6c2`. Verified `cve.data/` is
      not web-reachable. Measured corpus facts are in
      [architecture.md](architecture.md); the "~300k records" figure used in
      earlier planning was low, and the corpus is 2,934 MB of raw JSON. Initially
      provisioned blobless with full history, then re-provisioned shallow once
      D-020 removed the only consumer of that history.
- [x] **Spike: normalization.** Built the normalized artifact against the full
      corpus (D-024, D-023): 2,934 MB of raw JSON becomes a 272.8 MB queryable
      database, 98.7 MB gzipped, in a 19 s build. Measured delta economics too —
      median day 0.17 MB gzipped against a 98.7 MB full download. Together these
      resolved Q-001 without needing the planned bake-off: the owner
      chose bulk import with explicit Download and Sync actions (D-025).
- [ ] **Design: the delta protocol.** The main remaining design problem, and the
      one most likely to be underestimated. Settle the watermark (server-assigned
      content-hash sequence versus CNA-supplied `dateUpdated`), the delta format,
      tombstones for removed records, and how schema-version changes force a full
      re-download. Must address the four hazards enumerated in D-025 — stable
      server-owned lookup IDs, FTS5 external-content maintenance, tombstones, and
      non-destructive apply. Answers Q-001.
- [ ] **Decide: schema completeness.** What goes in beyond the D-024 floor —
      references (and FTS over them, per D-011), affected version ranges, CPE
      applicability, solutions, credits, timeline. Every addition grows the
      download every user takes, so re-measure the artifact after deciding.
      Answers Q-002.
- [ ] **Spike: browser-side budgets.** Import the full artifact in a real
      browser under Playwright and measure what server hardware could not:
      wall-clock to usable, peak memory, OPFS footprint, and query latency under
      WASM for the owner's motivating query and a full-text search. This is what
      confirms or breaks D-025. Answers Q-003 and gives vision criteria
      1 and 3 real numbers.
- [ ] **Spike: OPFS VFS selection.** Test `opfs` and `opfs-sahpool` against a
      corpus-scale database, including what nginx must send for COOP/COEP and
      what a second tab does under each. Answers Q-004.
- [ ] **Spike: endpoint hardening.** Determine what same-origin enforcement is
      achievable in this nginx/PHP setup, with a working demonstration of both
      the allowed path and a blocked cross-origin attempt, plus rate limiting.
      Smaller than originally scoped — D-025 makes the full artifact a static
      file, leaving only the delta endpoint's watermark parameter to validate.
      Answers Q-005.
- [x] **Research: corpus redistribution terms.** Confirmed against the terms
      source on 2026-07-30 — permissive grant, single notice obligation. Recorded
      as D-008; the resulting attribution surfaces are `proposed` rows for
      triage.
- [x] **Research: browser support floor.** Chrome/Edge 108+, Firefox 111+,
      Safari 16.4+ — from MDN browser-compat-data, not recollection. The floor is
      set by the *synchronous* forms of the sync-access-handle methods, which
      shipped later than the interface itself. Recorded as D-016.
- [x] **Toolchain decisions.** React 19 on Next.js 16 static export, TypeScript 7
      strict, Vitest + Playwright, ESLint + Prettier, pnpm, plain PHP 8.4. UI
      components restricted to OSS licenses. All licenses verified MIT or
      Apache-2.0. Recorded as D-017, then D-027 and D-028 after the owner
      revisited the UI framework — bundle size deprioritized in favour of
      framework richness and SSG.
- [ ] First full draft of [architecture.md](architecture.md), replacing the
      current skeleton.
- [ ] Rewrite the provisional ladder below into real milestones with exit
      criteria.

**Exit criteria:** every checklist item above is checked; every `proposed` row
in features.md is resolved **and every features.md open question answered**,
with decision-log entries for the significant calls; architecture.md first
draft reviewed; toolchain decided; M1+ milestones have scopes and exit
criteria. Nothing on this list is optional — M0 is not done while any item
above remains open.

## Provisional milestone ladder  `pending — to be rewritten in M0`

Ordered by risk: platform substrate and one working end-to-end path before
breadth. Sketch only — do not start work from these entries. They freely
reference `proposed` features.md rows, and nothing here pre-empts the M0 triage.

- **M1 — Scaffolding and one honest end-to-end path.** Toolchain, strict
  compiler settings, tests, license audit, and the rsync deploy script — plus
  the smallest change that exercises the riskiest substrate for real: server-side
  clone → whatever delivery mechanism M0 picked → a WASM SQLite database on
  OPFS → one query rendered in the UI, carrying the D-008 notice. Deliberately
  narrow and deliberately complete, so every layer is proven before anything is
  built on it.
- **M2 — Ingest at full scale.** Bulk import across the whole corpus (D-025):
  the Download action with progress, resumption, and integrity checking; the
  Sync action with the delta protocol and its four hazards; the server-side
  fetch job and artifact build. Ends with the corpus reliably reachable from a
  browser and staying current.
- **M3 — Schema and query.** The real schema: CVSS, CWE, CPE, and product
  extraction into queryable columns, full-text search, indexing tuned against
  measured query latency, schema versioning and migration, and the raw SQL
  console.
- **M4 — Analysis and reporting.** Structured filtering UI, aggregate and trend
  reporting, charting, saved queries, shareable query permalinks, and result
  export. This is where the tool becomes worth the import.
- **M5 — Resilience and public launch.** Storage quota and eviction handling,
  multi-tab behavior, browser capability gating, the diagnostics panel, endpoint
  rate limiting and an adversarial pass over the endpoint, then launch.
- **M6 — CISA KEV overlay.** The only overlay that survived triage (D-010).
  Server-side fetch and cache, joined to the corpus client-side. Small and
  self-contained, which is why it can sit last without blocking anything.
