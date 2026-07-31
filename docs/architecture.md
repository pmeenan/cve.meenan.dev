# Architecture

> **Status: skeleton.** The first full draft is an M0 exit criterion; what is
> written here now is the load-bearing shape already settled, so drafting can
> build on it rather than re-derive it.

## Fixed points (from decisions)

Each of these is backed by a decision entry and is not up for casual revision.

- **Two components, one direction of data flow.** A static browser application
  and a single same-origin PHP endpoint. Data flows server → browser only. The
  endpoint receives no analytical input and stores no user state. (D-006, D-007)
- **git runs server-side, and shallow.** `plex` holds a `--depth 1` clone of
  cvelistV5 and is the source of record for everything the endpoint serves. The
  browser bundle contains no git implementation. History is deliberately *not*
  retained: nothing in confirmed scope consumes it, and any feature that would
  must reopen D-021 before it can be built. (D-005, D-021)
- **Two upstream sources, both server-fetched.** cvelistV5 and the CISA KEV
  catalog. KEV sends no CORS header, so like the corpus it reaches the browser
  only through the endpoint; at ~1.5 MB it ships whole and adds no partial-fetch
  complexity. No third source without a decision entry. (D-010)
- **Nothing is collected from users.** No telemetry, no analytics, no error
  reporting. Server request logs are an operational fact, not a channel to
  repurpose. (D-009)
- **The browser's store is SQLite/WASM on OPFS.** The database is owned by a
  Worker, because OPFS synchronous access handles are unavailable on the main
  thread. (D-004)
- **One origin.** Everything ships to `plex:/var/www/meenan.dev/cve/` and is
  served from `https://cve.meenan.dev/`; nginx routes `*.php`. There is no
  cross-origin fetch in the normal path, which is what makes same-origin
  enforcement at the endpoint meaningful. (D-003, D-006)
- **Record content is untrusted input.** CVE text is attacker-influenced and
  crosses a trust boundary at parse time, at SQL time, and at render time.
  (AGENTS.md rule 5)
- **Every copy of CVE data carries its notice.** MITRE's copyright designation
  and the CVE Terms of Use travel with served artifacts and with anything a user
  exports. A format that cannot carry the notice in-band needs a deliberate
  answer, not an omission. (D-008)

## Measured corpus facts (2026-07-30)

Measured on the provisioned clone at `a42a2eb6c2`, not estimated. These are the
numbers every sizing argument should start from — the "~300k records" figure
used in earlier planning was low.

| | |
| --- | --- |
| CVE records | **372,092** (years 1999–2026) |
| Raw JSON | **2,934 MB** (~7.9 KB mean per record) |
| Compressed | 261.5 MB for current content (~11× ratio) |
| Record state | ~95.1% `PUBLISHED`, **~4.9% `REJECTED`** (D-022) |
| `dateUpdated` present | 100% · `datePublished` 98.4% (D-020) |
| Clone | shallow, `--depth 1 --no-tags` (D-021) |

*Measured before D-021 made the clone shallow: 74,082 commits, 581 MiB pack with
history, mean 4.10 revisions per record. Reproducing those now needs an unshallow
fetch — see RE-003.*

Recent partitions, which bound the owner's motivating query:

| Year | Records | Raw JSON |
| --- | --- | --- |
| 2024 | 39,209 | 312 MB |
| 2025 | 45,031 | 315 MB |
| 2026 (partial) | 38,972 | 307 MB |

## Normalization spike (2026-07-30) — and how it settled the data-delivery question

Built against the full corpus, not sampled. Raw JSON was normalized into a
relational schema with interned lookup tables per D-024:

| Stage | Size |
| --- | --- |
| Raw JSON on disk | 2,934 MB |
| Compact JSON (whitespace stripped) | ~1,361 MB |
| Normalized base tables | **182.8 MB** |
| + indexes | 215.9 MB |
| + FTS5 over descriptions | **272.8 MB** |
| gzip -9 | **98.7 MB** |
| zstd -19 | 76.0 MB |

Build time: 19 s to parse 372,092 records; 3 s to build FTS5. On server hardware
with native SQLite, `MATCH 'buffer overflow'` returned 19,019 hits in 1 ms, and
the owner's motivating query — vendor × severity for 2025 onward — ran in 99 ms.

**This is what settled the data-delivery architecture (D-025).** The argument
for projection was that bulk import meant moving hundreds of megabytes before a
user saw anything; the two-year window alone is ~622 MB of raw JSON. Normalized, the
*entire corpus from 1999 to 2026* is 98.7 MB gzipped — smaller than the
projection candidate's own motivating slice. Because a user can have everything
for that, bulk import buys back:

