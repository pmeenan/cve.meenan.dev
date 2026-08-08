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
work) no later than when they become the next milestone up — M0 – M5 are
decomposed and closed, and **M6 is next, decomposed 2026-08-08**. M7 and M8
carry scope prose and exit criteria until their turn.

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
- [x] **Deploy.** *Mostly done 2026-08-01; the owner-applied nginx steps landed
      the same day, and the last sub-item — Cloudflare — closed in M5 on
      2026-08-08, which is what completes this box.*
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
      - [x] **Cloudflare cache rules** (D-039) — **was moved to M5, and closed
            there 2026-08-08.** Measured 2026-08-01: `cve.meenan.dev` resolved
            straight to the origin and no response carried a `cf-ray`, so the
            domain was not proxied at all and there was nothing to configure —
            which left D-039's premise that Cloudflare absorbs abuse false, and
            D-034's origin rate limiting already gone. Flipped and verified from
            response headers in M5; `cf-ray` and `cf-cache-status` are present
            on every response, with the manifest revalidating and chunks
            `immutable`.

**Exit criteria — met 2026-08-01.** The deployed site loads from
`cve.meenan.dev`, fetches the published chunks, decompresses them itself,
writes them into OPFS, and renders one real query result — verified by running
`tests/e2e/import.spec.ts` against the live origin, not just locally. Q-003 and
Q-004 are answered (D-049 – D-051), vision criteria 1 and 3 carry real numbers,
and `pnpm check` / `pnpm e2e` are green. The one item deliberately left open was
Cloudflare (below) — not in the request path at all, which made it M5's problem
rather than a gap in this milestone. **It closed there on 2026-08-08, so this
milestone is now complete with nothing carried.**

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

## M4 — Analysis and reporting  `done`

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

Four shape decisions were taken by the owner before decomposition (2026-08-05),
because each of them changes what the tasks below are: the app becomes a
**tabbed workspace on one route** rather than a longer page or real routes, so
the Worker and its OPFS handle survive navigation; a report definition carries
**filters plus a rows dimension, an optional series dimension, and a time
bucket**, because both D-046 benchmark questions are cross-tabs and a
one-dimension primitive would be revised the moment M7 consumed it; charts are
**hand-rolled inline SVG**, which adds no dependency to audit under D-002 and
puts the accessibility story in our own hands rather than in a library's
defaults; and exports cover the **whole match set up to a disclosed cap**
rather than whatever the table happens to be showing.

Four more were taken against the first mockup, which was drawn from real records
rather than invented ones — which is what surfaced them. **Records with no CVSS
score are always shown as their own band**, never excluded by default: about
half the corpus has never been scored (189,742 of 372,322), so a severity chart
that quietly dropped them would understate every bucket, and hiding an absence
that large is the same failure D-022 guards against for REJECTED records.
**CRITICAL sits at the stack's baseline**, because stacked segments share only
that edge and the bottom series is the only one a reader can compare accurately
across buckets — so the founding question's series gets the readable position,
and the unscored band lands at the top where it cannot distort the trend
beneath it. **M4 adds a per-CVE detail view** — description, CWEs, affected
version ranges, reference URLs — which is what the scope's link-hardening
clause is actually for, is the only surface that reaches the references and
version ranges D-033 put in the schema, and is what D-044's "CVE detail" chat
tool will render through in M7. And accessibility is verified by **axe-core in
Playwright plus hand-written keyboard tests** — the automated pass for labels,
roles and contrast across every tab, the hand-written ones for tab order,
arrow-key movement and the chart's table fallback, which no rule engine checks.

One thing follows from the constraints rather than from preference, and is
recorded here so it is not re-litigated as a styling choice: a permalink puts
its report in the **URL fragment, never the query string**. A query string
reaches nginx in the request line and its access log, and a report definition
is made of predicates — the exact thing D-014 forbids the server to learn and
D-032 keeps it structurally unable to. The fragment is never sent.

Tasks in dependency order. The report definition comes first because everything
after it is either a producer or a consumer of one.

- [x] **The report definition** (`lib/report.ts`). The serializable object
      D-044 calls the shared primitive: filters, rows, series, bucket, chart
      type, sort, limit, title. It arrives from a URL fragment written by a
      stranger and, in M7, from a model — so it is *validated*, not cast, and
      an unknown dimension or chart type is refused by name rather than
      defaulted past. Carries a version, so a definition this build cannot read
      says so instead of rendering something subtly different from what its
      author saw.
- [x] **Two-axis aggregation and time buckets** in `lib/filters.ts`. `groupSql`
      grows a second dimension and a `year | quarter | month` bucket over
      `published`. Two properties have to survive the second axis: link-table
      dimensions still count `DISTINCT c.id`, so a record affecting eight
      products stays one record; and the cell count is bounded, because rows ×
      series is a product and a vendor × product cross-tab is not renderable at
      the corpus's cardinalities. Truncation is reported, never silent (D-052).
- [x] **The tabbed shell.** Data / Explore / Report / Saved / SQL on one route,
      as an ARIA tablist with roving tabindex and arrow-key movement. The
      Worker stays mounted across tabs — remounting costs the 3.4 s reopen
      measured in D-049 — and the freshness line and MITRE notice stay visible
      from every tab, since D-008 attaches to the copy rather than to a view of
      it.
- [x] **The report builder.** Filters as removable chips over a disclosure
      holding the full form, plus the rows/series/bucket/chart pickers. The M3
      filter form is refactored into a shared component rather than duplicated:
      Explore and Report must not drift into disagreeing about what an axis
      means. D-022's PUBLISHED-only default is shown as a chip rather than
      implied, because the one thing a report must never do is change its
      denominator quietly.
- [x] **Charts** — hand-rolled SVG (D-073): stacked and grouped bars, and lines
      over time. Severity is an **ordinal** encoding and the ramp is *checked
      rather than eyeballed* — `tests/unit/chart.test.ts` reads
      `app/globals.css` and asserts, for both themes, strictly ordered
      luminance, ≥1.4:1 between adjacent bands and ≥2:1 against the background
      each is drawn on. The unscored band is a neutral deliberately off the
      ramp, because it is an absence rather than a level. Identity dimensions
      get categorical slots, capped at eight with the drop reported rather than
      silent. Every chart ships its numbers as a table view — always rendered,
      with real `<th scope>` headers — which is both the accessibility channel
      and the audit one.
