# Decision log

Newest first. Every entry: what was decided, why, and what would reopen it.
Existing entries are never edited into a different decision — reversing or
amending one gets a *new* entry that supersedes it (a status-line annotation on
the old entry is fine). Entries that rest on claims about current technology
state must be grounded in current sources or local experiments — not training
knowledge — and note what was checked and when.

**Reading:** scan the D-NNN headings (or grep) and read only the entries your
task touches. Full read is for structural or cross-cutting work.

**Culling:** the log may be periodically pruned — superseded or moot entries
whose context no longer informs anything current are deleted outright; git
history is the archive. D-numbers are never reused.

Format:

```
## D-NNN: Title  (YYYY-MM-DD, status: accepted | proposed | superseded by D-MMM)
Decision / Context / Consequences / Reopen if
```

---

## D-008: CVE content is freely reusable, subject to a notice obligation  (2026-07-30, status: accepted)

**Decision.** We may reproduce, transform, and redistribute CVE List content —
including as derived artifacts such as a prebuilt database — provided every copy
we produce carries MITRE's copyright designation and the CVE Terms of Use
license text. That obligation is treated as a functional requirement of any
feature that emits CVE data, not as a footer detail.

**Context.** The project owner raised the licensing question and flagged a
possible carry-forward clause. Confirmed 2026-07-30 by reading the terms source
at `CVEProject/cve-website` (`src/views/Legal/TermsOfUse.vue`), which renders
[cve.org/legal/termsofuse](https://www.cve.org/legal/termsofuse) — the published
page is client-rendered and returns no readable text to a plain fetch. The
operative clause, verbatim:

> **CVE Usage:** MITRE hereby grants you a perpetual, worldwide, non-exclusive,
> no-charge, royalty-free, irrevocable copyright license to reproduce, prepare
> derivative works of, publicly display, publicly perform, sublicense, and
> distribute Common Vulnerabilities and Exposures (CVE™). Any copy you make for
> such purposes is authorized provided that you reproduce MITRE's copyright
> designation and this license in any such copy.

The grant is unusually permissive — derivative works and sublicensing are named
explicitly, and it is irrevocable — so the owner's read is correct: there is no
restriction on what we build. The single condition is the notice carried by each
copy. The terms also disclaim all warranties, which is worth surfacing given
this tool will be used for security decisions.

**Consequences.** The notice obligation attaches to more surfaces than a
license page:

- Any server-derived artifact the endpoint serves is a copy and must carry the
  notice, in-band where the format allows it.
- Exported result sets (CSV/JSON, both `proposed`) are copies a user
  redistributes; export should embed the notice rather than rely on the user
  knowing about it.
- The local OPFS database is a copy made on the user's machine; shipping the
  notice with the application covers this in practice.

This is a notice condition, not copyleft: it constrains attribution, not what we
may build or how we license our own code (D-002). Note also that these are
MITRE's terms for the CVE List; individual CNA-supplied reference URLs point to
third-party content governed by nobody's terms but their own.

**Reopen if.** The CVE Program republishes its terms under different conditions
— the text above is a 2026-07-30 snapshot and should be re-read before launch —
or we begin redistributing a data source other than the CVE List, which will
carry its own terms.

## D-007: The data plane stays in the browser  (2026-07-30, status: accepted)

**Decision.** All parsing, storage, indexing, querying, aggregation, charting,
and export happen client-side. The server stores no user state and receives no
query, filter, or report. The single server endpoint (D-006) ships corpus data
only.

**Context.** Stated by the project owner at kickoff as a "100% client-side tool."
The owner subsequently accepted a small server-side ingest component (D-006), so
the constraint is scoped precisely here: it is the *analysis* that is
client-side, not every byte of the system. Recording it explicitly prevents
future agents from reading D-006 as license to move work server-side.

**Consequences.** Users get privacy by construction — a researcher can query the
corpus without disclosing what they are looking for. It also forces the hard
problems into the browser: a ~300k-record corpus must import, persist, and query
within browser memory and storage limits, which is exactly what M0's spikes must
measure. Server-side query execution is unavailable as an escape hatch if
client-side performance disappoints; the answer would be a better schema, better
indexing, or a smaller derived corpus, not a server.

**Reopen if.** M0 measurement shows client-side query latency is unacceptable
for the core reporting use cases even after schema and indexing work — in which
case the tradeoff against the privacy property is an explicit owner decision,
not an agent's.

## D-006: Ingest is one hardened same-origin PHP endpoint  (2026-07-30, status: accepted)

**Decision.** Corpus data reaches the browser through a same-origin PHP endpoint
served from `https://cve.meenan.dev/`. It must be locked down so it serves
same-origin browser callers and does not become a general-purpose open endpoint.
It must never accept a caller-supplied URL, filesystem path, or git ref that is
passed through to the network, the filesystem, or a shell.

**Context.** Chosen by the project owner over a Cloudflare Worker, a
user-supplied ZIP upload, and a published prebuilt artifact. The owner has PHP
enabled for this origin, with nginx routing any URL ending in `.php` (query
parameters ignored for routing purposes). This choice was forced by verified
CORS behavior — see D-005 for the measurements.

**Consequences.** First-run ingest is fully automatic with no manual download
step, and the wire format is ours to design rather than GitHub's to dictate
(the format itself is an open question for M0). The cost is an internet-facing
endpoint that must be defended: parameter validation, bounded response sizes,
rate limiting, and same-origin enforcement are functional requirements, not
polish. The specific enforcement mechanism is an M0 open question —
`Sec-Fetch-Site` and `Origin` header checks are candidates, but both must be
validated against the actual nginx/PHP configuration and against browsers in
scope before being relied on. Note that same-origin enforcement via request
headers constrains *browsers*, not `curl`; rate limiting and cheap responses are
what bound abuse from non-browser callers.

**Reopen if.** The endpoint proves impractical to secure or operate on this
host, or PHP availability changes — the fallback ladder is a published prebuilt
artifact, then user-supplied ZIP upload.

## D-005: The cvelistV5 clone lives on the server, not the browser  (2026-07-30, status: accepted)

**Decision.** The server maintains a real git clone of
`https://github.com/CVEProject/cvelistV5` and derives baselines and deltas from
it. In-browser git (e.g. isomorphic-git into OPFS) is rejected.

**Context.** The owner's initial preference was to clone with git directly into
browser storage. Measurements taken 2026-07-30 against live endpoints show that
path is not viable:

- The repository reports 2,477,151 KB (~2.36 GB) via the GitHub API — far beyond
  a reasonable browser download and OPFS footprint.
- Release assets on `release-assets.githubusercontent.com` (the ~562 MB
  `all_CVEs_at_midnight.zip` baseline and ~4 MB hourly deltas) return **no**
  `access-control-allow-origin` header — browser-blocked.
- `codeload.github.com` zipball/tarball returns
  `access-control-allow-origin: https://render.githubusercontent.com` —
  browser-blocked for our origin.
- GitHub's git smart-HTTP endpoints send no CORS headers; isomorphic-git
  documents a CORS proxy as a hard requirement for browser clones, which would
  add a third-party dependency *and* still not solve the 2.36 GB problem.

By contrast, `raw.githubusercontent.com` and `api.github.com` both return
`access-control-allow-origin: *`, and `cves/delta.json` (a change manifest with
direct raw links) plus a 15.6 MB `cves/deltaLog.json` are readable from a
browser — so a browser-only *incremental* path exists even though the bulk path
does not. Moving the clone server-side makes both paths uniform and gives us
full git history, which is otherwise unavailable to the client.

**Consequences.** The hardest part of the owner's original design disappears:
git runs in its native environment. The server gains a periodic `git fetch` job
and ~2.4 GB of disk. Because full history is available server-side, per-record
change history becomes a feasible feature (tracked as `proposed` in
[features.md](features.md)) rather than an impossibility. The client never needs
a git implementation, so no git library appears in the browser bundle.

**Reopen if.** GitHub adds CORS headers to bulk-download paths, or the corpus
shrinks by an order of magnitude, or an official CORS-enabled bulk mirror
appears. Re-verify the CORS measurements above before acting on this — they are
a snapshot of 2026-07-30, not a standing guarantee.

## D-004: SQLite compiled to WASM, persisted to OPFS, is the local store  (2026-07-30, status: accepted)

**Decision.** The browser-side store is SQLite built to WebAssembly, with the
database persisted in the Origin Private File System. Relational queries against
persisted SQLite are the substrate the analytics and reporting features build
on.

**Context.** Stated by the project owner at kickoff ("using wasm as needed,
local opfs storage, sqlite and analytics/reporting tools on top of it").
Verified 2026-07-30: `@sqlite.org/sqlite-wasm` publishes version 3.53.0-build1
under Apache-2.0, compatible with this project's license (D-002).

**Consequences.** Query power comes free — arbitrary SQL, joins, aggregates, and
FTS are available without building a query engine. In exchange we inherit OPFS's
constraints, which are real and shape the architecture:

- SQLite's OPFS VFS variants differ materially. Per SQLite's own documentation,
  the `opfs` VFS requires COOP/COEP response headers, while `opfs-sahpool` does
  not but **does not support multiple simultaneous connections**. Which VFS we
  use is an M0 decision with direct consequences for multi-tab behavior, and it
  interacts with what nginx can be configured to send.
- Synchronous access handles require a Worker; the main thread cannot own the
  database.
- Browser storage quota and eviction apply, so quota handling and
  `navigator.storage.persist()` are functional concerns, not polish.

**Reopen if.** M0 spikes show the corpus cannot be imported or queried within
acceptable time and storage budgets in-browser, or a VFS limitation proves
incompatible with required multi-tab behavior.

## D-003: Deploy by rsync of `dist/` to the live directory  (2026-07-30, status: accepted)

**Decision.** The build produces a `dist/` directory that is rsynced directly to
`plex:/var/www/meenan.dev/cve/`, served by nginx at `https://cve.meenan.dev/`.
No staged rollouts, no backup step, no build tooling on the server.

**Context.** Stated by the project owner at kickoff. nginx routes any URL ending
in `.php` on this origin (query parameters ignored for routing). Verified
2026-07-30: `cve.meenan.dev` resolves and nginx responds over HTTPS with a valid
certificate, currently returning 403 for an empty document root — consistent
with a configured, pre-code deployment target.

**Consequences.** Deployment is one command and trivially scriptable, but it is
also a live overwrite with no rollback: a bad build is served immediately, and
recovery means rebuilding from a known-good commit. Since the PHP endpoint
(D-006) is deployed by the same mechanism, `dist/` contains both the static app
and the endpoint, and the build must keep server-side and client-side artifacts
distinguishable. rsync deletion semantics need deciding in M0 — a plain mirror
would delete server-side cache or clone state if it lives under the document
root, which is a good reason to keep it outside.

**Reopen if.** The project acquires a staging need, multiple deploy targets, or
state under the document root that a mirroring rsync would destroy.

## D-002: Apache-2.0, with dependency licenses verified at source  (2026-07-30, status: accepted)

**Decision.** The project is licensed Apache-2.0. Every dependency's license
must be compatible and must be verified from the package's own published
metadata before it lands — never assumed from memory.

**Context.** The Apache-2.0 `LICENSE` file predates this scaffold and the public
repository at `https://github.com/pmeenan/cve.meenan.dev` reports `Apache-2.0`.
The verify-at-source rule exists because license facts drift and training
knowledge is unreliable; two dependencies were checked against the npm registry
on 2026-07-30 while writing this scaffold (`@sqlite.org/sqlite-wasm` 3.53.0-build1
Apache-2.0, `isomorphic-git` 1.40.0 MIT).

**Consequences.** Copyleft dependencies are excluded from the shipped bundle.
A license audit belongs in the M0 toolchain decisions and should be automated so
it runs on every dependency change rather than by memory. Note separately that
CVE record *content* carries the CVE Program's own terms, which are distinct
from this project's code license and need checking before the corpus is
redistributed in a derived form.

**Reopen if.** A required capability exists only under an incompatible license,
or the owner changes the project license.

## D-001: AI-developed, human-gated workflow  (2026-07-30, status: accepted)

**Decision.** Agents implement and review; the human directs, decides, and is
the sole committer. Agents never run `git commit`, `git push`, or history
rewrites — work is left in the working tree for human review. The project
documentation in `docs/` is the durable memory that agents work from.

**Context.** Stated by the project owner by adopting this scaffold. The
collaboration loop, tech-lead mode, reviewer mode, fix-pass mode, and
verify-pass mode are specified in [workflow.md](workflow.md).

**Consequences.** Documentation quality is load-bearing rather than incidental —
a stale doc misleads every future agent, so doc updates ship inside the same
change as the code. Only one stream of work can be in flight at a time, since
the uncommitted working tree is the shared unit of review. The human commit gate
is the only checkpoint that cannot be automated away.

**Reopen if.** The owner wants agents to commit directly, or the single-stream
constraint becomes the binding limit on throughput.
