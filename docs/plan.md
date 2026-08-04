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

Milestones are decomposed into task-sized checkboxes (the workflow's unit of
work) no later than when they become the next milestone up — M2 is decomposed
now; M3+ carry scope prose and exit criteria until their turn, and get their
checkbox breakdown before work starts.

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
      (D-025, D-026 — the cadence became monthly in D-042).
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

## M1 — Scaffolding, one end-to-end path, and the browser measurements  `done`

The smallest change that exercises every risky layer for real, plus the two
deferred measurements. Deliberately narrow and deliberately complete.

Scope: Next.js 16 + React 19 project with `output: 'export'`, `distDir: 'dist'`,
`trailingSlash: true` (D-027, D-030); TypeScript strict, Vitest, Playwright,
ESLint + Prettier, pnpm; license-audit script (D-002); `rsync` deploy script;
the nginx changes from D-030 and D-034 (`trailingSlash`, and the `^~ /data/`
location serving `cve.pub/data/`, D-053), plus the Cloudflare cache rules honoring
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
- [x] **2026-08-01 external review, highest-priority fixes (D-047).** CVSS
      version preference corrected — v3.1 no longer beats v4.0 (stored codes
      31 > 4 were compared numerically), regression-tested in
      `pipeline/tests/`, now part of `pnpm check`; canonical D-008 notice with
      the copyright designation and license clause, asserted in unit and e2e
      tests against a rebuilt fixture; real SPDX `AND`/`OR` evaluation in the
      license audit with exceptions bound to their reviewed license; builds
      fail closed on malformed records; published generations immutable;
      `PRAGMA query_only` on the Worker's query path (first defense — the
      structural authorizer is M3).
- [x] **Q-003 at full scale (D-049).** The whole corpus: 73.3 s import
      (66.1 s of it building indexes), 682–715 MB peak RSS, 441 MB in OPFS,
      ~850 ms worst query and 4–190 ms for the rest. Vision criteria 1 and 3
      now carry real numbers, with their caveats — resource ceilings for
      memory and footprint, and a recorded baseline rather than a ceiling for
      query latency (owner decision). D-041's open number is
      settled at four chunks in flight — decided on throttled transport,
      because loopback cannot tell the settings apart. The sweep is re-runnable
      (`pnpm measure`, `tests/e2e/measure.spec.ts`) and writes
      `measurements/measurement.md`.
- [x] **D-050, found by that sweep.** SQLite's stock 2 MiB page cache made
      eight of ten benchmark queries take over a second — one of them 92 s —
      and index building 247 s; 256 MiB puts all ten under a second and cuts
      index building to 69 s, for ~150 MB of peak memory. Every Q-003 number
      depends on it.
- [x] **Q-004 (D-051):** `opfs`, not `opfs-sahpool`. The pool builds indexes
      faster and then freezes any second tab entirely, and its `importDb`
      cannot express M2's resumable staged replacement. Both paths stay in the
      Worker so the comparison can be re-run.
- [ ] **Deploy.** *Partially done 2026-08-01 — two steps need credentials the
      agent does not have.*
      - [x] First generation published by the real pipeline (now at
            `cve.pub/data/`, D-053):
            372,322 records, 12 chunks, 62.7 MB, built from clone `d300c5fcc0`.
      - [x] First `rsync` of `dist/` to the docroot. `https://cve.meenan.dev/`
            serves the app with COOP/COEP and `no-cache` on HTML.
      - [x] **Data layout settled** (D-053): published artifacts moved out of
            `cve.data/` to their own peer `cve.pub/`, so nothing under
            `cve.data/` is web-reachable.
      - [x] **nginx `/data/` locations** (owner-applied; the block is in
            [architecture.md](architecture.md)). Verified against the live
            origin: manifest `no-cache`, chunks `immutable`, COOP/COEP/CORP on
            both, **no** `Access-Control-Allow-Origin` even when an `Origin` is
            sent, no directory listing (403), `.php` under `/data/` not
            executed (404), and `cve.data/` unreachable by traversal — raw,
            encoded, and via the parent — repeating D-018's canary check
            against the new layout.
      - [x] **`.mjs` MIME type** (owner-applied). The stock nginx `mime.types`
            has no `.mjs`, so the Worker's runtime import of the SQLite
            distribution was refused by the browser's module MIME check and the
            database never opened. `scripts/serve.mjs` had masked it by being
            more permissive than production — RE-012.
      - [x] **Full-corpus import verified against the deployed origin**: 71.9 s
            total, 64.8 s of it index building, 441.1 MB in OPFS, query
            rendered, notice present, survives a reload. Elapsed transport
            ~7.1 s — indistinguishable from loopback, because this client and
            the origin share a fast path, so it neither confirms nor disturbs
            the throttled numbers in D-049.
      - [→] **Cloudflare cache rules** (D-039) — **moved to M5.** Measured
            2026-08-01: `cve.meenan.dev` resolves straight to the origin and no
            response carries a `cf-ray`, so the domain is not proxied through
            Cloudflare at all and there is nothing to configure yet. Until it
            is, D-039's premise that Cloudflare absorbs abuse does not hold and
            D-034's origin rate limiting is already gone — so the origin is
            currently unprotected. Tracked as an M5 scope item and exit
            criterion.

