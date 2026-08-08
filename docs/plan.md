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
work) no later than when they become the next milestone up. **M0 – M6 are
closed**: they are summarized below, and their full task-level record — every
checkbox, its evidence, and the defects each surfaced — lives in
[plan-archive.md](plan-archive.md), moved there verbatim so this document stays
small enough to load per task. **M7 is next, decomposed 2026-08-08**; M8
carries scope prose and exit criteria until its turn.

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

Four shape decisions were taken by the owner at decomposition (2026-08-08),
following M4 – M6's precedent, because each changes what the tasks below are.
**Chat is a side panel, not a sixth tab**: it opens beside whatever tab is
active, so a user can ask about what they are looking at. The consequence
follows from D-044 rather than from preference — the panel renders compact
results inline through the *same* components the Report tab uses, never a
parallel renderer, and every rendered definition carries an "Open in Report"
action that loads it into the builder, which is what keeps chat's output
hand-editable and re-runnable rather than a picture of an answer. **Chat
history is session-only**: a reload clears the conversation and nothing about
it is stored anywhere, which makes the tier's "nothing is stored" disclosure
true on the client as well as the server; the durable artifact is the report
definition, and Saved already owns that (D-072). **The first benchmark set is
~10 questions**: D-046's two canonical items plus roughly one per tool, each
with hand-written SQL ground truth — enough to score tool selection and
argument accuracy per tool without ground-truth authoring dominating the
milestone; the set grows in M8 when local-model selection needs it. **The
heavyweight treatment is pre-sanctioned for both gating surfaces**
(workflow.md's "when to go heavy" names them by name): the relay endpoint with
its limits, and the injection-containment story — hostile records through the
chat path — each get the multi-agent adversarial pass before the milestone
closes, sanctioned now rather than decided at the moment.

Tasks in dependency order. The streaming experiment leads because its outcome
decides the relay's implementation — and possibly forces a decision entry —
so nothing server-side is committed before it runs. The tool surface is
deliberately second rather than after the relay: it is pure client code,
testable without any model in the loop, so it can proceed while the server
half settles.

- [ ] **The php-fpm streaming experiment** (D-057). Before any implementation
      is committed: can PHP 8.4 behind php-fpm and this nginx stream a chat
      completion token by token — `output_buffering`, `fastcgi_buffering`,
      response compression, and Cloudflare in the path, all measured with a
      real Ollama round trip observed from a browser, not assumed from
      documentation (rule 3: training knowledge is stale for exactly this).
      The deliverable is a number and a verdict recorded in the task note: time
      to first token through the full stack, and whether tokens arrive
      incrementally or in one buffered flush. If PHP cannot stream cleanly,
      the alternative is a decision entry, not drift (D-057).
- [ ] **The tool surface** (D-044). The curated tools — search over the
      client-built FTS, filter + aggregate emitting report definitions, CVE
      detail, KEV lookup — with tight schemas sized for small models, plus the
      `SELECT`-only SQL tool riding D-065's authorizer with its row cap and
      D-066's cancellation. Read-only and render-only structurally: no tool
      fetches a URL, writes, or reaches the network, enforced by what the
      tools *can* do, never by inspecting arguments. Aggregates may enter
      model context; row sets return as handles rendered by the fixed UI
      (D-044: the model orchestrates, it never transcribes). Everything a
      model emits is a stranger's input: emitted report definitions go through
      `parseReport` exactly as a hostile fragment would, tool arguments are
      validated by name with unknown tools and malformed arguments refused,
      and a tool result carries structured data, never markup. Unit-tested
      against hostile records with no model in the loop — the surface is
      deterministic code, and its tests must not depend on an LLM.
- [ ] **The chat relay** (D-057, under D-006's rules). The same-origin
      endpoint relaying to `http://llm:11434/`: chat completion as the only
      exposed operation, server-pinned model (`gemma4:e4b` today), streamed,
      POST-only with a capped body. No caller-supplied model, URL, host, or
      path reaches anything; same-origin is the D-034 style — the *absence* of
      CORS headers; nothing is stored and request bodies are never logged —
      the access log records that the endpoint was hit, not what was asked,
      and that claim is checked against the server's actual log configuration
      rather than asserted. nginx `limit_req`/`limit_conn` on the location are
      a ship requirement, not a nicety — absence-of-CORS stops cross-site
      browsers, not `curl` — and the limits are verified against the live
      origin by exceeding them. Cloudflare must pass the stream through
      unbuffered and never cache the endpoint, verified from response headers
      like every other edge claim (M5's lesson: the dashboard is not
      evidence). Heavyweight review before this ships (pre-sanctioned above).
- [ ] **The chat loop and the panel.** The client-side orchestration —
      question → model → tool calls → grounded answer, streamed into the side
      panel (shape decision above). Chat prose renders as plain text, never
      markup or minted URLs (D-044); inline results render through the shared
      report components with Open in Report; the backing query of every
      number a user sees is inspectable from the panel, which is what vision
      criterion 7 means in a chat. History is session-only (shape decision
      above). Progress per D-052: a waiting model and a running tool each name
      themselves past a second, a query is cancellable mid-tool-call (D-066),
      and a stream that stops producing bytes is a stall reported as one
      (D-064's rule applied to the new long-running thing). The consent
      surface is here too: the first-use disclosure that on this tier the
      question and its tool results transit `cve.meenan.dev` and our model
      host and nothing is stored, shown before the first request leaves and
      recorded client-side; CSP `connect-src` stays pinned to the origin
      itself, asserted by a test so a later tier widening it is a deliberate
      diff rather than drift.
- [ ] **The benchmark harness** (D-046). ~10 questions with hand-written SQL
      ground truth: canonical items #1 and #2, plus at least one exercising
      each tool — search, aggregate, CVE detail, KEV, and the SQL tool —
      driven through the *actual* chat integration (our schemas, our system
      prompt) in Playwright and scored by comparing the emitted report
      definition or its result data against ground truth; no LLM judge.
      Scorecard per question: tool-call accuracy, turns needed, latency.
      Opt-in like `MEASURE=1`, because it needs the private `llm` host and an
      inference round trip is not a unit test. The `gemma4:e4b` scorecard is
      the milestone's honest-expectations artifact; a dev-only frontier-key
      spot check disambiguates tool-surface bugs from model weakness before
      either is "fixed" (D-057's accepted risk, mitigated as recorded).
- [ ] **The adversarial containment pass, heavyweight** (pre-sanctioned
      above). Hostile records through the chat path — markup, injection
      payloads, and hostile URLs in the descriptions and titles the model
      reads — and the containment claim verified rather than argued: nothing
      beyond the read-only tool surface is reachable from a compromised
      conversation, no record-supplied markup or URL renders outside the
      fixed UI's existing treatment, and a successful injection yields
      wrong-but-inspectable presentation and nothing more (D-044). The
      relay's abuse surface is in scope too: oversized bodies, cross-origin
      callers, concurrency exhaustion against the one small GPU box.

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
