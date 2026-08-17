/**
 * The published contract and the Worker message protocol.
 *
 * The manifest is the boundary between the Python pipeline (D-043) and this
 * application, so these types are the thing a test can hold onto when the two
 * drift.
 */

import type { CapabilityReport } from './capabilities'
import type { Catalog } from './catalog'

export type { Catalog } from './catalog'
import type { Dimension, Filters, SortKey, StateFilter } from './filters'
import type { ExportFormat } from './export'
import type { KevStatus } from './kev'
import type { Report } from './report'
import type { StorageReport } from './storage'

/**
 * The published *schema* — what columns the artifact carries. 2 since
 * 2026-08-08 (D-070's five field additions).
 *
 * A bump invalidates every local copy with no in-place migration, deliberately
 * (D-013, D-068), which is why D-070 timed the additions before public launch.
 */
export const SCHEMA_VERSION = 2

/**
 * The *envelope* format of the manifest and delta files — how the bytes are
 * arranged, not what columns they carry.
 *
 * Deliberately **not** bumped by D-070's schema change, even though the delta
 * record grew keys. The two numbers gate the same file and `assertUsable`
 * checks this one first, so bumping both would replace D-068's actionable
 * "reload the page to pick up the matching app" with "unsupported wire format",
 * for a client whose real problem is the schema. Record columns ride
 * `SCHEMA_VERSION`, because record columns *are* the schema; this moves when the
 * envelope around them does.
 */
export const FORMAT_VERSION = 1

/** Where the static data plane is mounted. No parameters are ever sent (D-032). */
export const DATA_ROOT = '/data'

export interface ChunkEntry {
  name: string
  /** Byte offset of this chunk's *decompressed* output within the database. */
  offset: number
  /** Decompressed length. The last chunk is short. */
  raw_bytes: number
  /** Compressed length, i.e. what crosses the wire. */
  bytes: number
  sha256: string
}

/**
 * One published delta file (D-055).
 *
 * There is deliberately no file name here. The client derives the URL from
 * `from` and `to` (see `deltaUrl`), so no string out of the manifest ever
 * reaches a request path — the same reason the client sends no parameters
 * (D-032). `bytes`/`sha256` describe the compressed file, as they do for a
 * chunk; `raw_bytes` bounds the decompression and is checked after it.
 */
export interface DeltaEntry {
  /** Exclusive: this file applies to a database whose watermark is exactly `from`. */
  from: number
  /** Inclusive: the watermark once it has been applied. */
  to: number
  /** Compressed length, i.e. what crosses the wire. */
  bytes: number
  /** Decompressed length. */
  raw_bytes: number
  /** SHA-256 of the compressed bytes. */
  sha256: string
}

export interface Manifest {
  format: number
  schema: number
  /**
   * The head revision the data plane can bring a client to: the last delta's
   * `to`, or the snapshot's own revision when no delta has been published
   * since. Distinct from `snapshot.rev` as soon as one has (D-055).
   */
  rev: number
  /** Unix seconds. Drives the staleness indicator. */
  generated: number
  /** MITRE's notice, carried in-band with every copy (D-008). */
  notice: string
  snapshot: {
    path: string
    /**
     * The revision the snapshot itself is at, so a client can plan the
     * download *and* its catch-up before importing anything. The imported
     * database carries the same number in `meta.rev`, which is what the
     * watermark is actually read from (D-031) — this is the pre-download copy
     * of it, and a mismatch between the two means the publish was inconsistent.
     *
     * Optional because the generation published before D-055 does not have it,
     * and that manifest is still being served. Read it through `snapshotRev`,
     * which says so in the error rather than blaming the local database.
     */
    rev?: number
    raw_bytes: number
    chunk_bytes: number
    chunks: ChunkEntry[]
  }
  /** Every delta file the origin still serves, oldest first (D-055). */
  deltas: DeltaEntry[]
}

/**
 * The lookup tables a delta can carry rows for, in apply order: `vendor`
 * before `product` and `host` before `url`, because those reference them. The
 * tuples mirror `pipeline/schema.sql` column order exactly, which is what makes
 * apply a positional insert rather than a mapping step.
 */
export const LOOKUP_ORDER = ['cna', 'cwe', 'vendor', 'product', 'host', 'url', 'vtype'] as const

export type LookupTable = (typeof LOOKUP_ORDER)[number]

export interface DeltaLookups {
  /** `[id, name]` */
  cna: [number, string][]
  /** `[id, cwe, descr]` */
  cwe: [number, string, string][]
  /** `[id, name]` */
  vendor: [number, string][]
  /** `[id, vendor_id, name]` */
  product: [number, number, string][]
  /** `[id, name]` */
  host: [number, string][]
  /** `[id, url, host_id]` */
  url: [number, string, number][]
  /** `[id, name]` */
  vtype: [number, string][]
}

/**
 * `[cvss_ver, cvss_score, cvss_sev, cvss_vec]` — the *stored* codes (2, 30, 31,
 * 4 and 0–4), never the labels, and never comparable numerically (D-047).
 */
export type DeltaCvss = [number, number | null, number | null, string]

/**
 * `[ssvc_expl, ssvc_auto, ssvc_impact]` — the stored codes, each null when that
 * decision point was not assessed (D-070).
 *
 * A null here is *not* the same as a 0: `Exploitation: none` is someone having
 * looked and found no known exploitation, and null is the absence of the
 * assessment. The tuple is omitted entirely when all three are null.
 */
export type DeltaSsvc = [number | null, number | null, number | null]

/**
 * `[product_id, default_status]` — the container default that governs every
 * version the record does not list, or null when it states none (D-070).
 */
