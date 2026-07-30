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
- [ ] **Feature triage.** Walk [features.md](features.md) with the owner; promote
      or reject every `proposed` row; answer every open question; record the
      significant calls in [decisions.md](decisions.md).
- [ ] **Spike: data-delivery architecture bake-off.** Build all three candidates
      from features.md open question 1 end to end against real data — (a) bulk
      import, (b) projection API, (c) range-request VFS with an OPFS-persisted
      page cache. Use one realistic exploration as the common benchmark, e.g.
      *counts by vendor, product, and severity over the last two years*, then a
      drill-down that widens the working set. Output per candidate: bytes
      transferred cold and warm, wall-clock to first useful result, peak browser
      memory, OPFS footprint, query latency, and an honest note on implementation
      complexity. Answers open questions 1, 3, and 4, and gives success criteria
      1 and 3 in [vision.md](vision.md) real numbers instead of placeholders.
- [ ] **Owner decision: the privacy envelope.** Given what the bake-off shows
      each candidate leaks to the server, decide where the acceptable line sits.
      Predicate pushdown is out by D-007; field sets, partition ranges, and page
      access patterns are the live question. Record in
      [decisions.md](decisions.md). Answers open question 2.
- [ ] **Spike: OPFS VFS selection and composition.** Test `opfs` and
      `opfs-sahpool` against a corpus-scale database, including what nginx must
      send for COOP/COEP and what a second tab does under each. If candidate (c)
      survives, also determine how a range-request VFS and OPFS persistence
      compose. Answers open question 5.
- [ ] **Research: cache correctness and invalidation.** How the client stays
      correct as upstream changes: the sync watermark under (a), and under
      (b)/(c) whether an artifact rebuild invalidates every cached page — plus
      what stable layout, immutable partitions, or versioned artifacts cost.
      Answers open question 6. This is the piece most likely to be
      underestimated.
- [ ] **Spike: ingest endpoint hardening.** Determine what same-origin
      enforcement is actually achievable in this nginx/PHP setup, with a working
      demonstration of both the allowed path and a blocked cross-origin attempt,
      plus a rate-limiting approach. Scope depends on candidate: (c) needs far
      less endpoint than (a) or (b). Answers open question 7.
- [x] **Research: corpus redistribution terms.** Confirmed against the terms
      source on 2026-07-30 — permissive grant, single notice obligation. Recorded
      as D-008; the resulting attribution surfaces are `proposed` rows for
      triage.
- [ ] **Research: browser support floor.** Establish the minimum browser set
      from OPFS and WASM requirements, verified against current compatibility
      data. Answers open question 9.
- [ ] First full draft of [architecture.md](architecture.md), replacing the
      current skeleton.
- [ ] **Toolchain decisions:** UI framework (deliberately left open at kickoff),
      build system, test stack, lint/format, license audit automation, and the
      deploy script. Record in [decisions.md](decisions.md).
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
- **M2 — Ingest at full scale.** The chosen delivery architecture working across
  the whole corpus: progress and interruption handling, integrity checking, the
  update protocol and cache invalidation, and the server-side fetch job and
  artifact cache. Ends with the corpus reliably reachable from a browser and
  staying current. Shape depends entirely on the M0 bake-off.
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
- **M6+ — Enrichment overlays, if triaged in.** KEV, EPSS, or NVD, each gated on
  its own CORS, licensing, and sync answers. Explicitly last: every overlay adds
  a network dependency to a tool whose value proposition is not needing one.
