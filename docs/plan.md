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
work) no later than when they become the next milestone up. **M0 – M7 are
closed**: they are summarized below, and their full task-level record — every
checkbox, its evidence, and the defects each surfaced — lives in
[plan-archive.md](plan-archive.md), moved there verbatim so this document stays
small enough to load per task. **M8 is parked** (2026-08-09, owner): the
product is complete on the tier it has, and the next work is user experience
and testing rather than more model tiers. It keeps its scope and exit criteria
for whenever it resumes. **The next milestone is not yet decomposed** — see
"What's next" below.

## Completed milestones — summaries

Each entry says what shipped, when it closed, and what it deliberately left
open. The decision entries named are where the reasoning lives; the archive is
where the task-by-task record is.

### M0 — Plan the plan  `done` (2026-08-01)

Vision, the 55-row feature triage, corpus provisioning on `plex`, the
normalization spike (2.9 GB raw → 72 MB brotli in 19 s), the delta protocol
measured against a real upstream window, schema completeness priced in
compressed bytes, data-plane hardening, and architecture.md's first full draft.
D-001 – D-042. Q-003/Q-004 were deliberately deferred to M1 (they needed a
running browser).

### M1 — Scaffolding and one end-to-end path  `done` (2026-08-01)

Next.js 16 static-export scaffold with the full toolchain; the pipeline's first
half (D-043); the whole browser path — manifest → chunked fetch → WASM brotli →
OPFS → client-built FTS → a rendered query with the D-008 notice — proven e2e
and then at full corpus scale: 73 s import, ~850 ms worst query (D-049), the
256 MiB page cache every number depends on (D-050), and `opfs` over
`opfs-sahpool` (D-051). First real deploy to `cve.meenan.dev`. Cloudflare
turned out not to be in front at all; carried to M5 and closed there.

### M2 — Full-corpus Download and Sync  `done` (2026-08-05)

The delta wire contract, contract-tested both ways (D-055); stable interned IDs
proven at corpus cardinality (D-056); the daily ingest cron, in production
since 2026-08-03 (D-058); the monthly snapshot cron (D-060); download with
staged replacement — resumable, atomic promotion, previous copy intact through
any failure (D-061); batched client-built FTS with honest progress (D-035,
D-052); sync applying each delta in one transaction (D-063); stall detection on
bytes-received and freshness from the data's own build stamp (D-064); and six
failure-and-resume cases, all passing. Not claimed at closure: the monthly
cron's first unattended firing (1 September — still unobserved), and any staged-
replacement guarantee for `opfs-sahpool`, which keeps destroy-then-download.

### M3 — Query surfaces and tuning  `done` (2026-08-05)

The shared query layer compiling every confirmed filter axis to bound-parameter
SQL, with D-022's PUBLISHED-only default structural rather than remembered
per report (`lib/filters.ts`); the filter surface with
grouped counts; the SQL console made read-only by a SQLite authorizer rather
than by inspection (D-065); query progress and cross-thread cancellation
(D-066); query statistics shipped in the artifact — reference-host scan 605 →
398 ms (D-067); and schema versioning end to end, refusal before a byte is
fetched (D-068). The re-download at a genuinely new schema was the one thing
not exercised — it needed two builds of the app, and M5's real bump closed it.

### M4 — Analysis and reporting  `done` (2026-08-07)

The validated report definition, the primitive permalinks and M7's chat layer
share (`lib/report.ts`, D-044); two-axis aggregation with time buckets, bounded
and truncation-reported (D-069); the tabbed one-route shell; the report builder
on the same filter component as Explore; hand-rolled SVG charts with a
luminance-checked ordinal ramp (D-073); fragment-only permalinks — never the
query string (D-014) — verified on a fresh profile; saved reports in
`localStorage`, re-validated on read (D-072); streaming CSV/JSON export whose
writer cannot be constructed without the D-008 notice, hostile cells
neutralized (D-071); the per-CVE detail view with reference hardening; and
accessibility asserted by axe-core plus hand-written keyboard tests. Full-scale
measurement found two 42-second report shapes and fixed them with pinned join
order — 115× and 66× (D-074).