**Exit criteria — met 2026-08-01.** The deployed site loads from
`cve.meenan.dev`, fetches the published chunks, decompresses them itself,
writes them into OPFS, and renders one real query result — verified by running
`tests/e2e/import.spec.ts` against the live origin, not just locally. Q-003 and
Q-004 are answered (D-049 – D-051), vision criteria 1 and 3 carry real numbers,
and `pnpm check` / `pnpm e2e` are green. The one item deliberately left open is
Cloudflare (below): it is not in the request path at all, which is M5's problem
rather than a gap in this milestone.

## M2 — Full-corpus Download and Sync  `in progress`

Tasks in dependency order; the wire contract and stable IDs come first because
everything downstream consumes them.

- [x] **The delta wire contract** (D-055). Finalized for the full accepted
      schema — all seven lookup tables, reference and version rows, tombstones
      by CVE ID — typed in `lib/protocol.ts` (`Manifest.deltas: unknown[]` is
      gone, and `snapshot.rev` joins the head `rev`), validated at runtime by
      `lib/delta.ts`, emitted by `pipeline/delta.py` with the manifest writer
      in `pipeline/manifest.py`. Contract-tested both ways: a pipeline-published
      data plane validated by the browser's own code
      (`tests/unit/contract.test.ts`), and a reference apply proving
      *sufficiency* — snapshot N + delta reconstructs snapshot N+1 table by
      table, idempotently (`pipeline/tests/`). Lookup rows are selected by
      per-table id floors rather than a `rev` column, which is the same range
      query D-031 specified for seven fewer columns.
- [x] **Stable interned IDs** (D-056). Builds seed from the previous artifact
      or explicitly bootstrap — there is no default — and seeding covers
      `cve.id` as well as the seven lookups. A value the corpus stops using is
      retired rather than carried forward, which is safe only because its id is
      never reissued: the high-water marks are recorded in the artifact's
      `meta` (`hwm`, `cve_hwm`) instead of being recomputed as `max(id)`, and
      that record is now where a delta's `floors` come from. The ID space also
      has a name (`idspace`) and each artifact records the revision it
      continued (`seed_rev`); `ledger.py` remembers the name the data plane was
      published from, and both publishers refuse an artifact that contradicts
      either — a different lineage, or the same lineage grown from the wrong
      ancestor, which a fingerprint of the ID space separates even when two
      builds share a revision. Proven at both scales: the fixture corpora are built twice,
      unseeded and seeded, so D-055's renumbering reproductions are regression
      tests; and on a synthetic corpus at the real corpus's ID-space
      cardinalities, 1,252,797 ids survived a day's churn — 200 records
      inserted ahead of every existing one — without one moving. The cost of
      seeding is memory, not time; the numbers and their caveats are in D-056,
      and they are dev-VM measurements on synthetic text, not production ones.
