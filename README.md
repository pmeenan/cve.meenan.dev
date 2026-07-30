# cve.meenan.dev

Browser-based search and analysis over the complete CVE List.

The [CVE List](https://github.com/CVEProject/cvelistV5) ships as roughly 300k
JSON records in a 2.4 GB git repository — a good distribution format and a poor
one for asking questions. This tool pulls the corpus into your browser once and
lets you query it locally from then on.

- **Your queries stay on your machine.** Records are stored in SQLite compiled
  to WebAssembly and persisted to OPFS, and every search, filter, and report
  runs client-side. A single same-origin endpoint feeds the corpus in; it never
  receives a query.
- **A real database, not a search box.** The corpus lands as a queryable
  relational store, so questions a keyword search cannot answer are in reach.
- **Kept current.** The local copy updates incrementally rather than by
  re-downloading the corpus.

Planned capabilities beyond the above — structured filtering, trend reporting,
export, enrichment overlays — are being triaged, not yet committed. See
[docs/features.md](docs/features.md) for what is confirmed versus proposed.

## Status

**Pre-code.** The project is in milestone M0 ("plan the plan"): scope,
architecture, and the milestone ladder are being settled before implementation
starts. There is no application to run yet. Progress lives in
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
