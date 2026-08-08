# Architecture

> **Status: first full draft**, 2026-07-31, closing the last M0 item. Everything
> here is either backed by a decision entry or by a measurement recorded below.
> Where something is genuinely unsettled it is in [Open questions](#open-questions),
> not softened in the prose.

## Overview

Two components and one direction of data flow.

```
GitHub                plex                                        browser
──────                ────────────────────────────────            ─────────────────
cvelistV5  ──fetch──▶ shallow clone                               ┌──────────────┐
CISA KEV   ──fetch──▶      │                                      │ React 19 UI  │
                           ▼                                      │              │
                      hash + normalize                            └──────┬───────┘
                           │                                             │ messages
                           ▼                                             ▼
                      cve.pub/data/  ──nginx, static──▶  fetch  ──▶ Worker
                        manifest.json                               SQLite/WASM
                        snapshot-<rev>/000.br … 011.br              on OPFS
                        deltas/<from>-<to>.json.br
                        kev.json
```

The server derives artifacts and publishes files. The browser downloads them
once, keeps them current with deltas, and does every query locally. **No request
the client makes carries a parameter**, so there is nothing for the server to
learn and nothing for it to execute (D-032).

## Fixed points

Each is backed by a decision entry and is not up for casual revision.

- **Two components, one direction of data flow.** A static browser application
  and a set of static same-origin files. The server receives no analytical input
  and stores no user state. (D-006, D-007, D-032)
- **git runs server-side, and shallow.** `plex` holds a `--depth 1` clone of
  cvelistV5 and is the source of record for every artifact we publish. The
  browser bundle contains no git implementation. History is deliberately *not*
  retained: nothing in confirmed scope consumes it, and any feature that would
  must reopen D-021 first. (D-005, D-021)
- **Two upstream sources of corpus data, both server-fetched.** cvelistV5 and
  the CISA KEV catalog. KEV sends no CORS header, so like the corpus it reaches
  the browser only as a file we publish; at ~1.5 MB it ships whole. No third
  data source without a decision entry. (D-010) The AI layer's browser-side
  fetches — model weights from Hugging Face, optional hosted-model calls — are
  not data sources and are bounded separately by D-045.
- **Nothing is collected from users.** No telemetry, no analytics, no error
  reporting. Server request logs are an operational fact, not a channel to
  repurpose. (D-009)
- **The browser's store is SQLite/WASM on OPFS**, owned by a Worker, because
  OPFS synchronous access handles are unavailable on the main thread. (D-004)
- **One origin for the data plane.** Everything ships to
  `plex:/var/www/meenan.dev/cve/` and is served from
  `https://cve.meenan.dev/`. There is no cross-origin fetch in the data path,
  which is what makes same-origin enforcement meaningful. The AI layer's two
  cross-origin exceptions — model-weight downloads and user-keyed hosted-model
  calls — are explicit user actions that never carry corpus requests and never
  touch this origin's data plane; its one same-origin addition, the D-057 chat
  relay, sits outside the data plane and never serves corpus data. (D-003,
  D-006, D-045, D-057)
- **Record content is untrusted input.** CVE text is attacker-influenced and
  crosses a trust boundary at parse time, at SQL time, and at render time.
  (AGENTS.md rule 5)
- **Every copy of CVE data carries its notice.** MITRE's copyright designation
  and the CVE Terms of Use travel with served artifacts and with anything a user
  exports. A format that cannot carry the notice in-band needs a deliberate
  answer, not an omission. (D-008)

## The server pipeline

Two cron jobs under `flock`, no daemon (D-042). **Daily** ingest —
`pipeline/ingest.py run`, 54.9 s of work per run (D-058) — and a **monthly**
generation rotation — `pipeline/snapshot.py`, ~90 s (D-060). Each records its
own outcome in the ingest state and `ingest.py status` reports both, because on
this machine that is the only alerting there is (D-058).

Upstream publishes about every 40 minutes. How much a day
accumulates depends on the day: D-031's 21.4 weekday hours implied ~665 changed
records and ~87 KB, while D-058's 69.5-hour window across a weekend worked out
at ~291 records and ~70 KB per day. Both are single windows and neither is a rate;
what they agree on is that a day's delta is one small file.

1. **Fetch.** `git fetch --depth 1 origin main` into `cve.data/git/cvelistV5`,
   then reset. Measured at 1.8 s. A shallow clone reports every advance as a
   forced update, so git's output is not a usable change signal (RE-006) — the
   pipeline ignores it. Every argument is a constant: nothing a record, a
   manifest or a caller supplies ever reaches a git ref or a URL (D-006).
2. **Hash.** Walk the working tree, compute a hash over each record's normalized
   projection — exactly the fields we store — and diff against the previous
   run's hashes. 16.9 s and 93.8 MB for all 372k records, measured on `plex`.
   Records changed or added become upserts; records present before and absent
   now become tombstones. The previous run's hashes live in
   `cve.data/state/ingest.sqlite` alongside the revision each record last
   changed at, the tombstone log and the artifact the next build seeds from
   (D-058) — 28.8 MB, and rebuildable from the clone by `ingest.py init`.
3. **Guard.** If the run would tombstone more than 0.1% of the corpus (~370
   records), abort rather than publish, and make the abort *findable*. Upstream
   has no deletion concept at all, so a mass deletion means our fetch broke, not
   that the CVE Program withdrew 400 records. "Alert" is deliberately not mail:
   `plex` has no MTA, so cron's mail is a no-op, and D-009 rules out a telemetry
   channel. Instead the run records its outcome in the state and `ingest.py
   status` reports it, so one command answers "is the ingest healthy?" and a job
   that has been failing since Tuesday says so (D-058). The user-visible half is
   unchanged: a stalled pipeline stops advancing `manifest.json`'s `generated`,
   which the client already surfaces as staleness (D-042). **This runs before the build, not merely
   before publication** — seeding retires every value the tree no longer
   mentions and never reissues its id (D-056), so a build from a half-fetched
   corpus is already unrecoverable. That ordering is what the second walk of
   the corpus buys, and the build's own counts are checked against the hash
   pass afterwards so the two walks cannot disagree about which records exist
   (D-058).
4. **Normalize.** Build the relational artifact (see [Schema](#schema)). 24.2 s
   seeded, measured on `plex` 2026-08-03 (D-058); the 19 s in D-023 was the
   M0 spike, against a smaller schema and unseeded. The build ends with
   `ANALYZE`, so the artifact carries its own query statistics — under a second
   here, 20.4 s if the browser has to derive them instead (D-067).
   The build **seeds its ID space from the previous artifact** — `--seed`, or an
   explicit `--bootstrap`, never a default (D-056) — so every id it already
   issued means what it meant, and new values append above the recorded
   high-water mark. That mark, per lookup table, is what makes "the rows a
   client at rev N is missing" a range query rather than a per-row revision
   column (D-055); the artifact carries its own in `meta`, which is where the
   next delta's floors come from. Seed from the *most recent* build rather than
   the last published snapshot — ids minted by a daily delta exist only there —
   which the artifact's recorded `seed_rev` and its fingerprint of the ID space
   it grew from let both publishers enforce rather than assume.
5. **Publish the delta.** If anything changed, increment the revision and write
   `deltas/<rev-1>-<rev>.json.br`, then register it in the manifest — file
   first, so the manifest never names something that is not there. One run per
   day means one file per day and consecutive revisions, so the files tile the
   revision space by construction — there is no rollup and no invariant to
   defend (D-042). A run that changed nothing mints no revision at all.

   The changeset, the artifact it was built from and `generated` are written to
   the state file *before* any of this and cleared only after the manifest names
   the delta, so a crash anywhere in between is resumed with the pinned bytes
   rather than a changeset recomputed against a tree that has moved — which is
   what makes an immutable URL survivable (D-058). A missed day needs no
   handling: `from` is always the published head and the changeset is the whole
   diff of the state against the tree.
6. **Snapshot, monthly** — `pipeline/snapshot.py`, 85–101 s and 391 MB peak RSS
   on the real corpus (D-060). It publishes the artifact the *daily* last built,
   at the revision that artifact is stamped with, which must be the published
   head: the daily walks the whole corpus and writes a complete database every
   run, so the rebuild has already happened and building a second one would only
   produce a different file with the same content. The artifact is split into
   32 MB slices of the uncompressed file and each is compressed at brotli -q10 —
   which is nearly all of that time, against 351 s for a monolith (D-041). Only the
   compressed chunks are published; the client decompresses in WASM (D-040), and
   no full-text index is built server-side because the client builds its own
   (D-035). No revision is minted: a rotation changes which generation is served,
   not what the data plane says.

   **A snapshot at head must be the artifact head's content came from**, and the
   ledger records each revision's artifact digest so that is checked rather than
   trusted (D-060). It is the one publication nobody already synced ever fetches
   — `planSync` tells a client at head it is current — so different content there
   would reach new arrivals only. A rebuild that genuinely changes content lands
   *above* head and costs every client a re-download, like a schema bump.
7. **Retire, one generation behind.** Keep the current generation and the
   previous one, and every delta back to the older of the two, so a client that
   read the manifest minutes ago and is mid-download does not start seeing 404s
   — and so a client one generation behind catches up from the chunks it already
   has instead of re-downloading. One spare generation costs 63 MB; the deltas
   are ~70–90 KB a day. **What is retained is defined by what the previous
   manifest advertised**, not by what is on disk and not by the ledger: a
   generation can exist that was never advertised (a rotation killed between the
   rename and the manifest write leaves one), and deleting by revision
   arithmetic over the directory listing removed delta files the manifest still
   named — the new one in the first version of this, the *previous* one a
   rotation later. Nothing the previous manifest named is deleted, and with no
   previous manifest nothing is retired at all. Retention runs *inside* the snapshot publish, never as a
   separate job: the manifest is rewritten first and the files are deleted after,
   so nothing is ever named and missing, and a delta file outlives its manifest
   entry by one full rotation for the same reason a generation does. Deleting a
   file does not un-publish it — the ledger keeps every URL ever served (D-055
   §7). This is what the manifest's tiling rule was relaxed for: every retained
   delta starts *below* the snapshot's revision, and what is required now is only
   that nothing the manifest names is a dead end (D-060).

Publication into `pub/` is an atomic rename, so a half-written artifact is never
reachable — and a published generation is immutable: same-rev republication is
refused, because its URLs carry an immutable cache policy (D-047). The clone,
working databases, and hash state live in sibling directories under `cve.data/`
and are never under the served root (D-018, D-034):

| Path | What |
| --- | --- |
| `cve.data/git/cvelistV5` | The shallow clone (D-021). |
| `cve.data/db/` | Working databases, including `snapshot.sqlite` — the artifact rev 1 was published from. |
| `cve.data/cache/` | The KEV cache (D-010), empty until M6. |
| `cve.data/state/ingest.sqlite` | The ingest's hash state, seed pointer and pending run (D-058). |
| `cve.data/state/pipeline.lock` | The `flock` both crons take (D-042). |
| `cve.data/state/artifacts/rev-N.sqlite` | Daily builds, ~377 MB each; the newest three are kept. |
| `cve.pub/published.json` | The append-only ledger of everything ever published (D-056). |
| `cve.pub/data/` | The published artifacts — the only web-reachable path here (D-053). |
| `~/src/meenan.dev/cve/` | A checkout of this repo; the crons run `pipeline/` from it, updated by `git pull` (D-059). Never the docroot. |

`cve.data/state/` is new in D-058; D-018 and D-053 describe the three
directories that preceded it.

## The published contract

Everything under `/data/`, served by nginx from `cve.pub/data/` — a peer of the
document root and of `cve.data/`, so nothing under `cve.data/` is web-reachable
(D-034, D-053).

| File | Cache | Notes |
| --- | --- | --- |
| `manifest.json` | `no-cache` | The only mutable file. Lists everything else with byte length and SHA-256. |
| `snapshot-<rev>/NNN.br` | immutable | 12 chunks, ~5.2 MB each, **62.7 MB** total, each expanding to a 32 MB slice of the 376.7 MB database (D-041). Measured on the first published generation, 2026-08-01. |
| `deltas/<from>-<to>.json.br` | immutable | One per day; consecutive revisions tile the space by construction (D-042). Retained back to the previous generation, so most of them start below `snapshot.rev` (D-060). |
| `kev.json` | short — **not yet true** | CISA KEV, its own freshness (D-010). |

`kev.json`'s row is a statement of intent, not of the deployed configuration,
and M6 has to close the gap before it publishes one. The block below has exactly
two locations: an exact match for `/data/manifest.json` at `no-cache`, and
`^~ /data/` stamping `immutable` on everything else. So the first KEV catalog
published would be pinned for a year at the edge and in every browser that
fetched it, under an unversioned URL — a frozen known-exploited set shown beside
a freshness claim. It needs its own `location = /data/kev.json`, exactly as the
manifest has one (found by M5's data-plane review).

### Assets the export ships but never loads

Turbopack emits `_next/static/media/db.worker.<hash>.ts` — the Worker's
TypeScript *source* — beside the bundled `turbopack-worker-<hash>.js` chunk it
actually runs. A network trace of a production page load confirms the `.ts` is
never requested; nginx serves it as `video/mp2t` if anyone asks. `copy-wasm.mjs`
likewise copies the whole SQLite distribution, including `index.d.mts`,
`node.mjs` and `sqlite3-worker1.mjs`, none of which the client loads.

None of this is a correctness or disclosure problem — the code is Apache-2.0 and
the bundled equivalents are public anyway — but it is dead weight on an origin
whose `/sqlite/` tree now revalidates on every load (D-054), and a `video/mp2t`
response is the kind of thing that wastes an afternoon during the *next*
investigation. Trimming `copy-wasm.mjs` to the three files the client requests
(`index.mjs`, `sqlite3.wasm`, `sqlite3-opfs-async-proxy.js`) is the obvious fix
and is unclaimed.

M5's service worker re-confirmed the `.ts` half independently, and by
experiment rather than by trace: deleting `db.worker.<hash>.ts` from `dist/`
and loading the app changes nothing. That is what makes it safe for the shell's
precache list to skip it — the list is an extension allowlist, and `.ts` is not
on it.

### The nginx block, as deployed

This supersedes the snippet in D-034, which still carried the rate limiting
D-039 removed and the `brotli_static` D-040 made wrong. Two locations, in the
`cve.meenan.dev` server block:

```nginx
location = /data/manifest.json {
    root /var/www/meenan.dev/cve.pub;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;
    add_header Cache-Control "no-cache";
}

location ^~ /data/ {
    root /var/www/meenan.dev/cve.pub;
    autoindex off;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;
    add_header Cache-Control "public, max-age=31536000, immutable";
}
```

Five things about it are load-bearing rather than stylistic:

- **`root`, not `alias`** — and the directory is named `data` so the URL maps
  straight through. This server block defines `try_files` at server level, which
  every location inherits, and `alias` + `try_files` is a long-standing nginx
  defect that appends `$uri` to the alias and 404s every artifact (D-053).
- **`^~`** outranks the regex locations in the same server block, so neither the
  `expires max` static-file rule nor `php.conf` can ever apply to an artifact.
- **The repeated `add_header`s.** nginx drops *all* inherited `add_header`
  directives as soon as a location declares one of its own, so leaving
  COOP/COEP to the server level would strip cross-origin isolation from every
  artifact — and the `opfs` VFS needs it (D-030, D-051).
- **`Cache-Control` without `always`; the security headers with it.** Without
  `always`, nginx attaches the header only to 2xx/3xx responses — so a 404
  under `/data/` carries no cache policy and Cloudflare's negative cache holds
  it for minutes, not a year. With `always` (how it was first deployed), a 404
  went out marked `immutable`, and since delta URLs are predictable
  (`deltas/<from>-<to>.json.br`), anyone could request tomorrow's delta today
  and poison that URL at the edge until a manual purge — a cheap remote
  sync-DoS, observed live 2026-08-08 the day the proxy was enabled.
  COOP/COEP/CORP keep `always`: isolation on an error page is harmless, and a
  gap would be a hole.
- **What is absent.** No `Access-Control-Allow-Origin` — its absence is the
  same-origin control (D-034). No `brotli_static`, because artifacts are opaque
  `.br` the client decodes itself and an added `Content-Encoding` would corrupt
  that path (D-040). No `limit_conn`/`limit_rate` (D-039).

**One location is still owner-applied and outstanding (M5).** The offline app
shell's worker (D-048) is served from the document root as `/sw.js`, where the
site's general `expires max` static-file rule would apply to it. That worker
decides which *other* files may be answered from a cache, so a stale one is a
stale shell that outlives its own fix — the failure D-054 exists to prevent,
reintroduced one level up. Browsers already bypass the HTTP cache for this
request when `max-age` exceeds a day, but that leaves a 24-hour window and
depends on a behaviour we do not control. `scripts/serve.mjs` already sends
`no-cache` here, which is the local server matching production rather than being
more permissive than it (RE-012's rule):

```nginx
location = /sw.js {
    add_header Cache-Control "no-cache";
}
```

The manifest carries `format`, `schema`, the head `rev`, the snapshot (with its
own `rev`), and the list of delta files, each with its byte lengths and SHA-256.
The client reads it, compares its local schema version, and either re-downloads
(on a schema bump — deltas cannot bridge one) or fetches the fewest-files chain
of delta files from its watermark, found breadth-first (`planSync`, D-055). It
is the one file served uncompressed, because it has to be readable before the
brotli decoder matters.

`rev` is the **head** revision — the newest state the data plane can reach —
while `snapshot.rev` is the snapshot's own; they are equal only until the first
delta lands, and a client that conflated them would think a fresh snapshot was
current (D-055). A delta entry is `{from, to, bytes, raw_bytes, sha256}` with no
file name in it: the client derives the URL from the two integers, so no string
out of the manifest ever reaches a request path.

Delta files must tile the revision space contiguously, or a client at some
watermark finds no covering chain and can never sync again. Daily ingest makes
that automatic — one run, one revision, one file — which is why D-042's cadence
choice removed the rollup machinery rather than just slowing it down. A client
that finds no chain re-downloads; a manifest that contradicts itself (a delta
above head, an origin behind the local watermark) is an error, not a re-download.

### Delta format

JSON at brotli -q5, whole records rather than field-level diffs, lookups ordered
before the upserts that reference them, and the D-008 notice in-band (D-031),
finalized for the accepted schema in D-055. Typed in
[lib/protocol.ts](../lib/protocol.ts), validated by [lib/delta.ts](../lib/delta.ts),
emitted by [pipeline/delta.py](../pipeline/delta.py).

```json
{"format":1,"schema":1,"from":1,"to":2,"generated":1767225600,
 "notice":"CVE record content: Copyright © 1999-2026, The MITRE Corporation. …",
 "lookups":{"cna":[[2,"globex-cna"]],"cwe":[[2,"CWE-787","OOB write"]],
            "vendor":[[2,"globex"]],"product":[[4,2,"sprocket"]],
            "host":[[3,"newhost.example.org"]],
            "url":[[3,"https://newhost.example.org/x",3]],"vtype":[[2,"custom"]]},
 "upsert":[{"id":3,"cve":"CVE-2026-1003","y":2026,"st":1,"cna":2,
            "pub":1772323200,"upd":1772323200,"cvss":[4,9.1,4,"CVSS:4.0/AV:N"],
            "descr":"…","cwe":[1],"prod":[4],"ref":[3],
            "ver":[[4,1,"0",null,"4.2",2]]}],
 "delete":[]}
```

That is a real published file, trimmed — `pipeline/tests/fixture_pub.py` writes
it, and `tests/unit/contract.test.ts` validates it with the browser's own code.
The rules that are not visible in the shape:

- `from` is exclusive, `to` inclusive; `generated` is unix seconds, as in the
  manifest.
- Lookup tuples are in schema column order, and the tables are emitted in apply
  order (`vendor` before `product`, `host` before `url`), so apply is a
  positional insert.
- A record carries both `id` (the server-owned row id) and `cve` (the canonical
  ID) because both are columns of the `cve` row. Apply must verify the pairing
  against the local database and stop if it disagrees: that means the ID space
  drifted, and replacing by id would silently overwrite the wrong record.
- `cvss` is `[ver, score, sev, vector]` in stored codes — 31 and 4 are labels,
  not magnitudes (D-047).
- **Absent means absent, not unchanged.** Apply replaces a record wholesale, so
  an omitted `cwe` deletes its CWE rows.
- `delete` carries canonical CVE IDs, so a tombstone needs no ID-space
  agreement to act on.

A merged delta is not a merge operation: "everything since `from`" is a range
query that returns final state by construction. For records that is the ingest's
content-hash diff (D-031) — the schema carries no per-record revision column;
for lookup rows it is one integer per table per revision, since the ID space is
append-only and "what the client is missing" is "everything above the floor"
(D-055). That integer is the high-water id the build *recorded*, not the highest
id still present: a retired row can be the highest one, and recomputing would
hand its id to a different value (D-056).

## The client

- **A Worker owns the database.** This follows from OPFS's threading
  constraints, not taste, and it means every query is asynchronous from the UI's
  perspective regardless of framework. The UI (React 19 on Next.js 16 static
  export, D-027) talks to it over messages.
- **Through the `opfs` VFS, with a 256 MiB page cache.** The VFS is measured,
  not assumed: `opfs-sahpool` imports ~10% faster and then freezes any second
  tab, and its `importDb` cannot express a resumable staged replacement
  (D-051). The page cache is the single largest lever on latency in the whole
  client — stock 2 MiB turns sub-second aggregates into tens of seconds
  (D-050).
- **Sync state lives inside the database.** A `meta` table holds the watermark,
  the schema version, and the notice, and the watermark advances in the *same
  transaction* as the rows it describes, so a crash cannot leave the two
  disagreeing. The snapshot carries its own revision in that table, which is how
  a fresh download starts with a correct watermark rather than an assumed one.
- **A download never writes into the live database.** Chunks land in a staging
  file — one of two alternating slots, `cve-a.sqlite` and `cve-b.sqlite` — and
  the live copy is neither closed nor touched until the staged one has passed
  its promotion gate: the bitmap complete and the staged file unpromoted, chunks
  covering the byte range exactly under distinct names, schema and revision
  agreeing with the manifest, the D-008 notice present, records non-zero,
  indexes built. **Which slot is live is recorded in the database's own header**
  (`PRAGMA user_version`, zero in every published artifact), so promotion is one
  SQLite transaction rather than a pointer file we would have to keep
  crash-safe. That counter is read *through SQLite* rather than from the file's
  bytes — the header can advertise a promotion the journal has yet to commit —
  and nothing is deleted until the database discovery chose is open and
  answering. A slot's SQLite sidecars are cleared before its bytes are reused,
  because a journal left by an aborted index build would otherwise be replayed
  into the new generation. The per-chunk completion bitmap in `staging.json` is advisory —
  losing it costs a re-download and can never cost the live copy — but it is
  bound to the staging file's length as well as to the manifest, because a
  record that outlives its file is believed otherwise (D-061). Peak footprint
  during a re-download is therefore two generations, at least ~882 MB at full
  scale: arithmetic from the measured 441.1 MB rather than a reading, and a
  floor, since it omits the journal written while the indexes build. M5's quota
  work plans against that number, and the two-slot bound is what keeps it from
  growing further.
- **Apply is one transaction per delta file, on the live database** (D-063).
  Lookups, then tombstones, then whole-record replacements, then the watermark —
  all inside it, so a failure leaves the copy at the revision it started from
  and a retry is safe with no reconciliation logic. A *chain* is not wrapped:
  each file is a step between published revisions, so stopping part way leaves
  the copy at one of them rather than discarding the files that did apply. The
  catch-up runs after promotion rather than on the staging file, so a delta
  fetch can never cost a finished download, and a download ends by catching up —
  a fresh copy lands at head, not at `snapshot.rev`. Apply refuses rather than
  guesses: the delta's `from` must equal the local watermark, a CVE's row id
  must match in **both** directions, and every lookup id a record references
  must exist once the delta's own lookups are in. Drift means re-download.
- **Every query goes through one shared layer** ([lib/filters.ts](../lib/filters.ts)),
  which compiles the confirmed filter axes into a `WHERE` clause with every
  value bound. Two properties are structural rather than per-report: D-022's
  PUBLISHED-only default is in the compiler, and link-table axes compile to
  `EXISTS` so a record affecting eight products is still one record. Lookup
  names become ids in a separate step, so a typo is reported as a typo. This is
  the object M4's permalinks and M7's chat tools will emit (D-044).
- **User SQL runs under a SQLite authorizer, never a text filter** (D-065). The
  console allows `SELECT`, `READ`, `FUNCTION` and `RECURSIVE` and refuses
  everything else — from the parser, so `PRAGMA query_only=OFF`, a write after a
  semicolon and `SELECT * FROM pragma_query_only` are all refusals rather than
  ways around it. Results are capped at 1,000 rows and the cap is reported.
- **A running query says so and can be stopped** (D-066). SQLite's progress
  handler posts an elapsed figure past about a second and aborts the statement
  when the page sets a flag in a `SharedArrayBuffer` — the only channel that
  reaches a Worker sitting inside SQLite, and available wherever cross-origin
  isolation is, which the `opfs` VFS already requires.
- **The client builds its own full-text indexes** after import, over
  descriptions, vendor names and product names — never references, whose URLs
  would shred into the same term space as the prose (D-035). Query statistics
  are the opposite call: they arrive **in the artifact** (D-067), because
  deriving them locally means reading every index back through OPFS — 20.4 s at
  full scale, against under a second on the server and a few kilobytes on the
  wire. The client collects its own only when a generation arrived without
  them. They are what let the query layer write natural SQL instead of working
  around the planner's guesses. Shipping the
  description index instead would cost 35.1 MB compressed, 31% of the download.
  Building them costs 66.1 s at full scale and 64.4 MB in OPFS — ~90% of import
  time, and the reason the progress display has to treat it as its own phase
  (D-049).
- **FTS5 maintenance is explicit, and lives inside that transaction.** The
  indexes are external-content, so every update issues
  `INSERT INTO fts(fts, rowid, descr) VALUES('delete', …)` with the *old* text —
  read out of the content table an instant before it changes, which is the only
  place that value exists — before writing the new row. Vendor and product names
  get the same treatment, since a delta can re-ship a lookup row whose content
  changed under an id the client already holds. Skipping it corrupts search
  silently, and the default `integrity-check` will not catch it — only the
  `rank = 1` form does (RE-005). That form ends every case in
  `tests/unit/sync.test.ts`; it is not run at runtime, where re-tokenizing
  122 MB of description text would cost about what building the index cost.
- **Decompression is ours, and it streams.** Chunks arrive as opaque `.br`
  bytes with no `Content-Encoding`; a WASM decoder unpacks each one and writes
  it straight into the staging file at that chunk's byte offset — never the live
  database, which is what the bullet above is about — so peak memory
  is four chunks in flight rather than the corpus (D-040, D-041; four is the
  measured number, D-049). Resumption is a bitmap of completed chunks — brotli
  is a stream format, so a range-resumed monolith could not be decoded from an
  arbitrary offset at all. Each chunk is flushed *before* its bit is recorded:
  a bitmap that claims a chunk the file does not hold would be trusted by the
  next run and promoted with a hole in it (D-061).
- **Nothing cached ever beats a reachable network** (D-054). The SQLite/WASM
  distribution lives at unversioned paths and its three files resolve each other
  by relative URL, so it is served `no-cache` (revalidate) rather than left to
  heuristic freshness or pinned by the static-file rule — both of which bit on
  deploy day (RE-012). The M5 service worker follows the same rule: network
  first, cache as fallback, so the offline story never costs a user a stale
  shell while online.
- **A stall is a failure; duration never is** (D-052, D-064). Every transfer
  runs under a watch whose only signal is bytes received: sixty seconds without
  one aborts it and reports that it stalled *rather than being slow*, with the
  local copy untouched and the staged chunks still resumable. Responses are read
  as streams for that reason — a chunk is 5 MB, so per-chunk beats would leave a
  connection that died mid-chunk looking alive — and into a buffer allocated at
  the published length, so an over-long response is refused at the byte that
  overruns. The watch can only see *network* stalls: SQLite, OPFS and brotli
  work blocks the Worker thread, so every long synchronous step beats when it
  returns, and the watch is disarmed before the index build entirely.
- **Capability gate before the import path**, so an unsupported browser is told
  on arrival rather than failing partway through a large import (D-016). The
  probe that matters *calls* a method rather than looking for one: Safari
  15.2–16.3 ships `createSyncAccessHandle` and returns Promises from the
  handle's methods, which SQLite calls synchronously — so every interface check
  passes and the import dies inside WASM. `lib/capabilities.ts` opens a scratch
  OPFS file, reads what `getSize()` returns, and removes it. There is no
  telemetry (D-009), so whatever the gate says on screen is the whole support
  channel: it names the specific missing capability *and* the floor, because
  "why does this not work" and "what do I do" are different questions and a
  stripped COOP header is a fixable case that has nothing to do with the
  browser.
- **Storage sized in advance.** Quota, eviction, and
  `navigator.storage.persist()` are part of the import design, not error
  handling bolted on later. Persistence is requested from the Download click —
  Firefox prompts, and a prompt outside a user gesture is dismissed — and the
  *answer* is what gets surfaced. The preflight runs after the manifest and
  before the first chunk, and budgets **two generations** when a copy is already
  present, because staged replacement holds both at once (D-061). An unknown
  quota proceeds: refusing on "I don't know" would block every browser that
  reports nothing, and the download then fails the way it always could, with the
  live copy intact.
- **One writer across tabs, and replacements propagate** (M5). Download and sync
  take a Web Lock for their whole duration, `ifAvailable` rather than queued — a
  download that starts twenty minutes later, after the user has moved on, is
  worse than being told now — and the refused tab is told *which* operation is
  running and keeps querying. The silent half is the other one: a tab that did
  not perform a replacement is left holding the slot that was promoted *over*,
  answering correctly from a generation nobody else can see. A promotion is
  therefore announced on a `BroadcastChannel` and the other tabs close and
  re-discover; an applied delta is announced too, so freshness lines agree. This
  is affordable only because D-051 chose the `opfs` VFS, where a second tab can
  open the same database at all.
- **The app shell is cached; the data plane never is** (D-048). A hand-rolled
  service worker, generated from the finished export so its precache list cannot
  drift from the chunk names Turbopack emits, and versioned by a hash of that
  list plus every file's contents — which is what "versioned per deploy" means
  with no build step on the server (D-003). `/data/` is not merely absent from
  the list: the worker returns without calling `respondWith` for it, so no later
  branch can reach one of those URLs. A stale manifest from a cache would break
  the staleness indicator, which is the one guard vision criterion 7 has.
- **Staleness is visible** (D-064). Sync is manual after the first one (D-025)
  — a download catches itself up, and after that the user chooses when — so a
  user can sit on a month-old corpus getting confident-looking counts. The
  indicator reads the data's own build stamp, `meta.generated`, which the delta
  carries so that a synced copy and a freshly downloaded one at the same
  revision report the same age (D-058 §4a). It is an age rather than a verdict
  about the origin, because `status` makes no network request — that is what
  lets a reopen work offline (D-048) — so past two days it says the copy is
  behind unless the origin has stopped publishing, and points at Sync. A sync
  then reports how many of the records it brought are CVEs this copy did not
  hold, which is the number a user actually opens the app for.

## The AI layer (planned — M7/M8, D-044 – D-046, D-057)

Sits entirely above the client described previously; the data plane below it is
unchanged, and the two Fixed points it touches — one origin, upstream sources —
carry their D-045/D-057 annotations above. Detail lands here when the layer is
built — these are the structural commitments:

- **Chat drives the fixed UI through report definitions.** The model's
  presentation tools emit the same serializable object the deterministic UI
  builds, renders, and shares. Charts, clickable CVE lists, and drill-downs are
  the existing UI components fed by the model rather than duplicated for it.
- **The model orchestrates; it never transcribes.** Small aggregate results may
  enter model context for trend interpretation; row-level result sets are
  returned as handles and rendered straight from SQLite. A number the user sees
  is a query result by construction.
- **Tool surface: read-only, render-only, forever.** Curated high-level tools
  with tight schemas, plus a `SELECT`-only, row-capped, timed-out SQL tool —
  enforced structurally (read-only connection or SQLite authorizer), never by
  inspecting query text. No tool fetches URLs, writes data, or reaches the
  network — record text in the prompt is assumed hostile (rule 5), and
  containment is structural. Report definitions carry structured data only: no
  model-authored HTML, markdown, or URLs; chat prose renders as plain text,
  and record URLs appear only through the fixed UI's existing
  never-auto-fetched treatment.
- **Provider ladder (D-045, re-ordered by D-057):** first to ship is the
  **site-hosted tier** — Ollama on the private `llm` box (`http://llm:11434/`,
  hostname in hosts on dev and prod, not publicly routable), relayed through a
  restricted same-origin endpoint: server-pinned model (`gemma4:e4b` today),
  chat completion as the only exposed operation, POST-only, body-capped, nginx
  rate- and concurrency-limited, nothing stored, no body logging. On this tier
  the question and its tool results transit this server — disclosed at first
  use. The M8 tiers follow: local WASM/WebGPU model (the intended default;
  weights from Hugging Face into OPFS on explicit action), Chrome built-in
  Gemini Nano, and user-supplied keys for Gemini / OpenRouter / Anthropic /
  OpenAI, called browser-direct with keys client-side only. `cve.meenan.dev`
  proxies no third-party model traffic and bundles no key.
- **Model selection is benchmarked, not assumed (D-046).** Ground-truth analyst
  questions scored by data comparison against the real corpus, run through the
  actual integration.

## Schema

**Schema 2** since 2026-08-08. The floor is D-024; version ranges, references
and reference hosts were added by D-033 after pricing every candidate, and
D-070's five fields landed before public launch because a bump after it costs
every user a 63 MB re-download (D-075). Interning is server-side, so the
published artifact carries no `UNIQUE` constraints that exist only to support
it.

```sql
-- interned lookups: server-owned ID space, append-only, never renumbered.
-- Each build seeds from the previous artifact, so an id means the same value in
-- every artifact and every delta; a value the corpus drops is retired and its
-- id never reissued (D-056).
CREATE TABLE cna(id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE cwe(id INTEGER PRIMARY KEY, cwe TEXT, descr TEXT);
CREATE TABLE vendor(id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE product(id INTEGER PRIMARY KEY, vendor_id INT, name TEXT);
CREATE TABLE host(id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE url(id INTEGER PRIMARY KEY, url TEXT, host_id INT);
CREATE TABLE vtype(id INTEGER PRIMARY KEY, name TEXT);

-- reserved / ssvc_* are schema 2 (D-070). NULL there means *not assessed*,
-- which is a different fact from `ssvc_expl = 0` ("none" — someone looked).
CREATE TABLE cve(id INTEGER PRIMARY KEY, cve_id TEXT UNIQUE, year INT, state INT,
  cna_id INT, published INT, updated INT,
  cvss_ver INT, cvss_score REAL, cvss_sev INT, cvss_vec TEXT,
  reserved INT, ssvc_expl INT, ssvc_auto INT, ssvc_impact INT);
-- A row exists if the record has *any* of the three. 17,842 REJECTED records
-- have only `reason`, which is why they rendered blank before schema 2.
CREATE TABLE cve_text(cve_id INTEGER PRIMARY KEY, descr TEXT, title TEXT, reason TEXT);

CREATE TABLE cve_cwe (cve_id INT, cwe_id     INT, PRIMARY KEY(cve_id,cwe_id))     WITHOUT ROWID;
CREATE TABLE cve_ref (cve_id INT, url_id     INT, PRIMARY KEY(cve_id,url_id))     WITHOUT ROWID;
-- default_status: the container default governing every version *not* listed in
-- cve_ver, in cve_ver.status's vocabulary (1/2/3), NULL when unstated (D-070).
CREATE TABLE cve_prod(cve_id INT, product_id INT, default_status INT,
  PRIMARY KEY(cve_id,product_id)) WITHOUT ROWID;
CREATE TABLE cve_ver(cve_id INT, product_id INT, status INT,
  version TEXT, lt TEXT, lte TEXT, vtype INT);

-- rev, schema, generated, notice — plus the ID space's own record, which the
-- client ignores and the next build and delta read: hwm, cve_hwm, idspace,
-- seed_rev, seed_marks, seed_fingerprint (D-056)
CREATE TABLE meta(k TEXT PRIMARY KEY, v);

-- built by the client after import, never shipped (D-035)
-- descr *and* title: 83.3% of titled records have a title that is not a
-- substring of their own description, and the title is where the vulnerability
-- class and the sink live (D-075)
CREATE VIRTUAL TABLE fts         USING fts5(descr, title, content='cve_text', content_rowid='cve_id');
CREATE VIRTUAL TABLE fts_vendor  USING fts5(name,  content='vendor',   content_rowid='id');
CREATE VIRTUAL TABLE fts_product USING fts5(name,  content='product',  content_rowid='id');

-- plus sqlite_stat1, which the *build* writes (D-067) — the client only
-- collects its own if a generation arrived without it
```

Three properties are load-bearing rather than stylistic:

- **`WITHOUT ROWID` with `cve_id` leading the primary key** is what makes delta
  apply cheap. Replacement semantics delete a record's dependent rows by
  `cve_id`; the spike's rowid table with only a `(cwe_id, cve_id)` index made
  that a full scan, costing 19× (D-031). Here the access path is structural.
  `cve_ver` is the exception — it carries non-key columns and permits duplicate
  pairs — so it needs `cve_ver(cve_id)` declared explicitly.
- **`cve.cve_id` keeps its unique index** because the client genuinely looks
  records up by ID; `url` and `product` do not, and dropping their build-time
  `UNIQUE` saved 63 MB (D-033).
- **`state` is a column, not a filter applied at ingest.** ~4.9% of the corpus
  is REJECTED; it is imported, excluded from aggregates by default, and
  filterable on request (D-022). That default belongs in a shared query layer,
  not in each report.

Indexes: `cve(year)`, `cve(cna_id)`, `cve(cvss_score)`, `cve(published)`,
`cve_cwe(cwe_id,cve_id)`, `cve_prod(product_id,cve_id)`, `cve_ref(url_id,cve_id)`,
`cve_ver(cve_id)`, `cve_ver(product_id)`, `product(vendor_id)`, `url(host_id)`.
None on `cvss_sev` and none on the three SSVC columns: they are low-cardinality
codes on the corpus table, so every grouping over them scans `cve` whichever way
it is written, and an index would cost download bytes for every user to save
none of them (D-033's trade, restated in D-075).

## Trust boundaries

| Boundary | What crosses | Control |
| --- | --- | --- |
| Upstream → pipeline | Attacker-influenced JSON | Parse defensively; never build SQL by concatenation; the tombstone guard bounds the blast radius of a broken fetch |
| Pipeline → `pub/` | Finished artifacts only | Atomic rename; working state stays in sibling directories |
| `pub/` → browser | Static files | No CORS headers, integrity hashes in the manifest. D-039 removed origin rate limiting in favour of Cloudflare — but as of the first deploy the hostname is **not proxied through Cloudflare**, so nothing is absorbing abuse today. M5 owns closing that before launch (D-034, D-039) |
| Database → UI | Record text | Never injected as HTML; URLs from records are never auto-fetched |
| UI → database | The user's own SQL, and filter values that may have come from a link | A SQLite authorizer allows reading and nothing else, from inside the parser rather than by inspecting the text; results are row-capped and the query is cancellable (D-065, D-066). Filter values are bound parameters, never concatenated (rule 4) |
| Database → model prompt | Attacker-influenced record text entering LLM context | Prompt injection is assumed; the tool surface is read-only and render-only with no network reach, and model output carries no markup or minted URLs — a successful injection yields wrong-but-inspectable presentation, nothing more (D-044) |
| Browser → hosted model provider | The user's question and its tool results — only when the user supplies a key | Explicit opt-in per provider; key stored client-side only; called browser-direct, never proxied, never touching this server (D-045) |
| Browser → chat relay → `llm` | The user's question and its tool results — only when the site-hosted tier is selected | Opt-in, disclosed at first use; the relay is same-origin, POST-only, body-capped, rate- and concurrency-limited, pinned to one model and one operation with no caller-supplied URL, host, or model; nothing stored, bodies never logged (D-057) |

Same-origin enforcement is **the absence of `Access-Control-Allow-Origin`**, not
a `Sec-Fetch-Site` check. Header sniffing stops nobody who matters — any
non-browser client forges or omits it — while breaking `curl` and direct
downloads, including by anyone auditing our privacy claim (D-034). There is no
origin rate limiting: Cloudflare fronts the data plane and honors our own
`Cache-Control` headers rather than its extension defaults, so per-IP limits
behind a proxy — which would have bucketed the internet into a few edge
addresses — are simply absent (D-039).

## Failure modes

| Failure | What happens | Why it is acceptable |
| --- | --- | --- |
| Interrupted download | Refetch the missing chunks | Each chunk is independently compressed and verified, so resume is a bitmap (D-041) |
| Interrupted rotation | The next run finishes it | The chunks land by rename before the manifest names them; re-cutting the same bytes completes the publication without `--force` (D-047, D-060) |
| Corrupted chunk | Refetch that chunk | Per-chunk SHA-256 in the manifest; costs 5 MB, not 63 |
| Snapshot rotates mid-download | Old generation still served | One previous generation is retained, and its deltas one rotation longer still (D-042, D-060) |
| Interrupted sync | Transaction rolls back; watermark unchanged; retry is safe | The watermark advances inside the same transaction as the rows, and a repeat of an applied file is refused rather than applied twice (D-063) |
| Schema version bump, local copy | Announced with both versions, not queried, and **kept** until a download replaces it | The local database is a rebuildable cache (D-013), but replacing it is not the same as deleting it without saying so (D-068) |
| Schema version bump, manifest | Refused before a byte is fetched; the message says to reload the app | A published schema this build cannot read means the *app* is behind, and re-downloading the same bytes fails identically (D-068) |
| Client older than the oldest delta | Full re-download | Delta retention is bounded to the previous generation, and `planSync` returns `null` rather than a chain that does not exist (D-042, D-060) |
| Upstream force-push | Nothing special | The pipeline diffs content hashes, never git history (RE-006) |
| Broken fetch drops records | Pipeline aborts before publishing | The 0.1% tombstone guard |
| Malformed record in the clone | Build aborts, artifact deleted | Fail closed (D-047): silent skips would undercount below the tombstone guard's radar, forever |
| FTS index drifts | Search returns wrong results **silently** | The one real threat to vision criterion 7 under this design; verified with `integrity-check` at `rank = 1` (RE-005) |
| Stale local corpus | Confident-looking counts from old data | Made visible, not prevented — sync is deliberately manual |

## Measurements

All measured against the full corpus on `plex`, not sampled or estimated.

### Corpus (2026-07-30, clone at `a42a2eb6c2`)

| | |
| --- | --- |
| CVE records | **372,092** (years 1999–2026) |
| Raw JSON | **2,934 MB** (~7.9 KB mean per record) |
| Record state | ~95.1% `PUBLISHED`, **~4.9% `REJECTED`** (D-022) |
| `dateUpdated` present | 100% · `datePublished` 98.4% (D-020) |

*Measured before D-021 made the clone shallow: 74,082 commits, 581 MiB pack with
history, mean 4.10 revisions per record — reproducing those needs an unshallow
fetch (RE-003). The clone was advanced to `d300c5fcc0` on 2026-07-31 for the
delta measurement, so a re-run sees slightly larger figures.*

Recent partitions, which bound the owner's motivating query:

| Year | Records | Raw JSON |
| --- | --- | --- |
| 2024 | 39,209 | 312 MB |
| 2025 | 45,031 | 315 MB |
| 2026 (partial) | 38,972 | 307 MB |

### Normalization (2026-07-30)

Raw JSON to a queryable database, per D-024:

| Stage | Size |
| --- | --- |
| Raw JSON on disk | 2,934 MB |
| Compact JSON (whitespace stripped) | ~1,361 MB |
| Normalized base tables | **182.8 MB** |
| + indexes | 215.9 MB |
| + FTS5 over descriptions | **272.8 MB** |

19 s to parse 372,092 records, 3 s to build FTS5. Native SQLite on server
hardware answered `MATCH 'buffer overflow'` in 1 ms and the owner's motivating
query — vendor × severity for 2025 onward — in 99 ms.

The interning cardinalities are why this works: 797 distinct CWEs were being
carried across 189,690 associations, and 479 CNA names across all 372,092
records. Dropped outright: `x_legacyV4Record` (19.1% of compact bytes),
`containers.adp` as a stored blob (21.5%, mined for CVSS and CWE first), and
`providerMetadata` (3.0%).

**This is what settled the data-delivery architecture.** The projection design
existed because bulk import meant moving hundreds of megabytes; normalized, the
entire corpus is smaller than that design's own motivating two-year slice, which
made bulk import (D-025) both simpler and more capable.

### Schema pricing (2026-07-31)

Every Q-002 candidate built against the full corpus and compressed, because
download bytes are the only cost that matters (D-033):

| Cumulative variant | Database | brotli -q5 |
| --- | --- | --- |
| Floor (D-024) | 271.4 MB | **75.6 MB** |
| + version ranges | 338.4 MB | 90.0 MB |
| + references (URLs + links) | 441.4 MB | 111.0 MB |
| **+ interned hosts — shipped** | **452.5 MB** | **113.0 MB** |
| *(alternative)* FTS over URLs instead | 482.7 MB | 126.6 MB |
| + reference names | 474.6 MB | 119.2 MB |
| + FTS over reference names | 489.8 MB | 124.7 MB |
| + reference tags | 515.2 MB | 132.0 MB |
| + CPE, remedies, credits, timeline | 532.1 MB | 135.5 MB |

Prevalence decided the exclusions: references 95.1%, version ranges 95.0%,
credits 20.1%, timeline 7.1%, solutions 4.5%, **CPE 2.2%**, exploits 1.3%,
workarounds 1.2%, configurations 0.3%.

That artifact measured **95.4 MB at brotli -q10** (416 s). D-035 then dropped
the shipped full-text index — 35.1 MB of q5, since an inverted index compresses
at only 1.7× — taking the published artifact to **62.6 MB at brotli -q10** over
391.3 MB of database. Year partitioning was measured too (a 2022+ window would
have been 38.0 MB) and rejected as not worth the coverage complexity (D-038).

### Compression

Measured on the 272.8 MB floor artifact:

| Codec | Size | Compress time | Support above the D-016 floor |
| --- | --- | --- | --- |
| gzip -9 | 98.7 MB | 29.4 s | universal |
| brotli -q5 | 83.2 MB | 5.2 s | universal |
| brotli -q9 | 79.0 MB | 52.7 s | universal |
| **brotli -q10** | **72.1 MB** | 239.3 s | universal |
| brotli -q11 | abandoned | > 2 min, unfinished | universal |
| zstd -19 | 76.0 MB | not recorded | **no Safari** |

**brotli -q10 settles the codec question outright**: smaller than zstd -19 *and*
universally supported, so the tradeoff that made zstd tempting does not exist.
Quality is capped at 10 per the project owner — q11 costs significantly more for
very little gain. q5 is the right setting for deltas, where turnaround matters
more than the last few percent.

`DecompressionStream` supports only gzip and deflate, which once made
`Content-Encoding` the only route for brotli. D-040 makes that moot: artifacts
ship as opaque `.br` with no encoding header and a WASM decoder
(`brotli-dec-wasm`, MIT OR Apache-2.0, ~200 KB) unpacks them, so progress
reporting and range resume both count the same bytes that cross the wire.

### Delta, over a real 21.4-hour window (2026-07-31)

`a42a2eb6c2` → `d300c5fcc0`, the evidence behind D-031:

| | |
| --- | --- |
| Records before → after | 372,092 → 372,322 |
| Added / updated / **removed** | 230 / 435 / **0** |
| Updates changing only `dateUpdated` | 275 of 435 (**63%**) |
| New lookup rows | 17 vendors, 86 products, 1 CWE; **0 vanished** |
| Payload | 382 KB JSON → 95 KB gzip -9 → **87 KB brotli -q5** |
| Description text as a share of payload | 62% |
| Apply to the 272.8 MB database | **0.08 s**, FTS maintenance included |
| `integrity-check` at `rank = 1` | 0.8 s |

Upstream published in 32 batches over the window, producing 832 change events
against 665 distinct records — so merging saves 20% of the payload, and one
request instead of 32. Earlier delta economics (D-025), measured over 31 days
via `deltaLog.json`: median day 1,312 events / 0.17 MB gzipped, busiest observed
6,147 / 0.78 MB, one week ~12,000 / 1.50 MB.

At these rates a month of catch-up costs a new user ~2.6 MB against a 62.6 MB
snapshot — about 4%, which is why the monthly rebuild cadence (D-042) is
comfortable: daily ingest bounds the delta file count at ~31. That cost is
proportional to *time since the last rotation*, not to the age of the corpus —
a new user arriving the day after a rotation pays almost nothing, and one
arriving the day before pays the whole month. It is the same ~2.6 MB a client
one generation behind applies instead of re-downloading (D-060).

### Traps worth knowing before writing any corpus scan

- `cves/delta.json` and `cves/deltaLog.json` are the publishing pipeline's own
  churn files, not CVE records. A naive `find cves -name '*.json'` includes them.
  `deltaLog.json` is also a rolling 30-day window, and models only `new`,
  `updated`, and `error` — there is no deletion concept upstream.
- **~4.9% of records are `REJECTED`.** Any aggregate without a state predicate
  overcounts by roughly that much, and it will look plausible.
- Records are nested as `cves/<year>/<N>xxx/CVE-<year>-<N>.json`, so the year
  partition is a directory level and comes free.
- 4.46% of records carry no description at all, so `cve_text` holds fewer rows
  than `cve`. Those records cannot match a search, and the UI must not present
  that as "no results" when the truth is "this record has no indexed text"
  (D-023).

## Deliberately absent

- **No client-side git.** Rejected with measurements in D-005; do not
  reintroduce isomorphic-git or a CORS proxy without reopening it.
- **No server-side query execution.** Rejected in D-007, reaffirmed in D-014:
  the server ships data, it does not filter, rank, or aggregate.
- **No dynamic endpoint at all**, as built (D-032). Adding one is a constraint
  change and restores every question D-034 declined to answer.
- **No custom SQLite VFS.** The range-request VFS was rejected in D-015 on
  simplicity grounds; do not reintroduce `sql.js-httpvfs`, `sqlite-wasm-http`,
  or a hand-written page-fetching VFS without reopening it.
- **No direct browser fetches to GitHub bulk endpoints.** Measured CORS-blocked
  2026-07-30 (RE-001). `raw.githubusercontent.com` and `api.github.com` do send
  `access-control-allow-origin: *` and remain usable as a cross-check, but they
  are not the primary path.

## Open questions

Tracked in [features.md](features.md); Q-001 – Q-005 are all answered. Q-003
(browser-side budgets, D-049) and Q-004 (OPFS VFS selection, D-051) were the
last two, measured in M1 against the full corpus rather than argued — with
D-050 (the 256 MiB page cache) falling out of the same sweep. Purely technical
questions not tracked there:

- **Where schema migration lives.** A server-owned schema makes a migration a
  server deploy plus a client re-import; a client-owned schema makes it a
  migration against a large local database. We have chosen server-owned by
  implication, and never costed the alternative.

- **Whether the delta rollup can be made obviously correct.** The tiling
  invariant has a nasty failure mode — a client that can never sync again — and
  wants a property test.
- **What a schema-version bump costs in practice.** The *behaviour* is settled
  and tested (D-068); what is not known is how often a bump is worth its cost,
  which stays a release-discipline question rather than a technical one.

*Resolved:* why the reference-table scan was slow — 1.2 million random rowid
lookups into `url`, fixed by query statistics that make the planner drive from
`host` through the covering indexes instead, shipped in the artifact because
deriving them in the browser costs 20.4 s (D-067); and what to do about the
cold first query after a reopen — show it, because the page cache starts empty
and warming does the same I/O at a moment nobody asked for (D-067, D-052 §3). What building the full-text indexes costs in WASM — 66.1 s for the
full corpus, ~90% of import, and D-035's "progress-bar concern rather than a
gate" holds, but only with D-050's page cache (247 s without it). How many
chunks to decompress concurrently — four, decided on throttled transport
because loopback cannot tell the settings apart (D-049, settling what D-041
deferred).
rsync semantics versus server-side state — D-018's peer directory.
Whether a partial cache can be quietly wrong — moot under D-025. Cache
invalidation on a rewritten upstream history — moot under D-031. Whether the FTS
index can be delta-updated or must be rebuilt — measured, 0.08 s with no bloat
across eight applies, so `'optimize'` is maintenance rather than part of sync.