- [x] **Daily ingest cron** (D-058). `pipeline/ingest.py run` under `flock`:
      fetch → hash → diff → tombstone guard → build → one delta, with
      `pipeline/state.py` holding the hash state the diff needs. The guard runs
      before the **build**, not merely before publication, because seeding
      retires permanently and a half-fetched tree would cost a new ID space —
      which is why the run pays for a second walk of the corpus (16.9 s) and
      then checks the two walks against each other. That check found and fixed a
      real defect: `build.retired_records` counted every newly minted record as
      a retirement. Re-run semantics are decided and tested at all three crash
      windows, and turn on one question — was anything ever published at this
      range? If nothing was, the pending run is abandoned and the revision
      re-minted (which is what keeps a deterministic refusal from being replayed
      forever); if something was, the pinned changeset is republished byte for
      byte. Each test moves the tree on *and* advances the clock before
      retrying, because otherwise the two behaviours are indistinguishable. A
      missed day needs no handling; a no-change run mints no revision. Measured on `plex` against the real corpus, in scratch: one run
      is 54.9 s and 1.22 GB peak RSS, and the real 69.5-hour window M1 left
      behind produced a 204 KB delta (843 records) that the reference applier
      turned into a database **identical to the rebuild across 3,778,313 rows**,
      holding exactly the 15 products and 2 urls the rebuild retired. The D-056
      migration is rehearsed at full scale and written up as the first
      production run in `pipeline/README.md`; the seeded rebuild of the live
      artifact minted zero ids, which is what makes `--adopt-id-space` honest.
      D-056's deferred question is answered with it: the ID-space marker stays
      **off** the wire, because the one path that looked like it could bypass
      the ledger fails closed. **Run in production 2026-08-03** with the owner's
      go-ahead (nothing is live yet, so the adoption's re-download cost was
      zero): the origin was rebuilt onto a recorded ID space as snapshot rev 2,
      the first delta carried 881 upserts in 218 KB, and the cron is installed
      and advancing the head daily. Verified over HTTPS from outside the machine — immutable and
      `no-cache` policies, COOP/COEP, no `Access-Control-Allow-Origin`, the
      ledger unreachable — and end to end by a real browser importing the new
      generation from `https://cve.meenan.dev/`.
- [x] **Monthly snapshot cron** (D-060). Built and reviewed 2026-08-03,
      deployed and installed 2026-08-04; first unattended firing 1 September.
      - [x] **`pipeline/snapshot.py`.** Take D-042's `flock`, finish any crashed
            ingest, publish **the artifact the ingest state points at** at the
            revision it is stamped with — which must be the published head —
            then retain and retire. It does not rebuild, because the daily
            already does: every daily run writes a complete artifact and the
            delta is only the wire file it emits afterwards, so the rotation is
            the other four verbs and costs what compressing a generation costs.
            It does not fetch either — a monthly job that could abort on the
            tombstone guard would take out the rotation path with the freshness
            path. Measured on `plex` against the real corpus in a scratch copy
            of the live plane, three times: **85–101 s** and 391 MB peak RSS, 12 chunks and
            62.9 MB published, 3 deltas retained, the pre-D-056 generation
            retired — and the published chunks, fetched and decompressed the
            way the client does, reassemble to the artifact **byte for byte
            across all 377 MB**.
      - [x] **The open question D-056 left**, settled the strong way: a snapshot
            at head is the one publication nobody already synced ever fetches,
            so it must be *the artifact that revision's content came from*,
            checked against a digest the ledger now records. The reproduction is
            a sibling build sharing the lineage, the `seed_rev`, the marks and
            the ID-space fingerprint — invisible to every other guard. The
            refusal lands before the generation directory moves, and `--force`
            does not skip it.
      - [x] **Pruning**, and it is not a separate job: retention happens inside
            the snapshot publish, so the manifest stops naming a file in the
            same operation that deletes it. What is retained is defined by what
            the *previous manifest advertised* — deriving it from the directory
            listing or from the ledger each deleted files a live manifest still
            named, three reproductions across two review rounds — and a delta
            file outlives its manifest entry by one full rotation, for the same
            reason a generation does.
      - [x] **The bridging delta**, unblocked: `assert_tiling` now requires only
            that nothing the manifest names is a dead end, which is also what
            makes retention expressible. Deliberately unused by the cron, which
            lands *at* head where the bridge is the identity; it exists for a
            content-changing rebuild, which must land above head and cost a
            re-download.
      - [x] **Adversarial review**, three rounds — four reviewers over the
            diff, an adversarial pass over their fixes, and a pass that
            reproduced recovery and migration paths nothing had exercised, plus
            a verification round that caught one fix applied to two of its three
            paths. Twenty-one defects, of which five would have corrupted the live data
            plane (a retention sweep deleting delta files the manifest still
            named; a `--force` refusal landing after the chunk swap; `--force`
            landing any content at head where the record was missing; a bridge
            redefining a published revision through the same gap; an artifact
            swapped between digest and publication) and two would have blocked
            the rotation for a month. Six guards had no failing test when first
            deleted; every guard has one now, and each was checked by removing
            it rather than by watching the suite pass.
      - [x] **Installed on `plex` 2026-08-04**, `43 5 1 * *`, 86 minutes
            clear of the daily's 4:17 and taking the same lock. Deployed by
            `git pull` into the checkout the crons run from (D-059) — 242 tests
            green on the server, checkout clean — and the daily's whole cycle
            rehearsed against the real corpus first (`--dry-run`: 43.8 s,
            1.22 GB peak RSS, 686 upserts, 0 tombstones, nothing published).
            The cron's own command line was then executed in production, where
            it refused with D-060's message because rev 5 predates artifact
            digests: the invocation, the log redirection and the fail-closed
            guard all confirmed live, and no outcome recorded because a dry run
            writes none.

            **What has not been observed is the scheduler firing it**, which
            first happens 1 September — by then a month of dailies will have
            recorded digests, so the guard above cannot trip. That is the one
            way this differs from the daily, which was checked only after it had
            run unattended: a monthly cannot be, without blocking the milestone
            on a calendar. The work itself is verified four times over at full
            scale against a scratch copy of the live plane. `last_snapshot` in
            `ingest.py status` is what will say it worked.

