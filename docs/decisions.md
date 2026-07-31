# Decision log

Newest first. Every entry: what was decided, why, and what would reopen it.
Existing entries are never edited into a different decision — reversing or
amending one gets a *new* entry that supersedes it (a status-line annotation on
the old entry is fine). Entries that rest on claims about current technology
state must be grounded in current sources or local experiments — not training
knowledge — and note what was checked and when.

**Reading:** scan the D-NNN headings (or grep) and read only the entries your
task touches. Full read is for structural or cross-cutting work.

**Culling:** the log may be periodically pruned — superseded or moot entries
whose context no longer informs anything current are deleted outright; git
history is the archive. D-numbers are never reused.

Format:

```
## D-NNN: Title  (YYYY-MM-DD, status: accepted | proposed | superseded by D-MMM)
Decision / Context / Consequences / Reopen if
```

---

## D-030: Server configuration baseline, and the two changes M1 needs  (2026-07-31, status: accepted)

**Decision.** Adopt the existing `cve.meenan.dev` nginx block as the baseline.
Two changes are required before M1 ships, both small:

1. Add `brotli_static on;` to the server block, so a precompressed `.br` snapshot
   (D-026) is served with `Content-Encoding: br`.
2. Set `trailingSlash: true` in `next.config.js` rather than editing `try_files`.
   Next then emits `/route/index.html`, which the existing
   `try_files $uri $uri/ =404;` already resolves — no nginx routing change.

**Context.** Read directly from `plex` on 2026-07-31, answering most of Q-005:

| Fact | Value |
| --- | --- |
| nginx | 1.30.2, `--with-http_gzip_static_module` |
| brotli modules | `ngx_http_brotli_filter_module.so` **and** `..._static_module.so`, both loaded at `nginx.conf:1-2` |
| brotli directives | **none anywhere** — modules loaded but not enabled |
| COOP/COEP on `cve.meenan.dev` | **already set**, at server level and in the HTML location |
| Routing | `try_files $uri $uri/ =404;` — no `$uri.html` |
| PHP | `include php.conf` → php-fpm 8.4 over a unix socket, running as **user `pmeenan`** |
| PHP path safety | `if (!-f $document_root$fastcgi_script_name) { return 404; }` |
| Cache headers | HTML `no-cache, must-revalidate`; `expires max` for `js|css|png|jpg|…` |

**Consequences.** The most significant finding removes a blocker rather than
adding one: **COOP/COEP are already served**, copied from the `webai` and
`keepawake` blocks where the owner uses the same pattern. So the `opfs` VFS is
available today, and D-027's warning that Next.js static export cannot emit
response headers is moot — nginx already emits them. Q-004 is now a pure
performance-and-concurrency question with no server-config obstacle on either
side.

php-fpm running as `pmeenan` means the endpoint can read
`/var/www/meenan.dev/cve.data/` (D-018) with no permission work. That
convenience is also a hazard worth recording: the endpoint runs as the user that
owns the clone, the artifacts, *and* the document root, so a flaw in it has
write access to all three. The endpoint only ever needs to read two
directories. Tightening that — a dedicated pool user, or read-only paths — is a
Q-005 hardening item, not a blocker.

Two smaller gaps: the `expires max` list covers `js|css|png|…` but not
`.sqlite`, `.br`, or `.wasm`, so the weekly snapshot would not get long-lived
cache headers it deserves; and `application/wasm` is in `gzip_types` but the
snapshot's type is not.

**Reopen if.** The host's nginx is rebuilt without the brotli modules, or the
PHP pool arrangement changes.

## D-029: M0 closes on planning questions; measurement spikes move to M1  (2026-07-31, status: accepted, amends the M0 exit criteria)

**Decision.** M0's exit criteria no longer require every open question answered.
Q-003 (browser-side budgets) and Q-004 (OPFS VFS selection) move into M1, where
they are measured against real scaffolding. M0 closes when the *planning*
questions are settled: the delta protocol, schema completeness, the architecture
draft, and the milestone ladder.

**Context.** Stated by the project owner 2026-07-31: *"we don't have to have all
of the answers up front, we can iterate as we go since we will discover more as
we build."* The trigger was a sequencing problem — Q-003 and Q-004 both require
running SQLite/WASM in a real browser under Playwright, and no application
scaffolding exists, so M0 as originally written could not close without either
building a throwaway harness or pulling M1 forward.

The original criteria were written deliberately airtight, so relaxing them
deserves a reason rather than just permission. The reason holds: M0's purpose
was to stop us building on unexamined assumptions, and the assumption with the
most rework attached — how data reaches the client — was settled with
measurements in D-024 through D-026. Q-003 and Q-004 are measurements *of an
implementation*, not inputs to a design; deferring them risks tuning, not
rework.

**Consequences.** M1 gains two spikes and stops being purely scaffolding, which
is honest — the "smallest change that exercises the riskiest substrate" was
always going to answer these. If Q-003's browser numbers come back bad, the
fallback is already identified in D-024 and D-025: ship the ~86 MB of structured
data first and defer text plus FTS. That is a real risk being carried
deliberately into M1 rather than retired in M0.

More broadly this sets the project's posture: milestones close on what they can
honestly settle, and open questions may cross milestone boundaries so long as
they stay recorded. Silent drift is still forbidden — a question moving between
milestones is a plan edit, not a quiet reprioritization.

**Reopen if.** Deferred questions start accumulating faster than they are
answered, which would mean the posture has become an excuse rather than a
sequencing choice.

## D-028: UI dependencies must be free and open-source  (2026-07-31, status: accepted)

**Decision.** Grid, charting, and editor components must be OSS under a
D-002-compatible license. AG Grid Enterprise and other commercially-licensed
component suites are rejected. AG Grid Community (MIT) and TanStack Table (MIT)
are both acceptable; the specific grid is chosen when the work starts.

**Context.** Chosen by the project owner 2026-07-31 when the licensing fork was
raised: AG Grid publishes Community under MIT (v36.0.2, verified same day) but
gates pivoting, row grouping, master-detail, and integrated charts behind a
commercial Enterprise license.

**Consequences.** The project stays fully open-source with no per-seat cost,
which matters for a public tool where any user could also be a contributor, and
D-002's policy needs no exception. The cost is concrete: pivoting and row
grouping are hand-built if wanted rather than configured. Verified 2026-07-31 as
MIT or Apache-2.0 and therefore available: `ag-grid-community` 36.0.2,
`@tanstack/react-table` 8.21.3, `recharts` 3.10.1, `@visx/visx` 4.0.0, `echarts`
6.1.0 (Apache-2.0), `uplot` 1.6.32, `@uiw/react-codemirror` 4.25.11.

**Reopen if.** A reporting feature turns out to need pivoting badly enough that
building it by hand costs more than a licence — an explicit owner call, not an
agent's.

## D-027: React 19 on Next.js 16 static export — supersedes the UI half of D-017  (2026-07-31, status: accepted, supersedes D-017 in part)

**Decision.** The UI is React 19 on Next.js 16 with `output: 'export'`, building
to fully static HTML/CSS/JS. Svelte 5 and Vite-as-app-bundler are dropped.
Everything else in D-017 stands: TypeScript strict, Vitest, Playwright, ESLint +
Prettier, pnpm, plain PHP 8.4.