export type DeltaProduct = [number, number | null]

/** `[product_id, status, version, lessThan, lessThanOrEqual, vtype_id]`. */
export type DeltaVersion = [
  number,
  number,
  string | null,
  string | null,
  string | null,
  number | null,
]

/**
 * One record, whole (D-031): apply deletes the record's dependent rows and
 * inserts these, so absent means absent rather than unchanged.
 *
 * Keys are short because 665 of these ship every day and 62% of the payload is
 * already description text. Optional keys are omitted when empty.
 */
export interface DeltaRecord {
  /** `cve.id` — the server-owned, append-only row id (D-055). */
  id: number
  /** `cve.cve_id` — the canonical CVE ID, and the schema's UNIQUE key. */
  cve: string
  y: number
  st: number
  cna?: number | null
  /** Unix seconds, as stored. */
  pub?: number | null
  upd?: number | null
  /** `dateReserved`, unix seconds (D-070). */
  res?: number | null
  cvss?: DeltaCvss | null
  /** Omitted when no decision point was assessed (D-070). */
  ssvc?: DeltaSsvc | null
  /** English only (D-023); omitted when the record has none. */
  descr?: string
  /** `containers.cna.title` (D-070); omitted when the record has none. */
  title?: string
  /**
   * The first English `rejectedReasons[]` value (D-070) — the only English text
   * a REJECTED record carries, so a record can have this and no `descr`.
   */
  reason?: string
  cwe?: number[]
  prod?: DeltaProduct[]
  ref?: number[]
  ver?: DeltaVersion[]
}

/**
 * One delta file's contents, decompressed (D-031, D-055).
 *
 * `lookups` come before `upsert` because the upserts reference them, and
 * `delete` carries canonical CVE IDs rather than row ids so a tombstone is
 * readable and needs no ID-space agreement to act on.
 */
export interface Delta {
  format: number
  schema: number
  /** Exclusive lower bound; matches the manifest entry. */
  from: number
  /** Inclusive upper bound; the watermark after apply. */
  to: number
  /** Unix seconds, like the manifest's. */
  generated: number
  /** MITRE's notice, carried in-band with this copy too (D-008). */
  notice: string
  lookups: DeltaLookups
  upsert: DeltaRecord[]
  delete: string[]
}

/**
 * `query` covers both a single query and the benchmark. It exists because
 * D-052 requires anything past about a second to say what it is doing, and a
 * cold aggregate over the whole corpus takes seconds — silence there is
 * indistinguishable from a hang.
 */
export type Phase =
  | 'idle'
  | 'manifest'
  | 'download'
  | 'index'
  | 'verify'
  /** Fetching and applying catch-up deltas (D-031). */
  | 'sync'
  | 'query'
  /**
   * Writing an export (M4). Its own phase rather than `query`, because it is
   * the one long operation with a *countable* fraction — records written of
   * records matched — and D-052 §3 asks for progress wherever the work can be
   * counted rather than only for a spinner.
   */
  | 'export'
  | 'ready'
  | 'error'

export interface Progress {
  phase: Phase
  /** 0..1 within the current phase, or null when the phase is not measurable. */
  fraction: number | null
  detail: string
}

/** The two OPFS VFSes Q-004 chooses between. */
export type Vfs = 'opfs' | 'opfs-sahpool'

/** What Q-004 settled on (D-051); `opfs-sahpool` stays reachable for the sweep. */
export const DEFAULT_VFS: Vfs = 'opfs'

/** Chunks in flight during download. What Q-003 tuned (D-041, D-049). */
export const DEFAULT_CONCURRENCY = 4

/**
 * SQLite's page cache, in MiB. Every miss is an OPFS read, and the corpus is
 * 377 MB against a stock cache of 2 MB, so this is the single biggest lever on
 * query latency — measured, not guessed (D-050).
 */
export const DEFAULT_CACHE_MIB = 256

/**
 * Import knobs. All three have measured defaults; they are settable so the
 * sweep in `tests/e2e/measure.spec.ts` can reproduce the numbers behind
 * D-049 – D-051 rather than leaving them as a one-off claim in a doc.
 */
