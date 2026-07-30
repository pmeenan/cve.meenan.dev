# Vision

## What this is

The CVE List is published as ~300k JSON records in a single 2.4 GB git
repository. That format is excellent for distribution and terrible for asking
questions. Anyone who wants to know *which CNAs publish the most disputed
records*, *how CVSS severity distributions shifted year over year*, or *every
CVE mentioning a given product with a CVSS ≥ 7 since 2023* currently either
writes throwaway scripts against a local clone or hands their query to somebody
else's search service.

cve.meenan.dev is the third option: bring the corpus into your own browser and
query it locally, without telling anyone what you asked. Records live in SQLite
compiled to WebAssembly and persisted to OPFS, so what sits in local storage is
a real relational database with real SQL behind it. A single locked-down
same-origin endpoint feeds data in and does nothing else — no query, filter, or
report ever leaves the client.

How much of the corpus is local, and when, is deliberately still open: a full
up-front copy and a cache that grows as you explore are both live candidates
(see [features.md](features.md) open question 1). The properties below are
written to hold either way.

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
4. **Query privacy is verifiable, not promised.** With the network panel open, a
   user can confirm that searching and reporting issue no requests at all, and
   that sync requests carry no query content. This is a property anyone can
   check, which is the point.
5. **Work already done stays available offline.** Any analysis whose data is
   already local runs with the network disconnected, and the app says plainly
   when a query needs data it does not have rather than failing obscurely. If
   M0 selects a full-copy architecture this strengthens to "everything works
   offline"; the weaker form is what holds under every candidate.
6. **Reports are shareable without the data being shareable.** A user can hand
   someone a query or report definition that reproduces the analysis on their
   own local copy, and separately export result sets in a standard format —
   carrying the attribution the CVE terms require (D-008).
7. **Results are never quietly wrong.** A query that cannot be fully answered
   from local data either fetches what it needs or reports the gap. It never
   returns a plausible-looking undercount. This matters most under a partial
   cache, which is precisely where it is easiest to get wrong.

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
  is the subject. Overlays such as KEV, EPSS, or NVD enrichment are candidates
  to be triaged in M0 ([features.md](features.md)), not assumed scope — each one
  adds a fetch path, a license question, and a sync problem.