**Context.** The owner delegated the stack at kickoff ("M0 picks"), D-017 chose
Svelte 5, and the owner revisited it on 2026-07-31 with priorities that
invalidated D-017's central argument. D-017 picked Svelte partly for a small
runtime beside a heavy WASM payload; the owner's direction is that **richness of
framework capability matters far more than bundle size**, given the data
download dwarfs any framework, and that SSG plus hydration is wanted for fast
first load.

That inverts the reasoning. D-017 had already recorded React's larger ecosystem
and greater training-data density as the counter-argument, noting it was a
genuine reliability factor in a project where agents write nearly all the code
(D-001) — with size deprioritized, that counter-argument simply wins. The
concrete gap is data grids: TanStack Table ships a Svelte adapter, but AG Grid
has no first-class Svelte wrapper, and Recharts and visx are React-only.

Verified against the Next.js 16.2.12 documentation, 2026-07-31:

- `output: 'export'` produces an HTML file per route with client-side navigation
  after hydration — SSG plus hydration, no Node server at runtime.
- Output lands in `out/` by default and `distDir` can redirect it, so it is
  configured to `dist/` to match D-003 rather than changing the deploy contract.

**Consequences.** Every React data library is available, and the static export
matches D-003's rsync deploy with no server-side build. Three consequences need
acting on rather than noting:

1. **nginx needs rewrite rules.** Static export emits `/route.html`; clean URLs
   require `try_files $uri $uri.html $uri/ =404;` per the Next documentation.
   This joins the brotli-module question (D-026) as server configuration to
   settle in the Q-005 spike.
2. **Next cannot set response headers in static export** — `headers` is on the
   documented unsupported list, along with rewrites, redirects, middleware, ISR,
   and Server Actions. This lands directly on **Q-004**: if the `opfs` VFS is
   chosen, its COOP/COEP headers must come from nginx, because the framework
   cannot supply them. `opfs-sahpool` needs no headers and is unaffected.
3. **The PHP endpoint must survive `rsync --delete`.** Since D-003 mirrors
   `dist/` into the docroot, the endpoint has to be part of the build output.
   Placing it in Next's `public/` directory should achieve this, as `public/` is
   copied to the export root — **confirm in M1 before relying on it**, since the
   static-export documentation does not state it explicitly.

Vitest is retained: it runs standalone and does not require Vite to be the
application bundler.

**Reopen if.** Next's static export gains constraints that conflict with a
confirmed feature, or the framework proves to be fighting the Worker/WASM/OPFS
boundary that D-004 forces.

## D-026: Download is snapshot + catch-up deltas; snapshots rebuild weekly  (2026-07-30, status: accepted, refines D-025)

**Decision.** The server publishes a **compressed full snapshot on a slow
cadence — weekly by default** — and a continuous stream of deltas keyed to it.
"Download data" fetches the cached snapshot *and* every delta since that
snapshot was taken, leaving the client current in one operation. "Sync" fetches
deltas since the client's own watermark. Both paths end in the same place, so
they share one apply implementation.

Retention rule: deltas are kept back to the current snapshot and no further. A
client whose watermark predates the current snapshot re-downloads rather than
being served an unbounded delta chain.

**Context.** Proposed by the project owner 2026-07-30. The problem it solves is
server cost: D-024's artifact rebuild is cheap (19 s) but *compression* is not —
brotli -q10 takes **239 s** to produce the 72.1 MB snapshot, confirmed by two
independent runs. Recompressing 272.8 MB on every hourly upstream fetch would be
almost entirely wasted work, since only ~1,300 records change per day (D-025).
The owner separately capped brotli quality at 10, q11 costing significantly more
time for little further gain.

The arithmetic strongly favors it. A week of deltas measured 1.50 MB gzipped
against a ~72 MB snapshot, so a brand-new user in the worst case — arriving
the moment before a rebuild — downloads about **2% more** than someone arriving
just after one. In exchange, full-artifact compression drops from roughly 168
times a week to once.

**Consequences.** The snapshot becomes a genuinely static file: built once,
compressed once, served many times, cacheable, and resumable via ordinary HTTP
range requests — which is most of what the "resumable download" feature needs.
Nothing in the hot path recompresses anything large; delta payloads are small
enough that compressing them is negligible.

It also collapses a distinction that was about to become two code paths. Under
D-025, Download and Sync were separate operations; here Download is just Sync
from a watermark of "whatever the snapshot contains." The client always ends by
applying deltas until current, and the four D-025 hazards need solving exactly
once.

Three things this introduces that need answers in Q-001:

- **Delta merging.** A client asking for a week of changes should receive each
  record's *final* state, not every intermediate revision. Serving the raw
  hourly sequence works but is wasteful and re-applies churn; a merged delta per
  watermark range is better and can be cached by range.
- **Watermark after download.** The client's watermark must end at the last
  delta applied, not at the snapshot's — otherwise the next sync silently
  re-fetches a week.
- **Snapshot cadence is a tuning knob, not a constant.** Weekly is a starting
  point chosen from the 1.50 MB/week measurement. At these rates even monthly
  would only accumulate ~6 MB, so the cadence can be relaxed if compression cost
  becomes the binding constraint.

One server-configuration dependency to verify in the Q-005 spike: serving a
precompressed snapshot with `Content-Encoding: br` requires either nginx's
brotli module or a location block that sets the header explicitly for a
prebuilt `.br` file. This has not been checked on `plex`.

**Reopen if.** Upstream change volume rises enough that a week of deltas becomes
a significant fraction of the snapshot, or compression stops being the reason
for the cadence.

## D-025: Bulk import with explicit Download and Sync — settles the data-delivery architecture  (2026-07-30, status: accepted, refined by D-026)

**Decision.** Candidate (a). The client downloads a complete prebuilt artifact on
an explicit **"Download data"** action, and applies incremental changes via a
custom delta format on an explicit **"Sync"** action. Both are user-initiated;
neither happens automatically. Candidate (b), the field-and-partition projection
API, is rejected.

**Context.** Decided by the project owner 2026-07-30, on two grounds. First,
storage is not a constraint: the owner runs other experiments storing tens of
gigabytes of WASM models in OPFS, so a few hundred megabytes is unremarkable.
Second, the D-024 normalization spike removed bulk import's only real weakness —
the full corpus is 98.7 MB gzipped, less than candidate (b)'s own two-year
motivating slice in raw form.

Delta economics were measured the same day against `cves/deltaLog.json` over a
31-day window and the spike database:

| | Changed records | Gzipped payload |
| --- | --- | --- |
| Median day | 1,312 | **0.17 MB** |
| Mean day | 1,749 | 0.24 MB |
| Busiest day observed | 6,147 | 0.78 MB |
| One week | ~12,000 | 1.50 MB |

A median day's delta is roughly **574× cheaper** than re-downloading, which is
exactly the owner's point about not re-fetching a full database daily for tiny
changes. At these rates a client would need to be stale for something on the
order of a year before a full re-download won on bytes — so in practice there is
no "delta too large, start over" threshold except a schema change.

