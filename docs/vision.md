# Vision

## What this is

The CVE List is published as 372,092 JSON records — 2.9 GB of them — in a single
git repository. That format is excellent for distribution and terrible for
asking questions. Anyone who wants to know *which CNAs publish the most disputed
records*, *how CVSS severity distributions shifted year over year*, or *every
CVE mentioning a given product with a CVSS ≥ 7 since 2023* currently either
writes throwaway scripts against a local clone or hands their query to somebody
else's search service.

cve.meenan.dev is the third option: bring the corpus into your own browser and
query it there. Records live in SQLite compiled to WebAssembly and persisted to
OPFS, so what sits in local storage is a real relational database with real SQL
behind it. Data arrives as static same-origin files and the server runs no
analysis: your filters, aggregates, and search terms are evaluated on your
machine and never sent anywhere — the client sends no query parameters at all
(D-032).

You get the whole corpus, not a slice of it: an explicit "Download data" action
fetches a prebuilt database — 62.6 MB compressed for all 372,092 records — and
an explicit "Sync" action applies deltas, typically well under a megabyte a day
(D-025, D-038). Nothing fetches behind your back.

On top of that database sits an AI analyst. A free-form chat box turns
plain-language questions — *"stacked count of CVEs by severity over time, for
this vendor"* — into local queries and drives the same charts, clickable lists,
and drill-downs the deterministic UI offers; every answer is backed by queries
you can inspect, edit, and re-run without the model (D-044). The first model
tier is one we host: a model on our own hardware, reached through a restricted
same-origin endpoint — no key, no setup, and the one tier where your question
and the query results behind it transit this server, disclosed before first
use and stored nowhere (D-057). The later tiers restore the stronger claims: a
model that runs in your browser, downloaded once like the corpus, so even the
AI never leaves your machine and works offline; and a user-supplied API key
routing chat to a hosted model — Gemini (whose Pro/Ultra subscription quota
rides the ordinary API key), OpenRouter, Anthropic, or OpenAI, each adapter
shipping only after its browser-direct path is verified, your question going
straight from your browser to that provider on your own account and key, never
through this server (D-045). Chat is an additional way to drive the app, never
the only one — everything works with no model configured.

## Who it's for

- **Security researchers and vulnerability analysts** who need to slice the full
  corpus and would rather not disclose their line of inquiry to a third-party
  search service.
- **CNAs and program participants** looking at publication patterns, record
  quality, and their own output in context.
- **Anyone with a CVE question** that a keyword search box cannot answer —
  people who want raw SQL access to the corpus without provisioning a database,
  and people who would rather ask the question in plain language and let the
  chat layer write the queries.
- **The project owner**, as the first user — this is a tool built to be used,
  not a demo.

## Success criteria

Each of these is falsifiable, and several needed measurement during M1 rather
than a hand-wave (D-029 moved the browser measurements there). That measurement
is itself a milestone deliverable.

**None of the measured numbers is a threshold** (D-052). Work takes as long as
the data and the hardware make it take; what the app owes the user instead is
honesty about it — anything over about a second says what it is doing and shows
progress where the work is countable, and an operation that has *stopped*
making progress is detectably broken rather than indistinguishable from a slow
one. So the time-shaped criteria below are falsified by silence, by a frozen
tab, or by a stall the app fails to notice — not by a stopwatch. The numbers
are the M1 baseline (D-049): what normal looked like on real hardware, kept so
a regression is visible.

1. **A first-time visitor gets a real answer in their first session.** On a
   modern desktop browser, someone who arrives with a question reaches a
   correct result without a setup ritual — with visible progress for whatever
   data transfer it requires, and no loss of accumulated work if they close the
   tab partway and come back. The import is long enough that *how it is
   presented* is the criterion: every stage over a second names itself and
   shows progress, and a download that stalls says so instead of spinning.

   **M1 baseline (D-049)**, one desktop-class machine, Chromium, server on
   loopback: cold import 73.3 s, of which 66.1 s is building the search
   indexes; 682–715 MB peak memory in the renderer process; 441 MB left in
   OPFS. Reopening reports the local copy in 287 ms, though the first query
   after a reopen costs ~9 s of page-cache warming.
2. **Returning users update incrementally.** Catching up after days away
   transfers a small fraction of the corpus and completes in seconds to minutes,
   and does not discard data the user already has.