export interface ImportOptions {
  concurrency?: number
  vfs?: Vfs
  cacheMib?: number
  /**
   * Abort the download after this many chunks have landed *in this run*, as if
   * the network had died there.
   *
   * A test affordance, in the same spirit as the three knobs above and for the
   * same reason: staged replacement exists so that an interrupted download can
   * be resumed and cannot damage the live copy, and neither property can be
   * asserted without a way to interrupt one deterministically. A 63 MB download
   * over loopback finishes long before a test can race it.
   *
   * It is not a hazard worth guarding beyond the clamp: the worst a crafted
   * `?stop=1` link can do is make a download stop early, leaving the previous
   * database exactly where it was — which is the property under test.
   *
   * Zero and below mean "do not stop", which is what the name says; they are
   * not clamped up to 1, because a knob that aborts after one chunk when asked
   * to abort after none is a trap for the next caller.
   */
  stopAfterChunks?: number
  /**
   * How long a transfer may go without receiving a byte before it is reported
   * as stalled (D-052). Clamped by `stallTimeout` in `lib/stall.ts`.
   *
   * Settable for the same reason `stopAfterChunks` is: a stalled connection is
   * a state a test has to be able to produce, and waiting out the real
   * sixty-second default in every run would be a minute per assertion.
   */
  stallMs?: number
  /**
   * The schema version this build claims to speak, overriding `SCHEMA_VERSION`.
   *
   * A schema bump is the one failure mode nobody can rehearse: it needs two
   * client builds, one on each side of the change, and by the time it happens
   * for real every existing user meets it at once. This knob is how the
   * announcement and the refusals get exercised before then — `?schema=2`
   * against a schema-1 data plane puts this build in exactly the position the
   * next one will be in.
   *
   * It cannot destroy anything, which is what makes it safe to leave reachable
   * (unlike `?vfs=`): a copy of another schema is *kept*, announced, and
   * replaced only by a download the user starts, and a manifest of another
   * schema is refused before a byte is fetched. The worst a crafted `?schema=`
   * link does is tell someone their copy needs re-downloading when it does not.
   */
  schema?: number
  /**
   * Force the capability probe's verdict, for the gate's own tests (M5, D-016).
   *
   * The condition it stands in for is a browser this project does not own —
   * Safari 15.2–16.3, whose sync access handles are asynchronous — and the real
   * probe runs inside the Worker, where a page-level `addInitScript` cannot
   * reach it. So the *only* way to see what a user below the floor is told is
   * to say so from here.
   *
   * It can only make the gate **stricter**, never permissive: there is no value
   * that turns a failing capability into a passing one, so a crafted link can
   * cost someone a refusal they did not deserve and can never let an
   * unsupported browser through to an import that would fail deep inside WASM.
   */
  probe?: 'async' | 'unavailable'
  /**
   * Pretend the browser has this many bytes free, for the preflight's own test
   * (M5). Same reason and same constraint as `probe`: the preflight reads
   * `navigator.storage` inside the **Worker**, where a page-level override
   * cannot reach it (RE-020), and a smaller number can only *refuse* a download
   * — there is no value that makes one proceed that would not have anyway.
   */
  freeBytes?: number
  /**
   * Virtual-machine instructions between SQLite progress callbacks, overriding
   * `PROGRESS_OPS`. **Zero installs no handler at all**, which is the only way
   * to measure what the handler costs — and what the M3 sweep compares against
   * the M1 baseline, where there was none. A session with no handler cannot
   * cancel a query and cannot report one running, so this is a measurement
   * affordance and not a setting.
   */
  progressOps?: number
  /**
   * Collect query statistics (`ANALYZE`) at the end of an import. Default true;
   * `?analyze=0` imports without them, which is the M1 baseline this
   * milestone's tuning is measured against and the only way to re-run that
   * comparison later (M3).
   */
  analyze?: boolean
  /**
   * Whether the hosted query tier may stand in when there is no local copy
   * (D-084). Default true; `?remote=0` turns it off, which is how the
   * no-hosted fallback (the download pitch) is reached deterministically in a
   * test — and how a user who wants nothing sent to the server can say so in
   * a link. There is no value that widens anything: the tier is same-origin
   * and read-only whichever way this is set.
   */
  remote?: boolean
}

/**
 * What the UI asks the query layer for (M3).
 *
 * `filters` carries names rather than lookup ids, so the same object is what a
 * permalink and the chat layer's report definition will serialize (M4, D-044).
 * The Worker resolves the names against its own copy immediately before
 * compiling, and says which ones matched nothing.
 */
export interface SearchRequest {
  filters: Filters
  /** null or absent: the record list. A dimension: counts grouped by it. */
  groupBy?: Dimension | null
  sort?: SortKey
  limit?: number
  offset?: number
  /** Also run the `count(*)`, which a capped list cannot tell you. */
  count?: boolean
}

/**
 * What a report asks for (M4).
 *
 * The definition itself rather than a flattened copy of it: `lib/report.ts` is
 * the shared primitive (D-069), and re-deriving `rows`/`series`/`filters` into a
 * second message shape would give the permalink and the Worker two ideas of
 * what a report is. The Worker validates it again on arrival, because the page
 * may have built it from a URL fragment a stranger wrote.
 */
export interface ReportRequest {
  report: Report
  /** Also run `count(*)` under the same filters — what a capped cross-tab cannot say. */
  count?: boolean
}

/**
 * What an export asks for (M4).
 *
 * `records` streams the match set row by row; `cells` writes the report's own
 * cross-tab. Both carry the same definition, so an export is provably of the
 * thing on screen rather than of a second query built beside it.
 */
export interface ExportRequest {
  format: ExportFormat
  kind: 'records' | 'cells'
  report: Report
  /** What the file calls itself. The user's words, never rendered as markup. */
  title: string
}

/** One record, in full — the per-CVE detail view's payload (M4). */
export interface DetailRecord {
  cve: string
  state: number | null
  year: number | null
  published: number | null
  updated: number | null
  cvssVersion: number | null
  score: number | null
  severity: number | null
  vector: string | null
  cna: string | null
  /** Null when the record has no English description at all (4.46%, D-023). */
  description: string | null
  /** `containers.cna.title` (D-070). Null for the 63% that carry none. */
  title: string | null
  /**
   * Why a REJECTED identifier was withdrawn (D-070). Null for PUBLISHED
   * records, and the *only* English text the 17,842 REJECTED ones carry — which
   * is why they rendered blank until schema 2.
   */
  reason: string | null
  /** `dateReserved`, unix seconds. 100% coverage. */
  reserved: number | null
  /**
   * SSVC's decision points, as stored codes (D-070). **Null means nobody
   * assessed this**, which is not the same as `Exploitation: none`.
   */
  ssvcExpl: number | null
  ssvcAuto: number | null
  ssvcImpact: number | null
}

export interface DetailCwe {
  cwe: string
  descr: string
}

