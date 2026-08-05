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
work) no later than when they become the next milestone up — M0 – M3 are
decomposed and closed. **M4 is next and still carries only scope prose**, so its
checkbox breakdown is the first thing that milestone owes. M5+ carry scope prose
and exit criteria until their turn.

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

## M2 — Full-corpus Download and Sync  `done`

Tasks in dependency order — the wire contract and stable IDs came first because
everything downstream consumes them. These are summaries: the reasoning, the
failure modes each guard exists for, and the full measurements are in the
decision entry each item names.

- [x] **The delta wire contract** (D-055). The whole accepted schema on the
      wire — seven lookup tables, reference and version rows, tombstones by CVE
      ID — typed in `lib/protocol.ts`, validated at runtime by `lib/delta.ts`,
      emitted by `pipeline/delta.py`. Contract-tested both ways: a
      pipeline-published data plane validated by the browser's own code
      (`tests/unit/contract.test.ts`), and a reference apply proving
      *sufficiency* — snapshot N + delta reconstructs snapshot N+1 table by
      table, idempotently (`pipeline/tests/`).
- [x] **Stable interned IDs** (D-056). Builds seed from the previous artifact or
      explicitly bootstrap — there is no default — and a value the corpus stops
      using is retired rather than carried forward, which is safe only because
      ids are never reissued: the high-water marks live in the artifact's `meta`
      rather than being recomputed, and both publishers refuse an artifact whose
      lineage or ancestor contradicts the ledger. Proven at the real corpus's
      cardinalities: 1,252,797 ids survived a day's churn without one moving.
- [x] **Daily ingest cron** (D-058). `pipeline/ingest.py run` under `flock`:
      fetch → hash → diff → tombstone guard → build → one delta. The guard runs
      before the **build** rather than before publication, because seeding
      retires permanently and a half-fetched tree would cost a new ID space —
      which is why the run pays for a second walk of the corpus. 54.9 s and
      1.22 GB peak RSS on the real corpus, with re-run semantics decided and
      tested at all three crash windows. **Running in production since
      2026-08-03**: the origin was rebuilt onto a recorded ID space as snapshot
      rev 2 and the cron has advanced the head daily since, verified over HTTPS
      from outside the machine and end to end by a real browser.
- [x] **Monthly snapshot cron** (D-060). `pipeline/snapshot.py` publishes the
      artifact the ingest state points at, at the revision it is stamped with,
      then retains and retires. It neither rebuilds — the daily already writes a
      complete artifact — nor fetches, so the freshness path cannot take the
      rotation path down with it; and retention is defined by what the *previous
      manifest advertised*, so the manifest stops naming a file in the same
      operation that deletes it. 85–101 s and 391 MB peak RSS against a scratch
      copy of the live plane, with the published chunks reassembling to the
      artifact **byte for byte across all 377 MB**. Three adversarial review
      rounds found twenty-one defects, five of them able to corrupt the live
      data plane; every guard now has a test checked by removing it rather than
      by watching the suite pass. **Installed on `plex` 2026-08-04**
      (`43 5 1 * *`, 86 minutes clear of the daily). Its first unattended firing
      is 1 September — the one thing this milestone closed without observing —
      and `last_snapshot` in `ingest.py status` is what will say it worked.
- [x] **Download with staged replacement** (D-061). Chunks land in a *staging*
      OPFS file — one of two alternating slots — and the live database is
      neither closed nor touched until the staged copy has passed its promotion
      gate. Promotion is then one SQLite transaction on the database's own
      header, which is what makes it atomic and durable without a pointer file
      to keep crash-safe by hand. The resume bitmap is bound to everything that
      decides what the bytes are, and each chunk is flushed before its bit is
      recorded. Measured at full scale: an interrupted re-download leaves the
      previous copy answering the same query, the retry fetches **11 of 12**
      chunks, and the origin ends holding one generation (441.1 MB) rather than
      two. Five crash-safety defects across two review rounds, four of them able
      to destroy a live copy, each now with a regression test checked by
      removing the fix. `opfs-sahpool` keeps M1's destroy-then-download
      behaviour and none of this is claimed for it (D-051).
- [x] **Client-built FTS** over descriptions, vendors and products (D-035),
      reported in the same progress display. The build is 58 of the 64 seconds a
      full-corpus import takes — the longest wait the app has — and fts5's
      `'rebuild'` is one opaque statement, so it walks the rowid space in
      batches instead and reports an exact row count and a weighted fraction
      through it (D-052 rule 3). It costs about 1%: **58.0 / 58.3 / 58.4 s
      batched against 57.3 / 57.6 / 57.8 s for `'rebuild'`**, for ~96 updates
      through a minute of silence. What batching moves is *who* covers the id
      space — a dropped range is records that exist and cannot be found, with
      the tables present, the counts right and the promotion gate passing — so
      coverage is asserted row by row in `tests/unit/search.test.ts`, and both
      halves of the claim were checked by breaking them.