**Consequences.** This discharges the debt D-015 took on. Coverage tracking is
no longer needed, and vision criterion 7 — results are never quietly wrong —
becomes structural again rather than machinery we maintain: the client either
has the whole corpus or has not downloaded it yet. Q-001 collapses from ragged
multi-version cache reconciliation to ordinary delta application, and Q-005
shrinks because the endpoint no longer takes caller-supplied field or partition
parameters — it serves a static artifact plus a delta by watermark. Offline
becomes complete rather than partial.

Making both actions explicit has a consequence that needs designing rather than
assuming: **the user is now responsible for freshness, so the UI must make
staleness visible.** A silently month-old corpus producing confident counts is
its own species of quietly-wrong. Sync should also be non-destructive — a failed
or interrupted delta must leave the previous consistent state intact rather than
a half-applied one.

The delta protocol is now the main design problem, and it carries four hazards
worth naming before anyone implements it:

1. **Interned IDs must be server-assigned and permanently stable.** D-024's
   lookup tables key CWE, CNA, vendor, and product by integer. If a client
   interns locally, a delta referring to vendor `24421` binds to a different
   vendor on every client. The server must own the ID space, never renumber it,
   and ship new lookup rows inside the delta that references them.
2. **FTS5 external-content indexes do not maintain themselves.** The spike uses
   `content='cve_text'`. Updating a row requires an explicit
   `INSERT INTO fts(fts, rowid, …) VALUES('delete', …)` before re-inserting, or
   the index silently drifts out of agreement with the table — producing wrong
   search results with no error. This is the single most likely way to violate
   vision criterion 7 under this architecture.
3. **Deletions need tombstones.** State transitions such as PUBLISHED → REJECTED
   are ordinary updates, but a record removed upstream will otherwise persist in
   every client forever.
4. **Schema changes cannot be deltaed.** When the artifact's schema version
   moves, the delta path cannot bridge it and the client must re-download.
   D-013 already establishes the local database as a rebuildable cache, so this
   is acceptable — but it must be explicit in the UI, not a surprise.

One encoding question is already settled by measurement: positional/compact row
encoding gzipped to about the same size as plain JSON objects, so the codec is
not worth building. Send readable JSON and let transport compression work.

**Reopen if.** Browser-side measurement in the bake-off shows the 98.7 MB import
cannot complete or persist acceptably — the fallback is the hybrid identified in
D-024, shipping the ~86 MB of structured data first and the 187 MB of text and
FTS on first search.

## D-024: Served artifacts are normalized and interned, never raw upstream JSON  (2026-07-30, status: accepted)

**Decision.** The server derives a normalized relational artifact from the
corpus. Repeated descriptive text is interned into lookup tables keyed by ID,
and upstream sections that carry no queryable value are dropped rather than
stored. This holds regardless of how the data-delivery question resolves — bulk import and
projection both ship normalized data.

Dropped outright:

- `cna.x_legacyV4Record` — a complete duplicate of each record in the retired
  CVE v4 format. **19.1% of compact corpus bytes.**
- `containers.adp` as a stored blob — **21.5% of bytes**. ADP enrichment is
  mined for CVSS and CWE values, which are merged into the normalized columns,
  and then discarded.
- `cna.providerMetadata` (3.0%) — org identity, interned to a `cna` row instead.
- JSON formatting whitespace — files average 7,886 bytes on disk but 3,658
  compact, so **~54% of the raw corpus is pretty-printing**.

**Context.** The owner observed that the raw JSON carries a lot the tool does
not need and a lot of structure that could be indexed — naming problem type and
severity specifically. Measured against the full corpus 2026-07-30 by building
the artifact rather than estimating it. The owner's instinct was right, and the
interning cardinalities show why:

| Lookup | Distinct values | Was repeated across |
| --- | --- | --- |
| CWE (`problemTypes`) | **797** | 189,690 associations |
| CNA (`assignerShortName`) | **479** | 372,092 records |
| Vendor | 24,420 | 523,446 associations |
| Product | 80,063 | 523,446 associations |

Each CWE's descriptive text — strings like *"Improper Neutralization of Input
During Web Page Generation ('Cross-site Scripting')"* — was being carried in
every record that referenced it. There are 797 of them.

Result: **2,934 MB of raw JSON becomes a 272.8 MB queryable database** — base
tables 182.8 MB, +33.1 MB indexes, +56.9 MB FTS5 — which is 98.7 MB gzipped.
Full parse and build took 19 s for all 372,092 records.

**Consequences.** A 16× reduction changes what is architecturally possible, and
it is the strongest evidence yet bearing on the data-delivery question — see the analysis in
[architecture.md](architecture.md), which the bake-off must now confirm in a
browser rather than on server hardware.

The composition matters as much as the total: `cve_text` (131.6 MB) and
`fts_data` (55.1 MB) are 68% of the database, while every structured column
anyone filters or aggregates on fits in roughly 86 MB. Text and search are the
expensive half, and they are separable — which is the natural seam if cold start
needs to be faster than a full download.

**These figures are a floor, not the final size.** The spike schema deliberately
omits references (10.6% of corpus bytes), affected version ranges, CPE
applicability, solutions, credits, and timeline. D-011 also requires FTS over
references, which this build does not include. A production schema will be
larger, and how much is exactly what Q-002 must settle.

**Reopen if.** A confirmed feature needs a section dropped here — in which case
add it to the schema deliberately and re-measure, rather than reinstating raw
JSON storage.

## D-023: Descriptions are stored English-only  (2026-07-30, status: accepted)

**Decision.** Only descriptions tagged as English are stored and indexed for
search. Other-language descriptions are discarded at ingest.

**Context.** Stated by the project owner 2026-07-30. Measured the same day over
a 12,000-record sample: the only language tags present are `en` (11,465
descriptions) and `de` (299). Non-English text is 3.1% of description bytes.

The check that mattered: **zero records have a non-English description without
an English one**, so English-only makes nothing unsearchable. Separately, 4.46%
of records carry no description at all — largely REJECTED records (D-022) —
which is why `cve_text` holds 354,376 rows against 372,092 records.

**Consequences.** Little is saved in bytes, so this is a simplification
decision rather than a size one: one language means one FTS5 tokenizer, no
per-language index selection, and no language column to filter on. Records
without English text simply have no FTS row and cannot match a search — the UI
must not present that as "no results found" when the truth is "this record has
no indexed text."

**Reopen if.** The CVE Program's language mix broadens materially — the current
99.5%/0.5% split is what makes this free — or non-English search is requested.

## D-022: REJECTED records are imported, excluded by default, and filterable  (2026-07-30, status: accepted)

**Decision.** Records with `cveMetadata.state == "REJECTED"` are imported and
carry `state` as a queryable column, but are excluded from counts, aggregates,
and reports unless the user explicitly opts in.

**Context.** Chosen by the project owner 2026-07-30. Measured the same day over
a 20,000-record random sample of the corpus: **4.9% are REJECTED** (989 of
20,000), the remainder PUBLISHED — roughly 18,000 records corpus-wide. Nothing
in the feature ledger had accounted for them.

**Consequences.** Every aggregate must carry a default `state = 'PUBLISHED'`
predicate. That is easy to write and easy to forget, so it belongs in a shared
query layer rather than in each report — a forgotten predicate silently inflates
counts by ~5%, which is exactly the quiet wrongness vision criterion 7 exists to
prevent. Any published record count should reconcile against official CVE
Program figures, and a mismatch of roughly this magnitude is the first thing to
check.