export interface DetailProduct {
  vendor: string
  product: string
  /**
   * `cve_prod.default_status`: the container default governing every version
   * the record does not list — 1 affected, 2 unaffected, 3 unknown, null when
   * the record states none (D-070).
   */
  defaultStatus: number | null
}

export interface DetailVersion {
  vendor: string
  product: string
  /** `cve_ver.status`: 1 affected, 2 unaffected, 3 unknown. */
  status: number | null
  version: string | null
  lt: string | null
  lte: string | null
  vtype: string | null
  /** The product's default, repeated per row so a row reads on its own (D-070). */
  defaultStatus: number | null
}

/** A reference as stored. Nothing decides here whether it may become a link. */
export interface DetailReference {
  url: string
  host: string
}

/**
 * This record's CISA KEV entry (M6, D-076).
 *
 * Null when the catalog does not list it **or** when this copy holds no
 * catalog, and the two are distinguished by `status.kev` rather than here: "not
 * known-exploited, per CISA" is a finding, and asserting it from a copy that
 * has never fetched a catalog would be inventing one.
 */
export interface DetailKev {
  /** `YYYY-MM-DD`, verbatim as CISA published them. */
  added: string
  due: string
  name: string
  description: string
  action: string
  /** 1 Known, 0 Unknown, null when CISA stated something this build does not read. */
  ransomware: number | null
  /** CISA's `notes`, a `;`-separated run of labelled URLs. Hostile until proven otherwise. */
  notes: string
  cwes: string[]
  vendor: string
  product: string
}

export interface CveDetail {
  record: DetailRecord
  cwes: DetailCwe[]
  products: DetailProduct[]
  versions: DetailVersion[]
  references: DetailReference[]
  /** Null when CISA does not list this record, or this copy has no catalog. */
  kev: DetailKev | null
  /** Sections whose per-section cap was reached, so the omission is reported (D-052). */
  truncated: string[]
  ms: number
}

/**
 * One validated tool call from the chat layer (M7, D-044).
 *
 * The *output* of `lib/tools.ts`'s validation, never a model's raw arguments —
 * by the time a value has this type it has been through a fixed vocabulary and,
 * for `aggregate`, through `parseReport`. The Worker validates again on arrival
 * for the same reason it re-validates a report: the page is not the last gate
 * before SQL, the Worker is.
 */
export type ToolCall =
  | { name: 'aggregate'; report: Report }
  | { name: 'search_records'; filters: Filters; sort?: SortKey; limit?: number }
  | { name: 'cve_detail'; cveId: string }
  | { name: 'kev_lookup'; cveId: string }
  | { name: 'sql'; sql: string }
  /**
   * JavaScript over the most recent result, in the page's sandbox (D-088) —
   * the one tool the Worker never sees: `page.tsx` routes it to
   * `lib/sandbox.ts` before the `tool` message would be sent.
   */
  | { name: 'compute'; code: string }

/**
 * The most recent result, whole (D-088): what `window.cveExplorer.last()`
 * returns and what the `compute` tool runs against. Every rows-producing
 * surface writes it — a canvas report or record list, a chat or agent
 * `aggregate` / `search_records` / `sql`, the SQL console — so "the last
 * query" means the last thing that ran, whoever ran it.
 */
export interface LastResult {
  /** What produced it: an aggregate, a record search, or SQL (tool or console). */
  source: 'aggregate' | 'records' | 'sql'
  columns: string[]
  /** Every row the query layer returned — bounded by its own caps, not the model's window. */
  rows: unknown[][]
  /** Records the filter matched, where the source counted them. */
  matches: number | null
  truncated: boolean
  sql: string
  /** The definition, for an aggregate or a record search. */
  report?: Report
  /** Unix milliseconds. */
  at: number
}

/**
 * What a tool did, as the Worker reports it.
 *
 * One shape carrying both audiences: the page renders `result`/`detail` through
 * the *same* components the Report and Explore tabs use, and
 * `describeToolResult` reduces this to the bounded structured text the model
 * sees. Splitting them into two messages would let the two drift, which is how
 * a model ends up describing something other than what is on screen.
 *
 * `refused` is a first-class outcome rather than an error: a KEV question asked
 * of a copy with no catalog, or a `SELECT` the authorizer stopped, is something
 * the model should be told so it can say so — not a failure of the chat turn
 * (D-077's rule, applied to the tool surface).
 */
export type ToolOutcome =
  | {
      kind: 'aggregate'
      report: Report
      result: QueryResult
      matches: number | null
      unmatched: Unmatched[]
    }
  | {
      kind: 'records'
      report: Report
      result: QueryResult
      matches: number | null
      unmatched: Unmatched[]
    }
  | { kind: 'detail'; cveId: string; detail: CveDetail | null }
  | {
      kind: 'kev'
      cveId: string
      kev: DetailKev | null
      catalog: KevStatus
      /**
       * Whether this copy holds the record at all.
       *
       * Separate from `kev`, because "CISA does not list it" and "this copy has
       * never heard of it" are different answers and only the first is a
       * finding — the same distinction D-077 draws one level up for a copy with
       * no catalog, and the same one `resolveAxis` draws for a vendor nobody
       * is called.
       */
      known: boolean
    }
  | {
      kind: 'compute'
      code: string
      ok: boolean
      /** The returned value as JSON text, clipped; null when it threw or returned nothing. */
      value: string | null
      error: string | null
      /** `console.log` lines the code wrote, bounded. */
      logs: string[]
      /** Wall-clock in the sandbox. */
      ms: number
      /** What it ran against. */
      input: { source: LastResult['source'] | null; rows: number; columns: string[] }
      /** The value was cut at the output cap. */
      truncated: boolean
    }
  | { kind: 'sql'; result: QueryResult }
  | { kind: 'refused'; tool: string; error: string }