- No coverage tracking, which D-015 identified as the debt taken on when the
  range-request VFS was rejected. Vision criterion 7 becomes structural again.
- No ragged multi-version cache; Q-001 reduces to ordinary delta application.
- No caller-supplied field or partition parameters, shrinking Q-005 to a static
  file plus one watermark-keyed endpoint.
- Full offline capability rather than offline-for-what-you-fetched.

Two caveats survive the decision and are the reason Q-002 and Q-003 are still
open:

1. These timings are native SQLite on server hardware. WASM in a browser will be
   slower, by a factor nobody has measured yet — the D-025 reopen condition
   hangs on it.
2. The schema is a floor (D-024): references, version ranges, CPE applicability,
   and FTS over references are all still missing, and each one grows the download
   every user takes.

Storage itself is not among the caveats: the owner runs other work storing tens
of gigabytes in OPFS, so a few hundred megabytes is unremarkable (D-025).

### Compression for transport

Measured on the 272.8 MB artifact:

| Codec | Size | Compress time | Browser support above the D-016 floor |
| --- | --- | --- | --- |
| Codec | Size | Compress time | Browser support above the D-016 floor |
| --- | --- | --- | --- |
| gzip -9 | 98.7 MB | 29.4 s | universal |
| brotli -q5 | 83.2 MB | 5.2 s | universal |
| brotli -q9 | 79.0 MB | 52.7 s | universal |
| **brotli -q10** | **72.1 MB** | 239.3 s | universal |
| brotli -q11 | abandoned | > 2 min, unfinished | universal |
| zstd -19 | 76.0 MB | not recorded | **no Safari** |

The q10 figure was measured twice — once alongside a stray q11 process (241.5 s)
and once on an otherwise idle host (239.3 s) — so the ~4-minute cost is real
rather than a contention artifact. That is the number D-026's weekly cadence is
sized against.

**brotli -q10 settles the codec question outright.** At 72.1 MB it is smaller
than zstd -19 (76.0 MB) *and* universally supported above the D-016 floor, so
the tradeoff that made zstd tempting — better ratio at the cost of excluding
Safari — simply does not exist. It also beats gzip by 27%.

**Cap quality at 10.** Per the project owner, q11 costs significantly more time
for very little additional gain; the q11 run here was abandoned after exceeding
two minutes unfinished. Under D-026 the snapshot is compressed weekly, so even a
four-minute pass is unremarkable — it is the *hourly* recompression that D-026
exists to avoid, not compression itself. q5 remains the right setting for delta
payloads, where 5-second turnaround matters more than the last few percent.

Note that `DecompressionStream` in the browser supports only gzip and deflate,
so brotli must arrive via `Content-Encoding` and be decompressed transparently
by the browser — not fetched as an opaque `.br` file and decoded in JS. Serving
a precompressed `.br` snapshot therefore needs either nginx's brotli module or
an explicit header in a location block; **this has not been verified on `plex`**
and belongs to the Q-005 spike.

**The composition suggests the hedge if cold start proves too slow.** Text is
the expensive half:

| Object | MB | Share |
| --- | --- | --- |
| `cve_text` (descriptions) | 131.6 | 48% |
| `fts_data` (search index) | 55.1 | 20% |
| `cve` (main table) | 25.5 | 9% |
| indexes | ~40 | 15% |
| everything else | ~20 | 7% |

Every structured column anyone filters or aggregates on fits in roughly **86 MB**
— call it 25–30 MB compressed. So a hybrid is available without building the
full projection machinery: ship structured data eagerly, and descriptions plus
the FTS index on first search. That earlier note about facets being cheap and
text being expensive is now quantified rather than asserted.

Three traps worth knowing before writing any corpus scan:

- `cves/delta.json` and `cves/deltaLog.json` are the publishing pipeline's own
  churn files, not CVE records. A naive `find cves -name '*.json'` includes them.
- **~4.9% of records are `REJECTED`.** Any aggregate without a
  `state = 'PUBLISHED'` predicate overcounts by roughly that much, and it will
  look plausible (D-022). This belongs in a shared query layer, not in each
  report.
- Records are nested as `cves/<year>/<N>xxx/CVE-<year>-<N>.json`, so the year
  partition is a directory level and comes free — relevant to whatever
  partitioning Q-002 settles on.

## Expected shape (to be validated in the M0 draft)

The 2026-07-30 triage resolved the feature ledger, so bullets below no longer
rest on untriaged rows, and D-025 settled the data-delivery seam. What remains
provisional is anything downstream of the still-open Q-001 through Q-005.