### M5 — Resilience and public launch  `done` (2026-08-08)

The site is launched. Schema 2 shipped before launch — SSVC, `dateReserved`,
`defaultStatus`, `cna.title`, rejection reasons — at +2.40 MB / +3.8% measured,
landing as a bootstrapped generation with `--new-id-space` (D-070, D-075), with
the announcement path exercised across the real bump (D-068). Around it:
multi-tab full support (one writer via Web Locks, promotions announced), the
storage preflight budgeting two generations, the capability gate that calls
`getSize()` rather than looking for it (D-016), the offline app shell generated
from the finished export (D-048), the diagnostics panel (D-009), Cloudflare
flipped and verified from response headers (D-039), the heavyweight data-plane
review — 19 findings, 15 upheld, including a non-retryable crashed publish and
a byte-identity bypass of the roll-backwards guard — and launch at schema 2
rev 11, verified by a full-corpus import from the live origin (1.8 min).

The browser matrix became two engines: WebKit dropped because Playwright's
Linux build has no OPFS (RE-022), after its skips had hidden a guard that
skipped all nine data-path specs on every engine while e2e reported green
(RE-024). **Left open at closure**: the Safari half of the D-016 floor is
unverified (needs real hardware); the full-corpus measurement, deliberately not
taken (owner, 2026-08-08); and a deterministic Next.js `generateBuildId`,
without which every deploy re-downloads the offline shell.

### M6 — CISA KEV overlay  `done` (2026-08-08)