- [x] **Download with staged replacement** (D-061). Chunks land in a *staging*
      OPFS file — one of two alternating slots — and the live database is
      neither closed nor touched until the staged copy has passed its promotion
      gate. The per-chunk bitmap in `staging.json` is bound to the snapshot
      path, its length, and every chunk's offset, length and hash, and each
      chunk is flushed before its bit is recorded; it is deliberately *not*
      bound to the head revision, so a delta published mid-download does not
      throw away staged chunks, and it *is* bound to the staging file's length,
      without which a record that outlived its file promotes a database with a
      hole in it. The gate is: the bitmap complete (counted), the staged file
      unpromoted, the chunks **covering the byte range exactly** with distinct
      names — per-chunk hashes prove each chunk's bytes and nothing proved the
      bytes between them, which the M1 path never checked — schema and
      `meta.rev` agreeing with the manifest, the D-008 notice present, records
      non-zero, indexes built. Promotion is then one SQLite transaction on the
      database's own header (`PRAGMA user_version`, zero in every published
      artifact), which is what makes it atomic and durable without a pointer
      file to keep crash-safe by hand. Measured at both scales — full corpus:
      an interrupted re-download leaves the previous copy answering the same
      query with the same numbers, the retry fetches **11 of 12** chunks, and
      the origin ends holding one generation (441.1 MB) rather than two. The
      M1-name upgrade path is covered in the same spec — a copy under
      `cve.sqlite` is adopted, queried, and retired by the first promotion,
      which matters because an unrecognised entry is *swept*, not ignored.
      `opfs-sahpool` keeps M1's destroy-then-download behaviour and none of
      this is claimed for it (D-051). A second review round found three more
      crash-safety defects, two of them able to destroy a live copy: discovery
      trusted raw header bytes, which can advertise a promotion the rollback
      journal has yet to commit (reproduced by killing a process mid-commit —
      header 9, SQLite 5); a slot's stale journal was replayed into the next
      generation written over it (reproduced: a file byte-identical to the
      published artifact stopped being so the moment it was opened); and a crash
      during index building refetched the whole snapshot instead of resuming.
      Each has a regression test checked by removing the fix. **Catch-up deltas are not yet staged**,
      because applying one is the Sync task below; the staged file is where
      they will land, and until then a download stops at `snapshot.rev` with
      the head ahead of it. Four adversarial reviewers over the diff found two
      defects that would have destroyed a live local copy — a failed *read*
      licensing a sweep, and an unbound resume record — plus a promotion gate
      with no test at any level; each now has a regression test checked by
      removing the fix.