export type Request =
  | { type: 'status'; options?: ImportOptions }
  /**
   * Hand the Worker the shared cancellation flag (lib/cancel.ts).
   *
   * A message rather than a Worker-created buffer because the page owns the
   * button. Sending it is optional: without one, queries run to completion and
   * the UI says cancellation is unavailable.
   *
   * It carries the session's query-time knobs for the same reason — this is the
   * one message the page sends before anything else happens.
   */
  | { type: 'control'; cancel: Int32Array; options?: ImportOptions }
  | { type: 'import'; options?: ImportOptions }
  /** Only `stallMs` is read here; the rest describe a download (D-052). */
  | { type: 'sync'; options?: ImportOptions }
  /** The built-in demo query — this build's own SQL, run without the authorizer. */
  | { type: 'query'; sql: string }
  /** Whatever the user typed. Runs under the authorizer and the row cap (M3). */
  | { type: 'console'; sql: string }
  | { type: 'search'; request: SearchRequest }
  /** A report definition, run as a one- or two-axis aggregate (M4, D-069). */
  | { type: 'report'; request: ReportRequest }
  /** One record in full, by canonical id (M4). */
  | { type: 'detail'; cveId: string }
  /** Stream an export, in batches, up to the disclosed cap (M4). */
  | { type: 'export'; request: ExportRequest }
  /**
   * Execute one validated tool call for the chat layer (M7).
   *
   * `id` is the model's own call id, echoed on the way back: a turn can issue
   * several calls and the loop has to pair each answer with the call it
   * answers, which a queue position cannot do once one of them is cancelled.
   */
  | { type: 'tool'; id: string; call: ToolCall }
  /**
   * The date extent of the copy that is answering (M9).
   *
   * Asked for once a tier is ready, and again after anything that can move it
   * — an import, a sync, a KEV refresh. It is what bounds the date controls:
   * a picker that offers 1970 over a corpus that starts in 1999 is offering
   * ranges whose only possible answer is an empty chart.
   */
  | { type: 'coverage' }
  /**
   * Every vendor and product name the answering copy holds, for the canvas
   * pickers (UI polish, 2026-08-16). Read once per state of the copy, like
   * `coverage`, and searched in memory on the page — never queried per
   * keystroke. Answered with `catalog: null` when it cannot be read.
   */
  | { type: 'catalog' }
  | { type: 'bench' }
  /**
   * What this browser can do and what its storage looks like (M5).
   *
   * Its own message rather than a field on `status`, because the two answer
   * different questions on different schedules: `status` is about the copy on
   * disk and is posted after every operation, while this is about the *browser*
   * — probed once, and re-read on demand when the diagnostics panel is open.
   */
  | { type: 'probe' }
  /**
   * Fetch the KEV catalog and rebuild the local overlay (M6).
   *
   * Its own request as well as a step at the end of Download and Sync, because
   * a refresh that failed has to be retryable without re-running either — and
   * because a copy imported before this build existed has no catalog at all.
   */
  | { type: 'kev'; options?: ImportOptions }
  /**
   * Probe the hosted query tier (D-084): read the server copy's `meta` — its
   * schema, revision, build stamp, notice and KEV catalog — and answer with
   * `hostedStatus`. Sent by the page when `status` reports no usable local
   * copy; a success is what licenses the Worker to serve queries remotely.
   */
  | { type: 'hosted'; options?: ImportOptions }
  | { type: 'reset' }

/**
 * What a catch-up did, summed across the chain it applied (M2).
 *
 * `from === to` with `applied: 0` is the ordinary answer on most days: the copy
 * was already at head and nothing was fetched. That is a *result*, not a
 * no-op — it is how a client learns it is current — so it is reported like one.
 */
export interface SyncOutcome {
  /** The local watermark before and after. */
  from: number
  to: number
  /** Delta files applied. Each one was its own transaction. */
  applied: number
  /** Records replaced and records tombstoned, summed across those files. */
  upserts: number
  /**
   * How many of those records are CVEs this copy did not hold before — the
   * "N new CVEs since your last sync" number the UI reports. A subset of
   * `upserts`; the remainder are revisions of records already here.
   */
  inserts: number
  deletes: number
  /** Compressed bytes that crossed the wire. */
  bytes: number
  /** Wall-clock in the Worker, fetch and apply together. */
  ms: number
}

/**
 * How far the copy that is answering actually reaches, per date axis (M9).
 *
 * Every field is unix seconds, or null where the copy holds nothing to measure
 * — an empty axis, or a copy with no KEV catalog. Null is a real answer here
 * and not an error: the date control simply goes unbounded on that axis, which
 * is where it was before this message existed.
 *
 * Read from the database rather than from the manifest on purpose. The
 * manifest describes the *generation*; this describes the rows this reader can
 * actually query, which after a partial slice or a hosted copy is not the same
 * claim.
 */
export interface Coverage {
  publishedMin: number | null
  publishedMax: number | null
  updatedMin: number | null
  updatedMax: number | null
  /** The identifier year, which is not the publication year (D-044's rename). */
  yearMin: number | null
  yearMax: number | null
  /** CISA's own dates, present only when this copy holds a catalog (M6). */
  kevAddedMin: number | null
  kevAddedMax: number | null
  kevDueMin: number | null
  kevDueMax: number | null
}

