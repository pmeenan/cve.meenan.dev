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
  touch this origin's data plane. (D-003, D-006, D-045)
- **Record content is untrusted input.** CVE text is attacker-influenced and
  crosses a trust boundary at parse time, at SQL time, and at render time.
  (AGENTS.md rule 5)
- **Every copy of CVE data carries its notice.** MITRE's copyright designation
  and the CVE Terms of Use travel with served artifacts and with anything a user
  exports. A format that cannot carry the notice in-band needs a deliberate
  answer, not an omission. (D-008)

## The server pipeline

Two cron jobs under `flock`, no daemon (D-042). **Daily** ingest, ~40 s of work
for ~87 KB of output; **monthly** snapshot rebuild. Upstream publishes about
every 40 minutes, so a day accumulates ~665 distinct changed records.

1. **Fetch.** `git fetch --depth 1 origin main` into `cve.data/git/cvelistV5`,
   then reset. Measured at 1.8 s. A shallow clone reports every advance as a
   forced update, so git's output is not a usable change signal (RE-006) — the
   pipeline ignores it.
2. **Hash.** Walk the working tree, compute a hash over each record's normalized
   projection — exactly the fields we store — and diff against the previous
   run's hashes. 15–18 s for all 372k records. Records changed or added become
   upserts; records present before and absent now become tombstones.
3. **Guard.** If the run would tombstone more than 0.1% of the corpus (~370
   records), abort and alert rather than publish. Upstream has no deletion
   concept at all, so a mass deletion means our fetch broke, not that the CVE
   Program withdrew 400 records.
