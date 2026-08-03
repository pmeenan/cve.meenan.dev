/**
 * The published contract and the Worker message protocol.
 *
 * The manifest is the boundary between the Python pipeline (D-043) and this
 * application, so these types are the thing a test can hold onto when the two
 * drift.
 */

export const SCHEMA_VERSION = 1
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
  cvss?: DeltaCvss | null
  /** English only (D-023); omitted when the record has none. */
  descr?: string
  cwe?: number[]
  prod?: number[]
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
export type Phase = 'idle' | 'manifest' | 'download' | 'index' | 'query' | 'ready' | 'error'

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
}

export type Request =
  | { type: 'status' }
  | { type: 'import'; options?: ImportOptions }
  | { type: 'query'; sql: string }
  | { type: 'bench' }
  | { type: 'reset' }

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
      rev: number | null
      generated: number | null
      notice: string | null
    }
  | { type: 'imported'; timings: Timings; notice: string }
  | { type: 'rows'; columns: string[]; rows: unknown[][]; ms: number }
  | { type: 'bench'; results: BenchResult[]; wasmHeapBytes: number }
  | { type: 'error'; message: string }

/** One benchmark query's outcome. `ms` is wall-clock inside the Worker. */
export interface BenchResult {
  name: string
  ms: number
  rows: number
}

/**
 * Q-003's numbers, reported by the Worker rather than inferred from the UI.
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
  totalMs: number
  compressedBytes: number
  rawBytes: number
  records: number
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

/** Reject a manifest we cannot honestly consume before acting on any of it. */
export function assertUsable(manifest: Manifest): void {
  if (manifest.format !== FORMAT_VERSION) {
    throw new Error(`unsupported wire format ${manifest.format} (expected ${FORMAT_VERSION})`)
  }
  if (manifest.schema !== SCHEMA_VERSION) {
    throw new Error(
      `schema ${manifest.schema} needs a full re-download (this build speaks ${SCHEMA_VERSION})`
    )
  }
  if (!manifest.snapshot?.chunks?.length) {
    throw new Error('manifest lists no snapshot chunks')
  }
}