Importing rather than discarding keeps rejection-pattern analysis possible —
which CNAs reject most, and why — at negligible cost, since the records are
small. Users who opt in must be shown clearly that rejected records are
included, because a chart that silently changes denominator is worse than one
that refuses to.

**Reopen if.** REJECTED records prove analytically inert in practice, or the
corpus grows a third state that makes a boolean opt-in insufficient.

## D-021: Shallow clone — supersedes D-019  (2026-07-30, status: accepted, supersedes D-019)

**Decision.** The server clone is
`git clone --depth 1 --no-tags https://github.com/CVEProject/cvelistV5.git`.
No history is retained.

**Context.** D-020 dropped the revision count, which triggers the exact reopen
condition D-019 recorded for itself: *"Reopen if D-012 is dropped — at which
point shallow becomes strictly better and should be adopted."* With no consumer
of commit history, the ~295 MB of trees and commits measured in D-019 buys
nothing. `--no-tags` matters here specifically: cvelistV5 publishes hourly
tagged releases, so tags would otherwise dominate the refs for no benefit.

**Consequences.** Measured after re-provisioning 2026-07-30: the pack drops from
581 MiB to **280.55 MiB** and clone wall-clock from 169 s to **68 s**, at the
same HEAD (`a42a2eb6c2`) with an identical 372,092 records. The checked-out
worktree is unchanged at 3.7 GB on disk, since that is current content either
way.

More importantly it removes a data path rather than shrinking one: no history
walk after each fetch, and no derived column that must stay consistent across
incremental syncs.

The tradeoff is that history becomes unavailable without re-cloning, so any
future feature wanting per-record change data — the D-012 family — must reopen
this before it can be built. That is a deliberate one-way door, taken because
nothing in confirmed scope was on the other side of it. Ongoing `git fetch` into
a shallow clone re-negotiates the shallow boundary each time; if that proves
costly at hourly cadence, `git fetch --depth 1` behavior is the thing to measure
before assuming a problem.

**Reopen if.** A change-history feature is confirmed, or shallow fetch proves
expensive at the sync cadence chosen in Q-001.

## D-020: The revision count is dropped — supersedes D-012  (2026-07-30, status: accepted, supersedes D-012)

**Decision.** Per-record revision counts are out of scope. Last-modified and
published dates are kept, sourced from `cveMetadata.dateUpdated` and
`cveMetadata.datePublished` in the record JSON rather than from git.

**Context.** The project owner challenged whether the count justified retaining
full git history, observing that the tool cares about a record's current state
rather than its edit history. On review the justification did not hold up. The
RE-003 finding had been cited in D-012's favour, but that anomaly was discovered
with a one-off `git log` during provisioning — keeping the finding costs nothing,
whereas shipping the feature costs a permanent data path. Those were conflated.

A cheaper middle path was measured and rejected: deriving "has been revised" from
the JSON alone. Over a 20,000-record sample, `dateUpdated` is present on 100% of
records and `datePublished` on 98.4%, but **95.5% have `dateUpdated >
datePublished`** — nearly every record has been revised at least once, so the
boolean carries no discriminating signal. It was the count or nothing.

**Consequences.** What is lost is the ability to distinguish a record revised 3
times from one revised 19 times (p50 and p99 respectively, per RE-003). No
confirmed feature queries that; the confirmed filter axes are vendor, product,
severity, CWE, CNA, and date. What is kept is recency, which is the actionable
half and is free — `dateUpdated` needs no git history at all.

This triggers D-019's reopen condition and is superseded onward by D-021, which
switches the clone to shallow. RE-003 remains in the findings log as a valid
observation about the corpus; it simply no longer justifies a feature.

**Reopen if.** A record-quality or CNA-auditing use case makes revision churn
central rather than incidental — at which point D-021 must be reopened first,
since shallow clones cannot answer it.

## D-019: Blobless clone, full history — not shallow  (2026-07-30, status: superseded by D-021)

**Decision.** The server clone is
`git clone --filter=blob:none https://github.com/CVEProject/cvelistV5.git`.
Full commit history is retained. A shallow (`--depth 1`) clone is rejected while
D-012 stands.

**Context.** The owner asked whether a shallow clone made more sense, given that
all current JSON must be parsed anyway and the clone will be synced regularly.
Measured on the actual clone 2026-07-30 rather than estimated:

| Object type | Count | On-disk |
| --- | --- | --- |
| trees | 474,911 | 280.7 MB |
| blobs (current content) | 372,132 | 261.5 MB |
| commits | 74,083 | 14.6 MB |
| **pack total** | 921,127 | **581 MiB** |

So history costs ~295 MB, dominated by *trees* rather than commits, and a
shallow clone would land around 265 MB — roughly half. The full clone GitHub
reports as 2.36 GB; the blob filter avoids ~1.7 GB of historical blob versions
that nothing in scope needs, since D-012 rejected diffs. Clone wall-clock was
169 s.

**Consequences.** This is a scope decision wearing a git costume. Shallow would
lose only the revision *count*: `datePublished` and `dateUpdated` are fields
inside each record's JSON, so last-modified survives a shallow clone for free.
The count is what needs history — and RE-003 demonstrated its analytical value
immediately, surfacing a record with 6,074 revisions against a 99.9th percentile
of 34, which is invisible without it. Computing all 372,092 counts takes 10
seconds from this clone with no persistent state.

The rejected middle path — shallow plus incrementally maintained counters — was
considered and is *more* complexity, not less: a derived counter that can drift
from ground truth, versus a ten-second recomputation. That runs against D-015's
simplicity preference rather than with it.

For ongoing sync the blobless clone is also the better-behaved option: `git
fetch` retrieves new commits, trees, and blobs incrementally, whereas repeated
`--depth 1` fetches re-negotiate the shallow boundary each time.

**Reopen if.** D-012 is dropped — at which point shallow becomes strictly better
and should be adopted — or disk pressure on `plex` makes 316 MB matter, which at
1.1 TB free it does not.

## D-018: Server-side state lives in `cve.data/`, a peer of the document root  (2026-07-30, status: accepted)

**Decision.** All server-side state lives under
`/var/www/meenan.dev/cve.data/` on `plex` — a sibling of the `cve/` document
root, never inside it:

| Path | Contents |
| --- | --- |
| `cve.data/git/` | The cvelistV5 clone |
| `cve.data/db/` | Derived artifacts and databases served to clients |
| `cve.data/cache/` | Fetched upstream data such as the KEV catalog (D-010) |

The deploy may therefore use `rsync --delete` safely.

**Context.** Chosen by the project owner 2026-07-30, matching the existing
convention on the host: `/var/www/meenan.dev/` is a container of per-subdomain
document roots (`cve/`, `webai/`, `www/`, `keepawake/`), not a document root
itself. A peer directory therefore sits beside the served content without being
served.

That was verified empirically rather than assumed, since the nginx config was
not readable without sudo. A canary file was placed in `cve.data/` and requested
four ways — `https://cve.meenan.dev/canary.txt`, a traversal attempt via
`cve.meenan.dev/../cve.data/`, `https://meenan.dev/cve.data/`, and
`https://www.meenan.dev/cve.data/`. All four returned 404. The host has 1.1 TB
free, so the ~2.4 GB corpus is not a constraint.