4. **Normalize.** Build the relational artifact (see [Schema](#schema)). 19 s.
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
   defend (D-042).
6. **Snapshot, monthly.** Rebuild the database, split it into 32 MB slices of
   the uncompressed file, and compress each at brotli -q10 — 101 s across 24
   cores, against 351 s for a monolith (D-041). Only the compressed chunks are
   published; the client decompresses in WASM (D-040), and no full-text index is
   built server-side because the client builds its own (D-035).
7. **Retire, one generation behind.** Keep the previous snapshot and every delta
   back to it, so a client that read the manifest minutes ago and is mid-download
   does not start seeing 404s. One spare generation costs 63 MB. Note what
   retention does *not* buy today: the manifest only lists deltas that start at
   or after its snapshot's revision, because nothing bridges the old revisions
   to a rebuilt snapshot, so a client a generation behind re-downloads until the
   bridging delta lands with the monthly cron. Seeded interning removed the
   ID-space half of that blocker — a rebuilt snapshot and the old head share an
   ID space now — and the remaining half is the manifest's own tiling rule,
   which still requires a delta to start at or above the snapshot's revision
   (D-055, D-056).

Publication into `pub/` is an atomic rename, so a half-written artifact is never
reachable — and a published generation is immutable: same-rev republication is
refused, because its URLs carry an immutable cache policy (D-047). The clone,
working databases, and hash state live in sibling directories under `cve.data/`
and are never under the served root (D-018, D-034).

## The published contract

Everything under `/data/`, served by nginx from `cve.pub/data/` — a peer of the
document root and of `cve.data/`, so nothing under `cve.data/` is web-reachable
(D-034, D-053).

| File | Cache | Notes |
| --- | --- | --- |
| `manifest.json` | `no-cache` | The only mutable file. Lists everything else with byte length and SHA-256. |
| `snapshot-<rev>/NNN.br` | immutable | 12 chunks, ~5.2 MB each, **62.7 MB** total, each expanding to a 32 MB slice of the 376.7 MB database (D-041). Measured on the first published generation, 2026-08-01. |
| `deltas/<from>-<to>.json.br` | immutable | One per day; consecutive revisions tile the space by construction (D-042). |
| `kev.json` | short | CISA KEV, its own freshness (D-010). |

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
    add_header Cache-Control "no-cache" always;
}

location ^~ /data/ {
    root /var/www/meenan.dev/cve.pub;
    autoindex off;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;
    add_header Cache-Control "public, max-age=31536000, immutable" always;
}
```

Four things about it are load-bearing rather than stylistic:

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
- **What is absent.** No `Access-Control-Allow-Origin` — its absence is the
  same-origin control (D-034). No `brotli_static`, because artifacts are opaque
  `.br` the client decodes itself and an added `Content-Encoding` would corrupt
  that path (D-040). No `limit_conn`/`limit_rate` (D-039).

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
- **Apply is one transaction and is idempotent.** Measured: eight applications
  of the same delta left row counts identical and the file 0.1 MB larger. An
  interrupted sync is safe to retry with no reconciliation logic.
- **The client builds its own full-text indexes** after import, over
  descriptions, vendor names and product names — never references, whose URLs
  would shred into the same term space as the prose (D-035). Shipping the
  description index instead would cost 35.1 MB compressed, 31% of the download.
  Building them costs 66.1 s at full scale and 64.4 MB in OPFS — ~90% of import
  time, and the reason the progress display has to treat it as its own phase
  (D-049).
- **FTS5 maintenance is explicit.** The indexes are external-content, so every
  update must issue `INSERT INTO fts(fts, rowid, descr) VALUES('delete', …)`
  with the *old* text before writing the new row. Skipping it corrupts search
  silently, and the default `integrity-check` will not catch it — only the
  `rank = 1` form does (RE-005).
- **Decompression is ours, and it streams.** Chunks arrive as opaque `.br`
  bytes with no `Content-Encoding`; a WASM decoder unpacks each one and writes
  it straight into the OPFS database at that chunk's byte offset, so peak memory
  is four chunks in flight rather than the corpus (D-040, D-041; four is the
  measured number, D-049). Resumption is a bitmap of completed chunks — brotli
  is a stream format, so a range-resumed monolith could not be decoded from an
  arbitrary offset at all.
- **Nothing cached ever beats a reachable network** (D-054). The SQLite/WASM
  distribution lives at unversioned paths and its three files resolve each other
  by relative URL, so it is served `no-cache` (revalidate) rather than left to
  heuristic freshness or pinned by the static-file rule — both of which bit on
  deploy day (RE-012). The M5 service worker follows the same rule: network
  first, cache as fallback, so the offline story never costs a user a stale
  shell while online.
- **Capability gate before the import path**, so an unsupported browser is told
  on arrival rather than failing partway through a large import (D-016).
- **Storage sized in advance.** Quota, eviction, and
  `navigator.storage.persist()` are part of the import design, not error
  handling bolted on later.
- **Staleness is visible.** Sync is manual (D-025), so a user can sit on a
  month-old corpus getting confident-looking counts. The freshness indicator is
  what keeps results honest — it replaces the coverage tracking that bulk import
  made unnecessary.

## The AI layer (planned — M7/M8, D-044 – D-046)

Sits entirely above the client described previously; the data plane below it is
unchanged, and the two Fixed points it touches — one origin, upstream sources —
carry their D-045 annotations above. Detail lands here when the layer is
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
- **Provider ladder (D-045):** local WASM/WebGPU model (default; weights from
  Hugging Face into OPFS on explicit action) → Chrome built-in Gemini Nano →
  user-supplied keys for Gemini / OpenRouter / Anthropic / OpenAI, called
  browser-direct. Keys live client-side only. `cve.meenan.dev` serves no
  inference and proxies no model traffic.
- **Model selection is benchmarked, not assumed (D-046).** Ground-truth analyst
  questions scored by data comparison against the real corpus, run through the
  actual integration.

## Schema

The floor is D-024; version ranges, references and reference hosts were added by
D-033 after pricing every candidate. Interning is server-side, so the published
artifact carries no `UNIQUE` constraints that exist only to support it.

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

CREATE TABLE cve(id INTEGER PRIMARY KEY, cve_id TEXT UNIQUE, year INT, state INT,
  cna_id INT, published INT, updated INT,
  cvss_ver INT, cvss_score REAL, cvss_sev INT, cvss_vec TEXT);
CREATE TABLE cve_text(cve_id INTEGER PRIMARY KEY, descr TEXT);

CREATE TABLE cve_cwe (cve_id INT, cwe_id     INT, PRIMARY KEY(cve_id,cwe_id))     WITHOUT ROWID;
CREATE TABLE cve_prod(cve_id INT, product_id INT, PRIMARY KEY(cve_id,product_id)) WITHOUT ROWID;
CREATE TABLE cve_ref (cve_id INT, url_id     INT, PRIMARY KEY(cve_id,url_id))     WITHOUT ROWID;
CREATE TABLE cve_ver(cve_id INT, product_id INT, status INT,
  version TEXT, lt TEXT, lte TEXT, vtype INT);

-- rev, schema, generated, notice — plus the ID space's own record, which the
-- client ignores and the next build and delta read: hwm, cve_hwm, idspace,
-- seed_rev, seed_marks, seed_fingerprint (D-056)
CREATE TABLE meta(k TEXT PRIMARY KEY, v);

-- built by the client after import, never shipped (D-035)
CREATE VIRTUAL TABLE fts         USING fts5(descr, content='cve_text', content_rowid='cve_id');
CREATE VIRTUAL TABLE fts_vendor  USING fts5(name,  content='vendor',   content_rowid='id');
CREATE VIRTUAL TABLE fts_product USING fts5(name,  content='product',  content_rowid='id');
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

## Trust boundaries

| Boundary | What crosses | Control |
| --- | --- | --- |
| Upstream → pipeline | Attacker-influenced JSON | Parse defensively; never build SQL by concatenation; the tombstone guard bounds the blast radius of a broken fetch |
| Pipeline → `pub/` | Finished artifacts only | Atomic rename; working state stays in sibling directories |
| `pub/` → browser | Static files | No CORS headers, integrity hashes in the manifest. D-039 removed origin rate limiting in favour of Cloudflare — but as of the first deploy the hostname is **not proxied through Cloudflare**, so nothing is absorbing abuse today. M5 owns closing that before launch (D-034, D-039) |
| Database → UI | Record text | Never injected as HTML; URLs from records are never auto-fetched |
| Database → model prompt | Attacker-influenced record text entering LLM context | Prompt injection is assumed; the tool surface is read-only and render-only with no network reach, and model output carries no markup or minted URLs — a successful injection yields wrong-but-inspectable presentation, nothing more (D-044) |
| Browser → hosted model provider | The user's question and its tool results — only when the user supplies a key | Explicit opt-in per provider; key stored client-side only; called browser-direct, never proxied, never touching this server (D-045) |

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
| Corrupted chunk | Refetch that chunk | Per-chunk SHA-256 in the manifest; costs 5 MB, not 63 |
| Snapshot rotates mid-download | Old generation still served | One previous generation is retained (D-042) |
| Interrupted sync | Transaction rolls back; watermark unchanged; retry is safe | Apply is idempotent, measured |
| Schema version bump | Full re-download, announced in the UI | The local database is a rebuildable cache (D-013), but it must not be a surprise |
| Client older than the oldest delta | Full re-download | Delta retention is bounded to the current snapshot (D-026) |
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
comfortable: daily ingest bounds the delta file count at ~31.

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
- **What a schema-version bump costs the user.** Deltas cannot bridge one, so
  the client re-downloads 62.6 MB. Acceptable rarely, unacceptable often — which
  makes schema stability a release-discipline question, not a technical one.
- **Whether the delta rollup can be made obviously correct.** The tiling
  invariant has a nasty failure mode — a client that can never sync again — and
  wants a property test.
- **Why the reference-table scan has no index.** At ~850 ms it is an order of
  magnitude slower than the other nine benchmark shapes, and the only one whose
  access path is a full scan of `cve_ref` joined through `url`. Not a budget
  violation — D-049 sets no latency ceiling — but the clearest indexing
  opportunity in the set. M3 owns it.
- **Why the first query after a reopen costs 9 s.** The page cache starts
  empty, so it is all OPFS reads (D-049). Whether that is warmed, amortised, or
  simply shown to the user is M3's call.

*Resolved:* what building the full-text indexes costs in WASM — 66.1 s for the
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