- [x] **Sync** (D-063). Each delta applies in **one transaction** with the
      watermark and the full-text indexes inside it, so a failure anywhere
      leaves the copy exactly where it was — one file at a time rather than the
      whole chain, because stopping part way then leaves the copy at a published
      revision instead of discarding every file that did apply. The catch-up
      runs on the **live** database after promotion, reversing what D-061 said
      it would do, and a download now ends by catching up so a fresh copy lands
      at head. fts5 maintenance uses the explicit `'delete'` protocol with the
      old value read out of the content table an instant before it changes: the
      half that fails silently, and the half only `integrity-check` at
      `rank = 1` catches (RE-005). Proven at two scales, ending with the full
      corpus at snapshot rev 2 walked up through four real daily deltas to
      rev 6 — **1,589 records changed in 56.8 s** in a browser, then queried,
      reloaded and queried again.
- [x] **Failure and resume tests** — for replacement, not just first download.
      Six cases, all passing:
      - [x] kill mid-download and resume refetches only the missing chunks
            (11 of 12 at full scale);
      - [x] a failure during re-download leaves the prior database intact and
            usable — including a discovery error, which must not license a
            sweep, and a resume record that outlived its file, which must not be
            believed;
      - [x] an interrupted sync rolls back and re-running is safe, with the
            refusal placed at the *last* record of a delta that has already
            written lookups, a tombstone and an upsert, so the unwinding is real
            rather than nominal (`tests/unit/sync.test.ts`);
      - [x] a snapshot rotation mid-download starts the download over rather
            than resuming one generation's bytes into another's staging file —
            the failure no hash in the manifest would catch;
      - [x] a chunk that fails its SHA-256 refuses the download by name, leaves
            the live copy answering, and is refetched by the retry;
      - [x] a failure *during index building*, after the bitmap is complete —
            the retry fetches zero chunks and resumes at the index build.

      The network failures are produced with `page.route`, which turns out to
      see the Worker's requests; the rotation and checksum cases were run at
      both scales, against the development slice and against a local mirror of
      the live data plane.
- [x] **Stall detection** (D-064, implementing D-052). The signal is bytes
      received, not elapsed time: sixty seconds without one aborts the transfer
      and reports that it *stalled rather than being slow*, while a download
      that is merely slow runs as long as it takes. Per-chunk progress was the
      wrong thing to hang it off — a chunk is 5 MB, so a connection that died
      mid-chunk would look alive — so responses are read as streams, which also
      bounds each one at the length the manifest published. The watch covers the
      download and the delta fetches and is disarmed before the index build;
      what keeps it honest is D-064 §2, every long *synchronous* step beating
      when it returns. Tested both ways: a hung chunk is reported with the live
      copy intact and the staged chunks still worth resuming
      (`tests/e2e/staged.spec.ts`), and a transfer that keeps beating is never
      reported however long it runs (`tests/unit/stall.test.ts`).
- [x] **Freshness** (D-064). The staleness indicator reads `meta.generated` —
      the data's own build stamp, which travels with every delta — so a synced
      copy and a freshly downloaded one at the same revision report the same
      age. It is deliberately an *age* rather than a verdict about the origin,
      because `status` makes no network request, which is what keeps a reopen
      working offline (D-048); past two days the page says the copy is behind
      unless the origin has stopped publishing, and points at Sync. The "N new
      CVEs since your last sync" summary is a real count rather than the total
      change: `inserts` falls out of the ID-pairing preflight apply already runs
      (D-063), so it costs no extra query. Against the live plane the page
      reported **529 new CVEs, 1,060 records revised, 0 withdrawn in 56.0 s**,
      matching an independent count of the four published delta files.

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

**Exit criteria — met 2026-08-05**, accepted by the project owner. Every task
above is checked, and each clause has evidence behind it rather than a claim:
the full corpus downloads, decompresses, indexes and queries in the browser
(D-049, re-run against the live generation for this milestone); each stage names
itself and reports countable progress, the index build included (D-035, D-052);
a stalled download is reported as stalled and a slow one is not (D-064); peak
memory is bounded by chunks in flight (D-041, D-049); the downloaded database
reassembles to the published artifact byte for byte (D-060) and a synced one
reproduces the pipeline's own next generation, lookups excepted by design
(D-063, D-056); a sync applies four real days of upstream change; and every
failure-and-resume case passes, including a failed *replacement* leaving the
previous copy queryable.