**Consequences.** This closes the open architecture question about whether the
deploy's rsync semantics can coexist with server-side state: they can, because
the state is not under the path being mirrored. The deploy stays the single dumb
command D-003 wanted, and `--delete` keeps the docroot an exact mirror of
`dist/` with no orphans surviving across deploys.

The endpoint reads from a path outside its own directory, which makes D-006's
rule sharper rather than softer: the base path must be a fixed constant in the
code, and any request parameter that selects a field or partition must be
validated against an allowlist and never concatenated into a filesystem path.
The separation into `git/`, `db/`, and `cache/` also means the endpoint only
ever needs read access to `db/` and `cache/` — it has no reason to touch the
clone, and should not be able to.

Because the directory is a peer rather than a child, this arrangement depends on
no nginx server block ever pointing at `/var/www/meenan.dev/` directly. That is
an assumption about host configuration, not something the application can
enforce, so it is worth re-running the canary check if the site's nginx
configuration is ever restructured.

**Reopen if.** The host layout changes, another server block is added that
serves the parent directory, or state needs to be web-readable directly rather
than through the endpoint.

## D-017: Toolchain — Vite, Svelte 5, TypeScript strict, Vitest + Playwright  (2026-07-30, status: superseded in part by D-027)

*The UI framework and app bundler below were replaced by D-027: React 19 on
Next.js 16 static export, after the owner deprioritized bundle size and asked
for SSG. The rest of this entry — TypeScript strict, Vitest, Playwright, ESLint
+ Prettier, pnpm, plain PHP 8.4 — still stands.*

**Decision.**

| Concern | Choice |
| --- | --- |
| Build | Vite 8 → static `dist/` |
| Language | TypeScript 7, strict |
| UI | Svelte 5 |
| Unit test | Vitest 4 |
| Browser test | Playwright 1.62 |
| Lint / format | ESLint 10 + Prettier 3 (`eslint-plugin-svelte`, `prettier-plugin-svelte`) |
| Packages | pnpm 11, with `pnpm licenses list` for the D-002 audit |
| Server | Plain PHP 8.4, `declare(strict_types=1)`, no framework |

**Context.** The owner left the stack open at kickoff for M0 to decide. Versions
and licenses verified against the npm registry 2026-07-30 — all MIT or
Apache-2.0, compatible with D-002. `plex` runs PHP 8.4.8, git 2.54.0, and
sqlite3 3.45.1 (verified same day).

**Consequences.** Vite emits a static `dist/` that matches D-003's deploy model
with no server build step, and has first-class Worker and WASM handling, which
D-004 makes unavoidable. Playwright is not optional here: OPFS, sync access
handles, and Worker behavior do not exist in Node, so "measure, don't assert"
(AGENTS.md rule 3) requires a real browser — Playwright is where the bake-off
numbers and every storage test must run. Vitest covers pure logic like schema
derivation and coverage-set arithmetic. pnpm was chosen partly because
`pnpm licenses list` makes the D-002 audit a built-in rather than another
dependency.

Svelte 5 is the choice most open to challenge, so the reasoning is explicit: its
runtime is small next to an already-heavy SQLite WASM payload, it compiles to
direct DOM updates (which matters for large result tables), and its mental model
is the simplest of the candidates — consistent with D-015's preference for
architectural simplicity. The counter-argument is real and was weighed: React
has a larger ecosystem and far more training data, which in a project where
agents write nearly all the code (D-001) is a genuine reliability factor, not an
abstract preference. Svelte won on fit; if agent friction shows up in practice,
that is evidence to reopen, and the cost of switching is lowest now, before M1
scaffolding lands. Charting and table libraries were deliberately not chosen
here — both should be picked framework-agnostically when the reporting work
starts.

**Reopen if.** Agents show repeated friction writing Svelte 5, a required
capability exists only in another ecosystem, or the bake-off reveals a data-layer
constraint the build system cannot accommodate.

## D-016: Browser support floor — Chrome 108, Firefox 111, Safari 16.4  (2026-07-30, status: accepted)

**Decision.** Supported: Chrome/Edge 108+, Firefox 111+, Safari 16.4+, Chrome
Android 109+, Safari iOS 16.4+. Below the floor, the capability gate shows an
explicit unsupported message on arrival.

**Context.** Verified 2026-07-30 against MDN's `browser-compat-data` JSON
directly, rather than from recollection. The important subtlety: the base
`FileSystemSyncAccessHandle` interface shipped considerably earlier — Chrome
102, Safari 15.2 — but SQLite's OPFS VFS needs the **synchronous** forms of
`close`, `flush`, `getSize`, and `truncate`, which BCD tracks separately and
which landed in Chrome 108 and Safari 16.4. Firefox shipped both at 111. This
independently corroborates SQLite's own claim that `opfs-sahpool` works on
"all major browsers released since March 2023": Safari 16.4 and Firefox 111 both
shipped that month. `StorageManager.persist` is available far below this floor
(Chrome 55, Firefox 57, Safari 15.2), so quota persistence adds no constraint.

**Consequences.** The capability gate must probe for the *synchronous* method
forms specifically — a naive `'FileSystemSyncAccessHandle' in self` check passes
on Safari 15.2 through 16.3 and then fails deep inside the import, which is
precisely the failure the gate exists to prevent. Mobile browsers clear the
floor, but clearing it is not an endorsement: whether a multi-hundred-megabyte
import belongs on a phone is a product question the bake-off numbers should
inform. Because D-009 rules out telemetry, we will never observe real-world
gate hits, so the gate's message must be self-explanatory on first read.

**Reopen if.** The SQLite WASM build changes its VFS requirements, or a storage
layer that does not need synchronous access handles is adopted.

## D-015: The range-request VFS is rejected — keep the architecture simple  (2026-07-30, status: accepted, amends D-014)

**Decision.** Candidate (c) — a custom SQLite VFS fetching database pages over
HTTP range requests with an OPFS-persisted page cache — is out. Open question 1
is now a two-way choice: (a) bulk import versus (b) field-and-partition
projection.

**Context.** Stated by the project owner 2026-07-30: *"I want to keep the
architecture simple and the VFS sounds anything but."* The assessment holds up:
(c) required composing two VFS layers — range-request fetching and OPFS
persistence — and neither prior-art library (`sql.js-httpvfs`,
`sqlite-wasm-http`, both self-described experimental) persists its page cache,
so that layer would have been ours to write and maintain against a moving
SQLite WASM target. Novel infrastructure underneath the storage layer is
exactly where a project of this size can lose months.

**Consequences.** The significant one is a cost, and it should not be discovered
later: **(c) was the only candidate that made query correctness free.** SQLite
decided which pages it needed, so a query could not silently run against a
partial view. With (c) gone, cache coverage tracking becomes mandatory
engineering if (b) wins — vision criterion 7 is now something we build rather
than something we inherit.

It is tractable at this granularity, which is what makes the trade acceptable.
Because the contract is fields × partitions (D-014), coverage is a
set-membership check: what a query requires is computable from the columns it
references and the date range it spans, compared against a local manifest of
what has been synced. Fetch the difference, or say so. The awkward case is an
unbounded query — "every CVE for this vendor, ever" — which needs every
partition and so degenerates into a full sync; that deserves a deliberate answer
in the UI rather than a silent stall.