- [x] **Permalinks.** Fragment-encoded report definitions, a Copy link action,
      and restore-on-load. Bounded on the way in: a hostile fragment is a
      stranger's input, so length and structure are checked before anything is
      decoded. Verified on a **fresh browser profile** with its own local copy,
      which is the only test that proves the link carries the report and not a
      pointer into this browser's state.
- [x] **Saved reports and history** (D-072). Named saves plus an automatic
      recent list, in `localStorage` — deliberately *not* in the SQLite copy,
      which is a rebuildable cache (D-013) that a re-download or a schema bump
      destroys, and D-070 already schedules a bump. Everything read back is
      re-validated through `parseReport`, entry by entry, so one report naming a
      dimension this build dropped costs that report rather than the other
      nineteen; and a write that does not stick is *reported*, because a report
      that appears to save and is gone on reload is worse than one that says it
      cannot be saved.
- [x] **Export, and the hardening it drags in** (D-071). CSV and JSON, streamed
      from the Worker in batches so a large export is bounded by a batch rather
      than by the result set, up to a disclosed cap of 50,000 records — stated
      in the file's own preamble as well as in the UI. The guards are
      structural rather than per-caller: a writer **cannot be constructed
      without the D-008 notice** (it throws), and every cell goes through
      `lib/sanitize.ts`, which neutralizes the six spreadsheet formula leads,
      strips C0/C1 and the Trojan Source bidi overrides, and always quotes.
      Unit tests supply the hostile records; the e2e test asserts the property
      over real corpus text, which is what catches a guard that exists but is
      not in the path.