Two things are deliberately **not** claimed by this closure. The monthly
rotation cron has never been observed *firing* — its first unattended run is
1 September, and blocking a milestone on a calendar was the alternative
(D-060). And the `opfs-sahpool` path keeps M1's destroy-then-download behaviour;
none of the staged-replacement guarantees are claimed for it, which is what
D-051 chose against.

## M3 — Query surfaces and tuning  `done`

The schema itself shipped in M1 (`pipeline/schema.sql`); this milestone makes
it queryable, fast, and safe. Tasks in dependency order — the shared query layer
came first, because the filter surface, the console and the tuning all sit on
what it decides about defaults and bound parameters. These are summaries; the
reasoning and the measurements are in the decision entry each item names.

- [x] **The shared query layer** (`lib/filters.ts`). Every confirmed filter axis
      — CVSS v2/v3.x/v4, CWE, CNA, vendor/product, published and updated dates,
      year, state, and references **by host** (D-033; CPE was rejected there and
      FTS never covers references, D-035) — compiled into one `WHERE` clause
      with every value bound. Two things are structural rather than remembered
      per report: D-022's PUBLISHED-only default lives in the compiler, and
      link-table axes compile to `EXISTS`, so a record affecting eight products
      is one record in a list and one in a count. Lookup names resolve to ids in
      a separate step, which is what keeps "no vendor is called that" and "no
      CVE matches that vendor" different answers (D-023). Tested by *executing*
      the compiled SQL against the published schema, with vendor and product
      names that are themselves SQL injection attempts.
- [x] **The filter surface and grouped counts.** A plain form over every axis,
      counts by any dimension, and the SQL with its bound values on screen under
      every result. Deliberately not the reporting UI — M4 owns that, and will
      build it on `Filters`, which is also the object a permalink and a
      chat-emitted report definition will carry (D-044).
- [x] **The SQL console, structurally read-only** (D-065). A SQLite authorizer
      allowing four actions and refusing everything else, installed for the
      duration of the statement, plus a reported 1,000-row cap. 21 hostile
      statements are asserted to leave the database *unchanged*, not merely to
      raise.
- [x] **Query feedback and cancellation** (D-066). SQLite's progress handler
      reports elapsed time past about a second (D-052 §3) and aborts the
      statement when the page sets a flag in shared memory — the only channel
      that reaches a Worker sitting inside SQLite. Covered by a test that runs a
      query which would never finish, cancels it, and queries the same database
      afterwards.
- [x] **Indexing tuned against the M1 baseline** (D-067). Query statistics, no
      new indexes and no query rewritten around a plan — and they ship **in the
      artifact**, because deriving them in the browser costs 20.4 s and every
      cheaper variant lost. The reference-host scan, the slowest of the ten
      shapes and the one D-049 left open, drops from **605 ms to 398 ms** with
      the import unchanged. The cold first query after a reopen (D-049's other
      open shape) is **shown rather than removed**.
- [x] **Schema versioning end to end** (D-068). A local copy of another schema
      is announced with both version numbers, not queried, and **kept** until a
      download replaces it. A manifest of another schema is refused before a
      byte is fetched, with the message that actually helps. `?schema=N`
      exercises all of it, because a real bump needs two builds of the app.

**Exit criteria:** every confirmed filter axis is queryable; no regression
against the M1 baseline, with any deliberate trade recorded; a query past a
second reports that it is running, can be cancelled, and does not freeze the
tab (D-052, covered by a test that runs a slow one); a schema-version bump triggers a correct,
announced re-download; hostile SQL in the console (writes, pragma flips,
runaway queries) is refused by structure, covered by tests.

**Exit criteria — met 2026-08-05.** Every axis answers in a browser against the
real thing: each lookup axis is filtered by a value taken from its own grouped
counts, and the two numbers have to agree — which is what would catch a filter
and an aggregate disagreeing about what a record is. The M1 baseline was
re-measured beside the new numbers, same machine and artifact and session
(`?analyze=0&ops=0` reproduces it): faster on the two shapes statistics reach,
unchanged elsewhere, import unchanged (numbers in features.md under Q-003). A
runaway query reports, stays responsive and cancels; hostile SQL is refused with
the corpus unchanged, and sync still works afterwards — the check that the guard
is per-query rather than left on the connection.

One thing is deliberately **not** claimed: the re-download at a *new* schema is
not exercised end to end, because that needs a data plane at the new schema and
a client that speaks it — two builds of the app (D-068).

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