- [x] **Client-built FTS** over descriptions, vendors and products (D-035),
      surfaced in the same progress display. The index build is 58 of the 64
      seconds a full-corpus import takes — the longest wait the app has — and it
      was reporting an indeterminate bar for all of it, which is the case D-052
      rule 3 exists for. fts5's `'rebuild'` is one opaque statement, so the
      build now walks the rowid space in batches instead and reports through it:
      a fraction weighted by each index's measured share of the indexed text
      (descriptions are 98% of it), and an exact running row count. The rowid
      range is the progress metric because it is the only one that is free —
      `min`/`max` on an INTEGER PRIMARY KEY are seeks, where `count(*)` would
      scan the 122 MB the build is about to read anyway — and it is honest
      enough: half the id space is 40% of the text, so the bar runs slightly
      fast early, never backwards. Measured at full scale on the real published
      artifact, three runs each in one session: **58.0 / 58.3 / 58.4 s batched
      against 57.3 / 57.6 / 57.8 s for `'rebuild'`** — about 1%, for ~96 updates
      through a minute of silence. The index is the same size either way,
      because the batches share one transaction per index and fts5 flushes its
      hash on its own schedule inside one; committing per batch is what would
      have cost segments. What the batching moves is *who* covers the id space:
      a dropped range is records that exist and cannot be found, with the fts5
      tables present, the row counts right and the promotion gate passing — so
      the ranges are held to it directly (`tests/unit/search.test.ts`, against
      the published schema and the same SQLite the browser runs, every row
      carrying a unique token so coverage is asserted row by row, and the whole
      build compared against `'rebuild'` on hostile text). Both halves of the
      claim were checked by breaking them: a dropped range and an off-by-one in
      the range predicate each fail six tests. `import.spec.ts` now also asserts
      the index phase reports a row count and a determinate bar while the user
      is waiting on it, and that a search over the imported corpus returns rows
      — the one place the WASM build's own fts5 answers a query.
- [ ] **Sync.** Merged deltas applied in one idempotent transaction, watermark
      advancing with the rows; FTS maintenance with the explicit `'delete'`
      protocol, verified by `integrity-check` at `rank = 1` (RE-005).
- [ ] **Failure and resume tests** — for replacement, not just first
      download. Partly landed with D-061 in `tests/e2e/staged.spec.ts`, and
      listed here so the rest is not written twice:
      - [x] kill mid-download and resume refetches only missing chunks
            (11 of 12 at full scale);
      - [x] a failure during re-download leaves the prior database intact and
            usable — plus two failure modes the review pass reproduced: a
            discovery error must not license a sweep, and a resume record that
            outlived its file must not be believed;
      - [ ] an interrupted sync rolls back and re-running is safe (needs the
            Sync task);
      - [ ] a snapshot rotation mid-download does not strand the client — the
            *decision* is unit-tested (`bindsTo` refuses a rotated plan), the
            end-to-end file behaviour is not;
      - [ ] a chunk that fails its SHA-256 mid-download, which has no test at
            any level today;
      - [x] a failure *during index building*, after the bitmap is complete —
            the retry fetches zero chunks and resumes at the index build.
- [ ] **Stall detection** (D-052). Duration is never a failure, but a download
      that has stopped advancing is: surface it as an error with a message
      rather than a bar that never moves. The per-chunk progress already
      landed in M1 is what this hangs off.
- [ ] **Freshness.** The visible staleness indicator and the "N new CVEs
      since your last sync" summary.

**Exit criteria:** a browser downloads all 372,092 records, decompresses them
itself, builds its indexes, and queries the result — with one honest progress
display across all three stages (every stage over a second names itself and
shows progress where the work is countable, D-052), a stalled download reported
as stalled rather than spinning, and peak memory bounded by chunks in flight
rather than by the corpus; the *downloaded* database is verified identical to a
freshly built one, and a *synced* one matches it record for record while
holding, by design, the lookup rows a rebuild retired (D-056); a sync applies a
real day of upstream changes; every failure-and-resume
test above passes, including failure *during replacement* leaving the previous
copy usable.

## M3 — Query surfaces and tuning  `pending`