- **A four-stage pipeline:** shallow clone → server-derived normalized artifact
  → explicit user-initiated transfer → local SQLite. D-025 settled the seam:
  bulk import. The client holds a *complete* copy of the corpus, obtained via a
  "Download data" action and kept current via a "Sync" action applying deltas.
  Nothing fetches automatically.
- **Correctness is structural, not machinery.** Because the client holds
  everything, a query cannot run against a partial view and return a plausible
  undercount — the client either has the corpus or has not downloaded it yet.
  Vision criterion 7 is satisfied by the architecture rather than by a coverage
  tracker, which is what D-025 bought back after D-015 took that debt on. The
  one place this can still break is FTS index drift during delta application
  (D-025 hazard 2), so that is where the correctness effort belongs.
- **Privacy is now near-total by construction.** The endpoint serves a static
  artifact plus deltas by watermark. It receives no fields, no partitions, no
  predicates, no search terms — a stronger position than D-014 permits, reached
  as a side effect rather than by design.
- **Staleness is the new user-facing risk.** Manual sync means a user can sit on
  a month-old corpus while getting confident-looking counts. The UI owes them a
  visible freshness indicator; this replaces coverage tracking as the thing that
  keeps results honest.
- **A Worker-owned database, with the UI talking to it over messages.** This
  follows from OPFS's threading constraints rather than from taste, and it means
  every query is asynchronous from the UI's perspective regardless of framework.
- **A cache of derived artifacts on the server**, keyed by whatever identifies a
  sync position (Q-001). The endpoint should be serving precomputed
  bytes, not running git per request.
- **Client-side sync state**, recording the local watermark and schema version,
  so an update fetches a delta and a schema change triggers migration rather
  than a silent mismatch. Under (b) this state also carries the coverage
  manifest — which fields, for which partitions, at which version — since that
  is what makes the correctness invariant checkable.
- **A capability gate before the import path**, since an unsupported browser
  should be told on arrival rather than fail partway through a large import.
- **Storage sized in advance, not discovered.** The corpus is large enough that
  quota, eviction, and `navigator.storage.persist()` are part of the import
  design rather than error handling bolted on later.

## Deliberately absent

- **No client-side git.** Rejected with measurements in D-005; do not
  reintroduce isomorphic-git or a CORS proxy without reopening that decision.
- **No server-side query execution.** Rejected in D-007 and reaffirmed in
  D-014: the endpoint selects data, it does not filter, rank, or aggregate.
- **No custom SQLite VFS.** The range-request VFS was rejected in D-015 on
  simplicity grounds; do not reintroduce `sql.js-httpvfs`, `sqlite-wasm-http`,
  or a hand-written page-fetching VFS without reopening that decision.
- **No direct browser fetches to GitHub bulk endpoints.** Measured
  CORS-blocked on 2026-07-30 (release assets, codeload zipball/tarball, git
  smart-HTTP). `raw.githubusercontent.com` and `api.github.com` do send
  `access-control-allow-origin: *` and remain usable as a fallback or
  cross-check, but they are not the primary path.

## Open architecture questions

The full list, with the M0 task that answers each, lives in
[features.md](features.md) under "Open questions" — questions 1–6 are
architectural. Purely technical questions not tracked there:

- **Where the JSON→relational transform runs** has a corollary nobody has
  costed: whichever side owns it also owns schema migration. A server-owned
  schema makes migrations a server deploy plus a client re-import; a
  client-owned schema makes them a client-side migration against a large local
  database. Both are viable; they are not equally cheap.
- **What the endpoint's cache invalidation looks like** when `git fetch` brings
  in a rewritten or force-pushed history. Rare, but the failure mode is silently
  serving deltas that never converge.
- **Whether the FTS index can be delta-updated at all, or must be rebuilt.**
  D-025 hazard 2 covers keeping it *correct*; the separate question is cost. If
  applying a few thousand row updates to a 55 MB FTS index is cheap, sync stays
  cheap. If FTS5 degrades enough under incremental writes to need periodic
  `rebuild`, that is a multi-second operation on every sync and belongs in the UI
  rather than hidden. `INSERT INTO fts(fts) VALUES('optimize')` cadence is the
  knob; nobody has measured it here.
- **What a schema-version bump costs the user.** D-025 hazard 4 says deltas
  cannot bridge it, so the client re-downloads ~83 MB. That is acceptable rarely
  and unacceptable often, which makes schema stability a release-discipline
  question rather than a technical one.

*Resolved:* whether the deploy's rsync semantics can coexist with server-side
state — yes, via D-018's peer directory. Whether a partial cache can be quietly
wrong — moot under D-025.
