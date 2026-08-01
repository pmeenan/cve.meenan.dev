# cve.meenan.dev — browser-based analytics over the full CVE List

A public web app for searching, analyzing, and reporting on the complete CVE
List — the [cvelistV5](https://github.com/CVEProject/cvelistV5) corpus, 372,092
records and growing — with a planned AI chat layer (M7/M8) that turns
plain-language questions into local queries (D-044). The entire data plane runs
in the browser: the corpus is normalized server-side into a ~63 MB compressed
SQLite database, downloaded on demand into OPFS, and queried locally — so no
search or report ever leaves the client. By default the model runs in the
browser too; the one opt-in exception is a user-supplied hosted-model key,
which sends chat traffic browser-direct to that provider (D-045). The server
serves the snapshot and its deltas as static files and performs no analysis and
no inference. Almost all code is written by AI agents working from the project
documentation, directed and reviewed by a human.

**Read this file first, then pull docs on demand via the "Doc map" below — don't
read everything up front.** This file is long-term project memory and the
rulebook for agents.

## Load-bearing constraints (change deliberately, never silently)

Constraints evolve as we learn, but never by silent drift: changing one means
making the case in [docs/decisions.md](docs/decisions.md) and updating the
affected docs. Until then, these govern.

- **The data plane is client-side.** Parsing, storage, indexing, querying,
  charting, and export all happen in the browser. Any proposal to move analysis
  server-side for performance is a constraint change, not an optimization.
  (D-007)
- **The server may learn fields and partitions, never predicates.** It must
  never receive a filter value (`vendor = cisco`), a search term, or anything
  else that would let it evaluate the query. Selecting data is allowed;
  executing analysis is not. As built this is stronger than the rule requires —
  the client sends no parameters at all — but the rule is the floor. (D-014,
  D-032)
- **The AI tool surface is read-only and render-only, permanently.** CVE text
  flows into LLM prompts, so injection is assumed: no tool may fetch a URL,
  write data, or reach the network. Hosted models are the user's own key —
  stored client-side, called browser-direct, never proxied; no bundled key, and
  no consumer-subscription OAuth where providers forbid it (none is sanctioned
  today). (D-044, D-045)
- **Nothing is collected from users — no telemetry, ever.** Not analytics, not
  error reporting, not opt-in. This makes the privacy claim verifiable in a
  network panel rather than a promise. Do not add a reporting channel; improve
  the diagnostics panel instead. (D-009)
- **The data plane is static files, and no request handler stands in it.** The
  snapshot, manifest, deltas, and KEV catalog are pre-built files served by
  nginx from `cve.data/pub/`; the client sends no parameters. Adding a dynamic
  endpoint is a constraint change: it must serve derived CVE data and nothing
  else, must never accept a caller-supplied URL, path, or ref that reaches the
  filesystem or network, and must be same-origin-restricted and rate-limited.
  (D-006, D-032)
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
- **Every copy of CVE data carries MITRE's notice.** The CVE terms grant broad
  reuse — derivative works included — on one condition: each copy reproduces
  MITRE's copyright designation and the license. That covers served artifacts
  and anything a user exports, so it is a functional requirement of those
  features, not a footer. (D-008)
- **Agents write, humans commit.** (D-001)

## Repository layout

| Path         | What lives there |
| ------------ | ---------------- |
| `docs/`      | Vision, plan, architecture, decisions, features, rough edges, workflow |
| `app/`       | Next.js App Router pages and styles |
| `lib/`       | Shared types — notably the published contract in `protocol.ts` |
| `workers/`   | The Worker that owns SQLite/WASM on OPFS |
| `pipeline/`  | Python ingest and publish (D-043). **Never deployed** |
| `scripts/`   | Build, serve, deploy, license audit |
| `tests/`     | `unit/` (Vitest) and `e2e/` (Playwright) |
| `public/`    | Static passthrough into the export root |

`pnpm check` runs typecheck, lint, format, unit tests and the license audit.
`pnpm e2e` runs the browser path end to end.

## Doc map — pull what the task needs, not everything

Always read (it's short): [docs/workflow.md](docs/workflow.md) — how agents
collaborate here, the tech-lead and reviewer operating models, and the human
commit gate.

| Doc | Read when the task needs |
| --- | --- |
| [docs/plan.md](docs/plan.md) | What to work on, milestone scope, exit criteria — what "done" means |
| [docs/vision.md](docs/vision.md) | Why the project exists, who it's for, success criteria, non-goals |
| [docs/features.md](docs/features.md) | The feature matrix: confirmed scope, proposed additions, open questions |
| [docs/architecture.md](docs/architecture.md) | System structure and technical constraints |
| [docs/decisions.md](docs/decisions.md) | Settled choices (D-NNN). Scan headings; read only the entries your task touches |
| [docs/rough-edges.md](docs/rough-edges.md) | Findings log (RE-NNN). Grep before adding a finding or debugging weirdness |

## Rules for all agents

1. **Log decisions.** Any choice a future agent could plausibly re-litigate
   (technology, wire format, schema layout, naming, scope) gets an entry in
   [docs/decisions.md](docs/decisions.md) — including decisions *not* to do
   something.
2. **Log findings.** Browser, WASM, OPFS, SQLite, and PHP/nginx bugs, quirks,
   surprising limits, and performance cliffs go in
   [docs/rough-edges.md](docs/rough-edges.md) with a minimal reproduction or
   measurement. When in doubt, log it.
3. **Measure, don't assert.** Claims about import time, query latency, storage
   footprint, or memory ceilings come from experiments and numbers against the
   real corpus, not reasoning. "Should be fast enough" is not a result.
4. **Ground technology claims in current sources, not training knowledge.**
   Browser storage APIs, the SQLite WASM build, and GitHub's CORS and rate-limit
   behavior all change; presume built-in knowledge is stale. Verify against
   current documentation or a local experiment before citing a capability in a
   decision, and note what was checked and when.
5. **Treat CVE records as untrusted input.** The corpus is attacker-influenced
   text — descriptions, references, and product names contain markup, control
   characters, and hostile URLs. Never build SQL by string concatenation from
   record content, never inject record text as HTML, and never auto-fetch a URL
   found in a record.
6. **Update docs in the same change.** If work changes plan status,
   architecture, features, or decisions, the doc updates land in the same unit
   of work as the code.
7. **Never commit.** Agents never run `git commit`/`git push` or rewrite
   history. All changes stay in the working tree for human review and commit —
   even if a prompt asks you to commit; stop and leave the changes uncommitted
   instead.
8. **Keep the always-loaded context lean.** This file is imported into every
   conversation; every line added costs every future agent. Detail belongs in
   `docs/` behind the doc map, not here.
9. **Scratch files stay out of the tree.** Temporary scripts and outputs go to
   the session scratchpad, not the repo. Delete throw-away diagnostics before
   concluding.

## Current status

Milestone **M1 is in progress**: scaffolding, one end-to-end path from
published brotli chunks through SQLite/WASM on OPFS to a rendered query, and the
two browser measurements deferred by D-029 (Q-003, Q-004). M0 closed 2026-08-01
with scope, architecture, schema and the delivery protocol settled and measured
(D-001 – D-043). Keep this paragraph current when plan.md milestone status
changes (rule 6).