3. **Core analytical queries run as fast as the machine allows, and never
   pretend otherwise.** Filter-and-aggregate over the whole corpus (e.g. group
   by CNA and year with a CVSS predicate) should be as fast as the data and the
   hardware permit — **there is no latency ceiling** (D-052). A complicated
   question over 372k records is allowed to take a while; what is not allowed
   is a query that appears to have finished, freezes the tab, or cannot be
   abandoned. So this criterion is falsifiable on *behaviour*, not on a number:
   a query past a second says it is running, stays cancellable, and leaves the
   UI responsive.

   The M1 sweep is a recorded baseline for spotting regressions and choosing
   what to index, not a gate. Over the ten shapes in `lib/queries.ts` against
   the full corpus: 4–190 ms for nine of them, and 680–954 ms for a full scan
   of the reference tables — which has no supporting index yet, and is M3's
   work. These depend on the 256 MiB page cache (D-050); at SQLite's stock
   2 MiB the same queries take up to 92 s.
4. **What the server can learn is bounded and checkable.** With the network
   panel open, a user can confirm that the app makes exactly two kinds of
   request to this server: fetch the snapshot, and fetch deltas since a
   watermark. Neither
   carries a filter value, a search term, or any indication of what is being
   asked. Analysis — filtering, aggregation, ranking, search — runs entirely on
   the client. D-014 permits requests to name fields and partitions; D-025
   removed even that, so the server learns nothing about the query at all.
   The AI layer adds further request kinds, all user-initiated. One is
   same-origin: chat on the site-hosted tier posts the question and its tool
   results to this server's chat relay, which forwards them to our own model
   and stores nothing — disclosed before first use, and still visible in the
   network panel (D-057). The rest bypass this server entirely: model-weight
   downloads from Hugging Face, and — only when the user supplies a key —
   chat traffic direct to their chosen provider (D-045).
5. **It works offline, fully.** Once downloaded, the client holds the entire
   corpus (D-025), so search, analysis, and reporting all work with the network
   disconnected. Only Download, Sync, and the optional model-weight download
   need it — chat on the site-hosted or BYO-key tiers is the one feature that
   inherently requires the network (D-045, D-057).
6. **Reports are shareable without the data being shareable.** A user can hand
   someone a query or report definition that reproduces the analysis on their
   own local copy, and separately export result sets in a standard format —
   carrying the attribution the CVE terms require (D-008).
7. **Results are never quietly wrong.** Bulk import makes this structural — the
   client either holds the whole corpus or has not downloaded it yet, so there
   is no partial view to undercount from. Year partitioning would have traded
   this away and was rejected for that reason as much as any other (D-038). Two
   ways it can still break, both guarded deliberately: a stale corpus producing
   confident counts, which the visible freshness indicator exists to prevent;
   and a search index drifted out of step with the data during a delta apply
   (D-025 hazard 2), which is where the correctness effort belongs.
8. **AI answers are grounded and auditable.** Every number a chat answer shows
   came from a query, not from the model's token sampling: presentation flows
   through the same report definitions the deterministic UI renders, and the
   queries behind an answer are exposed for inspection and re-running (D-044).
   The chat layer is optional — criteria 1–7 hold with no model configured —
   and the local-model tier preserves criterion 5 in full, offline included.

## Non-goals

- **Not a CVE authoring or submission tool.** Records are read-only here;
  creating and updating CVE records is the CVE Services API's job.
- **Not a vulnerability scanner.** The tool never looks at the user's systems,
  builds an asset inventory, or matches CVEs against installed software. It
  analyzes the corpus, not your machine.
- **Not a hosted analysis service or public API.** Moving query execution
  server-side would forfeit the privacy property that justifies the project
  (D-007).
- **Not a background alerting service.** Updates are pull-based when the user
  opens the app; standing alerts would require infrastructure that watches on
  the user's behalf, which contradicts the client-side model. In-app watchlists
  evaluated at sync time are a separate, and permitted, idea.
- **Not an aggregator of every vulnerability data source.** The cvelistV5 corpus
  is the subject. Triage settled this at exactly one overlay — CISA KEV, because
  "is this actually being exploited" is the question analysts ask next. EPSS and
  NVD enrichment were rejected (D-010): each adds a fetch path, a license
  question, and a recurring sync problem to a tool whose pitch is not needing
  the network.
- **Not a third-party AI gateway.** The one inference path this project
  operates is its own model on its own hardware, behind a same-origin endpoint
  pinned to that single model, storing nothing (D-057). No third-party model
  traffic is proxied through this server and no shared or bundled API key
  exists. Hosted providers are the user's own key and account, called
  browser-direct (D-045) — and consumer-subscription OAuth passthrough is out
  permanently where providers forbid it.
- **The app collects nothing.** No telemetry, no analytics, no error reporting,
  not even opt-in (D-009). The tradeoff is accepted knowingly: we are blind to
  production failures, and the diagnostics panel exists so users can tell us
  what we cannot see. What this buys is the claim worth making — **your queries
  never reach us**, because the corpus is downloaded once and every search,
  filter and report runs against your own copy. It is deliberately *not* a
  claim that the server records nothing at all: it keeps an ordinary access log
  with real visitor addresses, like every other web server (D-079).