Two simplifications come with it: Q-004 reduces to picking `opfs` or
`opfs-sahpool` with no composition problem, and the M0 bake-off drops from three
implementations to two.

**Reopen if.** Both surviving candidates miss their budgets in the bake-off, or
a maintained, non-experimental range-request VFS with OPFS persistence appears.

## D-014: Field-and-partition projection is acceptable; predicate values are not  (2026-07-30, status: accepted, amended same day by D-015)

*Amended by D-015, which removes candidate (c). The correctness point below now
lands on us as work rather than arriving free.*

**Decision.** The client may ask the server for specific fields and specific
partitions — "these columns, these year ranges" — and the server may learn that.
The server must still never receive predicate *values* (`vendor = cisco`,
`severity >= 7`) or full-text search terms. Traffic-pattern analysis is
explicitly out of scope as a threat.

**Context.** Stated by the project owner 2026-07-30: *"I'm not worried about
pattern sniffing attacks on usage or anything insane like that so an explicit
field-based sync/delta of database records is perfectly acceptable."* On
follow-up the owner set the boundary at fields and partitions rather than full
predicate pushdown. This amends D-007, which had been written to forbid any
query content reaching the server.

**Consequences.** The practical effect is to restore candidate (b), the
projection API, as a peer in the data-delivery question — the bake-off is three-way again.
Under a field-and-partition contract (b) serves facet and count workloads
directly, and can serve full-text search by shipping the FTS index for the
requested partitions rather than the whole corpus, which is what makes it viable
now where D-011 had ruled it out. This weakens D-011's demotion of (b) but does
not touch D-011's own decision.

Two things this does *not* change, and they matter:

- **The correctness hazard stands.** Candidate (b) still requires cache coverage
  tracking, because a partially populated cache can answer a query with a
  plausible undercount; candidate (c) gets that guarantee free from SQLite. That
  argument is about correctness, not privacy, and is untouched here — it remains
  the strongest case for (c).
- **The server still does no query execution.** Projecting requested columns for
  requested partitions is data selection, not analysis. If a design starts
  having the server filter, rank, or aggregate, that is D-007's substance and a
  separate decision.

Documentation must now be accurate about this: claims that the endpoint "never
receives a query" or that sync requests carry "no query content" were true under
the original D-007 and are false under this decision. What a user can verify is
narrower and specific — that predicate values and search terms never appear in
requests. Vision criterion 4, the README, and AGENTS.md were corrected in the
same change as this entry.

**Reopen if.** The tool acquires users whose threat model includes the operator,
or someone else deploys it where the operator is not trusted — at which point
the field/partition leak becomes worth closing, and with (c) rejected by D-015
candidate (a) is the remaining answer.

## D-013: The local database is a cache, not a user asset  (2026-07-30, status: accepted)

**Decision.** The OPFS database is treated as rebuildable cache. Import/export
of the whole local database is rejected. Users export *results* (D-011's
sibling row in features.md), not the store.

**Context.** Decided in the 2026-07-30 feature triage. The framing follows from
where the data-delivery question is heading: under a demand-driven design the local
database is a materialized subset of a server artifact, not a curated corpus a
user built. Treating it as precious would be a category error that constrains
eviction, migration, and invalidation for no real gain.

**Consequences.** Schema migrations may discard and rebuild rather than
transform in place, which is dramatically simpler. Eviction and quota pressure
become recoverable events rather than data loss. The cost is real if candidate
(a) wins: a user who spent a long cold start has no way to move or back up that
work, and would re-import from scratch on a new machine.

**Reopen if.** Candidate (a) wins the data-delivery question *and* the measured cold start
is expensive enough that re-importing is a genuine burden — in which case
whole-database export becomes a proportionate answer.

## D-012: Change history is revision metadata, not diffs  (2026-07-30, status: superseded by D-020)

**Decision.** Surface how many times a record has been revised and when it last
changed. Full per-revision diff views are rejected.

**Context.** Decided in the 2026-07-30 feature triage. The server holds full git
history (D-005), so both were available; the narrow form carries most of the
analytical signal — "this record is churning" or "this was quietly rewritten
after publication" — for a fraction of the data path.

**Consequences.** Revision count and last-modified become columns derived at
artifact-build time from git history, so they cost the client nothing extra and
need no second fetch path. Answering *what specifically changed* remains out of
reach, which is a real loss for anyone auditing CNA behavior. Because the git
history stays on the server, adding diffs later is additive rather than a
rework.

**Reopen if.** Users ask for the specific-changes question often enough to
justify the second data path, or a record-quality analysis use case makes diffs
central rather than incidental.

## D-011: Full-text search over descriptions is in scope, in full  (2026-07-30, status: accepted, consequences amended same day by D-014 and D-015)

*The decision below stands. Its reasoning about candidates (b) and (c) is
superseded: D-014 permits field-and-partition requests, so (b) can ship the FTS
index per partition and is no longer demoted, and D-015 removed (c) entirely.
The durable point is that FTS keeps search terms on the client and makes the
index a major transfer cost.*

**Decision.** SQLite FTS5 over CVE descriptions and references, not a scoped
index over short fields.

**Context.** Chosen by the project owner in the 2026-07-30 feature triage from
four options (full, scoped to titles/products, metadata-only, defer). "Searching
CVEs" is in the project's own description, and a search tool that cannot search
narrative text undersells that.

**Consequences.** This decision reaches past its own feature and constrains
the data-delivery question, which is why it is logged rather than left as a ledger row.
Free-text search requires the search term and the indexed text to meet
somewhere. Under a projection API — candidate (b) — that means either shipping
all description text to the client (which defeats projection and collapses (b)
toward (a)) or sending search terms to the server, which is predicate pushdown
and forbidden by D-007. Under candidate (c) the FTS5 index lives in the same
database file and its B-tree pages are range-fetched like any other, so search
works lazily and terms never leave the client. Candidate (b) is therefore
demoted to a hybrid fallback and the bake-off is effectively (a) versus (c).
Description text also dominates corpus size, so the FTS index is a major
contributor to whatever budget Q-003 establishes.

**Reopen if.** The bake-off shows the FTS index is what makes the working-set
budget unachievable — the fallback ladder is scoped FTS over short fields, then
metadata-only search.

## D-010: Enrichment is limited to CISA KEV  (2026-07-30, status: accepted)

**Decision.** CISA's Known Exploited Vulnerabilities catalog is the only
enrichment overlay in scope. EPSS and NVD enrichment are rejected.

**Context.** Chosen by the project owner in the 2026-07-30 feature triage.
Verified the same day: the KEV JSON feed carries 1,656 entries in ~1.5 MB
(catalogVersion 2026.07.29) and returns **no** `access-control-allow-origin`
header, so the browser cannot fetch it directly. FIRST's EPSS per-CVE API does
return `access-control-allow-origin: *`, but per-CVE lookups cannot cover ~300k
records, so full EPSS coverage would mean mirroring a daily bulk file.

**Consequences.** KEV joins the corpus as a second server-fetched source: the
server pulls it, caches it, and serves it same-origin, inheriting the D-006
hardening requirements. At 1.5 MB it can ship whole, so it adds no partial-fetch
complexity regardless of how the data-delivery question resolves. The rejections keep the
tool's dependency surface at two sources instead of four — EPSS in particular
would have meant daily-changing scores across the whole corpus, a recurring sync
problem for a secondary signal. Users wanting exploit-prediction context will
not find it here.

