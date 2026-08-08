# cve.meenan.dev — browser-based analytics over the full CVE List

A public web app for searching, analyzing, and reporting on the complete CVE
List — the [cvelistV5](https://github.com/CVEProject/cvelistV5) corpus, 372,092
records and growing — with a planned AI chat layer (M7/M8) that turns
plain-language questions into local queries (D-044). The entire data plane runs
in the browser: the corpus is normalized server-side into a ~63 MB compressed
SQLite database, downloaded on demand into OPFS, and queried locally — so no
search or report ever leaves the client. Chat is the opt-in exception: the
first model tier is an Ollama instance we host, reached through a restricted
same-origin relay (D-057), with in-browser models and user-supplied hosted-model
keys (chat traffic browser-direct to that provider, D-045) following. The
server serves the snapshot and its deltas as static files and performs no
analysis — the D-057 chat relay is its one dynamic endpoint, and it forwards
chat to our own model without storing anything. Almost all code is written by
AI agents working from the project documentation, directed and reviewed by a
human.

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
  write data, or reach the network. The first model tier is site-hosted: our
  own Ollama on the private `llm` box, relayed through a restricted
  same-origin endpoint that pins the model, stores nothing, and logs no bodies
  (D-057). Third-party hosted models are the user's own key — stored
  client-side, called browser-direct, never proxied; no bundled key, and no
  consumer-subscription OAuth where providers forbid it (none is sanctioned
  today). (D-044, D-045, D-057)
- **Nothing is collected from users — no telemetry, ever.** Not analytics, not
  error reporting, not opt-in. This makes the privacy claim verifiable in a
  network panel rather than a promise. Do not add a reporting channel; improve
  the diagnostics panel instead. (D-009)
- **The data plane is static files, and no request handler stands in it.** The
  snapshot, manifest, deltas, and KEV catalog are pre-built files served by
  nginx from `cve.pub/data/`, a peer of the document root — nothing under
  `cve.data/` is web-reachable (D-053); the client sends no parameters. The
  one dynamic endpoint is D-057's chat relay, which sits outside the data
  plane and follows D-006's rules: it never accepts a caller-supplied URL,
  path, or ref that reaches the filesystem or network, and it is
  same-origin-restricted and rate-limited. Adding any other dynamic endpoint
  is a constraint change. (D-006, D-032, D-057)
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
| `pipeline/`  | Python ingest and publish (D-043). **Never in the docroot** — the crons run it from a git checkout at `~/src/meenan.dev/cve/` on `plex`, updated with `git pull` (D-059) |
| `scripts/`   | Build, serve, deploy, license audit |
| `tests/`     | `unit/` (Vitest) and `e2e/` (Playwright) |
| `public/`    | Static passthrough into the export root |

`pnpm check` runs typecheck, lint, format, unit tests and the license audit.
`pnpm e2e` runs the browser path end to end.

## Doc map — pull what the task needs, not everything

Always read (it's short): [docs/workflow.md](docs/workflow.md) — the
build → commit loop, on-demand reviews, and the human commit gate.

| Doc | Read when the task needs |
| --- | --- |
| [docs/plan.md](docs/plan.md) | What to work on, milestone scope, exit criteria — what "done" means |
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

**M6 in progress — the CISA KEV overlay.** The client half is built and passes
end to end in a browser; the origin half is one owner-applied nginx block away
and **nothing may publish a catalog until it lands**, because the first fetch
through Cloudflare pins whatever cache policy is in place and correcting it
needs a purge. KEV is CC0, so no notice travels (D-076) — provenance does:
every place the app asserts membership says *per CISA*, with the catalog
version and release date, which is what keeps it a statement about CISA's
catalog rather than an endorsement by it. `pipeline/kev.py` is its own cron with
its own lock and its own state, sharing a `flock` helper with the corpus crons
and nothing else; it validates fail-closed, publishes CISA's verbatim bytes by
atomic rename, and a refusal leaves the previous catalog serving. Client-side
the catalog is a **rebuildable table** like the full-text indexes — no schema
bump, so no re-download — created by the apply that fills it, which is what lets
a copy with no catalog *refuse* a KEV question instead of answering that nothing
is known to be exploited (D-077). "Not in KEV" is a labelled value, not an
absence band: absence from the catalog is the finding.

**Four defects came out of it that the unit tests could not see.** Two came
from the adversarial pass over the server half and compounded into one story: a
hostile or merely broken upstream could freeze the catalog **permanently** while
`kev.py status`, the exit code and the cron log all reported success — because
only a validation refusal recorded an outcome, and because the roll-backwards
guard *defends whatever it is holding*, so one catalog claiming a far-future
version was published once and then protected against every real one. The third
came from writing the e2e: a KEV refresh reported its start and never its
ending, and the page derives *busy* from the phase, so after a download every
button in the app was disabled — permanently, with the catalog correctly loaded
and the freshness line correctly rendered above them. The fourth is the one
worth remembering: **the bundler dropped a literal segment** out of a template
carrying `${…}` concatenated with `+`, so the browser ran SQL the source never
had (RE-028) — unit tests import the source, only the browser runs the bundle,
and `scripts/check-bundle.mjs` now refuses such a build. `pnpm check` was green
through all four. Also fixed: `state.lock`'s new `name` argument was dead code, so the
failure-domain claim rested on the directories differing rather than on the
mechanism four documents described.

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