The schema itself shipped in M1 (`pipeline/schema.sql`); this milestone makes
it queryable, fast, and safe. Scope: every confirmed filter axis — CVSS
v2/v3.x/v4, CWE, CNA, vendor/product, dates, state, and references *by host*
(D-033; CPE was rejected there, and FTS never covers references — D-035);
schema versioning exercised end to end: a bump invalidates and forces an
announced full re-download, because the local database is a rebuildable cache
(D-013) and there is no in-place migration; indexing tuned against the M1
baseline, aiming at the shapes that are actually slow (the reference-host scan,
and the cold first query after a reopen) rather than at a ceiling — D-049 sets
none; the raw SQL console, made structurally read-only here — a SQLite
authorizer, not query-text inspection or the `query_only` pragma alone — and
row-capped (this is where D-044's tool-surface commitment starts being real
code). Long-running queries are handled, not forbidden: progress, cancellation,
and a responsive UI, since with no latency ceiling that is the only way
slowness can hurt anyone. Any interrupt is a *safety* mechanism against runaway
or hostile SQL, and must not be a stopwatch that kills a legitimate slow query.

**Exit criteria:** every confirmed filter axis is queryable; no regression
against the M1 baseline, with any deliberate trade recorded; a query past a
second reports that it is running, can be cancelled, and does not freeze the
tab (D-052, covered by a test that runs a slow one); a schema-version bump triggers a correct,
announced re-download; hostile SQL in the console (writes, pragma flips,
runaway queries) is refused by structure, covered by tests.

## M4 — Analysis and reporting  `pending`

Scope: structured filtering UI, aggregate and trend reporting, charting, saved
queries and history, shareable query permalinks, CSV/JSON export carrying the
D-008 notice. Export and render hardening, because CVE text is hostile input
(rule 5): CSV formula-injection neutralization, control-character stripping,
URL-scheme allowlisting on anything rendered as a link, and the notice embedded
in every export format. Accessibility as an acceptance criterion, not a polish
pass: keyboard operability and labels for filters, tables, and charts.

The serializable report definition behind permalinks is now also the contract
the AI chat layer emits (D-044) — design it here as a shared primitive, not a
permalink implementation detail.

