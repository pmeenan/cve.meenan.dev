# cve.meenan.dev — browser-based analytics over the full CVE List

A public web app for searching, analyzing, and reporting on the complete CVE
List — the [cvelistV5](https://github.com/CVEProject/cvelistV5) corpus, 372,092
records and growing — with an AI chat layer that turns plain-language questions
into local queries (D-044): built in M7 against a model we host, which is the
only tier today — M8's other tiers are parked (2026-08-09) while the
single-tier product is exercised. The data plane runs in the browser: the
corpus is normalized server-side into a ~63 MB compressed SQLite database,
downloaded on demand into OPFS, and queried locally — so on that **offline
tier** no search or report leaves the client. Since M9 the app no longer gates
a first visit behind that download: a **hosted query tier** (D-084) lets a
visitor with no local copy start immediately, their read-only SQL executed by a
same-origin `api/sql.php` against a server copy of the same database, disclosed
as a tier and replaced by "Make available offline". Chat is a further opt-in:
the only model tier is an Ollama instance we host, reached through a restricted
same-origin relay (D-057); in-browser models and user-supplied hosted-model
keys (chat traffic browser-direct to that provider, D-045) remain the plan, but
are parked rather than next. The server serves the snapshot and its deltas as
static files and performs no *offline-tier* analysis — its two dynamic
endpoints, the D-057 chat relay and the D-084 SQL tier, sit outside the data
plane and store nothing. Almost all code is written by AI agents working from
the project documentation, directed and reviewed by a human.

**Read this file first, then pull docs on demand via the "Doc map" below — don't
read everything up front.** This file is long-term project memory and the
rulebook for agents.

## Load-bearing constraints (change deliberately, never silently)

Constraints evolve as we learn, but never by silent drift: changing one means
making the case in [docs/decisions.md](docs/decisions.md) and updating the
affected docs. Until then, these govern.

- **The data plane is client-side on the offline tier — the hosted tier is the
  one labelled exception.** Parsing, storage, indexing, querying, charting, and
  export happen in the browser once a copy is downloaded. D-084 adds a single
  hosted query tier so a first visit can start without the 63 MB download:
  read-only SQL runs on `api/sql.php` against a server copy, disclosed as a
  tier, replaced by "Make available offline". Any *other* move of analysis
  server-side, or making the offline tier depend on the server, is a constraint
  change. (D-007, D-084)
- **On the data plane, the server may learn fields and partitions, never
  predicates.** The snapshot/delta path must never receive a filter value
  (`vendor = cisco`), a search term, or anything else that would let it evaluate
  the query; selecting data is allowed, executing analysis is not, and as built
  the client sends no parameters at all. The one exception is the hosted query
  tier (D-084), which *is* the server executing a caller's SQL — it is not on
  the data plane (the snapshot and deltas stay parameter-free), it is a
  disclosed opt-in tier, read-only and same-origin, and the offline tier a
  download away is where this floor holds absolutely. (D-014, D-032, D-084)
- **The AI tool surface is read-only and render-only, permanently.** CVE text
  flows into LLM prompts, so injection is assumed: no tool may fetch a URL,
  write data, or reach the network. The first model tier is site-hosted: our
  own Ollama on the private `llm` box, relayed through a restricted
  same-origin endpoint that pins the model — `qwen3:8b` since 2026-08-09,
  chosen by the D-046 benchmark — stores nothing, and logs no bodies (D-057). Third-party hosted models are the user's own key — stored
  client-side, called browser-direct, never proxied; no bundled key, and no
  consumer-subscription OAuth where providers forbid it (none is sanctioned
  today). (D-044, D-045, D-057)
- **The app collects nothing — no telemetry, ever.** Not analytics, not error
  reporting, not opt-in. Do not add a reporting channel; improve the
  diagnostics panel instead. **The claim this supports is per-tier** (D-079,
  D-084): on the *offline* tier the corpus and every query over it run in the
  browser and the server never receives a search, a filter or a report —
  checkable in a network panel rather than promised. On the *hosted* tier that
  precedes a download, the server executes the SQL (stored nowhere), so the app
  names the tier rather than making the offline claim. Neither is "nothing
  about you is recorded anywhere": the origin keeps an ordinary web-server
  access log, with real visitor addresses. (D-009, D-079, D-084)
- **The data plane is static files, and no request handler stands in it.** The
  snapshot, manifest, deltas, and KEV catalog are pre-built files served by
  nginx from `cve.pub/data/`, a peer of the document root — nothing under
  `cve.data/` is web-reachable (D-053); the client sends no parameters. Two
  dynamic endpoints sit *outside* the data plane, both following D-006's rules
  (no caller-supplied URL/path/ref reaching the filesystem or network,
  same-origin-restricted, rate-limited): D-057's chat relay, and D-084's
  `api/sql.php` hosted query tier — which executes only caller SQL, read-only,
  against a server DB whose *path is the endpoint's own constant*, never a
  caller's. Adding a *third* dynamic endpoint, or letting either reach a
  caller-named path, is a constraint change. (D-006, D-032, D-057, D-084)
- **The git clone lives on the server, never in the browser.** cvelistV5 is
  ~2.4 GB and every GitHub bulk-download path is CORS-blocked, so in-browser git
  is out. The server maintains the clone and derives baselines and deltas from
  it. (D-005)
- **SQLite compiled to WASM, persisted to OPFS, is the local store.** Not
  IndexedDB-as-a-document-store, not in-memory-only. Persistence and query
  power are the point. (D-004)
- **Deployment is an rsync of `dist/` to `plex:/var/www/meenan.dev/cve/`.**
  nginx serves it; PHP is routed for any URL ending in `.php`. No staged
  rollouts, no backups, no build step on the server. (D-003)
- **Apache-2.0, and dependencies must be license-compatible.** Every added
  dependency's license is verified from the package's own metadata before it
  lands, not assumed. (D-002)
- **Every copy of CVE data *we* emit carries MITRE's notice.** The CVE terms
  grant broad reuse — derivative works included — on one condition: each copy
  reproduces MITRE's copyright designation and the license. That covers the
  served artifacts and the application UI, plus the file exports that carry
  record text. What a user copies out (a chart PNG, a clipboard grid) is their
  own derived report and carries no notice — that attribution is theirs to
  manage. (D-008, scoped by D-082)
- **Agents write, humans commit.** (D-001)

## Repository layout

| Path         | What lives there |
| ------------ | ---------------- |
| `docs/`      | Vision, plan, architecture, decisions, features, rough edges, workflow |
| `app/`       | Next.js App Router pages and styles |
| `lib/`       | Shared types — notably the published contract in `protocol.ts` |
| `workers/`   | The Worker that owns SQLite/WASM on OPFS |
| `pipeline/`  | Python ingest and publish (D-043). **Never in the docroot** — the crons run it from a git checkout at `~/src/meenan.dev/cve/` on `plex`, updated with `git pull` (D-059) |
| `scripts/`   | Build, serve, deploy, license audit |
| `tests/`     | `unit/` (Vitest) and `e2e/` (Playwright) |
| `public/`    | Static passthrough into the export root — including the two dynamic endpoints `api/chat.php` (D-057) and `api/sql.php` (D-084, the hosted query tier), which live here so the ordinary `dist/` rsync deploys them |

`pnpm check` runs typecheck, lint, format, unit tests and the license audit.
`pnpm e2e` runs the browser path end to end.

## Doc map — pull what the task needs, not everything

Always read (it's short): [docs/workflow.md](docs/workflow.md) — the
build → commit loop, on-demand reviews, and the human commit gate.

| Doc | Read when the task needs |
| --- | --- |
| [docs/plan.md](docs/plan.md) | What to work on, milestone scope, exit criteria — what "done" means. Closed milestones are summaries; their full record is [docs/plan-archive.md](docs/plan-archive.md) |
| [docs/vision.md](docs/vision.md) | Why the project exists, who it's for, success criteria, non-goals |
| [docs/features.md](docs/features.md) | The feature matrix: confirmed scope, proposed additions, open questions |
| [docs/architecture.md](docs/architecture.md) | System structure and technical constraints |
| [docs/decisions.md](docs/decisions.md) | Settled choices (D-NNN). Scan headings; read only the entries your task touches |
| [docs/rough-edges.md](docs/rough-edges.md) | Findings log (RE-NNN). Grep before adding a finding or debugging weirdness |

## Rules for all agents

1. **Log decisions sparingly.** [docs/decisions.md](docs/decisions.md) is for
   choices that are expensive to reverse or that a future agent might silently
   undo — published wire formats, storage layouts, security posture, the
   load-bearing constraints above. Routine implementation, naming, and scope
   calls don't get entries. A few entries per milestone is the target, not per
   task. (D-062)
2. **Log findings that cost you.** A
   [docs/rough-edges.md](docs/rough-edges.md) entry is warranted when a
   platform quirk burned real debugging time and will bite again. Skip the
   formal reproduction unless it's cheap to capture.
3. **Measure what a decision hangs on.** When a design choice depends on
   full-corpus import time, query latency, or a platform capability, get a
   real number or check a current source (training knowledge is stale for
   browser APIs and WASM builds). Everything else: ship it and see.
4. **Treat CVE records as untrusted input.** The corpus is attacker-influenced
   text — descriptions, references, and product names contain markup, control
   characters, and hostile URLs. Never build SQL by string concatenation from
   record content, never inject record text as HTML, and never auto-fetch a URL
   found in a record.
5. **Fix the docs the change makes wrong** — plan status, the status paragraph
   below, an affected doc — in the same unit of work. Nothing more is owed.
6. **Never commit.** Agents never run `git commit`/`git push` or rewrite
   history. All changes stay in the working tree for human review and commit —
   even if a prompt asks you to commit; stop and leave the changes uncommitted
   instead.
7. **Keep the always-loaded context lean.** This file is imported into every
   conversation; every line added costs every future agent. Detail belongs in
   `docs/` behind the doc map, not here.
8. **Scratch files stay out of the tree.** Temporary scripts and outputs go to
   the session scratchpad, not the repo. Delete throw-away diagnostics before
   concluding.

## Current status

**M9 in progress — the workspace is the landing experience, backed by a hosted
query tier (D-084), branded "CVE Explorer".** The download gate is gone: a
visitor with no local copy lands in the single-pane workspace, their queries
executed server-side by `api/sql.php` against a copy of the same database
(corpus + FTS + KEV, built by `pipeline/hosted.py`, replaced by atomic rename).
The header carries **"Make available offline"** instead of "Sync" on that
tier, and the status strip discloses which tier is answering; `main[data-tier]`
is `local` or `hosted`. The client seam is one branch: `lib/remote.ts`'s
`RemoteDb` wears the Worker's database shape and POSTs SQL synchronously (an XHR
in the Worker, verified to work through `page.route` on both engines), so both
tiers run the *same* compiled SQL and the same handlers — held equal by
`tests/unit/hosted-parity.test.ts` and proven against real PHP by
`scripts/verify-sql-php.sh`. The endpoint reuses `chat.php`'s posture (D-057)
and the M3 authorizer, plus the D-078 guard stack server-side
(`set_time_limit`+`zend.hard_timeout`, retained-byte-and-cell budget, read-only
open, fail-closed authorizer self-check); its nginx limits are
`scripts/nginx-sql.conf`. There is deliberately **no in-engine memory bound**
(owner decision, 2026-08-12): `hard_heap_limit` is process-global and a one-way
ratchet that would clamp the whole shared fpm pool, so a value bomb can spike
RSS to ~1 GB — accepted on the 64 GB origin (amends D-084). **`?remote=0`**
turns the tier off and restores the download gate (the local-tier e2e specs and
`importCorpus` use it). Everything else about M9 stands: one report canvas with
chat beside it, Filters / SQL / Data / Saved as collapsible panels, the canvas
never opens empty, results copy out formula-guarded (D-071) and attribution-free
(D-082). The e2e suite's selector knowledge lives in `tests/e2e/ui.ts` — update
it first when the UI changes.

**Dates are one control now (D-085), bounded by the copy that is answering.**
`app/date-range.tsx` over `lib/dates.ts` replaces every `<input type="date">`:
keystrokes are buffered and committed on **Enter or blur only** — a commit
re-runs the report, a running query disables the box, and a disabled input eats
the keys after it (RE-037) — a bare `2025` means the whole year per edge, and a
date outside the data is clamped rather than accepted. An unset edge *displays*
the copy's extent in muted text and filters nothing, because seeding it as a
value would write today's boundaries into every permalink. The extent is the
`coverage` Worker message, answered from the database on either tier.

**M7 complete — the AI chat layer is live.**
Five read-only tools over the local corpus (`lib/tools.ts`), a same-origin PHP
relay to our own Ollama (`public/api/chat.php`, D-057), and a side panel that
renders every answer through the *same* components the Report and Explore tabs
use — no parallel renderer, and an aggregate leaves the conversation through
"Open in Report" while a record search goes to Explore, because those are the
surfaces that render each. Chat prose is a text node, always: no markdown, no
linkification, and the one thing a compromised model must not be able to do is
mint a URL. The conversation is session-only, which is what makes the tier's
"nothing is stored" disclosure true on the client as well as the server.

**A conversation that outgrows the window is fitted by dropping old tool
results, never by summarising (D-080).** A conversation is ~99% tool output by
volume — the floor is 3,717 tokens, one 50-row result is 3,215, an answer is
~30 — so six or seven ordinary questions reach the window, and overrunning it
is silent: 30 exchanges were accepted with `prompt_eval_count` pinned at 29,743
and no error. The model then reconstructs the topic from whatever survived,
which is how "which vendor am I investigating?" answered *Cisco* to a
conversation that opened with Fortinet, 0/5. Evicting the bulk and keeping
every word either party said: 5/5. **Summarising is the thing not to reach
for** — it would mint counts indistinguishable from tool output in a
conversation whose first rule is that only a tool may state one.

**The php-fpm streaming question D-057 left open is settled by measurement: PHP
streams.** Chromium saw 105 separate `read()` resolutions for 112 lines, first
at 431 ms; Firefox 111 for 112, at 405 ms — through nginx and Cloudflare, which
neither buffers nor caches it. Three buffers had to be turned off and each
costs a different amount (RE-030); all three are the app's to set, which is why
the relay deploys by unprivileged rsync.

**The heavyweight review found nine defects, two of them exploitable, and the
worst was a bound everyone assumed existed.** The SQL row cap counts *rows*, and
one row can be any size: `SELECT hex(zeroblob(50000000))` is 100 MB,
`group_concat(descr)` over `cve_text` is the whole table, and a recursive CTE
lands exactly on the 1,000-row cap with a gigabyte behind it — held in the
Worker, then structured-cloned to the page. Every one is a plain read the
authorizer allows, *correctly*. Fixed at three layers and recorded in D-078:
`SQLITE_LIMIT_LENGTH` inside the engine, a retained-character budget in the row
callback, and the wall-clock deadline D-044 asked for and nothing had. **The SQL
console had all of this exposure since M3**; the chat layer is only what made it
reachable by something other than the person typing. The other two that would
have shipped wrong answers: `kev_lookup` said "not in CISA's catalog" about an
identifier the copy has never held — D-077's rule, one level down — and
`cve_detail` reported `knownRansomwareUse: false` where CISA had stated
something this build cannot read, disagreeing with `kev_lookup` about the same
row.

**The scorecard is the honest-expectations artifact: 9/10 tool selection, 8/10
data exactly right, median 17.0 s** against the deployed site, the live relay
and `qwen3:8b` (2026-08-09), **ten of ten in a single turn**. **D-046 item #1 —
the founding question — is tool ✓ axes ✓ data ✓ in one turn, in every run.**
Item #2, the three-way breakdown, now scores fully for the first time.

**The run before it scored 7/10, and three of those four failures were mine,
not the model's.** Both KEV questions failed inside the *ground truth* with "no
such table: kev" — the harness never waited for the catalog the download
rebuilds after the import heading appears, and `page.reload()` tore down the
Worker mid-refresh with nothing retrying it. **And nothing had ever told the
model what day it is**, so "the last two years" was filtered as 2021–2023 —
its training era — in 2 of 3 probes. The date is now a `{{TODAY}}` placeholder
the relay substitutes per request, not a baked literal that would be stale the
day after a deploy while still reading as authoritative; `yearFrom`/`yearTo`
now say they are the *identifier* year rather than publication. The third was
the truth itself: a hard-coded 2024-08-01 that no correct answer could match
and that drifted further every day.

The two that remain are real. `sql-highest-score` answered 186,280 where the
truth is 1,562 — it counted every scored record instead of those holding the
maximum, which is a SQL reasoning error and not a surface gap.
`cisco-criticals` called `sql` where the benchmark wants `aggregate`, and
**that one is a tension in our own prompt**: the line that says to use `sql`
for "a single value rather than a tally" is what took `sql-highest-score` from
0/8 to 5/6, and a count of Cisco criticals is exactly a single value. The
benchmark prefers `aggregate` because its vendor dimension resolves names that
hand-written SQL guesses at. Tightening either way is measured to break the
other; it is left as it stands, and noted.

**Two rounds of push-back took tool selection from 8/10 to 10/10, and the
scorecard attributed each.** `sql-highest-score` moved from *"called aggregate,
aggregate, aggregate"* to *"called sql, and it refused: no such table:
cve_records"* to running SQL — because (a) an identical tool call is now
refused before it runs, the corpus cannot change mid-turn so a repeat returns
identical rows, and (b) **the system prompt now carries the schema**, which
D-044 specified and it did not have. A test reads `pipeline/schema.sql` and
refuses a brief naming anything the corpus lacks: a wrong schema is worse than
none, because the model writes confident SQL against it.

**Run-to-run variance is large; one scorecard is a sample, not a constant.**
`cisco-criticals` went exact → 0-against-204 → exact with no code change, and
item #2 produced a different wrong axis pair in every run. Item #1 never varied.

**Every remaining failure then turned out to be the tool surface, not the
model** — D-057's accepted risk, walked into and then caught by a fast probe
(the real prompt and schemas straight to Ollama, no browser). The dimensions
were a bare enum of sixteen names with no descriptions, so nothing said
`product` is labelled `vendor / product` and carries both; and the prompt's
"prefer `aggregate` for anything countable" steered models off the SQL tool for
a question `aggregate` cannot express (first-call `sql` selection 0/8 → 2/6 on
`gemma4:e4b`, 0/8 → 5/6 on `qwen3:8b`). **A model comparison settled the rest:
`qwen3:8b` scores 6/6 on item #2 where the pinned `gemma4:e4b` scores 0/6, at
half the size and the same latency — and `qwen3:14b` is *worse* than the 8b.**
It takes both halves: `qwen3:8b` is 0/8 on item #2 without the dimension guide
and 8/8 with it. The pinned model is unchanged pending the owner's call
(D-057 makes that configuration); the table is in plan.md.

**Building the harness found a two-milestone-old defect in a shipped surface.**
Computing a full-text ground truth through the SQL console failed with *"PRAGMA
(data_version) is refused"*: **fts5 reads that pragma itself**, and the M3
authorizer denied PRAGMA wholesale — so the console had never been able to run
a full-text query, including its own "Critical CVEs mentioning deserialization"
example button. Invisible for two milestones because Explore, Report and the
chat tools all run *unguarded*; the authorizer is installed only for SQL a
person or a model wrote, and nothing had ever driven that path automatically
(RE-033).

**Verifying against the live origin found three things reading the config could
not.** `nginx -t` refused the first config as a duplicate directive, so the
reload never happened while the files sat on disk saying "applied". The limits
were then keyed on `$binary_remote_addr`, which behind Cloudflare is *an edge
IP* — barely limiting an attacker while `limit_conn 2` would 429 a third
simultaneous visitor sharing an edge (RE-031); now keyed on `CF-Connecting-IP`
with a looser per-peer backstop, and deliberately not via `set_real_ip_from`,
which would start writing visitor IPs into the access log of a site that
collects nothing. And the benchmark harness itself hung twice on Playwright
locators that match nothing — which do not time out inside `expect.poll`, they
never settle (RE-032). Verified by exceeding: **15 concurrent through
Cloudflare → 4 × 429**; the access log carries `$request` and no
`$request_body`.

771 unit tests and 116 browser specs passing across two engines (42 skips, all
the opt-in `MEASURE=1` and `BENCH` suites), with the relay verified against the
live origin (405 on GET, 403 cross-origin, 413 over 256 KB, caller-supplied
`model` ignored, caller-supplied `system` or `tools` refused with 400, no CORS
headers, `cf-cache-status: DYNAMIC`).

**M6 complete — the CISA KEV overlay is live.** `kev.json` is served under its
own `no-cache` location by its own cron (`41 */6 * * *`): 1,662 entries,
byte-identical to what cisa.gov serves. KEV is CC0 so no notice travels (D-076)
— provenance does: every assertion of membership says *per CISA*, with the
catalog version and release date. Client-side the catalog is a **rebuildable
table** like the full-text indexes, so no schema bump and no re-download, and a
copy with no catalog *refuses* a KEV question rather than answering that nothing
is known to be exploited (D-077). "Not in KEV" is a labelled value, not an
absence band. Four defects came out of building it, `pnpm check` green through
all four; the one worth remembering is that **the bundler dropped a literal
segment** out of a template carrying `${…}` concatenated with `+`, so the
browser ran SQL the source never had (RE-028) — unit tests import the source,
only the browser runs the bundle, and `scripts/check-bundle.mjs` now refuses
such a build. Pointing the header spec at the live origin also found an M5
regression that had been recorded as verified (RE-029): `always` on
`^~ /data/`'s `Cache-Control` meant a 404 went out `immutable` and the edge was
already holding one, a cheap remote sync-DoS since delta URLs are predictable.


**M5 complete — the site is launched.** The origin serves **schema 2, rev 11**
in ID space `schema2-2026-08-08`, published 2026-08-08: 12 chunks, 65.7 MB
compressed from 398.5 MB raw, which retired the old lineage and all eight of its
deltas in the same operation. Verified from outside rather than asserted — a
full-corpus import from the live origin in a real browser (1.8 min), the header
contracts, and a hand-rehearsed daily cycle that would cut rev 12 from 11. The
published schema is at **2** (D-070, D-075): SSVC's
three decision points, `dateReserved`, `defaultStatus`, `cna.title` and the
rejection reason for the 17,842 REJECTED records that used to render blank.
Measured against a schema-1 build of the *same* clone, it costs **+2.40 MB
compressed (+3.8%)** — better than the proxy the owner took the trade on. NULL
is a value throughout: "not assessed" is filterable through a sentinel that
compiles to `IS NULL` beside the `IN`, sits last on every axis, and takes the
off-ramp neutral on a chart, because `Exploitation: none` is a finding and half
the corpus has no assessment at all. `title` joins the client-built full-text
index as a second column, on 83.3% of titles not being substrings of their own
description. The bump landed as a **bootstrapped** generation above the head
with `--new-id-space`; the runbook it followed is in pipeline/README.md, now
carrying the measured timings of the run that executed it.

Around it: a capability gate that *calls* a synchronous access-handle method
rather than looking for one — the only check that separates Safari 16.4 from
16.3; a storage preflight that budgets two generations before a byte is fetched;
one writer across tabs via Web Locks, with promotions announced so a tab that
did not perform the replacement reopens rather than answering from a generation
nobody else can see; an offline app shell generated from the finished export;
and the diagnostics panel D-009 makes the only support channel. **Six defects
came out of building it, and a passing test would have shown none of them —
one of them *was* a passing test**: a fixed probe filename that deadlocked two
tabs on an exclusive handle (RE-007), a cached `Response` whose URL became the
worker's and dropped the fragment its bootstrap config lived in (RE-021), a
Worker load failure with no `onerror` handler anywhere, RE-015 sitting live on
the launch path — now closed for `build.py` — a capability guard that checked
`createSyncAccessHandle` on the main thread, where **no** engine exposes it, and
so skipped all nine data-path spec files on every engine while `pnpm e2e`
reported green (RE-024), and an `/etc/nginx/sites-enabled` entry that had
stopped being a symlink, so a config change was edited into a file nginx was not
reading (RE-025). Cloudflare is in front and verified from response headers
(2026-08-08), which itself surfaced two live defects the day it was flipped.

**The browser matrix is two engines, not three.** WebKit was dropped
2026-08-08: Playwright's Linux build ships no OPFS (RE-022), so it could only
ever skip, and a project contributing nothing but skips is what let RE-024 hide.
**The Safari half of the D-016 floor is therefore unverified** and rests on
documented feature availability plus the gate. Chromium and Firefox run
everything: 98 tests, 57 passing, and 40 skips that are all the opt-in
`MEASURE=1` suite.

**Left after M5**: the full-corpus measurement, deliberately not taken (owner,
2026-08-08); Safari coverage, which needs real hardware; and a deterministic
Next.js `generateBuildId`, without which every deploy changes the service
worker's precache URLs and re-downloads the offline shell.

Behind it: M4 made the corpus analysable through one validated report definition
carried only in the URL fragment (D-069 – D-074), M3 made the query surface safe
by structure rather than by inspection (D-065 – D-068), M2 closed the server half
in production (daily ingest D-058, monthly rotation D-060 — whose first
unattended firing, 1 September, is still unobserved), and M1 proved the browser
data path end to end (D-049 – D-051). The AI ladder was re-ordered 2026-08-03 so
the first model tier is site-hosted Ollama behind a restricted same-origin relay
(D-057). Process was rightsized for MVP scale 2026-08-04 (D-062). Details live in
plan.md and the decision log; keep this paragraph short and current when
milestone status changes (rule 5).