**Reopen if.** KEV proves valuable enough that exploit-prediction context is the
obvious next ask, or EPSS begins publishing in a form that composes with the
chosen delivery architecture instead of fighting it.

## D-009: No telemetry, of any kind  (2026-07-30, status: accepted)

**Decision.** The application collects and transmits no usage data, error
reports, or analytics. Not aggregate counters, not opt-in diagnostics.

**Context.** Chosen by the project owner in the 2026-07-30 feature triage from
three options (none, opt-in diagnostics, aggregate counters). The tool's pitch
is that queries stay local; a telemetry channel — even a benign one — makes that
claim something users must take on trust rather than verify by opening the
network panel.

**Consequences.** Vision criterion 4 becomes checkable rather than promised:
the only requests the app ever makes are data fetches, so any request a user
sees in the network panel is the client asking for corpus data — never a report
about the user. (Under D-014 a search or filter may trigger such a fetch when
the local cache lacks coverage; what it must never carry is the predicate or
the search term.) In exchange we are blind in production. A failing
import on some browser/hardware combination produces no signal — we learn about
it from a bug report or not at all. This makes the diagnostics panel
(`confirmed`) more than a nicety: it is the only mechanism by which a user can
tell us what went wrong, so it must surface enough state to reconstruct a
failure from a screenshot. Server-side request logs still exist as an operational
fact of running a web server; they are not a telemetry channel and must not be
repurposed into one.

**Reopen if.** Never, for passive collection — this is a standing property. An
explicitly user-initiated "copy diagnostics to clipboard" affordance is not
telemetry and does not require reopening this.

## D-008: CVE content is freely reusable, subject to a notice obligation  (2026-07-30, status: accepted)

**Decision.** We may reproduce, transform, and redistribute CVE List content —
including as derived artifacts such as a prebuilt database — provided every copy
we produce carries MITRE's copyright designation and the CVE Terms of Use
license text. That obligation is treated as a functional requirement of any
feature that emits CVE data, not as a footer detail.

