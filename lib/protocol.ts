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
  deltas: unknown[]
}

export type Phase = 'idle' | 'manifest' | 'download' | 'index' | 'ready' | 'error'

export interface Progress {
  phase: Phase
  /** 0..1 within the current phase, or null when the phase is not measurable. */
  fraction: number | null
  detail: string
}

export type Request =
  { type: 'status' } | { type: 'import' } | { type: 'query'; sql: string } | { type: 'reset' }

export type Response =
  | { type: 'progress'; progress: Progress }
  | { type: 'status'; ready: boolean; rev: number | null; generated: number | null }
  | { type: 'imported'; timings: Timings; notice: string }
  | { type: 'rows'; columns: string[]; rows: unknown[][]; ms: number }
  | { type: 'error'; message: string }

/** Q-003's numbers, reported by the Worker rather than inferred from the UI. */
export interface Timings {
  fetchMs: number
  decompressMs: number
  writeMs: number
  openMs: number
  indexMs: number
  totalMs: number
  compressedBytes: number
  rawBytes: number
  records: number
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
