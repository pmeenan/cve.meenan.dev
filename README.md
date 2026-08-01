# cve.meenan.dev

Browser-based search and analysis over the complete CVE List.

The [CVE List](https://github.com/CVEProject/cvelistV5) ships as 372,092 JSON
records — 2.9 GB of them — which is a good distribution format and a poor one
for asking questions. This tool normalizes the corpus into a compact SQLite
database (~63 MB compressed), pulls it into your browser once, and lets you
query it locally from then on.

- **Your queries stay on your machine.** Records are stored in SQLite compiled
  to WebAssembly and persisted to OPFS, and every search, filter, aggregate, and
  report is evaluated client-side. The server hands over static files and runs
  no analysis — it never sees a filter value, a search term, or any other
  request parameter.
- **A real database, not a search box.** The corpus lands as a queryable
  relational store, so questions a keyword search cannot answer are in reach.
- **Kept current.** The local copy updates incrementally rather than by
  re-downloading the corpus.
- **AI-assisted (planned).** A chat layer will turn plain-language questions
  into local queries and drive the same charts and lists as the regular UI —
  by default with a model that also runs in your browser; optionally with your
  own hosted-model API key, called browser-direct and never through this
  server (D-044, D-045).

The feature ledger is fully triaged — see
[docs/features.md](docs/features.md) for what is confirmed versus rejected.

## Status

**M1 in progress.** Milestone M0 ("plan the plan") closed with scope,
architecture, schema, and the data-delivery protocol settled and measured
against the real corpus. Scaffolding and the first end-to-end path — published
chunks → SQLite/WASM on OPFS → a rendered query — run locally; full-scale
measurement and the first deploy remain. Progress lives in
[docs/plan.md](docs/plan.md).

## How this project is built

Almost all code here is written by AI agents working from the documentation in
`docs/`, directed and reviewed by a human who is the sole committer. The
documentation is the project's long-term memory, which is why it is unusually
explicit about what is decided, what is merely proposed, and what is still open.

## Start here

- [AGENTS.md](AGENTS.md) — the rulebook and doc map; read first
- [docs/vision.md](docs/vision.md) — why this exists, who it is for, success criteria
- [docs/features.md](docs/features.md) — the scope ledger: confirmed, proposed, open
- [docs/plan.md](docs/plan.md) — milestones and current progress
- [docs/architecture.md](docs/architecture.md) — system shape and fixed points
- [docs/decisions.md](docs/decisions.md) — the decision log
- [docs/workflow.md](docs/workflow.md) — how agents and the human collaborate
- [docs/rough-edges.md](docs/rough-edges.md) — findings log

## License

This project's code is licensed [Apache-2.0](LICENSE).

CVE record content is published by the [CVE Program](https://www.cve.org/) and
is used here under the
[CVE Terms of Use](https://www.cve.org/legal/termsofuse), which permit
reproduction and derivative works provided MITRE's copyright designation and
license accompany each copy. CVE™ is a trademark of The MITRE Corporation. The
CVE List is provided "AS IS" without warranty of any kind — see the terms.