The origin serves `kev.json` — 1,662 entries, byte-identical to cisa.gov —
under its own `no-cache` location, published by `pipeline/kev.py` on its own
cron, lock and state, validating fail-closed with atomic-rename publish. KEV is
CC0, so no notice travels (D-076); provenance ("per CISA, as of
\<dateReleased\>") travels everywhere membership is asserted. Client-side the
catalog is a rebuildable table created by the apply that fills it — no schema
bump, and a copy with no catalog refuses KEV questions rather than answering
that nothing is exploited (D-077). KEV is a filter *and* a report dimension;
"Not in KEV" is a labelled value, not an absence band; the detail view renders
CISA's notes URLs under the existing reference hardening.

Four defects `pnpm check` could not see: silent-success state handling that let
a broken upstream freeze the catalog permanently; a roll-backwards guard that
defended a poisoned far-future catalog (fixed with a client-side guard plus
future ceiling, D-077 §3); a KEV refresh that never reported ending, disabling
every button after each download; and the bundler dropping a literal SQL
segment (RE-028) — now caught by `scripts/check-bundle.mjs` on every build.
Running the header spec against the live origin also found and fixed RE-029,
an M5 `always` regression that let the edge cache 404s `immutable` for a year.

### M7 — AI chat layer: tool surface, site-hosted endpoint, benchmark  `done` (2026-08-08, hardened through 2026-08-09)

Five read-only tools over the local corpus (`lib/tools.ts`), a same-origin PHP
relay to our own Ollama (`public/api/chat.php`, D-057), and a side panel that
renders every answer through the *same* components Report and Explore use — an
aggregate leaves the conversation through "Open in Report", a record search
through Explore, because those are the surfaces that render each. Chat prose is
a text node always: no markdown, no linkification, because the one thing a
compromised model must not do is mint a URL. The conversation is session-only,
which is what makes "nothing is stored" true on the client as well as the
server. The relay pins the system prompt and the tool schemas from a build-time
artifact and refuses a caller-supplied one with 400, so the endpoint cannot be
used as a general-purpose LLM — which is what let its rate limit be raised
tenfold. **D-057's php-fpm streaming question was settled by measurement: PHP
streams**, 105 `read()` resolutions for 112 lines through nginx and Cloudflare,
once three separate buffers were turned off (RE-030).

**The heavyweight review found nine defects, two exploitable, and the worst was
a bound everyone assumed existed**: the SQL row cap counts *rows*, and one row
can be any size — `hex(zeroblob(50000000))` is 100 MB, and every one is a plain
read the authorizer allows, correctly. Fixed at three layers (D-078). **The SQL
console had that exposure since M3**; chat only made it reachable by something
other than the person typing. Building the harness also found a two-milestone-old
defect in a shipped surface: fts5 reads `PRAGMA data_version` itself and M3's
authorizer denied PRAGMA wholesale, so the console had never run a full-text
query — invisible because Explore, Report and the chat tools all run unguarded
(RE-033). Verifying the relay against the live origin found three more that
reading the config could not, including limits keyed on a Cloudflare edge IP
(RE-031).

**Model selection was decided by measurement, and every failure that looked
like model weakness turned out to be the tool surface** — D-057's accepted risk,
walked into and then caught. A bare enum of sixteen dimension names became a
guide (item #2: 0/8 → 8/8), and "prefer `aggregate` for anything countable"
became a line naming what `aggregate` *cannot* do (first-call `sql`: 0/8 → 5/6).
`qwen3:8b` replaced `gemma4:e4b` at half the size and the same latency, with
`qwen3:14b` measurably worse than the 8b.

Closed 2026-08-08; hardened 2026-08-09 with three further prompt defects found
the same way. **Nothing had ever told the model what day it is**, so "the last
two years" resolved to its training era — now a `{{TODAY}}` placeholder the
relay substitutes per request. The KEV join was ambiguous (`kev.cve_id` is the
integer, `cve.cve_id` the string) and produced a silent zero-row join in 5/5
probes. The decline paragraph declines the nouns it names and no others, which
is written down rather than overclaimed. Context is fitted by evicting old tool
results, never by summarising (D-080). Two scorecards are recorded rather than
one overwriting the other: `gemma4:e4b` at 10/10 tool and 8/10 data, `qwen3:8b`
at 9/10 and 8/10 with ten of ten in a single turn.

**Left open at closure**: the decline paragraph's lexical coverage (~1/11 leak
on an unlisted noun); `cisco-criticals`, where the benchmark wants `aggregate`
and our own prompt says `sql`, and measurement says tightening either way
breaks the other; and two environment changes that live outside git —
`OLLAMA_NUM_PARALLEL=2` on the llm box and the nginx rate limit.

## What's next — user experience and testing  `not decomposed`

The owner's direction, 2026-08-09: iterate on the experience and test the
product as it stands before adding model tiers. Scope is the owner's to set;
this section is only the material already on the books, collected so
decomposition starts from what is known rather than from memory.

**Carried open from closed milestones** (each is in a summary above, with the
milestone that recorded it):

- A deterministic Next.js `generateBuildId` (M5). Without it every deploy
  changes the service worker's precache URLs and re-downloads the offline
  shell — a user-visible cost on every deploy, and the most product-shaped
  item on this list.
- The Safari half of the D-016 capability floor is unverified (M5). It needs
  real hardware; Playwright's Linux WebKit ships no OPFS (RE-022).
- The full-corpus measurement, deliberately not taken (M5, owner).
- The monthly rotation cron's first unattended firing, 1 September (M2) —
  still ahead, and still the one part of the publish path never observed
  running by itself.
- The chat decline paragraph's lexical coverage, and the `cisco-criticals`
  disagreement between the benchmark and our own prompt (M7). Both measured,
  both written down where they will be found.

**Not yet examined at all**: the experience for a first-time visitor who has
not downloaded the corpus, on a slow connection or a phone; what the app does
when chat's single GPU box is unavailable; and whether the tabs, the filter
surface and the report builder read the way an analyst expects rather than the
way they were built. *The first and last of these are M9's subject.*

## M9 — Workspace UI revamp  `in progress` (2026-08-09)

The owner's decomposition of the experience work: reshape the app from five
mechanism-named tabs into a data-exploration product (D-081), branded **CVE
Explorer**.

Scope, from the owner's direction:

- **Landing view** for a visitor with no local copy: what the app is, what it
  offers, one "Download CVE dataset" action. The capability gate and storage
  preflight speak here, before the button.
- **Single-pane workspace** once a copy exists: the report canvas front and
  centre, chat beside it as the primary interaction, and collapsible panels
  for filters, raw SQL, data management and saved reports.
- **Chat populates the surfaces**: a model aggregate lands on the canvas and
  fills the filter and SQL panels (hidden by default, editable) — the answer
  is an editable report, not a terminal rendering.
- **Never an empty canvas**: auto-run the most recent report, or CVEs by
  severity over time on a first visit.
- **Presentation control on the canvas**: chart-type switching suited to the
  axes, legend show/hide per series, editable title and series display names.
- **Copy paths for sharing**: chart to clipboard as PNG (title, subtitle and
  legend drawn in), grid to clipboard as TSV + HTML for docs and Excel — every
  cell formula-guarded (D-071), no attribution block (D-082).
- **Test migration**: the e2e suite follows the UI it tests — a shared
  selector map (`tests/e2e/ui.ts`) replaces per-spec locator duplication.

First round of owner iteration (2026-08-11), from use of the deployed
workspace: no landing flash before the Worker reports whether a copy exists
(neither view renders until then); severity re-coloured to the conventional
hue palette (D-083); hover tooltips on every chart type; a stacked-area chart
type; the numbers table shown only as the Table view — a sortable,
zebra-striped spreadsheet — while staying in the DOM under a chart as the
screen-reader and audit channel; and the copy buttons collapsed into one copy
icon that copies the chart or the table, whichever is shown.

Second round (2026-08-11): CRITICAL darkened to brick red (floors re-checked);
the published-date window and a Monthly/Quarterly/Yearly bucket radio moved
onto the canvas above the chart — the same predicates the drawer edits, so
chips, drawer and permalinks agree; the chart-type dropdown became icon
toggles; every chat turn now carries the canvas's current definition in the
tool vocabulary (`canvasContext`, round-trip-tested against `parseToolCall`)
so "change the date range" edits the chart on screen instead of starting
blind; and the prompt now states that "the last N years" is a full window
ending today, not the last N calendar-year labels.

Third round (2026-08-12): the owner made the product call that the app is **no
longer offline-first** (D-084). The download gate is replaced by a **hosted
query tier** so a first visit starts in the workspace with no download: a
same-origin `api/sql.php` executes the client's read-only SQL against a server
copy of the same database (corpus + FTS + KEV, built by `pipeline/hosted.py`,
refreshed by the daily ingest's `--hosted` hook and the 6-hourly KEV job's,
replaced by atomic rename). The client seam is one branch — `lib/remote.ts`'s
`RemoteDb` wears the Worker's database shape and issues a synchronous XHR — so
both tiers run identical compiled SQL and handlers. "Make available offline"
replaces "Sync" on the hosted tier; the status strip discloses which tier
answers; `?remote=0` turns the tier off. The safeguard question was settled by
measurement rather than recollection (php:8.3 in a container): a CPU-bound
infinite statement is killed by `set_time_limit`+`zend.hard_timeout` at ~4 s,
and the M3 authorizer ports directly. An in-engine memory bound
(`PRAGMA hard_heap_limit`) was measured and then **removed** by owner decision
(2026-08-12): it is process-global and a one-way ratchet that would clamp the
whole shared fpm pool, so a value bomb can spike RSS to ~1 GB — accepted on the
64 GB origin (amends D-084). The endpoint verifies the authorizer installed
fail-closed (503, never a silently unguarded query). Verified: 6/6 hosted
browser specs on chromium (including the offline upgrade flipping the tier),
the parity test holding three implementations equal, and
`scripts/verify-sql-php.sh` driving the real endpoint in the official PHP image
(transport ladder, results, KEV join, fts5, every guard, fpm-respawn liveness).
Left for deploy: the two nginx include files
(`scripts/deploy-sql-nginx.sh`), confirming `zend.hard_timeout` is non-zero on
the origin, and the cron additions.

Fourth round (2026-08-16): the **date range control** (D-085), from the owner's
use of the deployed workspace. Two `<input type="date">` boxes are replaced by
one component used everywhere a date pair appears — the canvas strip and the
drawer's four axes — because the native control failed at all four things the
owner hit: typing `2025` into a year committed `0002` on the first keystroke
(a controlled date input fires a change per *segment*); the boxes were blank
over a report that was covering the whole corpus; the calendar offered 1970 and
2099 over data that starts in 1999; and reaching a month took a click per
month. It now buffers keystrokes and commits on Enter or blur (`2025` means the
whole year, per edge), shows the copy's own extent in place of an empty box
without committing a predicate, bounds and clamps every edge to that extent,
and offers a shortcut rail, month and year selects, two months at once, a
two-click range and full keyboard control. The extent is a new Worker message
(`coverage`) answered from the database on either tier, so the bounds describe
the copy that is actually answering. The ID-year boxes became bounded selects
for the same reason. Verified in both engines, with the calendar in the axe
pass; the arithmetic and the input parser are unit-tested under a pinned
non-UTC zone, since a suite running in UTC cannot tell a correct implementation
from one that reads local time.

Fifth round (2026-08-16): the **consumer cut** (D-086), from the owner's list.
The Filters drawer, the Data panel and the status strip left the workspace,
which is now the canvas (with a strip over the chart: the published range, a
weekly / monthly / yearly grain — quarterly withdrawn from the radio, weekly
new as a Monday-labelled `week` dimension — a Vendor and a Product picker, and
Reset), chat, the SQL panel (Run and Schema only) and Saved. The pickers are
hybrid comboboxes over an in-memory catalog of every vendor and product name
(`catalog` Worker message, paged for the hosted tier; `lib/catalog.ts` ranks
by substring tier then by how many CVE-product rows carry the name; a chosen
vendor narrows the products), committing into the same `filters.vendor` /
`filters.product` lists a permalink or chat call sets. Quick ranges over the
chart (all time, 10 / 5 / 2 / 1 years, YTD) set a lower edge relative to
today, and a window too wide for the grain coarsens it rather than being cut.
The workspace opens on week × severity over the last two years, and a local
copy more than twelve hours behind catches itself up on opening with the
progress bar saying why.
The Data panel's contents and the strip's revision / freshness / KEV lines
moved whole into a footer "Data & diagnostics" disclosure; the hosted tier's
disclosure is a footer line. Under the chart the state chip (default), the
"records match — buckets × series in ms" line and the backing-SQL disclosure
went — the SQL panel carries the last query. And the chat tools became
the **agent surface**: registered on WebMCP (`document.modelContext`) where
the browser has it, and always as `window.cveExplorer` for any extension with
a JavaScript tool, plus a `cve_explorer_guide` tool that returns the chat
prompt, dimensions and schema — same descriptors, same validation, same
Worker path, same canvas; a hidden agent note in the page and `/llms.txt` say
so in prose. The e2e suite drives the query layer through that surface now
that there is no drawer (`agentCall` in `tests/e2e/ui.ts`). And the model now
**reads every tool's result** (D-087, reversing D-044's "never transcribes"):
`search_records` hands back its rows in the same bounded window `sql` has —
50 rows within 12,000 characters, the remainder counted — so chat and agents
can summarise, compare and pick among the records they listed; the owner's
call, on the grounds that the chat layer exists for answers the UI cannot
give and the privacy-minded tier is the parked bring-your-own model, not a
handicapped general one. Then, on the same reasoning, **a sixth tool and an
accessor** (D-088): `compute` runs a model-written JavaScript function over
the *full* rows of the most recent result — the whole record list, not the
window — inside a sandbox (opaque-origin `srcdoc` frame, `default-src 'none'`
CSP, blob: worker terminated at 10 s, output clipped), so chat can do what
neither a query nor a 50-row window can — text matching over every
description, ratios, ranking, joining two results — and its code and output
render as a chat step; `window.cveExplorer.last()` gives an agent the same
rows whole. Both engines prove the boundary from inside the sandbox
(`tests/e2e/compute.spec.ts`); Firefox found the first design (a static file)
refused by this site's own CORP header, hence `srcdoc`.