- [x] **The per-CVE detail view.** Description, CWEs, affected version ranges
      and references for one record — the first surface to reach the two
      sections D-033 accepted into the schema and nothing has rendered since.
      References are the hostile part: a URL in a CVE record is
      attacker-supplied, so it is held to a scheme allowlist, rendered with its
      host shown, never auto-fetched, and never turned into a request by
      hovering it (rule 4, D-011's referrer concern).
- [x] **Accessibility as an acceptance criterion.** Keyboard operability and
      labels across tabs, the filter form, tables and charts — asserted by
      tests rather than inspected once: `@axe-core/playwright` for labels, roles
      and contrast on every tab, hand-written tests for tab order, arrow-key
      movement and the chart's table fallback. The dependency's license is
      verified from its own metadata before it lands (D-002).

**Exit criteria:** the owner's motivating question — counts by vendor, product,
and severity over the last two years (D-046 benchmark item #2) — is answerable
entirely through the UI, charted and exportable, with REJECTED records excluded
by default (D-022). Each promised surface is accepted, not just the one report:
saved queries and history survive a reload; a permalink reproduces its report
on a fresh browser profile; CSV/JSON exports carry the D-008 notice and
neutralize formula injection (covered by tests with hostile records); charts
and tables pass a keyboard-and-labels accessibility check.

**Exit criteria — met 2026-08-07**, in a browser against the development slice
(`tests/e2e/report.spec.ts`, `tests/e2e/a11y.spec.ts`). Each clause has evidence
rather than a claim:

- The founding question renders — severity by month, stacked, CRITICAL at the
  baseline and the never-scored band present and on top — and benchmark item #2
  answers through the same builder for **both** vendor and product over the last
  two years. The cross-tab is checked for the failure that would be invisible:
  no row's total exceeds the match count, which is what a join chain
  double-counting a record affecting eight products would produce (D-069).
- The chart and its table are reconciled row by row, so the drawing and the
  numbers cannot disagree.
- D-022's default is on screen as a chip rather than implied.
- A CSV export carries the notice, is quoted throughout, and — over **real
  corpus text**, not an invented payload — has no cell beginning with something
  a spreadsheet executes and no control character that would split a record. A
  JSON export parses and carries the notice and the backing query. A record
  export writes exactly as many rows as matched, against 100 on screen, which is
  the difference the feature exists for.
- Saved reports and history survive a reload, a delete stays deleted, and
  opening one runs it — including when it is opened before the Worker has
  finished reopening the copy, which is a real window and silently did nothing
  until it was tested.
- A permalink reproduces its report **on a fresh browser context** — its own
  OPFS and its own `localStorage`, so only the URL crosses — producing the same
  table cell for cell. The link's query string is asserted empty; the definition
  is entirely in the fragment (D-014, D-032). A damaged, smuggled or
  from-the-future fragment is refused by name.
- The detail view opens with focus, and every reference it links is `http(s)`
  with `rel="noreferrer noopener"` and `referrerPolicy="no-referrer"`.
- `@axe-core/playwright` is clean on **every** tab — first visit, Data, Explore,
  Explore with a record open, the report builder, the chart, Saved and SQL —
  scanned per tab, because four of five panels are `hidden` at any moment and a
  single pass would report the app clean having looked at one fifth of it. The
  hand-written half covers what no rule engine checks: arrow-key and Home/End
  movement, the roving tabindex being one tab stop, the chart's table being a
  real table, and a filter chip removable from the keyboard by a name that says
  which filter it is.

Three defects were found by writing those tests rather than by reading the code,
and are fixed: the CVSS-version checkboxes rendered **v2.0, v4.0, v3.0, v3.1**,
because JavaScript orders integer-like object keys numerically and 31 > 4 —
D-047's "codes are not magnitudes" confusion resurfacing in a checkbox list; two
colours that pass on white and fail on near-black (`.error` at 2.87:1 and the
primary button's own label at 2.41:1); and every horizontally scrolling table
was reachable by mouse and not by keyboard.

**Measured at full scale 2026-08-07, and it found a 42-second defect** (D-074).
The correctness tests run against the development slice, so `crossSql` was
timed separately against a local mirror of the live data plane — 372,322
records, snapshot rev 2, every chunk checksum verified. Warm, in a browser, with
the 256 MiB page cache:

| report | ms |
| --- | --- |
| Month × Severity (the founding question) | 343 |
| Year × Severity | 396 |
| Vendor × Severity | 624 |
| Product × Severity | 575 |
| CWE × Severity | 364 |
| CNA × Severity | 244 |
| Reference host × Severity | 1,348 |
| Vendor × CWE | 633 |
| Month, one axis | 116 |

Every shape is under a second and a half. **Two of them were 42 seconds before
this measurement.** With statistics present the planner inverts the CWE join
chain and drives from `cwe`'s 797 rows, turning one covering-index scan into
~190,000 random lookups; pinning the link-table chains with `CROSS JOIN` — the
access path `schema.sql` was built for — takes `CWE × Severity` from 41,718 ms
to 364 ms and `Vendor × CWE` from 41,946 ms to 633 ms, 115× and 66×, with no
other shape moving beyond run-to-run variance (D-074). It was invisible on the
39,196-record slice, which is the whole reason this number was worth taking.

Cold, the reference-host shape is 13.0 s and everything else is 0.4–5.4 s; that
is the page cache filling, and it is the same cold-first-query behaviour D-067
chose to *show* rather than hide. The sweep is re-runnable —
`tests/e2e/measure.spec.ts`, case `M4 report shapes`.

One thing is deliberately **not** claimed: the runs are Chromium-only, as every
milestone's have been. Firefox and WebKit are M5's, before the D-016 floor is
claimed publicly.

## M5 — Resilience and public launch  `done`

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

Four shape decisions were taken by the owner at decomposition (2026-08-08),
following M4's precedent, because each changes what the tasks below are.
**Cloudflare is a flip, not a migration**: `meenan.dev` is already a Cloudflare
zone, just unproxied — the work is proxying the record and applying D-039's
cache rules, then verifying from response headers; no nameserver move.
**Launch is the flip**: when the exit criteria hold, the site is launched — no
landing page, about copy, or announcement surface is M5 scope. **Multi-tab is
full support, not honest degradation** — a raise over the "degrades honestly"
wording this section carried: a second tab must keep querying while another
tab syncs, and must follow a replacement rather than keep answering from a
promoted-over copy. And **the data-plane review gets the heavyweight
treatment** (workflow.md's "when to go heavy"), sanctioned in advance rather
than decided at the moment — it gates launch, and it is exactly the class of
change that section names.

**The last schema additions, and they land here for a timing reason** (D-070).
Five fields the corpus has been carrying that the projection drops: SSVC's three
decision points from CISA's Vulnrichment ADP — the corpus's only structured
exploitation signal, on 91–99% of everything published since 2023 —
`dateReserved` at 100%, `affected[].defaultStatus`, `cna.title`, and the
rejection reason for the 17,822 REJECTED records that currently import with no
text at all. This is M5 work rather than M6 or later because a schema bump
invalidates every client's local copy with no in-place migration (D-068): before
launch that is free, after launch it is a 63 MB re-download for every user. Two
of the five are not enrichment — `default_status` makes `cve_ver` readable
without ambiguity, and `reason` stops D-022's rejected records rendering blank.
The pipeline half is `normalize.py`, `schema.sql` and a rebuild; the client half
is the schema assertion, the `lib/filters.ts` axes for the SSVC enums, and the
detail view. Absence stays visible throughout: a record with no SSVC assessment
is its own band, never folded into `none`.

Tasks in dependency order. The schema bump leads because it invalidates every
local copy and changes the artifact every later task tests against — landing it
first means nothing downstream is verified twice. Cloudflare is the exception:
it is independent of everything else and should be flipped early for soak time,
in parallel with whatever task is current.

- [x] **The schema bump, pipeline half** (D-070, D-075). `schema.sql` carries
      the five fields at **schema 2**; `normalize.py` mines them, with the
      conservative `defaultStatus` tie-break explicit — 13,628 records really do
      state two different defaults for one deduped `(vendor, product)` pair, so
      taking the first would have been a coin flip on a correctness field. The
      SSVC extractor was written against a **full scan of the corpus** rather
      than a sample (374,269 records, 172,041 blocks): exactly three option
      names, exactly six values, one record with `options: null`, and 164
      records carrying two blocks — which is why the merge rule is stated (first
      block to supply a point wins, **adp then cna**, deliberately unlike
      `cvss`) rather than discovered later.

      **The marginal cost, measured with both schemas built from one clone**
      (2026-08-08): the published artifact goes from 63,308,279 to **65,709,320
      bytes — +2.40 MB, +3.8%**, against D-070's 2.65 MB proxy, so the owner's
      call holds with room. Build time +1.4 s. Recorded, as D-070 asked, not
      treated as a gate.

      **How it lands on the wire is settled** (D-075): a **bootstrapped**
      generation above the published head, `publish.py --new-id-space`, then
      `ingest.py init --force`. Not seeded — `build._seed_from` refuses that
      deliberately, and the guard stays: every client re-downloads at a bump
      anyway, so carrying id stability across one preserves something nobody can
      use. `--new-id-space` retires every pre-bump delta in the same operation,
      which is what stops a schema-1 delta being advertised beside a schema-2
      snapshot. `FORMAT_VERSION` deliberately does *not* move with it — it is
      checked first, and bumping it would replace D-068's actionable "reload the
      page" with "unsupported wire format". The runbook is in
      [pipeline/README.md](../pipeline/README.md).
- [x] **The schema bump, client half.** The three SSVC axes are filters,
      grouped counts and report dimensions, and **NULL is selectable** — through
      a `NOT_ASSESSED` sentinel that compiles to `IS NULL` beside the `IN`
      rather than into it, because `IN (…)` is never true for NULL and without
      it the band holding half the corpus would be visible on every chart and
      selectable nowhere. On a chart those axes take the **ordinal ramp**,
      spaced across it, since none → poc → active is an escalation and D-073's
      argument applies unchanged; the unassessed band takes the off-ramp
      neutral, and the adjacency test asserts the pairs *these* stacks have,
      which are not severity's — the neutral sits above the highest band here,
      not above NONE. The detail view renders the title, the rejection reason
      (17,842 records stop rendering blank), `reserved`, and a version table
      with an "Everything else" column, without which a list of `unaffected`
      rows can mean the opposite of what it looks like. An export carries the
      six new columns and the record table does not: an export is a copy
      (D-071).

      **`title` joins the full-text index** — D-070's open question, decided by
      measurement (D-075). A second *column* on the existing index rather than a
      fourth index, so a search stays one `MATCH` and the promotion gate keeps
      counting three tables. 9,854,710 bytes of title text against 123,525,051
      of descriptions — ~8% more indexed text — against a recall gain that is
      the point: 83.3% of titled records have a title that is not a substring of
      their own description, and the title is where the vulnerability class and
      the sink live.
- [x] **The bump exercised end to end** (D-068). `tests/e2e/bump.spec.ts` runs
      an old client against the **real** new data plane — `pipeline/pub` is
      schema 2 and `pipeline/pub-schema1` is the generation before it — and
      asserts the refusal names both versions, says *reload* rather than
      re-download, and leaves the origin with no chunk fetched and no file
      written. Then the same browser at the plane's own schema downloads it and
      the new columns answer through the SQL console, including that **both**
      SSVC states exist: assessed records and unassessed ones, because a zero in
      the second would mean the projection was inventing findings.

      **The mirror half stays a rehearsal, and that is a finding rather than a
      shortcut.** A build can claim another schema version (`?schema=`); it
      cannot *be* another build. The full-text index definition is compiled in
      and now covers `cve_text.title`, so this build downloading the schema-1
      artifact fails on `no such column: title` — not because the announcement
      is broken but because the two halves of a bump ship together. The
      announcement path compares two numbers and never branches on them, which
      is what makes `query.spec.ts`'s knob faithful to it. Deploy sequencing is
      settled and written down (pipeline/README.md): artifact first, app in the
      same window, because a deployed client refuses a new-schema manifest and
      says to reload.
- [x] **Multi-tab, full support** (owner decision 2026-08-08). One writer at a
      time via Web Locks — download and sync are exclusive, and a second tab
      asked to sync says who is already doing it — while every tab keeps
      querying throughout (the `opfs` VFS's concurrent-reader behaviour is why
      D-051 chose it). Promotion and applied deltas propagate: a tab that did
      not perform the replacement learns of it and reopens the new generation
      rather than answering from the promoted-over slot, and freshness lines
      agree across tabs. What must not regress: D-061's crash-safety with a
      reader present at the moment of promotion. Verified by a two-page e2e —
      tab B queries while tab A syncs; tab A replaces the database and tab B
      follows.

      **Writing this found a real deadlock, and not in the part it was aimed
      at.** The capability probe (below) opened a scratch OPFS file under a
      *fixed* name, and a sync access handle is an exclusive lock whose release
      outlives `close()` (RE-007) — so two tabs starting at once was one tab
      hanging with no error, no timeout, and a page stuck at "pending". It
      presented as three unrelated e2e failures. The probe now names its file
      per call, and `isOurEntry` matches the prefix so a tab killed mid-probe
      leaves nothing behind.
- [x] **Storage quota, persistence and eviction.** `navigator.storage.persist()`
      is requested from the Download **click** — Firefox prompts, and a prompt
      outside a user gesture is dismissed — and the *answer* is what the page
      reports, not the fact that the call returned. The preflight runs after the
      manifest and before the first chunk, budgeting **two generations** when a
      copy is already present, because staged replacement holds both (D-061); an
      unknown quota proceeds rather than blocking, since refusing on "I don't
      know" would block every browser that reports nothing. A retry credits the
      staging allocation already counted in `usage`, so the preflight cannot
      strand the resumable bytes it is meant to preserve. An evicted copy at
      reopen is already an honest empty origin — that is what discovery reports
      — which is why the preflight is a check rather than a reservation.

      **D-068's open question is decided: the retained obsolete copy stays.** It
      is one generation, the same bound a re-download already accepts, and it is
      reclaimed by the next promotion's ordinary sweep. Deleting it would trade
      a bounded, temporary cost for the one thing D-068 exists to prevent —
      a user arriving to find their download gone with nothing saying why.
- [x] **The capability gate** (D-016). `lib/capabilities.ts` **calls**
      `getSize()` on a real handle and reads whether a number or a Promise came
      back — the only probe that separates Safari 16.4 from 16.3, where the
      interface exists and its methods are async and the import then dies inside
      WASM. Beside it: WebAssembly, OPFS, cross-origin isolation and
      `SharedArrayBuffer`, all required; streaming responses reported as
      *narrowed* rather than blocking. The gate runs before the manifest, and
      its message names the specific missing capability **and** the floor,
      because "why does this not work" and "what do I do" are different
      questions — and a stripped COOP header is a fixable case that has nothing
      to do with the browser. D-009 means no gate hit is ever observed remotely,
      so the sentence on screen is the whole support channel.

      Testing it needed a knob: the probe runs in the Worker, and a page-level
      `addInitScript` never reaches there (RE-020). `?probe=` forces the verdict
      and `?free=` shrinks the reported quota; both can only make the checks
      *stricter*, which is what makes them safe to leave reachable — unlike
      `?vfs=` (D-051).
- [x] **Firefox and WebKit** (D-016, rule 3), **with the WebKit half recorded
      as a trade rather than claimed, and WebKit ultimately dropped.**
      `playwright.config.ts` carries two engines, Chromium first so
      `--project=chromium` stays the fast loop and a bare `pnpm e2e` runs the
      claim.

      **This item was ticked once on evidence that did not exist.** The guard
      added to let WebKit skip the specs it cannot run tested
      `createSyncAccessHandle` on the **main thread**, where no engine exposes
      it — so it skipped all nine data-path spec files on all three engines, and
      a run reporting "zero failures" had executed none of them (RE-024). The
      guard now probes inside a Worker and **asserts** instead of skipping,
      because after WebKit's removal every configured engine is expected to have
      OPFS and a failure there is a regression, not a reason to run less.

      **The real two-engine run**, once that was fixed: 98 tests, **57 passed,
      40 skipped, 1 failed**. All 40 skips are `measure.spec`, which is opt-in
      behind `MEASURE=1`; nothing else skipped, and `bump.spec` genuinely ran, so
      D-068's announcement path is exercised rather than assumed. The single
      failure was a Firefox race in `openTab` — `ready` goes true, then briefly
      false again while the Worker settles a fresh profile's copy, and a click
      inside that second window is dropped by a genuinely-disabled button. Fixed
      by retrying the click, which is also what a person would do.

      **Firefox runs the whole suite**, and found two things Chromium could not.
      One was ours: a tab clicked across the enabled/disabled transition landed
      before the component wired it up — invisible on Chromium, reliable on
      Firefox. The other is an engine difference worth keeping (RE-023):
      Firefox serves a `no-cache` response from its HTTP cache when offline, so
      a sync attempted with no network reported **"already current"** instead of
      failing. That is the confusion D-048 keeps the service worker away from
      `/data/` to prevent, arriving one layer lower — the manifest is now
      fetched `no-store`, which makes the freshness signal a network request or
      nothing.

      **WebKit cannot run the app at all, and that is a fact about the test
      browser** (RE-022). Playwright's Linux WebKit 26.5 is cross-origin
      isolated, has `SharedArrayBuffer`, Web Locks and service workers, and has
      **no OPFS**: `navigator.storage.getDirectory` is `undefined`. D-016's
      floor is Safari 16.4, which has it; the gap is between Safari and the
      build Playwright ships, and no option closes it. So **the Safari half of
      the floor is not verified by this suite and cannot be** — it rests on
      documented feature availability plus the gate, which is weaker than the
      other two claims and is written down rather than implied.

      **The engine was removed from the project list** (owner decision,
      2026-08-08) rather than kept and skipped, because a project whose entire
      contribution is skips reads identically to a passing one in a summary
      line — which is precisely how RE-024 stayed invisible. The cost is named
      rather than buried: WebKit was the only engine where the capability gate
      fired on a browser that genuinely fails, so `resilience.spec.ts` now
      covers it only through the forced `?probe=` knob. Re-adding a project is
      one line if a WebKit build with OPFS appears.
- [x] **The offline app shell** (D-048, network-first per D-054). A hand-rolled
      service worker **generated from the finished export** by
      `scripts/build-sw.mjs`, so the precache list is derived rather than
      maintained: Turbopack's chunk names change every build, and a hand-written
      list is the version of this that ships caching nothing that matters and is
      noticed only when the network is gone. Versioned by a hash of that list
      plus every file's contents, which is what "versioned per deploy" means
      with no build step on the server (D-003). `/data/` is not merely absent
      from the list — the worker returns without calling `respondWith` for it,
      so no later branch can reach one of those URLs. The e2e is a *reopen*:
      network killed, app reopened cold, corpus queried (vision criterion 5),
      plus a check that the shell cache holds no `/data/` entry at all.

      One nginx location is **owner-applied and outstanding**: `/sw.js` needs
      `Cache-Control: no-cache`, or the site's `expires max` static rule pins
      the file that decides what everything *else* may be cached from. The block
      is in architecture.md; `scripts/serve.mjs` already sends it, which is the
      local server matching production rather than being looser (RE-012).
- [x] **The diagnostics panel** (D-009). The one support channel: storage used
      against quota and whether persistence was granted, last sync and the
      copy's age, record counts, schema version, service-worker state
      (registered, version, controlling), and the capability probe's results —
      the things a bug report needs and telemetry will never provide. A
      `<details>` on the Data tab, closed by default and re-probed on open,
      because a panel showing what was true at page load sends someone chasing a
      number that has already changed.
- [x] **Cloudflare in front** (D-039, carried from M1). **Flipped and verified
      2026-08-08.** The flip surfaced two real defects, both fixed the same
      hour. First, the zone's SSL mode was *Flexible*, so Cloudflare spoke
      HTTP to an origin that redirects HTTP→HTTPS and every request looped —
      the site was down until the owner set *Full (strict)*. Second, the
      origin sent its `immutable` Cache-Control on **404s** (`add_header …
      always`), and Cloudflare cached one for a year (observed: `HIT`,
      `age: 26`) — with delta URLs predictable, anyone could have poisoned
      tomorrow's `deltas/<from>-<to>.json.br` at the edge for a year, a cheap
      remote sync-DoS. Dropping `always` from the Cache-Control lines (the
      security headers keep theirs) makes error responses `BYPASS` entirely;
      the block and the reasoning are in architecture.md. Verified from
      responses, not the dashboard: `cf-ray` everywhere, chunks `MISS`→`HIT`,
      manifest and `/sqlite/` `REVALIDATED`/`no-cache`, COOP/COEP/CORP intact
      through the proxy, no `Access-Control-Allow-Origin` under a hostile
      `Origin`, `.php` under `/data/` 404, traversal 400, NEL disabled so
      Cloudflare injects no reporting channel (D-009). The verification also
      caught that the docroot still held the **Aug 2 build** — three
      milestones stale — which the first live-origin e2e failed against;
      the M4 app was deployed (D-003 rsync) and the full-corpus import e2e
      then passed against the proxied origin, 7.2 m end to end.
- [x] **The heavyweight data-plane review** (sanctioned 2026-08-08, run the
      same day). Six reviewers over the dimensions the data plane actually has —
      artifact-chain immutability, the ID space, the wire contract across the
      bump, the crons and retention, the edge, and hostile record content —
      each finding then put to **three independent skeptics** with different
      lenses and kept only on a majority. **19 findings, 15 upheld, 33 verify
      votes to refute.** A completeness critic then asked what fell between the
      six.

      What it found was not the browser code. It was the **launch runbook** and
      the publisher underneath it, which is exactly the class workflow.md
      reserves this for:

      - **A crashed `--new-id-space` publish could not be retried** (critical,
        reproduced). The ledger is written before the manifest, so a kill
        between them left `published_head` reading the ledger's new revision
        while the manifest advertised the old one — and the retry met the
        "needs a revision above the published head" guard *at the revision it
        had just published itself*, with both crons stopped on the
        manifest/ledger disagreement and no exit but hand-editing the ledger.
        This is step 2 of the schema-bump runbook.
      - **Byte identity bypassed the roll-backwards guard** (high, reproduced
        three ways including on the monthly rotation's own shape). Under
        retention the older generation's directory is still on disk, so a
        flagless re-run of that generation's artifact matched `_same_bytes`,
        skipped the check, and rewrote the manifest at the old revision with
        every delta dropped.
      - **`publish.py` never checked the artifact's schema at all** — the one
        publisher without the check `delta.extract` has always made, defaulting
        a missing value to 1. Building before `git pull` and publishing after
        would have published a schema-1 artifact while retiring the old ID
        space, and the schema-2 app would then refuse the plane it had just
        replaced.
      - **A fixed `.staging-<rev>` name with an unconditional `rmtree`**, and no
        lock: two publishes of one revision shared it, and the second deleted
        the first's chunks between recording their digests and renaming the
        directory into place.
      - **The provenance commit was read after the walk**, so `init`'s "the tree
        did not move" check could not see a mid-walk `git reset --hard` — the
        exact race the instruction it enforces is about.
      - **SSVC let a CNA's own container outrank CISA's**, handing the party
        with the incentive to downplay exploitation control of the corpus's only
        structured exploitation signal. Reversed, and the reversal is explained
        against `cvss`'s opposite precedence.
      - **The storage preflight was wrong in both directions**: it measured a
        two-generation peak against *free* space, double-counting the copy
        already inside `usage` — refusing re-downloads that would have succeeded
        and pointing the user at the one action that destroys a working corpus —
        while budgeting the *artifact* rather than the imported footprint, which
        passes a browser that then runs out during the index build.
      - **"Clear local copy" was the one writer outside the Web Lock**, so a
        clear during another tab's download deleted the live copy, failed on the
        slot the downloader held, told the user it had failed, and then watched
        the downloader promote a full corpus anyway.
      - Plus: the shell's install swallowed precache failures and then deleted
        the previous, complete cache; a stray `%` in any URL killed the local
        test server; and `kev.json` is documented `short` while the deployed
        nginx block would serve it `immutable` for a year — recorded now so M6
        does not inherit it.

      Every fix has a regression test, and the two on the publisher were checked
      **by removing them** and watching the test fail.
- [x] **Launch.** Done 2026-08-08. The artifact shipped first and the app
      followed in the same window, per the runbook's sequencing: bootstrap build
      at rev 11 (32.6 s), `publish --new-id-space` (99.6 s, 12 chunks, 65.7 MB),
      `ingest init --force` (24.0 s), then `pnpm build` and the rsync. Verified
      from outside rather than from the deploy's own exit code — the live
      manifest reads `schema 2, rev 11` with the MITRE notice, a chunk's
      `content-length` matches the manifest byte for byte with no
      `Content-Encoding` (D-040), and a **full-corpus import from the live
      origin in a real browser passes in 1.8 min**. The daily cron was
      commented out for the window and restored after; the cycle was then
      rehearsed by hand and would cut rev 12 from 11, so its first unattended
      firing against the new lineage is a repeat rather than a first.

      Two owner-applied pieces landed with it: the `location = /sw.js` block,
      and the `sites-enabled` symlink it turned out to need (RE-025) — the
      block had been edited into a file nginx was not reading, and `/sw.js` was
      serving `max-age=315360000` behind Cloudflare until a response header
      said otherwise.

**Exit criteria:** the origin is behind Cloudflare with the D-039 cache rules
applied and verified from a response header; the app degrades honestly on an
unsupported browser and under quota pressure, and a second tab is **fully
functional** — it queries during another tab's sync and follows a replacement —
each verified by a test, with the capability gate exercised in real Firefox and
WebKit runs; the diagnostics panel reports storage used, last sync, record
counts, and schema version; the data plane survives the heavyweight adversarial
pass; an offline *reopen* e2e test passes — network killed, app reopened,
corpus queried — and a stale-manifest check confirms the service worker never
serves `/data/` from cache (D-048); D-070's five fields are in the built
artifact with their real marginal cost measured against D-033's table,
filterable where they are axes, and reported with "not assessed" as a visible
band rather than a silent zero — **and the bump ships before launch, not
after**, with D-068's announcement path exercised end to end across the real
bump; public launch.

## M6 — CISA KEV overlay  `in progress`

Scope: server-side KEV fetch and cache (D-010), joined to the corpus
client-side. Small and self-contained. The gate the original scope set —
record KEV's redistribution terms before anything ships — was discharged at
decomposition: **CC0 1.0 Universal, no notice obligation** (D-076), verified
2026-08-08 from CISA's own license text, so nothing has to travel with the
data and the open question becomes pure engineering. The wire shape is also
settled there: `kev.json` is a standalone mutable file *outside* the manifest,
served verbatim, and client-side KEV is a **client-built, D-013-style
rebuildable table** — never part of the artifact or its schema version, which
is what lets the overlay ship without the post-launch re-download a schema
bump now costs (D-068, D-070).

Three shape decisions were taken by the owner at decomposition (2026-08-08),
following M4 and M5's precedent, because each changes what the tasks below
are. **KEV is a report dimension, not just a filter** — In KEV / Not in KEV
and ransomware use as rows/series axes, which is what makes "KEV share of
criticals over time" a chartable report and gives M7's KEV tool (D-044) a
dimension to emit rather than only a predicate. **The client fetches KEV on
Download and Sync only** — a download ends by fetching the catalog, a sync
refreshes it when `catalogVersion` moved, and no request happens outside the
actions users already understand. **All eleven fields ship** — at 1,662 rows
the storage cost is noise, the detail view gets CISA's remediation text, and
the SQL console gets the whole catalog.

One framing point so it is not re-litigated per surface: **"Not in KEV" is a
real value, not an absence band.** Unlike an SSVC point nobody assessed,
absence from the catalog is the finding — *not known-exploited, per CISA* —
so the complement is an ordinary categorical slot, labeled with its
provenance ("per CISA, as of \<dateReleased\>"), never the off-ramp neutral
M5 gave the unassessed.

Tasks in dependency order. The nginx location precedes the first publish
because the first fetch through Cloudflare pins whatever cache policy is in
place — the M5 finding this milestone would otherwise inherit.

- [x] **KEV's redistribution terms, recorded** (D-076). Done at decomposition,
      2026-08-08: CC0 1.0 Universal — a full waiver, no notice or attribution
      owed on any copy or export. The only riders sit outside copyright: no
      CISA logo or DHS seal, and nothing presented as CISA endorsement — which
      the provenance line ("per CISA, as of \<dateReleased\>") satisfies by
      stating the relationship instead of implying one. D-008's second-source
      reopen is exercised and closed; MITRE's notice still governs the CVE rows
      KEV columns appear beside.
- [ ] **The nginx location** (owner-applied, **outstanding**). The block is
      written and in [architecture.md](architecture.md): `location =
      /data/kev.json` at `no-cache` — an exact match, so it outranks
      `^~ /data/`; the security headers repeated (`add_header` does not merge,
      D-053); and no `always` on the Cache-Control line, so error responses
      stay uncached at the edge (the M5 404-poisoning fix applies to this block
      from birth). `no-cache` rather than a small `max-age`, which is the other
      reading of "short": the client fetches `no-store` anyway (RE-023), so
      only the edge is affected, and this is the policy the manifest has
      already proved behaves correctly through the proxy.

      `scripts/serve.mjs` matches it locally — and matches it on the *resolved
      file path*, because nginx decodes and merges slashes before selecting a
      location, so comparing raw pathnames would serve `/data/%6Bev.json`
      `immutable` and be looser than production (RE-012's rule, in the
      direction that rule forbids). `tests/e2e/headers.spec.ts` asserts the
      policy and that a 404 is not cacheable for a year; **the 404 half only
      means anything against the real origin** — the local server has no
      `always` flag to model — so it is confirmed with
      `BASE_URL=https://cve.meenan.dev pnpm e2e headers`.

      **Nothing may publish a catalog until this is applied and verified**: the
      first fetch through Cloudflare pins whatever policy is in place, and
      correcting it afterwards needs a purge. architecture.md's contract table
      keeps an "owner-applied, unverified" caveat until then.
- [x] **The pipeline half.** `pipeline/kev.py` on its own cron (`41 */6 * * *`),
      its own failure domain: its own lock file and its own state directory, so
      the two jobs share a `flock` helper and nothing else. Fetch from cisa.gov
      with the `cisagov/kev-data` mirror as the fallback (D-076 §3) — both
      exercised, and both served **byte-identical** content on 2026-08-08
      (1,662 entries, 1,577,762 bytes, sha256 `2a6c54ce…`). Validation is
      fail-closed and everything published is checked; the bytes are published
      verbatim by atomic rename, and a refusal leaves the previous catalog
      serving. `status` reports what is served beside when the job last ran and
      last succeeded. **52 pipeline tests, and every guard was checked by
      removing it and watching a test fail.**

      **The two reviews found more than the tasking anticipated, and the
      findings compounded into one story**: a hostile or merely broken upstream
      could freeze the catalog *permanently* while `kev.py status`, the exit
      code and the cron log all reported success. Four things had to change.
      Only `Refuse` recorded an outcome, so a run that died any other way — a
      full disk, a `ValueError` from `int()` on an unbounded `catalogVersion` —
      left the state reading healthy. The socket timeout bounded each read
      rather than the transfer, and the job holds its lock across the fetch, so
      a peer dribbling one byte per timeout was a permanent freeze (reproduced:
      a 2 s timeout held a connection for 12 s and scaled linearly). The
      roll-backwards guard *defends whatever it is holding*, so one catalog
      claiming `99999999.1.1` was published once and then protected against
      every real one, rendering as fresh because the same party chose
      `dateReleased` (D-077 §3). And `Infinity`/`NaN` — which Python parses and
      `JSON.parse` refuses — would have shipped verbatim and taken the overlay
      down for every user while the cron reported success.

      Smaller, same class: `http.client.HTTPException` is not an `OSError`, so
      a truncated response never reached the mirror the fallback exists for;
      lone surrogates (RE-015, for the second untrusted source) reached SQLite;
      dates were shape-checked but not calendar-checked; a failed publish left a
      `.tmp` file in the **web-served** directory for `^~ /data/` to serve
      `immutable`; and `state.lock`'s new `name` argument was **dead code**, so
      every job took `pipeline.lock` and the failure-domain claim rested on the
      directories differing rather than on the mechanism the docs described.
      Two of the four `FailureDomain` tests passed with the mechanism removed;
      they now observe the lock file on disk and hold the *corpus* lock while a
      KEV run completes.
- [x] **The client fetch and the local `kev` table.** Fetched same-origin with
      `no-store` (RE-023 — the freshness signal is a network request or
      nothing), streamed and bounded like every other body, and validated again
      in the browser rather than trusted: a client that took the server's word
      would be trusting a check it cannot see, through a mutable URL with a
      cache in front of it. Applied in one transaction — the table, the rows,
      and the `meta` keys that describe them — so a failure leaves the previous
      catalog intact and answering. `cveID` resolves to `cve.id` at load; an
      entry the corpus lacks keeps its row and is counted rather than dropped.
      Runs as a writer under the Web Lock and is announced, so other tabs'
      freshness lines agree. A download ends by fetching KEV **after** the
      catch-up (D-063's ordering), a sync refreshes it, and `Refresh KEV` is
      its own action so a failure is retryable without re-running either.

      **It also aged an M2 assumption out from under three staged-replacement
      tests.** `imported` is no longer the end of a download — it continues into
      a catch-up and now a KEV refresh, both writing to the *live* database — so
      `tests/e2e/staged.spec.ts`'s exact OPFS entry-set assertions were listing
      the origin mid-transaction and finding a rollback journal beside the live
      file, and navigating away at that moment left one behind for real. Not a
      leaked generation, but enough to fail the assertion, and it failed on
      Firefox where Chromium's timing had hidden it. Every such assertion now
      waits for the app to report itself idle first, and the audit that found
      the rest of them is written down beside the helper.

      **And the e2e found a second one that no unit test could ever see**
      (RE-028): the *bundler* dropped a literal segment out of a template
      carrying `${…}` that was concatenated with `+` across two lines, so the
      browser ran `k.ransomware = 1WHEN k.ransomware = 0` — SQL the source never
      had — and SQLite refused it. `pnpm check` was green,
      `tests/unit/filters.test.ts` executed the affected expression against real
      SQLite and passed, and the failure surfaced as an export download event
      that never fired, several steps from the cause. Unit tests import the
      source; only the browser runs the bundle. Every interpolated SQL fragment
      is now one literal, and `scripts/check-bundle.mjs` runs on every build and
      refuses a bundle with a SQL keyword glued to a digit — checked by
      re-splitting the literal and watching it fail.

      **Writing the e2e found the defect the unit tests could not see.** A KEV
      refresh reported its own start and then never reported an ending, and the
      page derives *busy* from the Worker's progress phase — so after a download
      every button in the app was disabled, permanently, with the catalog
      correctly loaded and the freshness line correctly rendered above them.
      Every unit test passed, `pnpm check` was green, and the app was unusable.
      It presented as this spec waiting ten minutes for a Run button that was
      never going to enable; the fix is a terminal `report('ready', …)` on
      **both** paths — a failed refresh must also return to `ready`, because the
      corpus operation succeeded and the copy is queryable — plus an assertion
      right after the download so the next occurrence is thirty seconds and a
      sentence rather than a test timeout with no obvious cause.

      **The client-half reviews found that the client had validated the wrong
      half.** It re-implements the pipeline's *shape* checks — deliberately,
      because a client that trusted the server would be trusting a check it
      cannot see — and had none of the *ordering* ones, which are the half that
      defends against the thing that makes the re-validation necessary: a
      mutable URL with a cache in front of it. One poisoned response could
      therefore replace a current catalog with a 2019 one, and because "Not in
      KEV" is a real value here rather than an absence, the app would then
      positively assert *not known-exploited, per CISA* for everything listed
      since — persisted in OPFS, honest-looking offline, agreeing across tabs,
      and rendering as maximally fresh, because `describeFreshness` clamps a
      future stamp to zero and the same party chose `dateReleased`. The client
      now carries its own roll-backwards guard and its own future ceiling
      (D-077 §3); the ceiling is what makes the guard safe to have, since
      nothing can install a floor real catalogs cannot clear.

      Beside it: `catalogVersion` and `dateReleased` were the only catalog
      strings reaching the DOM on *every* session and the only two nothing
      bounded, so a hostile catalog could wedge a multi-megabyte string onto the
      front page permanently; a refusal echoed up to 20,000 characters of
      attacker-authored prose back in the app's own voice; `splitNotes` was
      quadratic on a long part with no match (~0.3 s of main thread *per
      render*); and the notes' label was validated, tested, and then dropped by
      the component that was supposed to render it — with the e2e's own
      assertion iterating **zero** links and reporting the hardening verified,
      which is the RE-024 shape exactly.

      **And three places where the prose was wrong rather than the code.** The
      `k.cve` vs `k.cve_id` distinction the comment called "the one place the
      difference matters" does not exist given that ON clause — a row with a
      null `cve_id` never reaches the join at all — so the unmatched entries are
      preserved by the nullable column and the unmatched count, not by the
      grouping expression. The `kevRansomware` NULL band was called an absence
      in prose and given a categorical slot in code; the code is right (there is
      no scale for an absence to be misplaced on) and the prose now says so.
      And that band had **three different names** across four surfaces —
      "(not stated by CISA)" on the chart and in the detail view, "(not
      assessed)" on its own filter checkbox and chip — which is how a reader
      concludes they are three bands. One `absenceLabel(axis)` now serves all
      four. KEV also stopped borrowing the corpus's two-day staleness
      threshold, whose justification is "the pipeline publishes daily": CISA is
      *business*-daily, so a Friday catalog was painted stale every weekend with
      nothing wrong and nothing to fetch.

      One thing is deliberately **not** built: the overlay gets no storage
      preflight of its own, unlike a download (M5). The bounds are what stand in
      for it — 32 MB of body, 100,000 entries, every string capped — and the
      apply is one transaction, so a quota failure rolls back and leaves the
      previous catalog answering. Budgeting a megabyte-scale write against a
      441 MB corpus would be ceremony.

      **Two shape calls came out of building it** (D-077). The refresh is
      applied unconditionally rather than only when `catalogVersion` moved —
      1,662 rows is milliseconds, and the version is not the only thing that
      goes stale: `cve_id` is resolved at load, so a sync that brought in the
      records CISA listed last week turns unmatched entries into matched ones.
      And **the table is created by the apply that fills it**, never empty on
      open: its absence is the signal that no catalog is loaded, so a KEV
      question against a copy that has none is refused by name instead of
      answering that nothing is known to be exploited.
- [x] **The query surface.** KEV membership and ransomware use are filter axes
      with grouped counts and rows/series dimensions, `dateAdded` and `dueDate`
      are date ranges, and every one of them rides the existing machinery —
      `CODE_AXES` gives them checkboxes, chips and a permalink round trip
      without a branch. Filters compile to `EXISTS`/`NOT EXISTS` rather than to
      the dimensions' join, so a filter can never change how many times a
      record appears even though this particular join is 1:1; the test asserts
      the 1:1 against the record that affects two products rather than assuming
      it. The complement is a categorical slot carrying its provenance, and the
      *listed* band sorts first — D-073's argument for CRITICAL at the
      baseline, applied to the band that is 0.4% of the corpus. Record exports
      grow six KEV columns led by a computed `kev_listed`, with the catalog
      version and date in the preamble; the SQL console reaches the table
      through the existing authorizer with no new work.

      **Two things are absent on purpose.** The KEV columns are absent from an
      export made without a catalog rather than present and empty — a blank
      `kev_date_added` cannot be told from a column nobody filled in, and which
      of those it is *is* the claim (D-077 §1). And `k.cve` is what the
      dimensions group on, never `k.cve_id`: `cve_id` is NULL for a record CISA
      *has* listed that this copy does not hold, so grouping on it would file
      those entries under "not in KEV" — the one place the two nulls mean
      opposite things.
- [x] **The detail view, freshness, and diagnostics.** The per-CVE detail gains
      a KEV block above the references, because it is the strongest single
      statement anything on that surface makes about a record: `dateAdded`,
      `dueDate`, `requiredAction`, ransomware use in **three** states — Known,
      Unknown *per CISA*, and "(not stated)" for a listed record whose value
      this build cannot read — and the `notes` URLs. CISA writes `notes` as a
      `;`-separated run of labelled URLs, so it is split and each part goes
      through the reference list's own treatment: scheme allowlist, visible
      host, `noreferrer`/`no-referrer`, never auto-fetched, and a refused one
      rendered as text with the reason rather than disappearing. The
      development catalog carries a `javascript:` token so that is asserted
      rather than assumed.

      Freshness is its own line, because the two datasets are on two cadences
      and one number would be wrong about whichever moved last: `catalogVersion`,
      the *release* age (not the fetch's — a browser that re-fetched an
      unchanged catalog has not made it newer), the unmatched count, and when
      this browser fetched it. Read out of the copy like the corpus's, so it is
      honest offline and agrees across tabs. Diagnostics carries the same facts
      in one line to paste into a bug report, plus the last refresh error.

**Exit criteria:** KEV's terms are recorded (D-076) and provenance — source,
`catalogVersion`, `dateReleased` — is visible wherever KEV is asserted, with
no notice invented and nothing presented as CISA endorsement; the live origin
serves `kev.json` published by the cron under its own nginx location, verified
from response headers through Cloudflare — short/revalidating cache, never
`immutable`, error responses uncached — closing the M5 finding rather than
inheriting it; KEV status is queryable, filterable, *and chartable*: a
filtered count agrees with its grouped count (M3's pattern) and a
KEV × severity report renders reconciled with its table (M4's); KEV staleness
is surfaced separately from the corpus's, including offline and across tabs;
a KEV fetch failure or a malformed/hostile catalog leaves the corpus
operation unaffected and the previous catalog answering with its age
reported, verified by tests in both engines; and the detail view's KEV block
renders a hostile fixture under the existing reference hardening.

**Exit criteria — the client half is met, the origin half is not, and the
milestone stays open on the second.** `tests/e2e/kev.spec.ts` passes on **both
engines** — Chromium and Firefox, three tests each — against a data plane
carrying a catalog: a download
ends with one, membership filters and its grouped count agree, a KEV × severity
report renders with **both** bands and reconciles with its table, the detail
block's note links are all `http(s)` with `noreferrer`, a second tab reports the
same catalog, and a cold reopen with the network killed still shows it. Both
failure shapes hold: a 503 and a malformed-but-parseable catalog each leave the
previous one serving with the failure reported beside it, and a sync still
succeeds afterwards; a copy with no catalog refuses a KEV question by name while
every other query still works.

**What is not met is the origin half**, and it is the item the whole milestone
was ordered around: `location = /data/kev.json` is owner-applied and has not
been applied, so nothing has published a catalog and no response header has been
verified through Cloudflare. Until then the exit criterion's first clause — the
live origin serving `kev.json` under its own location — is unmet by
construction, and publishing before it would be the failure the ordering
exists to prevent.

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