/** One result set, whatever asked for it. */
export interface QueryResult {
  columns: string[]
  rows: unknown[][]
  /** Wall-clock inside the Worker, SQLite only. */
  ms: number
  /**
   * The row cap stopped it. Reported rather than left implicit: a capped result
   * that looks complete is the same quiet wrongness as a missing state
   * predicate (D-022).
   */
  truncated: boolean
  /**
   * Truncation was by *size*, not by row count (M7).
   *
   * A distinct signal because the two call for different sentences. "Capped at
   * 1,000 rows" is an ordinary answer to a broad query; "this result was too
   * large to hold" means the query produced values a page cannot render — one
   * row of `group_concat` over the whole corpus — and the fix is to narrow the
   * columns rather than to add a `LIMIT`. Absent when the row cap did it.
   */
  overflowed?: boolean
  /**
   * The SQL that ran and the values bound into it, so a number on screen can
   * always be traced to a query. This is the deterministic half of the
   * "backing queries are inspectable" property the chat layer will need (D-044).
   */
  sql: string
  params: (string | number)[]
}

/** A filter value that named nothing in this copy — a typo, not an empty result. */
export interface Unmatched {
  axis: string
  values: string[]
}

export type Response =
  | { type: 'progress'; progress: Progress }
  /**
   * `notice` is MITRE's, read back out of the database's `meta` table. It rides
   * on status rather than only on `imported` because D-008 requires every copy
   * of CVE data to carry it — including the copy a returning visitor is
   * querying, whose page never saw an `imported` message (RE: the reload path).
   */
  | {
      type: 'status'
      ready: boolean
      /**
       * What the Worker actually established about local storage.
       *
       * `ready` cannot carry this: it is false both for "there is no local
       * copy" and for "I could not find out", and the two call for opposite
       * responses — the first is an invitation to download, the second must not
       * clear the panels or claim the copy is gone, because it may not be
       * (D-061).
       *
       * `obsolete` is the fourth answer and the one a schema bump produces: a
       * complete local copy of a version this build cannot read. It is not
       * `empty` — there is a database, it is just not queryable — and not
       * `unknown`, because we know exactly what it is (M3).
       */
      storage: 'ready' | 'empty' | 'unknown' | 'obsolete'
      rev: number | null
      generated: number | null
      notice: string | null
      /** `meta.schema` of the copy on disk, when one was read. */
      localSchema: number | null
      /** The schema version this build speaks — `SCHEMA_VERSION`, or the override. */
      schema: number
      /**
       * The KEV catalog this copy holds, or null when it holds none (M6).
       *
       * Rides on `status` for the same reason `notice` does: it is a property
       * of the copy on disk, read back out of `meta`, and a returning visitor's
       * page never saw the fetch that wrote it. Which is also what makes the
       * freshness line honest offline — nothing here is a network request.
       */
      kev: KevStatus | null
    }
  /**
   * The capability gate's verdict and the storage picture behind it (M5,
   * D-016). Posted unprompted once the Worker starts, so the gate is on screen
   * before the Download button can be pressed, and again for every `probe`.
   */
  | { type: 'environment'; capabilities: CapabilityReport; storage: StorageReport }
  | { type: 'imported'; timings: Timings; notice: string }
  | { type: 'synced'; outcome: SyncOutcome }
  /**
   * What a KEV refresh did (M6).
   *
   * Its own message rather than an error, because a KEV failure is **not** a
   * failure of the operation that triggered it: a download that fetched 372,322
   * records and then could not reach `kev.json` has downloaded the corpus. So
   * the corpus operation reports success, this reports what happened to the
   * overlay, and the page shows it as a warning beside a copy that still works.
   *
   * `kev` is the catalog now in the local copy — the *previous* one when this
   * refresh failed, which is what "the old catalog stays and its age is
   * reported" means.
   */
  | {
      type: 'kev'
      kev: KevStatus | null
      /** Null on success. A sentence, not a stack trace. */
      error: string | null
      /** How many entries were applied, when one was. */
      applied: number | null
      ms: number
    }
  | {
      type: 'result'
      /** Which surface asked, so the page renders it in the right place. */
      kind: QueryKind
      result: QueryResult
      /** `count(*)` under the same filters, when the request asked for it. */
      matches?: number | null
      /** Filter values that named nothing, so a typo does not read as "no CVEs". */
      unmatched?: Unmatched[]
      /** Present on a grouped search: which dimension the buckets are. */
      groupBy?: Dimension | null
      /** The effective record-state scope used for this answer. */
      state?: StateFilter
      /**
       * The definition this answer is of, echoed back (M4).
       *
       * Echoed rather than read from the page's current state, because the two
       * drift the moment someone edits the builder while a query is running —
       * and a chart labelled with axes it was not grouped by is the quiet
       * wrongness vision criterion 7 rules out.
       */
      report?: Report
    }
  /** One record in full (M4). `detail` is null when no record carries that id. */
  | { type: 'detail'; cveId: string; detail: CveDetail | null }
  /** What one chat tool call produced (M7), paired with the call by `id`. */
  | { type: 'toolResult'; id: string; outcome: ToolOutcome; ms: number }
  /**
   * One serialized batch of an export, in order (M4).
   *
   * The Worker never holds the whole file and neither does this message: the
   * page appends each chunk to a `Blob` part list, so peak memory is a batch on
   * both sides.
   */
  | { type: 'exportChunk'; text: string }
  | {
      type: 'exported'
      filename: string
      mime: string
      /** Records actually written. */
      records: number
      /** Records that matched, when counted — which may be more than were written. */
      matches: number | null
      /** The cap stopped it short, and the file says so too. */
      truncated: boolean
      ms: number
    }
  /**
   * The user stopped a running query (M3). A result, not an error: nothing is
   * wrong, and the page must not show it in red next to a stack of failures.
   */
  | { type: 'cancelled'; kind: QueryKind; ms: number }
  /**
   * What the hosted tier probe found (D-084).
   *
   * On `ok`, the fields mirror `status`'s — they describe the *server's* copy,
   * read from its `meta` the same way `status` reads the local one — and the
   * Worker will now answer query requests remotely until a local copy opens.
   * On failure the page falls back to the download pitch: a visitor the
   * hosted tier cannot serve is exactly where the old landing gate stood.
   */
  | {
      type: 'hostedStatus'
      ok: boolean
      /** Present on failure. A sentence, not a stack trace. */
      error?: string
      rev?: number | null
      generated?: number | null
      notice?: string | null
      kev?: KevStatus | null
    }
  | { type: 'coverage'; coverage: Coverage }
  | { type: 'catalog'; catalog: Catalog | null }
  | { type: 'bench'; results: BenchResult[]; wasmHeapBytes: number }
  | {
      type: 'error'
      message: string
      /** Present when the failed request belonged to a query surface. */
      kind?: QueryKind
    }

