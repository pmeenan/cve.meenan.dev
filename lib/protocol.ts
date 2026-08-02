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

export interface Manifest {
  format: number
  schema: number
  rev: number
  /** Unix seconds. Drives the staleness indicator. */
  generated: number
  /** MITRE's notice, carried in-band with every copy (D-008). */
  notice: string
  snapshot: {
    path: string
    raw_bytes: number
    chunk_bytes: number
    chunks: ChunkEntry[]
  }
  /** Typed by M2's first task (the delta wire contract); empty until then. */
  deltas: unknown[]
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

export function chunkUrl(manifest: Manifest, chunk: ChunkEntry): string {
  return `${DATA_ROOT}/${manifest.snapshot.path}/${chunk.name}`
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
