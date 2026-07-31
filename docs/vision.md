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
behind it. A single locked-down same-origin endpoint feeds data in and runs no
analysis: your filters, aggregates, and search terms are evaluated on your
machine and never sent anywhere.

You get the whole corpus, not a slice of it: an explicit "Download data" action
fetches a complete prebuilt database — roughly 72 MB compressed for all 372,092
records — and an explicit "Sync" action applies deltas, typically well under a
megabyte a day (D-025). Nothing fetches behind your back.

## Who it's for

- **Security researchers and vulnerability analysts** who need to slice the full
  corpus and would rather not disclose their line of inquiry to a third-party
  search service.
- **CNAs and program participants** looking at publication patterns, record
  quality, and their own output in context.
- **Anyone with a CVE question** that a keyword search box cannot answer,
  including people who want raw SQL access to the corpus without provisioning a
  database.
- **The project owner**, as the first user — this is a tool built to be used,
  not a demo.

## Success criteria

Each of these is falsifiable, and several need a measured budget attached during
M0 rather than a hand-wave. That measurement is itself an M0 deliverable.

1. **A first-time visitor gets a real answer in their first session.** On a
   modern desktop browser, someone who arrives with a question reaches a
   correct result without a setup ritual — with visible progress for whatever
   data transfer it requires, and no loss of accumulated work if they close the
   tab partway and come back.
2. **Returning users update incrementally.** Catching up after days away
   transfers a small fraction of the corpus and completes in seconds to minutes,
   and does not discard data the user already has.
3. **Core analytical queries run at interactive speed.** Filter-and-aggregate
   over the whole corpus (e.g. group by CNA and year with a CVSS predicate)
   returns within a latency budget set from M0 measurements on real data — not
   an assumed one.
4. **What the server can learn is bounded and checkable.** With the network
   panel open, a user can confirm that the app makes exactly two kinds of
   request: fetch the snapshot, and fetch deltas since a watermark. Neither
   carries a filter value, a search term, or any indication of what is being
   asked. Analysis — filtering, aggregation, ranking, search — runs entirely on
   the client. D-014 permits requests to name fields and partitions; D-025
   removed even that, so the endpoint learns nothing about the query at all.
5. **It works offline, fully.** Once downloaded, the client holds the entire
   corpus (D-025), so search, analysis, and reporting all work with the network
   disconnected. Only Download and Sync need it.
6. **Reports are shareable without the data being shareable.** A user can hand
   someone a query or report definition that reproduces the analysis on their
   own local copy, and separately export result sets in a standard format —
   carrying the attribution the CVE terms require (D-008).
7. **Results are never quietly wrong.** Bulk import makes this largely
   structural — the client either holds the whole corpus or has not downloaded
   it yet, so there is no partial view to undercount from. Two ways it can still
   break, and both are guarded deliberately: a stale corpus producing confident
   counts, which the visible freshness indicator exists to prevent; and a search
   index drifted out of step with the data during a delta apply (D-025 hazard 2),
   which is where the correctness effort belongs.

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
- **Nothing is collected from users.** No telemetry, no analytics, no error
  reporting, not even opt-in (D-009). The tradeoff is accepted knowingly: we are
  blind to production failures, and the diagnostics panel exists so users can
  tell us what we cannot see.