/**
 * Which surface a query, a cancellation or a failure belongs to.
 *
 * One union rather than three copies: M4 added three surfaces, and the page
 * routes every one of these messages by this field — a kind that exists in one
 * union and not another is a message rendered in the wrong panel or nowhere.
 */
export type QueryKind = 'demo' | 'console' | 'search' | 'report' | 'detail' | 'export' | 'tool'

/** One benchmark query's outcome. `ms` is wall-clock inside the Worker. */
export interface BenchResult {
  name: string
  ms: number
  rows: number
}

/**
 * Q-003's numbers, reported by the Worker rather than inferred from the UI.
 *
 * `writeMs` covers everything the staged writer does — the truncate, the
 * positional writes, a `flush()` per chunk, and persisting the resume bitmap
 * after each one (D-061). It is therefore not comparable with a pre-D-061
 * reading, which flushed once for the whole download.
 *
 * fetchMs / decompressMs / writeMs are *cumulative per-chunk time* summed
 * across chunks that run concurrently — they measure work, not elapsed time,
 * and their sum exceeds wall-clock whenever `concurrency` is above 1. totalMs
 * (and openMs / indexMs, which are serial) are wall-clock. Compare like with
 * like: a throttled run at concurrency 8 reports 61 s of fetch inside a 78 s
 * import, and both numbers are correct.
 */
export interface Timings {
  fetchMs: number
  /** SHA-256 verification of the compressed bytes — its own cost, not decompression. */
  digestMs: number
  decompressMs: number
  writeMs: number
  openMs: number
  indexMs: number
  /**
   * Verifying the staged copy, promoting it, and sweeping what it replaced
   * (D-061). Serial wall-clock, like `openMs` and `indexMs`.
   *
   * Reported separately because it is otherwise invisible: it lands between the
   * stages the measurement sweep already stamps, so `total - index - open`
   * silently absorbed it and reported it as transport.
   */
  verifyMs: number
  totalMs: number
  compressedBytes: number
  rawBytes: number
  records: number
  /** Chunks in the snapshot, and how many this run actually had to fetch. */
  chunksTotal: number
  /**
   * Fewer than `chunksTotal` means the run resumed a staged download and
   * skipped what was already on disk (D-061). `compressedBytes` still reports
   * the whole snapshot, so the two together say what a resume was worth.
   */
  chunksFetched: number
  /** The settings this run used, so a recorded number is never ambiguous. */
  vfs: Vfs
  concurrency: number
  cacheMib: number
  /**
   * Everything the origin holds in OPFS afterwards, summed by walking it —
   * `null` if the walk failed, which must stay distinguishable from an origin
   * that really holds nothing.
   */
  opfsBytes: number | null
  /** `navigator.storage.estimate().usage` — quota accounting, not file bytes. */
  storageBytes: number | null
  /**
   * SQLite's WASM linear memory at the end of import. Queries can grow it
   * further, so the benchmark reports its own reading rather than reusing this
   * one — a page-cache claim made from this number alone would be about index
   * building, not about querying.
   */
  wasmHeapBytes: number
}

export function manifestUrl(): string {
  return `${DATA_ROOT}/manifest.json`
}

/**
 * Both halves are checked against the shapes `pipeline/publish.py` writes
 * (`snapshot-<rev>` and `NNN.br`) rather than pasted in, so that "no string out
 * of the manifest reaches a request path" is true of the whole data plane and
 * not only of deltas — a `path` of `../..` would otherwise walk straight out of
 * `/data/`.
 */
export function chunkUrl(manifest: Manifest, chunk: ChunkEntry): string {
  const path = manifest.snapshot?.path
  if (typeof path !== 'string' || !/^snapshot-\d+$/.test(path)) {
    throw new Error(`manifest names a snapshot directory this build will not fetch: ${path}`)
  }
  if (typeof chunk?.name !== 'string' || !/^\d+\.br$/.test(chunk.name)) {
    throw new Error(`manifest names a chunk this build will not fetch: ${chunk?.name}`)
  }
  return `${DATA_ROOT}/${path}/${chunk.name}`
}

/**
 * The snapshot's own revision, or a refusal that names the real problem.
 *
 * The generation published before D-055 has no `snapshot.rev`, and the sync
 * path needs it: without this, `planSync(manifest, manifest.snapshot.rev)`
 * reports "local watermark undefined is not a revision", which blames the
 * database for a missing manifest field.
 */
