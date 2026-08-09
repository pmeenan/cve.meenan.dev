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
way they were built.

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