**Context.** The project owner raised the licensing question and flagged a
possible carry-forward clause. Confirmed 2026-07-30 by reading the terms source
at `CVEProject/cve-website` (`src/views/Legal/TermsOfUse.vue`), which renders
[cve.org/legal/termsofuse](https://www.cve.org/legal/termsofuse) — the published
page is client-rendered and returns no readable text to a plain fetch. The
operative clause, verbatim:

> **CVE Usage:** MITRE hereby grants you a perpetual, worldwide, non-exclusive,
> no-charge, royalty-free, irrevocable copyright license to reproduce, prepare
> derivative works of, publicly display, publicly perform, sublicense, and
> distribute Common Vulnerabilities and Exposures (CVE™). Any copy you make for
> such purposes is authorized provided that you reproduce MITRE's copyright
> designation and this license in any such copy.

The grant is unusually permissive — derivative works and sublicensing are named
explicitly, and it is irrevocable — so the owner's read is correct: there is no
restriction on what we build. The single condition is the notice carried by each
copy. The terms also disclaim all warranties, which is worth surfacing given
this tool will be used for security decisions.

**Consequences.** The notice obligation attaches to more surfaces than a
license page:

- Any server-derived artifact the endpoint serves is a copy and must carry the
  notice, in-band where the format allows it.
- Exported result sets (CSV/JSON, both `proposed`) are copies a user
  redistributes; export should embed the notice rather than rely on the user
  knowing about it.
- The local OPFS database is a copy made on the user's machine; shipping the
  notice with the application covers this in practice.

This is a notice condition, not copyleft: it constrains attribution, not what we
may build or how we license our own code (D-002). Note also that these are
MITRE's terms for the CVE List; individual CNA-supplied reference URLs point to
third-party content governed by nobody's terms but their own.

**Reopen if.** The CVE Program republishes its terms under different conditions
— the text above is a 2026-07-30 snapshot and should be re-read before launch —
or we begin redistributing a data source other than the CVE List, which will
carry its own terms.

## D-007: The data plane stays in the browser  (2026-07-30, status: accepted, amended same day by D-014)

*Read D-014 with this entry. The core holds — analysis runs on the client and
the server executes no queries — but the clause below saying the server "never
sees a user's query, filter, or report" was relaxed: the client may ask for
specific fields and partitions. Predicate values and search terms are still
forbidden.*

**Decision.** All parsing, storage, indexing, querying, aggregation, charting,
and export happen client-side. The server stores no user state and receives no
query, filter, or report. The single server endpoint (D-006) ships corpus data
only.

**Context.** Stated by the project owner at kickoff as a "100% client-side tool."
The owner subsequently accepted a small server-side ingest component (D-006), so
the constraint is scoped precisely here: it is the *analysis* that is
client-side, not every byte of the system. Recording it explicitly prevents
future agents from reading D-006 as license to move work server-side.

**Consequences.** Users get privacy by construction — a researcher can query the
corpus without disclosing what they are looking for. It also forces the hard
problems into the browser: a ~300k-record corpus must import, persist, and query
within browser memory and storage limits, which is exactly what M0's spikes must
measure. Server-side query execution is unavailable as an escape hatch if
client-side performance disappoints; the answer would be a better schema, better
indexing, or a smaller derived corpus, not a server.

**Reopen if.** M0 measurement shows client-side query latency is unacceptable
for the core reporting use cases even after schema and indexing work — in which
case the tradeoff against the privacy property is an explicit owner decision,
not an agent's.

## D-006: Ingest is one hardened same-origin PHP endpoint  (2026-07-30, status: accepted)

**Decision.** Corpus data reaches the browser through a same-origin PHP endpoint
served from `https://cve.meenan.dev/`. It must be locked down so it serves
same-origin browser callers and does not become a general-purpose open endpoint.
It must never accept a caller-supplied URL, filesystem path, or git ref that is
passed through to the network, the filesystem, or a shell.

**Context.** Chosen by the project owner over a Cloudflare Worker, a
user-supplied ZIP upload, and a published prebuilt artifact. The owner has PHP
enabled for this origin, with nginx routing any URL ending in `.php` (query
parameters ignored for routing purposes). This choice was forced by verified
CORS behavior — see D-005 for the measurements.

**Consequences.** First-run ingest is fully automatic with no manual download
step, and the wire format is ours to design rather than GitHub's to dictate
(the format itself is an open question for M0). The cost is an internet-facing
endpoint that must be defended: parameter validation, bounded response sizes,
rate limiting, and same-origin enforcement are functional requirements, not
polish. The specific enforcement mechanism is an M0 open question —
`Sec-Fetch-Site` and `Origin` header checks are candidates, but both must be
validated against the actual nginx/PHP configuration and against browsers in
scope before being relied on. Note that same-origin enforcement via request
headers constrains *browsers*, not `curl`; rate limiting and cheap responses are
what bound abuse from non-browser callers.

**Reopen if.** The endpoint proves impractical to secure or operate on this
host, or PHP availability changes — the fallback ladder is a published prebuilt
artifact, then user-supplied ZIP upload.

## D-005: The cvelistV5 clone lives on the server, not the browser  (2026-07-30, status: accepted)

**Decision.** The server maintains a real git clone of
`https://github.com/CVEProject/cvelistV5` and derives baselines and deltas from
it. In-browser git (e.g. isomorphic-git into OPFS) is rejected.

**Context.** The owner's initial preference was to clone with git directly into
browser storage. Measurements taken 2026-07-30 against live endpoints show that
path is not viable:

- The repository reports 2,477,151 KB (~2.36 GB) via the GitHub API — far beyond
  a reasonable browser download and OPFS footprint.
- Release assets on `release-assets.githubusercontent.com` (the ~562 MB
  `all_CVEs_at_midnight.zip` baseline and ~4 MB hourly deltas) return **no**
  `access-control-allow-origin` header — browser-blocked.
- `codeload.github.com` zipball/tarball returns
  `access-control-allow-origin: https://render.githubusercontent.com` —
  browser-blocked for our origin.
- GitHub's git smart-HTTP endpoints send no CORS headers; isomorphic-git
  documents a CORS proxy as a hard requirement for browser clones, which would
  add a third-party dependency *and* still not solve the 2.36 GB problem.

By contrast, `raw.githubusercontent.com` and `api.github.com` both return
`access-control-allow-origin: *`, and `cves/delta.json` (a change manifest with
direct raw links) plus a 15.6 MB `cves/deltaLog.json` are readable from a
browser — so a browser-only *incremental* path exists even though the bulk path
does not. Moving the clone server-side makes both paths uniform and gives us
full git history, which is otherwise unavailable to the client.

**Consequences.** The hardest part of the owner's original design disappears:
git runs in its native environment. The server gains a periodic `git fetch` job
and — as provisioned under D-021 — a 280 MiB pack plus a 3.7 GB worktree. The
client never needs a git implementation, so no git library appears in the
browser bundle.

*Amended by D-021: this entry originally noted that server-side history made
per-record change history feasible. D-020 dropped that feature and D-021 made
the clone shallow, so history is no longer retained. The rest of this decision
stands unchanged — the clone belongs on the server regardless of its depth.*

**Reopen if.** GitHub adds CORS headers to bulk-download paths, or the corpus
shrinks by an order of magnitude, or an official CORS-enabled bulk mirror
appears. Re-verify the CORS measurements above before acting on this — they are
a snapshot of 2026-07-30, not a standing guarantee.

## D-004: SQLite compiled to WASM, persisted to OPFS, is the local store  (2026-07-30, status: accepted)

**Decision.** The browser-side store is SQLite built to WebAssembly, with the
database persisted in the Origin Private File System. Relational queries against
persisted SQLite are the substrate the analytics and reporting features build
on.

**Context.** Stated by the project owner at kickoff ("using wasm as needed,
local opfs storage, sqlite and analytics/reporting tools on top of it").
Verified 2026-07-30: `@sqlite.org/sqlite-wasm` publishes version 3.53.0-build1
under Apache-2.0, compatible with this project's license (D-002).

**Consequences.** Query power comes free — arbitrary SQL, joins, aggregates, and
FTS are available without building a query engine. In exchange we inherit OPFS's
constraints, which are real and shape the architecture:

- SQLite's OPFS VFS variants differ materially. Per SQLite's own documentation,
  the `opfs` VFS requires COOP/COEP response headers, while `opfs-sahpool` does
  not but **does not support multiple simultaneous connections**. Which VFS we
  use is an M0 decision with direct consequences for multi-tab behavior, and it
  interacts with what nginx can be configured to send.
- Synchronous access handles require a Worker; the main thread cannot own the
  database.
- Browser storage quota and eviction apply, so quota handling and
  `navigator.storage.persist()` are functional concerns, not polish.

**Reopen if.** M0 spikes show the corpus cannot be imported or queried within
acceptable time and storage budgets in-browser, or a VFS limitation proves
incompatible with required multi-tab behavior.

## D-003: Deploy by rsync of `dist/` to the live directory  (2026-07-30, status: accepted)

**Decision.** The build produces a `dist/` directory that is rsynced directly to
`plex:/var/www/meenan.dev/cve/`, served by nginx at `https://cve.meenan.dev/`.
No staged rollouts, no backup step, no build tooling on the server.

**Context.** Stated by the project owner at kickoff. nginx routes any URL ending
in `.php` on this origin (query parameters ignored for routing). Verified
2026-07-30: `cve.meenan.dev` resolves and nginx responds over HTTPS with a valid
certificate, currently returning 403 for an empty document root — consistent
with a configured, pre-code deployment target.

**Consequences.** Deployment is one command and trivially scriptable, but it is
also a live overwrite with no rollback: a bad build is served immediately, and
recovery means rebuilding from a known-good commit. Since the PHP endpoint
(D-006) is deployed by the same mechanism, `dist/` contains both the static app
and the endpoint, and the build must keep server-side and client-side artifacts
distinguishable. rsync deletion semantics need deciding in M0 — a plain mirror
would delete server-side cache or clone state if it lives under the document
root, which is a good reason to keep it outside.

**Reopen if.** The project acquires a staging need, multiple deploy targets, or
state under the document root that a mirroring rsync would destroy.

## D-002: Apache-2.0, with dependency licenses verified at source  (2026-07-30, status: accepted)

**Decision.** The project is licensed Apache-2.0. Every dependency's license
must be compatible and must be verified from the package's own published
metadata before it lands — never assumed from memory.

**Context.** The Apache-2.0 `LICENSE` file predates this scaffold and the public
repository at `https://github.com/pmeenan/cve.meenan.dev` reports `Apache-2.0`.
The verify-at-source rule exists because license facts drift and training
knowledge is unreliable; two dependencies were checked against the npm registry
on 2026-07-30 while writing this scaffold (`@sqlite.org/sqlite-wasm` 3.53.0-build1
Apache-2.0, `isomorphic-git` 1.40.0 MIT).

**Consequences.** Copyleft dependencies are excluded from the shipped bundle.
A license audit belongs in the M0 toolchain decisions and should be automated so
it runs on every dependency change rather than by memory. Note separately that
CVE record *content* carries the CVE Program's own terms, which are distinct
from this project's code license and need checking before the corpus is
redistributed in a derived form.

**Reopen if.** A required capability exists only under an incompatible license,
or the owner changes the project license.

## D-001: AI-developed, human-gated workflow  (2026-07-30, status: accepted)

**Decision.** Agents implement and review; the human directs, decides, and is
the sole committer. Agents never run `git commit`, `git push`, or history
rewrites — work is left in the working tree for human review. The project
documentation in `docs/` is the durable memory that agents work from.

**Context.** Stated by the project owner by adopting this scaffold. The
collaboration loop, tech-lead mode, reviewer mode, fix-pass mode, and
verify-pass mode are specified in [workflow.md](workflow.md).

**Consequences.** Documentation quality is load-bearing rather than incidental —
a stale doc misleads every future agent, so doc updates ship inside the same
change as the code. Only one stream of work can be in flight at a time, since
the uncommitted working tree is the shared unit of review. The human commit gate
is the only checkpoint that cannot be automated away.

**Reopen if.** The owner wants agents to commit directly, or the single-stream
constraint becomes the binding limit on throughput.