export function snapshotRev(manifest: Manifest): number {
  const rev = manifest.snapshot?.rev
  if (!isRevision(rev)) {
    throw new Error(
      'manifest predates the delta contract (no snapshot.rev): the origin must republish ' +
        'before this copy can sync'
    )
  }
  return rev
}

/** A revision number we are willing to act on: a non-negative safe integer. */
export function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Structural check on one manifest delta entry. Separate from `assertUsable`
 * on purpose: a broken delta list must not stop a fresh client from
 * downloading the corpus, so this runs on the sync path and fails there.
 */
export function assertDeltaEntry(entry: DeltaEntry): void {
  if (!isRevision(entry?.from) || !isRevision(entry?.to)) {
    throw new Error('delta entry: from/to must be non-negative integers')
  }
  if (entry.to <= entry.from) {
    throw new Error(`delta entry ${entry.from}-${entry.to}: to must be greater than from`)
  }
  if (!isRevision(entry.bytes) || !isRevision(entry.raw_bytes)) {
    throw new Error(`delta entry ${entry.from}-${entry.to}: byte counts must be integers`)
  }
  if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
    throw new Error(`delta entry ${entry.from}-${entry.to}: sha256 must be 64 hex characters`)
  }
}

/**
 * Built from the revision numbers, never from a name in the manifest — the
 * numbers are checked integers, so there is no string here that could carry a
 * path segment (D-055).
 */
export function deltaUrl(entry: DeltaEntry): string {
  assertDeltaEntry(entry)
  return `${DATA_ROOT}/deltas/${entry.from}-${entry.to}.json.br`
}

/**
 * Which delta files carry a database at `watermark` up to the manifest's head,
 * in apply order.
 *
 * `[]` means already current; `null` means no covering chain exists and the
 * only honest option left is a full re-download.
 *
 * The search is a breadth-first walk, not a greedy longest-first one, so it
 * finds the fewest-files chain whenever any chain exists. Greedy was wrong for
 * exactly the case that motivated it: given 1→3, 1→2 and 2→4 with head 4, it
 * takes the longest first hop, dead-ends at 3, and reports "re-download 63 MB"
 * while a two-file chain sits there. Today's pipeline emits one file per
 * revision so no chain has a choice to make (D-042) — this is what makes the
 * rollup claim in D-055 true if one ever does.
 *
 * Inconsistencies in the manifest itself throw rather than quietly degrading
 * into a re-download: a delta above the head revision, or a local watermark
 * ahead of the origin, means the publisher (or a cache) is serving something
 * incoherent, and silently downloading 63 MB would hide it. A client that is
 * already current returns first, so the daily "anything new?" check is not the
 * thing that surfaces a malformed entry it would never have fetched.
 */
export function planSync(manifest: Manifest, watermark: number): DeltaEntry[] | null {
  if (!isRevision(manifest?.rev)) throw new Error('manifest carries no usable head revision')
  if (!isRevision(watermark)) throw new Error(`local watermark ${watermark} is not a revision`)
  const head = manifest.rev
  if (watermark > head) {
    throw new Error(`local copy is at rev ${watermark}, ahead of the origin's ${head}`)
  }
  if (watermark === head) return []

  const entries = manifest.deltas ?? []
  if (!Array.isArray(entries))
    throw new Error('manifest lists deltas as something other than a list')
  for (const entry of entries) {
    assertDeltaEntry(entry)
    if (entry.to > head) {
      throw new Error(`delta ${entry.from}-${entry.to} is above the head revision ${head}`)
    }
  }

  // Breadth-first over revisions, so the first time `head` is reached it is by
  // a chain of the fewest files. `to > from` is asserted above, so every edge
  // moves forward and the visited set cannot cycle.
  const queue: { at: number; chain: DeltaEntry[] }[] = [{ at: watermark, chain: [] }]
  const seen = new Set<number>([watermark])
  while (queue.length > 0) {
    const { at, chain } = queue.shift()!
    // Longest hop first, as a tie-break only: among chains of the same length
    // it prefers the one that gets furthest per file. That is a stable choice,
    // not a smaller download — nothing here compares `bytes`.
    const next = entries.filter((entry) => entry.from === at).sort((a, b) => b.to - a.to)
    for (const entry of next) {
      if (entry.to === head) return [...chain, entry]
      if (seen.has(entry.to)) continue
      seen.add(entry.to)
      queue.push({ at: entry.to, chain: [...chain, entry] })
    }
  }
  return null
}

/**
 * Reject a manifest we cannot honestly consume before acting on any of it.
 *
 * The schema clause is the *other* half of a bump, and it says something
 * different from the local-copy half. A published schema this build does not
 * speak is not a re-download — re-downloading fetches the same bytes and fails
 * the same way — it means the app is older than the data plane, and the fix is
 * to load the app again. The origin serves HTML `no-cache` for exactly this
 * (D-054), so saying "reload" is actionable rather than a shrug (M3).
 *
 * @param speaks the schema version this build reads; overridable so the bump
 * can be exercised before it happens (`ImportOptions.schema`).
 */
export function assertUsable(manifest: Manifest, speaks: number = SCHEMA_VERSION): void {
  if (manifest.format !== FORMAT_VERSION) {
    throw new Error(`unsupported wire format ${manifest.format} (expected ${FORMAT_VERSION})`)
  }
  if (manifest.schema !== speaks) {
    throw new Error(
      `the published data is at schema ${manifest.schema} and this app reads schema ${speaks} — ` +
        'reload the page to pick up the matching version of the app. Your local copy is untouched.'
    )
  }
  if (!manifest.snapshot?.chunks?.length) {
    throw new Error('manifest lists no snapshot chunks')
  }
}