**Exit criteria:** the owner's motivating question — counts by vendor, product,
and severity over the last two years (D-046 benchmark item #2) — is answerable
entirely through the UI, charted and exportable, with REJECTED records excluded
by default (D-022). Each promised surface is accepted, not just the one report:
saved queries and history survive a reload; a permalink reproduces its report
on a fresh browser profile; CSV/JSON exports carry the D-008 notice and
neutralize formula injection (covered by tests with hostile records); charts
and tables pass a keyboard-and-labels accessibility check.

## M5 — Resilience and public launch  `pending`

Scope: **putting `cve.meenan.dev` behind Cloudflare and applying D-039's cache
rules** — carried over from M1, where it turned out the hostname resolves
straight to the origin, so D-039's premise that Cloudflare absorbs abuse is
currently false and D-034's origin rate limiting is already gone; storage quota
and eviction handling, multi-tab behavior per the Q-004 outcome, browser capability gating against the D-016 floor — with Playwright
runs on Firefox and WebKit added *before* the floor is claimed publicly
(Chromium-only today, and rule 3 applies to support claims too); the
diagnostics panel (the only support channel, given D-009), surfacing service
worker state alongside storage and sync; an adversarial review pass over the
published data plane; and the offline app shell (D-048): a service worker
caching the shell, Worker, WASM, and brotli decoder — scoped to never touch
`/data/` or model weights — so vision criterion 5 covers reopening the app
offline, not just an already-open tab.

**Exit criteria:** the origin is behind Cloudflare with the D-039 cache rules
applied and verified from a response header; the app degrades honestly on an
unsupported browser, under quota pressure, and in a second tab — each verified by a test, with the
capability gate exercised in real Firefox and WebKit runs; the diagnostics
panel reports storage used, last sync, record counts, and schema version; the
data plane survives an adversarial pass; an offline *reopen* e2e test passes —
network killed, app reopened, corpus queried — and a stale-manifest check
confirms the service worker never serves `/data/` from cache (D-048); public
launch.

## M6 — CISA KEV overlay  `pending`

Scope: server-side KEV fetch and cache (D-010), joined to the corpus
client-side. Small and self-contained, which is why it sits last without
blocking anything. Before anything ships: record KEV's redistribution terms
and required provenance/notice in the decision log — D-008's reopen-if names
"a second data source" as exactly this trigger, and only size/CORS were
researched in D-010.

**Exit criteria:** KEV's terms are recorded and its required notice (if any)
travels with the data; KEV status is a queryable, filterable attribute; its
staleness is surfaced separately from the corpus's.

## M7 — AI chat layer: tool surface, site-hosted endpoint, benchmark  `pending`

The chat loop proven against one consistent, always-available tier first — the
Ollama instance we host (D-057) — so the tool surface can be developed and
benchmarked with minimal client requirements: no key, no WebGPU, no weight
download. Depends on M4's report definitions and, for the KEV tool, on M6. The
risk this ordering accepts — an 8B model's failures being mistaken for
tool-surface bugs — is recorded in D-057; the D-046 benchmark and a dev-only
frontier-key spot check are the mitigations.

Scope: the chat surface; the read-only tool surface over report definitions —
curated high-level tools plus the `SELECT`-only SQL tool (D-044); the
**same-origin chat endpoint** relaying to Ollama at `http://llm:11434/` —
server-pinned model (`gemma4:e4b` today), chat completion as the only exposed
operation, streamed, POST-only with a capped body, nginx rate and concurrency
limits, no chat storage and no request-body logging (D-057), with the
php-fpm streaming question settled by experiment before the implementation is
committed; the consent surface: a first-use disclosure that on this tier the
question and its tool results transit `cve.meenan.dev` and our model host, and
that nothing is stored; CSP `connect-src` pinned — for this tier, to the
origin itself; the D-046 benchmark harness with ground-truth questions, the
owner's severity-over-time question first, scored against the pinned model.

**Exit criteria:** the founding question — stacked CVE counts by severity over
time, all products and per-product (D-046 benchmark item #1) — is answered
end-to-end through chat on the site-hosted tier, rendering via the fixed UI
with the backing queries inspectable; the benchmark runs against the pinned
model and produces a scorecard; a network-panel check confirms chat traffic
goes only browser → `cve.meenan.dev` → `llm`, and nothing else leaves the
browser; the endpoint refuses cross-origin browser callers, oversized bodies,
and any operation but its one, with its rate and concurrency limits verified
against the live origin; and an adversarial pass feeds hostile records —
markup, injection payloads, hostile URLs — through the chat path and shows
containment: nothing beyond the read-only tool surface is reachable, and no
record-supplied markup or URL renders outside the fixed UI's existing
treatment.

## M8 — Other model tiers: BYO keys and in-browser local  `pending`

The differentiator ships here — AI analysis that never leaves the machine —
plus hosted models on the user's own key (both moved after the site-hosted
tier by D-057). Gated on M7's benchmark harness, which is what selects the
local model and sets per-tier expectations.

Scope: provider adapters for user-supplied keys — Gemini, OpenRouter,
Anthropic, OpenAI — keys stored client-side only, traffic browser-direct and
never proxied, in-browser CORS verified per provider before an adapter ships
(D-045, RE-010), each with the first-use per-provider disclosure, key storage
with a visible clear action, and CSP `connect-src` widened only to enabled
providers; in-browser inference (WASM/WebGPU) with weights downloaded from
Hugging Face into OPFS on explicit user action, lifting webai's acquisition
and runtime plumbing as prior art; Chrome built-in Gemini Nano via the Prompt
API as the zero-setup tier; capability gating for the local tier above the
D-016 base floor; benchmark-driven model shortlist with weight licenses
checked deliberately (D-045, D-046); and the storage story for multi-gigabyte
weights — quota, eviction, and the guarantee that a weight download can never
evict the corpus (weights are D-013-style rebuildable cache).

**Exit criteria:** with a hosted key, benchmark item #1 is answered end-to-end
through at least two hosted providers, each producing a scorecard; every
provider adapter that ships passes an in-browser key round-trip and CORS check
(adapters that fail verification are cut from the release, not shipped
hopeful); a network-panel check confirms BYO-key chat traffic goes only
browser → provider and keys never reach `cve.meenan.dev`; a shortlisted local
model answers the benchmark's core questions correctly with the network
disconnected (corpus and weights already local); Gemini Nano works where
Chrome offers it and degrades honestly where it does not; an unsupported
browser is told at the gate, not mid-download; the benchmark scorecard for
local candidates is recorded and the default model choice is justified from
it; and the storage guarantee is tested, not assumed — a weight download into
a nearly-full quota fails cleanly with the corpus intact (weights are
D-013-style rebuildable cache, D-045).