Then a defect the pickers exposed (2026-08-16): **a time axis was sparse**.
`GROUP BY` returns only the buckets that hold a record and the chart places
buckets ordinally, so a week with no matching CVEs was not a zero — it was
absent, and its neighbours closed ranks: one vendor's trend line jumped from
March to September as two adjacent points, and every bar chart over a sparse
filter was drawn on an axis that was not a timeline. Invisible on the
unfiltered corpus, which has a record in every week since 1999. The chart
model (`fillTimeGaps`, lib/chart.ts) now inserts a zero row for every missing
grain step, widened to the report's published window when the canvas knows it
— clamped into the copy's extent, and the old end trusted only when the query
was not narrowed to its cap, since the query layer keeps the recent end — so
the chart, the tooltip, the table and the copied numbers all carry the zeros.
Building it found the two aggregate builders disagreeing about *which* end:
`crossSql` narrowed an over-cap time axis to the recent buckets, `groupSql`
(the one-dimension aggregate, and what `crossSql` delegates to with no series)
took `ORDER BY … ASC LIMIT n` — the oldest — so a chat "CVEs by month" with no
window answered about 1999 where the cross-tab answered about now. Aligned:
`groupSql` narrows newest-first in a CTE and re-sorts ascending, with the
Worker's sentinel row (`limit + 1`, which it turns into the "capped" flag by
stopping on it) sorted explicitly *last* — narrowed and merely re-sorted, the
sentinel would be the oldest row, come out first, and the Worker would keep it
and drop the newest bucket. And the same round marks **partial buckets**
(owner's ask): a time bucket the answer does not cover whole — the current
week or month, cut by the copy's last day, or an edge the report's own window
falls inside (the "2 yr" lower edge is a Monday mid-month, so a monthly chart's
first bucket is one) — carries " (partial)" in its label on every channel
(axis, tooltip, table, copied numbers), draws faded over a shaded band, and
the caption says why; `timeSpan` (lib/chart.ts) is the one place the window
over the copy is computed, for the canvas and the chat panel alike (which now
receives `coverage`). Building the caption found RE-039: an HTML entity in a
multi-line JSX text node made the bundle drop the text's leading space, so
"(partial) are" shipped as "(partial)are" — a literal `’` does not.

Exit: `pnpm check` and `pnpm e2e` green on both engines across both tiers; the
owner has used the deployed workspace and the remaining rough edges are
recorded here rather than open-ended.

## M8 — Other model tiers: BYO keys and in-browser local  `parked` (2026-08-09)

**On hold, owner's call.** The product is complete and usable on the tier it
has: everything but chat runs in the browser and depends on no server at all,
and chat works end to end against the model we host (D-057). Adding tiers
multiplies the surface — four provider adapters, a WASM/WebGPU runtime,
multi-gigabyte weight storage — before the single-tier product has been
exercised by real use. So the next work is the user experience and testing what
exists; this milestone resumes when that is worth building on.

**What being parked here costs, stated rather than assumed.** Chat is the one
feature with a server dependency, and it is a *hard* one: a single GPU box with
two inference slots. Everything else — search, filtering, reports, charts,
export, KEV, the SQL console — is unaffected if that box is down, so the
failure is bounded to one feature degrading rather than the site. But the
concurrency ceiling is real, and it is lower than the rate limit in front of
it: nginx allows 120 requests a minute, and two slots at ~4.7 s serve far
fewer, so the queue is the true limit and the honest number for concurrent chat
users is single digits. This is the argument for D-045's tiers, and it is a
scale argument, not a correctness one — which is why it can wait.

The scope below is unchanged and still current.

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
