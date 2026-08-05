/// <reference lib="webworker" />
/**
 * The Worker that owns the database.
 *
 * It owns it because OPFS synchronous access handles are unavailable on the
 * main thread (D-004), which makes every query asynchronous from the UI's
 * point of view regardless of framework.
 *
 * The import path is fetch -> decompress -> positional write over a window of
 * four chunks, so peak memory is bounded by chunks in flight rather than by the
 * corpus (D-040, D-041, D-049). Nothing here sends a request parameter: the
 * manifest names every file (D-032).
 *
 * Those writes go into a *staging* file, and the live database is not closed,
 * truncated or deleted until the staged copy has been verified and promoted
 * (D-061). M1 wrote straight into the live file, which meant a failed download
 * cost the user the copy they already had.
 */
import initBrotli, { decompress as brotliDecompress } from 'brotli-dec-wasm/web'
import type { Database, SAHPoolUtil, Sqlite3Static, SqlValue } from '@sqlite.org/sqlite-wasm'

import { authorize, AUTH_DENY, AUTH_OK, CONSOLE_ROW_LIMIT } from '../lib/authorizer'
import {
  armCancel,
  cancelRequested,
  elapsedLabel,
  isInterrupt,
  PROGRESS_OPS,
  QUERY_QUIET_MS,
  QUERY_REPORT_MS,
} from '../lib/cancel'
import { parseDelta } from '../lib/delta'
import {
  countSql,
  groupSql,
  lookupKey,
  LOOKUP_AXES,
  LOOKUP_SQL,
  rowsSql,
  ROW_LIMIT,
  type Filters,
  type LookupAxis,
  type Resolved,
  type SqlParam,
} from '../lib/filters'
import { isNotFound, readTextEntry, removeIfPresent, writeFully, writeTextEntry } from '../lib/opfs'
import { BENCH_QUERIES } from '../lib/queries'
import {
  ANALYZE_SHARE,
  batchRanges,
  indexBatches,
  indexPlan,
  indexSql,
  type SearchIndex,
} from '../lib/search'
import { stallError, stallTimeout, watchForStalls, type StallWatch } from '../lib/stall'
import { applyDelta, type SyncDb } from '../lib/sync'
import {
  assertLocallyUsable,
  assertPromotable,
  assertPromotionCompleted,
  bindsTo,
  classifyCandidate,
  chooseStagingFile,
  completed,
  isOurEntry,
  isSidecarOf,
  newRecord,
  parseStagingRecord,
  pendingChunks,
  stagingPlan,
  LEGACY_DB_FILE,
  SLOT_FILES,
  REQUIRED_TABLES,
  STAGING_RECORD_FILE,
  type Candidate,
  type SlotFile,
  type StagedMeta,
  type StagingPlan,
  type StagingRecord,
} from '../lib/staging'
import {
  assertUsable,
  chunkUrl,
  deltaUrl,
  isRevision,
  manifestUrl,
  planSync,
  DEFAULT_CACHE_MIB,
  DEFAULT_CONCURRENCY,
  DEFAULT_VFS,
  SCHEMA_VERSION,
  type BenchResult,
  type ChunkEntry,
  type Delta,
  type DeltaEntry,
  type ImportOptions,
  type Manifest,
  type Progress,
  type QueryResult,
  type Request,
  // Aliased so `Response` still means the platform's here: this module is
  // mostly fetch code, and shadowing the global in a file that reads response
  // bodies is a trap.
  type Response as WorkerMessage,
  type SearchRequest,
  type SyncOutcome,
  type Timings,
  type Unmatched,
  type Vfs,
} from '../lib/protocol'

/**
 * The name the `opfs-sahpool` path imports to, inside the pool's own opaque
 * namespace — unrelated to the OPFS entry of the same name that M1 wrote, and
 * kept because renaming it would orphan any pool database already on disk.
 *
 * The `opfs` path's file names live in lib/staging.ts: which of them is live is
 * a staged-replacement question, not a constant (D-061).
 */
const POOL_DB_FILE = 'cve.sqlite'

let sqlite3: Sqlite3Static | null = null
let db: Database | null = null
/** Installed lazily: it costs a directory of pre-opened handles (Q-004). */
let sahPool: SAHPoolUtil | null = null
/**
 * Which OPFS entry the open `db` is reading, so a promotion knows what to close
 * and what to sweep. Null while nothing is open, and always null on the pool
 * path, whose files are not OPFS entries we can name.
 */
let liveFile: string | null = null
/**
 * The page's cancellation flag, shared memory rather than a message, because
 * the message queue does not turn while SQLite is running (lib/cancel.ts).
 * Null until the page sends one, and on a browser that has no
 * `SharedArrayBuffer` it stays null and queries simply run to completion.
 */
let cancelFlag: Int32Array | null = null
/**
 * How many VDBE instructions between progress callbacks, for this session. The
 * measurement sweep sets it to 0 to run a query with no handler installed at
 * all, which is how the handler's own cost is priced (M3).
 */
let progressOps = PROGRESS_OPS

function post(message: WorkerMessage): void {
  ;(self as DedicatedWorkerGlobalScope).postMessage(message)
}

function report(phase: Progress['phase'], fraction: number | null, detail: string): void {
  post({ type: 'progress', progress: { phase, fraction, detail } })
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory()
}

/** Hex SHA-256, so a corrupted chunk costs one refetch rather than the download. */
async function digest(bytes: Uint8Array): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * The manifest is small, but it is still part of both transfer paths. Reading
 * it through `response.json()` would give the stall watch no beats until the
 * whole body arrived, so a connection delivering it slowly but continuously
 * would be reported as stalled after sixty seconds. Stream it for the same
 * reason chunks and deltas are streamed, with a generous bound so the one
 * response whose length is not declared by the manifest cannot grow without
 * limit.
 */
const MAX_MANIFEST_BYTES = 1_048_576

async function readManifest(response: Response, beat: () => void): Promise<Manifest> {
  const body = response.body
  if (!body) return (await response.json()) as Manifest

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let json = ''
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    // An empty stream chunk is not forward progress: the policy is explicitly
    // about bytes received, not callbacks delivered.
    if (value.length === 0) continue
    received += value.length
    if (received > MAX_MANIFEST_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`manifest: exceeds the ${MAX_MANIFEST_BYTES} byte client limit`)
    }
    json += decoder.decode(value, { stream: true })
    beat()
  }
  json += decoder.decode()
  return JSON.parse(json) as Manifest
}

async function fetchManifest(
  signal?: AbortSignal,
  beat: () => void = () => undefined
): Promise<Manifest> {
  const response = await fetch(manifestUrl(), { cache: 'no-cache', signal })
  if (!response.ok) throw new Error(`manifest: HTTP ${response.status}`)
  const manifest = await readManifest(response, beat)
  // The schema this session speaks, so a bump can be exercised before it
  // happens (M3). A manifest at another schema is refused here, before a byte
  // of it is acted on and with the local copy untouched.
  assertUsable(manifest, sessionSchema)
  return manifest
}

/**
 * Read a response body into a buffer of exactly the length the manifest
 * declared, beating the stall watch as bytes arrive.
 *
 * Two things come out of reading the stream rather than calling
 * `arrayBuffer()`. The stall watch gets a signal per network read instead of
 * one per 5 MB chunk, which is what makes "stopped receiving data" a question
 * about bytes rather than about whole files (D-052). And the buffer is
 * allocated once, at the published length, so a response that runs long is
 * refused at the byte that overruns instead of growing a buffer for it — the
 * memory bound D-040/D-041 imposes is over *our* accounting, and a body whose
 * length nobody checked is outside it.
 *
 * The length itself is a check the M1 path never made: a short body would have
 * failed its SHA-256 anyway, but it would have failed it after decompressing
 * whatever arrived, and the error would have named a checksum rather than a
 * truncated download.
 */
async function readBody(
  response: Response,
  expected: number,
  label: string,
  beat: () => void
): Promise<Uint8Array> {
  if (!isRevision(expected) || expected === 0) {
    throw new Error(`${label}: the manifest declares an unusable compressed length ${expected}`)
  }
  const body = response.body
  if (!body) {
    // No stream to read (a body already buffered by the platform). The length
    // is still checked, which is the part that matters.
    const whole = new Uint8Array(await response.arrayBuffer())
    beat()
    if (whole.length !== expected) {
      throw new Error(`${label}: manifest says ${expected} bytes, got ${whole.length}`)
    }
    return whole
  }

  const out = new Uint8Array(expected)
  const reader = body.getReader()
  let at = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value.length === 0) continue
    if (at + value.length > expected) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`${label}: server sent more than the ${expected} bytes the manifest declares`)
    }
    out.set(value, at)
    at += value.length
    beat()
  }
  if (at !== expected) {
    throw new Error(`${label}: manifest says ${expected} bytes, got ${at}`)
  }
  return out
}

interface ChunkResult {
  chunk: ChunkEntry
  bytes: Uint8Array
  fetchMs: number
  digestMs: number
  decompressMs: number
}

async function loadChunk(
  manifest: Manifest,
  chunk: ChunkEntry,
  signal: AbortSignal,
  beat: () => void
): Promise<ChunkResult> {
  const started = performance.now()
  // No Content-Encoding on these: they are opaque bytes and we decode them
  // ourselves, so progress and resume both count the bytes that crossed the
  // wire (D-040).
  const response = await fetch(chunkUrl(manifest, chunk), { signal })
  if (!response.ok) throw new Error(`${chunk.name}: HTTP ${response.status}`)
  const compressed = await readBody(response, chunk.bytes, chunk.name, beat)
  const fetched = performance.now()

  const actual = await digest(compressed)
  // Stamped separately: verifying 62.7 MB of SHA-256 is not decompression, and
  // folding it into decompressMs would publish a number under the wrong name.
  const digested = performance.now()
  if (actual !== chunk.sha256) {
    throw new Error(`${chunk.name}: checksum mismatch`)
  }

  const bytes = brotliDecompress(compressed)
  // Decompressing 5 MB is a synchronous block, so nothing has been able to
  // report progress for its duration: beat before the next await rather than
  // let the first tick after it measure the decode as idle time.
  beat()
  const decompressed = performance.now()

  if (bytes.length !== chunk.raw_bytes) {
    throw new Error(`${chunk.name}: expected ${chunk.raw_bytes} bytes, got ${bytes.length}`)
  }

  return {
    chunk,
    bytes,
    fetchMs: fetched - started,
    digestMs: digested - fetched,
    decompressMs: decompressed - digested,
  }
}

/**
 * Yield chunks in file order, keeping at most `limit` fetches in flight.
 *
 * Peak memory is that window plus the one chunk the consumer is writing —
 * `limit + 1` buffers, 160 MB at the default, not the corpus (D-040, D-041,
 * D-049). Note that a slot holds a *resolved* chunk until it is consumed, so
 * while one chunk straggles the others finish and sit; that is deliberate,
 * because starting replacements would be exactly the unbounded growth the
 * window exists to prevent.
 *
 * Ordering is a property of *this loader*, not of the format — every chunk
 * still carries its own absolute offset, so a resumed download is still just
 * "which offsets are done" (M2). It is ordered because `SAHPoolUtil.importDb`
 * can only be fed sequentially, and Q-004 is only a fair comparison if both
 * VFSes are driven by the same loader.
 */
async function* orderedChunks(
  manifest: Manifest,
  chunks: ChunkEntry[],
  limit: number,
  signal: AbortSignal,
  beat: () => void
): AsyncGenerator<ChunkResult> {
  const inFlight = new Map<number, Promise<ChunkResult>>()
  let started = 0
  const fill = () => {
    while (inFlight.size < limit && started < chunks.length) {
      const index = started++
      const pending = loadChunk(manifest, chunks[index]!, signal, beat)
      // When one chunk fails, the consumer stops pulling and the rest of the
      // window is abandoned mid-flight. This marks those as handled so a
      // second failure is not reported as an unhandled rejection on top of the
      // real error; whoever awaits a promise still sees its rejection.
      pending.catch(() => undefined)
      inFlight.set(index, pending)
    }
  }

  fill()
  for (let index = 0; index < chunks.length; index++) {
    const pending = inFlight.get(index)!
    // Delete before awaiting: on a rejection the generator throws and the map
    // is not consulted again, but the slot must not count against the window.
    inFlight.delete(index)
    const result = await pending
    fill()
    yield result
  }
}

/** What a write path returns: milliseconds spent writing, not fetching. */
type Pull = () => Promise<ChunkResult | undefined>

/**
 * The `opfs` VFS: one real OPFS file, written positionally through a sync
 * access handle, and never the live one. Needs COOP/COEP, which production
 * serves (D-030).
 *
 * Each chunk is flushed and *then* recorded in the bitmap, in that order. A
 * record that claims a chunk the file does not hold is worse than no record at
 * all: the next run trusts it, skips the fetch, and promotes a database with a
 * zero-filled hole that every hash in the manifest agrees with.
 *
 * `stopAfter` aborts the run once that many chunks have landed *in this run*,
 * which is how the resume path gets tested at all — see `ImportOptions`.
 */
async function writeStagedChunks(
  root: FileSystemDirectoryHandle,
  record: StagingRecord,
  pull: Pull,
  stopAfter: number | null,
  watch: StallWatch
): Promise<number> {
  // Timed from here, not from the first write: `importThroughSahPool` cannot
  // separate its own handle setup from its writes, so this path must include
  // the same span — opening the handle, the 377 MB truncate, and the close —
  // or the two VFSes get compared under one column heading while measuring
  // different things. Persisting the bitmap is counted here too; it is an OPFS
  // write, and hiding it would make the staged path look free.
  const started = performance.now()
  let pullMs = 0
  const index = new Map(record.chunks.map((chunk, at) => [chunk.name, at]))
  const handle = await root.getFileHandle(record.file, { create: true })
  const access = await handle.createSyncAccessHandle()
  let landed = 0
  try {
    // Idempotent on a resume: the file is already this long. Growing a short
    // one zero-fills a tail the pending chunks are about to overwrite, and
    // shrinking a long one cannot lose a completed chunk, because the bitmap
    // and the length come from the same record.
    if (access.getSize() !== record.rawBytes) access.truncate(record.rawBytes)
    // Truncating to 377 MB blocks this thread, so the first stall tick after it
    // would otherwise measure the truncate. Same reason as the beat after each
    // write below: this watch can only see network stalls, and every long
    // synchronous step has to hand it back a fresh reading (D-052).
    watch.beat()
    for (;;) {
      const pullStart = performance.now()
      const result = await pull()
      pullMs += performance.now() - pullStart
      if (!result) break
      // Positional write: each chunk carries its absolute offset, so resuming
      // a download is just "which offsets are done" (D-041). `writeFully`
      // because a short write is permitted by the spec and silently corrupts
      // the file (RE-014).
      writeFully(access, result.bytes, result.chunk.offset)
      access.flush()
      watch.beat()
      const at = index.get(result.chunk.name)
      if (at === undefined) {
        throw new Error(`staged a chunk the record does not name: ${result.chunk.name}`)
      }
      record.done[at] = true
      await persistRecord(root, record)
      landed += 1
      if (stopAfter !== null && landed >= stopAfter) {
        throw new Error(`download stopped after ${landed} chunks (stopAfterChunks)`)
      }
    }
  } finally {
    // Awaited deliberately: these are declared synchronous in the current spec
    // but Chrome has shipped promise-returning forms, and the exclusive lock is
    // not released until close() settles. Opening the OPFS VFS while it is
    // still held hangs with no error (RE-007).
    await access.close()
  }
  return performance.now() - started - pullMs
}

async function persistRecord(
  root: FileSystemDirectoryHandle,
  record: StagingRecord
): Promise<void> {
  await writeTextEntry(root, STAGING_RECORD_FILE, JSON.stringify(record))
}

/**
 * The record left by a previous run, if it describes exactly this download.
 *
 * Anything else — absent, unparseable, a different generation, a different
 * slot — starts a fresh one. The record is an optimization and never an
 * authority: it can cost a re-download and it can never cost the live copy
 * (D-061).
 */
async function loadRecord(
  root: FileSystemDirectoryHandle,
  plan: StagingPlan,
  file: SlotFile
): Promise<StagingRecord> {
  const text = await readTextEntry(root, STAGING_RECORD_FILE)
  if (text !== null) {
    let parsed: StagingRecord | null = null
    try {
      parsed = parseStagingRecord(JSON.parse(text))
    } catch {
      parsed = null
    }
    if (parsed && bindsTo(parsed, plan, file)) return parsed
  }
  return newRecord(plan, file)
}

/**
 * A page cache for probe connections. They read one header field and close, so
 * the 256 MiB the query path wants (D-050) would be pure allocation.
 */
const PROBE_CACHE_MIB = 2

/**
 * Examine a candidate: is it a promoted corpus this build would serve?
 *
 * **Read through SQLite, never from the file's bytes.** `user_version` lives at
 * header offset 60 and reading it directly is tempting — one 100-byte read per
 * candidate instead of an open — but the raw bytes are not the committed state.
 * SQLite's commit sequence writes the dirty pages, *then* deletes the rollback
 * journal (https://sqlite.org/atomiccommit.html, read 2026-08-04), so a crash
 * between those two steps leaves a file whose header advertises a promotion
 * that never committed and that the next open rolls straight back. Reproduced
 * 2026-08-04 by killing a process mid-commit: the header read 9 while SQLite,
 * after recovering the journal, reported 5. Believing the header there picks the
 * wrong slot as live and sweeps the one that really is (D-061).
 *
 * Opening also performs that recovery, which is the point: discovery leaves
 * every candidate in a consistent state rather than judging it in an
 * inconsistent one.
 */
async function examine(root: FileSystemDirectoryHandle, name: string): Promise<Candidate> {
  // The live database is already open; a second connection to the same file
  // would work but there is nothing to learn from it that this one cannot say.
  if (db && liveFile === name) {
    return describe(db)
  }

  let size: number | null
  try {
    size = await entrySize(root, name)
  } catch {
    return { kind: 'unreadable' }
  }
  if (size === null) return { kind: 'absent' }
  if (size === 0) return { kind: 'unusable' }

  let probe: Database
  try {
    probe = await openDatabase('opfs', name, PROBE_CACHE_MIB, 'w')
  } catch {
    // It exists and we could not open it. That is *not* "there is nothing
    // here": the caller turns that answer into deletions, and this may be the
    // user's only copy behind a transient failure.
    return { kind: 'unreadable' }
  }
  try {
    return describe(probe)
  } finally {
    probe.close()
  }
}

/**
 * The schema version this run speaks.
 *
 * `SCHEMA_VERSION` unless a caller overrode it, and clamped to a small positive
 * integer because it arrives from a query string. It changes only what this
 * build *claims*: a copy of another schema is announced and kept, never deleted
 * (`ImportOptions.schema`).
 */
function speaks(options: ImportOptions = {}): number {
  const n = Math.trunc(Number(options.schema))
  if (!Number.isFinite(n) || n < 1 || n > 9999) return SCHEMA_VERSION
  return n
}

/**
 * Instructions between progress callbacks for this session.
 *
 * Zero means "install no handler", which the measurement sweep uses to price
 * the handler itself; anything else is clamped to a range that keeps the
 * callback from firing so often it becomes the workload, or so rarely that
 * Cancel appears not to work.
 */
function queryOps(options: ImportOptions = {}): number {
  const n = Math.trunc(Number(options.progressOps))
  if (!Number.isFinite(n)) return PROGRESS_OPS
  if (n <= 0) return 0
  return Math.min(Math.max(n, 1_000), 100_000_000)
}

/**
 * The schema version discovery and `status` are currently using.
 *
 * Discovery runs from several entry points that have no options in hand
 * (`examine`, `findLive`, `nextGeneration`), and threading one through all of
 * them would put a diagnostic knob into the middle of the crash-safety code.
 * The session records it instead, and every request that carries options sets
 * it first.
 */
let sessionSchema = SCHEMA_VERSION

/** Build the reads `classifyCandidate` needs from an open connection. */
function describe(database: Database): Candidate {
  return classifyCandidate(
    {
      counter: () => counterOf(database),
      tablesPresent: () =>
        database.selectValue(
          "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name IN " +
            `(${REQUIRED_TABLES.map((name) => `'${name}'`).join(', ')})`
        ),
      meta: (generation) => ({
        schema: database.selectValue("SELECT v FROM meta WHERE k = 'schema'"),
        rev: database.selectValue("SELECT v FROM meta WHERE k = 'rev'"),
        notice: database.selectValue("SELECT v FROM meta WHERE k = 'notice'"),
        // Existence, not a census: the gate compares against zero only, and a
        // true count over 372k rows adds ~1.1 s to every page load (D-061).
        records: database.selectValue('SELECT count(*) FROM (SELECT 1 FROM cve LIMIT 1)'),
        promoted: generation,
      }),
    },
    sessionSchema
  )
}

/** The promotion counter as SQLite reports it, or null if it is unreadable. */
function counterOf(database: Database): number | null {
  const value = database.selectValue('PRAGMA user_version')
  return typeof value === 'number' ? value : null
}

/**
 * Remove the SQLite sidecars belonging to `file`.
 *
 * Called before raw bytes are written into a slot, and it throws rather than
 * shrugging: a rollback journal from an aborted index build describes the
 * *previous* generation's pages, and SQLite replays it into whatever main file
 * it finds. Reproduced 2026-08-04 — a staged file byte-identical to the
 * published artifact stopped being byte-identical the moment it was opened
 * beside a stale journal, and the rows it then held belonged to neither
 * generation. Overwriting the main file and leaving the journal is the exact
 * pattern SQLite documents as corruption (D-061).
 */
async function discardSidecars(root: FileSystemDirectoryHandle, file: string): Promise<void> {
  const doomed: string[] = []
  for await (const entry of root.values()) {
    if (isSidecarOf(entry.name, file)) doomed.push(entry.name)
  }
  for (const name of doomed) await removeIfPresent(root, name)
}

/**
 * What the `opfs` path holds, answered from the files themselves rather than
 * from a pointer beside them.
 *
 * The promoted slot with the highest counter wins, provided it is a corpus this
 * build would serve. A copy under M1's name has no counter and is adopted only
 * when no slot has been promoted — the upgrade case, swept by the first
 * promotion that lands.
 *
 * `conclusive` is false when any candidate could not be examined. The live copy
 * is still reported when one was found: a stray unreadable entry in the other
 * slot should not cost the user their database's availability. What it does do
 * is stop the sweep, because a keep list built from an incomplete picture is
 * exactly how the previous two versions of this deleted a live database.
 */
async function findLive(root: FileSystemDirectoryHandle): Promise<Found> {
  let best: { file: string; generation: number } | null = null
  // A copy of another schema version, kept apart from both "live" and "junk":
  // it is what a schema bump leaves behind, and it is announced rather than
  // swept (M3, D-013).
  let stale: { file: string; generation: number; schema: number } | null = null
  let conclusive = true
  for (const slot of SLOT_FILES) {
    const candidate = await examine(root, slot)
    if (candidate.kind === 'unreadable') conclusive = false
    if (candidate.kind === 'obsolete' && candidate.generation > 0) {
      if (!stale || candidate.generation > stale.generation) {
        stale = { file: slot, generation: candidate.generation, schema: candidate.schema }
      }
      continue
    }
    if (candidate.kind !== 'database') continue
    if (candidate.generation > 0 && (!best || candidate.generation > best.generation)) {
      best = { file: slot, generation: candidate.generation }
    }
  }
  if (best) return { file: best.file, obsolete: null, conclusive }

  const legacy = await examine(root, LEGACY_DB_FILE)
  if (legacy.kind === 'unreadable') conclusive = false
  if (legacy.kind === 'obsolete' && !stale) {
    stale = { file: LEGACY_DB_FILE, generation: legacy.generation, schema: legacy.schema }
  }
  return {
    file: legacy.kind === 'database' ? LEGACY_DB_FILE : null,
    obsolete: stale ? { file: stale.file, schema: stale.schema } : null,
    conclusive,
  }
}

/** What `findLive` concluded: at most one live copy, and any obsolete one. */
interface Found {
  file: string | null
  /** A complete copy this build cannot read, with the schema it carries. */
  obsolete: { file: string; schema: number } | null
  conclusive: boolean
}

/** An entry's byte length, or null if it is not there. */
async function entrySize(root: FileSystemDirectoryHandle, name: string): Promise<number | null> {
  try {
    return (await (await root.getFileHandle(name)).getFile()).size
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

/**
 * One past the highest promotion counter on disk. Starts at 1.
 *
 * Counts a slot we would not *serve* as well as one we would: the point is that
 * no counter is ever reissued, so an unusable file carrying 7 still has to push
 * the next promotion to 8.
 */
async function nextGeneration(root: FileSystemDirectoryHandle): Promise<number> {
  let highest = 0
  for (const slot of SLOT_FILES) {
    const candidate = await examine(root, slot)
    // `obsolete` counts as much as `database` does: a copy from another schema
    // version was promoted by an earlier build of this app and carries a real
    // counter, so re-issuing it would make the two slots indistinguishable.
    if (candidate.kind === 'database' || candidate.kind === 'obsolete') {
      highest = Math.max(highest, candidate.generation)
    }
  }
  return highest + 1
}

/**
 * Delete every entry of ours that is not one of `keep` (or a journal belonging
 * to one), best-effort.
 *
 * Best-effort because this runs *after* a download has already succeeded: a
 * slot another tab still holds open is 441 MB of wasted space, which the next
 * status or download will clear, and failing a good import over it would be a
 * worse trade. "Clear local copy" does not use this — that path must report a
 * clear it did not achieve, so it uses `clearStorage`, which throws.
 */
async function sweep(root: FileSystemDirectoryHandle, keep: readonly string[]): Promise<void> {
  const kept = (name: string) => keep.some((file) => name === file || name.startsWith(`${file}-`))
  const doomed: string[] = []
  for await (const entry of root.values()) {
    if (isOurEntry(entry.name) && !kept(entry.name)) doomed.push(entry.name)
  }
  for (const name of doomed) {
    await removeIfPresent(root, name).catch(() => undefined)
  }
}

/**
 * `opfs-sahpool`: the database lives inside the pool's opaque pre-opened files,
 * so bytes can only get in through `importDb` — which truncates the target and
 * appends strictly sequentially, pulling chunks from a callback. That shape is
 * the VFS's, not an API detail, and it is most of what D-051 turns on.
 *
 * Because the pull happens *inside* importDb, write time is only separable by
 * subtracting the time spent in the callback.
 */
async function importThroughSahPool(pull: Pull): Promise<number> {
  const pool = await installSahPool()
  let pullMs = 0
  const started = performance.now()
  await pool.importDb(`/${POOL_DB_FILE}`, async () => {
    const pullStart = performance.now()
    const result = await pull()
    pullMs += performance.now() - pullStart
    return result?.bytes
  })
  return performance.now() - started - pullMs
}

/**
 * Clamp a caller-supplied knob into a range the process can survive.
 *
 * These arrive from a query string (`?concurrency=`, `?cache=`), so they are
 * attacker-influenced in the ordinary sense that any link is: the ceilings are
 * what keeps a crafted URL from turning the memory bound D-040/D-041 exists to
 * impose into 384 MB of simultaneous chunk buffers, or the page cache into a
 * terabyte. `Math.max(1, NaN)` is `NaN`, so the finiteness check is not
 * redundant — without it a NaN window downloads nothing and leaves a truncated
 * database behind.
 */
function clamp(value: number | undefined, fallback: number, max: number): number {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(n, max)
}

/** 12 chunks today; a window wider than the corpus is the whole corpus. */
const MAX_CONCURRENCY = 16
/**
 * A ceiling on what a URL can ask for, not a recommendation: 512 MiB already
 * bought no latency over 256 and cost 31 MB of peak memory (D-050), and SQLite
 * does claim what it is given, so this only bounds the damage.
 */
const MAX_CACHE_MIB = 1024

async function importSnapshot(options: ImportOptions = {}): Promise<void> {
  // Chunks still in flight when an import ends have nobody left to receive
  // them. Unaborted they keep downloading and decompressing into buffers that
  // are already garbage — up to `concurrency - 1` × 32 MB of decompressed
  // output landing *after* the error, which blows the memory bound D-040/D-041
  // exists to hold at exactly the moment it matters most, and does it while the
  // user is likely clicking Download again.
  const transfers = new AbortController()
  // A download that has stopped advancing is a failure, and a slow one is not
  // (D-052). The watch turns the first into an aborted transfer carrying a
  // message; the second it never touches, because every byte received is a
  // beat. The error is kept as the abort *reason* so the catch below can report
  // it even when Fetch substitutes its own generic AbortError.
  const watch = watchForStalls({
    timeoutMs: stallTimeout(options.stallMs),
    onStall: (idleMs) =>
      transfers.abort(
        stallError(
          'The download',
          idleMs,
          'Your local copy is untouched, and downloading again resumes from the chunks ' +
            'already staged.'
        )
      ),
  })
  try {
    await runImport(options, transfers, watch)
  } catch (error) {
    // Chromium preserves an AbortSignal's custom reason while `fetch()` is
    // waiting for headers, but a response body reader rejects with a generic
    // AbortError once headers have arrived. A stall in the middle of a chunk
    // must not lose the diagnosis and recovery message just because it reached
    // that later phase of Fetch.
    throw transfers.signal.aborted ? transfers.signal.reason : error
  } finally {
    // Stopped here as well as inside `runImport`, because a failure anywhere
    // above leaves the interval running for the life of the Worker otherwise.
    watch.stop()
    transfers.abort()
  }
}

async function runImport(
  options: ImportOptions,
  transfers: AbortController,
  watch: StallWatch
): Promise<void> {
  const overallStart = performance.now()
  const concurrency = clamp(options.concurrency, DEFAULT_CONCURRENCY, MAX_CONCURRENCY)
  const vfs = options.vfs ?? DEFAULT_VFS
  const cacheMib = clamp(options.cacheMib, DEFAULT_CACHE_MIB, MAX_CACHE_MIB)

  report('manifest', null, 'Reading manifest')
  const manifest = await fetchManifest(transfers.signal, () => watch.beat())
  const { chunks, raw_bytes: rawBytes } = manifest.snapshot
  const compressedTotal = chunks.reduce((sum, c) => sum + c.bytes, 0)
  // `clamp` substitutes its fallback for anything below 1, so zero and negatives
  // are filtered out here instead: "stop after 0 chunks" means "do not stop".
  const requestedStop = Math.trunc(Number(options.stopAfterChunks))
  const stopAfter =
    Number.isFinite(requestedStop) && requestedStop > 0
      ? Math.min(requestedStop, chunks.length)
      : null

  let fetchMs = 0
  let digestMs = 0
  let decompressMs = 0
  let writeMs = 0
  let fetched = 0

  /**
   * One chunk, with the transport accounting both VFS paths share. `already`
   * is what a resumed run found on disk, so the bar measures the download the
   * user is waiting for rather than the part of it this process performed.
   */
  const makePull = (list: ChunkEntry[], already: number): Pull => {
    const loader = orderedChunks(manifest, list, concurrency, transfers.signal, () => watch.beat())
    return async (): Promise<ChunkResult | undefined> => {
      const { value, done } = await loader.next()
      if (done || !value) return undefined
      fetchMs += value.fetchMs
      digestMs += value.digestMs
      decompressMs += value.decompressMs
      fetched += 1
      report(
        'download',
        (already + fetched) / chunks.length,
        `${already + fetched} / ${chunks.length} chunks (${(compressedTotal / 1e6).toFixed(1)} MB)`
      )
      return value
    }
  }

  let staged: Database
  let openMs = 0
  /** Set on the staged path; the promotion needs it and the pool has none. */
  let stagedFile: SlotFile | null = null
  let plan: StagingPlan | null = null
  const root = await opfsRoot()

  if (vfs === 'opfs-sahpool') {
    // D-051: the pool cannot express staged replacement — `importDb` truncates
    // its target and appends strictly sequentially. This path keeps M1's
    // destroy-then-download behaviour and exists only so `pnpm measure` can
    // re-run Q-004; nothing selects it by default, and the plan's replacement
    // guarantees are deliberately not claimed for it.
    db?.close()
    db = null
    liveFile = null
    await clearStorage()
    // Deleting a 441 MB database is not instant either.
    watch.beat()
    report('download', 0, `0 / ${chunks.length} chunks`)
    writeMs = await importThroughSahPool(makePull(chunks, 0))
    watch.stop()
    report('verify', null, `Opening database — ${capabilities()}`)
    const openStart = performance.now()
    staged = await openDatabase('opfs-sahpool', POOL_DB_FILE, cacheMib)
    openMs = performance.now() - openStart
  } else {
    // Refuses a manifest whose chunks do not cover the byte range, or that
    // names one twice, *before* anything is written: per-chunk hashes prove
    // each chunk's bytes and nothing proves the bytes between them (D-061).
    plan = stagingPlan(manifest)
    // The live database is neither closed nor touched here. It stays on disk
    // right through the download, and a failure anywhere below leaves it
    // exactly where it was — which is the whole point of the staged path.
    //
    // Asked of OPFS every time rather than remembered in `liveFile`: another
    // tab may have promoted since, and staging over *its* new live database is
    // the one mistake this function must not make. Two 100-byte reads.
    const present = await findLive(root)
    // The obsolete copy counts as "do not stage here" as well: it is not
    // queryable, but keeping it until this download promotes is what makes the
    // schema-bump announcement survive a download that fails half way (M3).
    // If another slot was unreadable, however, it may be the usable copy. Do
    // not overwrite that uncertainty merely because the obsolete slot is the
    // one we could identify.
    if (present.obsolete && !present.conclusive) {
      throw new Error(
        'local storage could not be inspected safely; the existing copies are untouched'
      )
    }
    stagedFile = chooseStagingFile(present.file ?? present.obsolete?.file ?? null)
    const record = await loadRecord(root, plan, stagedFile)
    // Bind the record to the file as well as to the manifest. `bindsTo` proves
    // the bitmap describes this *download*; only the length proves it describes
    // these *bytes*. A record that outlived its file — a failed sweep, a clear
    // that stopped partway — would otherwise make this run fetch only the
    // chunks the bitmap calls pending into a freshly zero-filled file, and hand
    // promotion a database with a hole in it. On a genuine resume the length
    // always matches, because the file is truncated to it before the first
    // chunk lands.
    const size = await entrySize(root, stagedFile)
    // Once every chunk has landed, the client builds its indexes *into* this
    // file (D-035), so it legitimately grows past `rawBytes` — an exact-length
    // test there would discard a complete download after a crash in the index
    // build and refetch the whole snapshot. While the download is still in
    // progress the length is exact, because the file is truncated to it before
    // the first chunk lands.
    const complete = completed(record) === record.chunks.length
    const describesTheFile =
      size !== null && (complete ? size >= plan.rawBytes : size === plan.rawBytes)
    if (completed(record) > 0 && !describesTheFile) {
      record.done.fill(false)
      await persistRecord(root, record)
    }
    const already = completed(record)
    const pending = pendingChunks(record, manifest)
    // Discovery opened and closed both slots and read a resume record — real
    // work, and on a large local copy not instant. Beat before the transfers
    // start so the first gap the watch measures is a network gap.
    watch.beat()

    report(
      'download',
      already / chunks.length,
      already > 0
        ? `resuming — ${already} / ${chunks.length} chunks already staged`
        : `0 / ${chunks.length} chunks`
    )
    if (pending.length > 0) {
      // Before any raw byte goes in: a journal left by an aborted index build
      // on this slot describes the generation we are about to overwrite, and
      // SQLite would replay it into the new file at the next open (D-061).
      await discardSidecars(root, stagedFile)
      writeMs = await writeStagedChunks(root, record, makePull(pending, already), stopAfter, watch)
    }
    // "Every chunk present" is the first clause of the promotion gate, so it is
    // checked rather than assumed. Without this the gate rests entirely on the
    // loop having pulled what it was handed, and any way of producing a short
    // pull list — a duplicate chunk name collapsing two entries into one, a
    // future change to the loader — reaches `verifyStaged` with an unwritten
    // byte range that `meta` and a row count cannot see.
    const landed = completed(record)
    if (landed !== record.chunks.length) {
      throw new Error(`staged only ${landed} of ${record.chunks.length} chunks`)
    }

    // Nothing below this line crosses the network, and what follows it is the
    // index build: 58 of the 64 seconds an import takes, spent inside one
    // synchronous call that no watch can see into. Leaving the watch armed
    // through it would mean the first tick afterwards measuring the build and
    // reporting a stall that never happened.
    watch.stop()
    report('verify', null, `Verifying the staged copy — ${capabilities()}`)
    const openStart = performance.now()
    // Not 'c': on this path the file must already exist, and creating one turns
    // "the staging file is gone" into an empty database that fails later under
    // a misleading name.
    staged = await openDatabase('opfs', stagedFile, cacheMib, 'w')
    openMs = performance.now() - openStart
  }

  // One try, one close. Every step from here to the promotion can throw —
  // `verifyStaged` by design, the fts5 build on hostile description text,
  // `nextGeneration` on an OPFS read, `promote` on SQLITE_BUSY or quota — and
  // a `staged` that escapes unclosed holds a sync access handle on the slot for
  // the life of the Worker, which wedges every later download *and* the clear
  // button behind RE-007.
  let indexMs = 0
  const finalizeStart = performance.now()
  try {
    if (plan) verifyStaged(staged, manifest, plan)

    // Indexes before promotion, not after: a promoted database is one the user
    // can search, and D-035 makes the indexes part of what "downloaded" means.
    // A crash here costs the index build on the next run, never the chunks —
    // the bitmap is already complete, so the retry starts at this line.
    const indexStart = performance.now()
    buildSearchIndexes(staged, (fraction, detail) => report('index', fraction, detail), options)
    indexMs = performance.now() - indexStart

    if (stagedFile !== null) {
      // Promotion: one SQLite transaction on the file's own header, which is
      // what makes it atomic and durable without a pointer file we would have
      // to keep crash-safe ourselves (D-061). Everything above is discardable;
      // below it, the staged copy *is* the local database.
      report('verify', null, 'Promoting the new copy')
      promote(staged, await nextGeneration(root))
    }
  } catch (error) {
    staged.close()
    throw error
  }

  const previous = db
  db = staged
  liveFile = stagedFile
  if (stagedFile !== null) {
    // Everything below has already succeeded — the new database is promoted and
    // is what the user queries — so a failure here must not be reported as a
    // failed import. Closing the old connection first is the one ordering that
    // has to be right: an open database cannot be removed.
    try {
      previous?.close()
      await sweep(root, [stagedFile])
      // M1 cleared both VFSes on every import. The staged path clears neither,
      // so without this a `?vfs=opfs-sahpool` run followed by a default one
      // leaves a second full corpus in the pool that nothing reports and
      // nothing can reclaim — while `opfsBytes` silently counts it into
      // Q-003's footprint number.
      await unlinkPoolCopy(root)
    } catch {
      /* best-effort: the next status or download sweeps again */
    }
  }

  // Everything from opening the staged database to the swept origin, minus the
  // index build that sits inside it — the span that was previously invisible
  // and got reported as transport.
  const verifyMs = performance.now() - finalizeStart - indexMs

  await finishImport({
    compressedTotal,
    rawBytes,
    vfs,
    concurrency,
    cacheMib,
    fetchMs,
    digestMs,
    decompressMs,
    writeMs,
    openMs,
    indexMs,
    verifyMs,
    chunksTotal: chunks.length,
    chunksFetched: fetched,
    overallStart,
  })
}

/**
 * Read the four values the promotion gate turns on and hand them to it.
 *
 * The decision itself is `assertPromotable` in lib/staging.ts, where it can be
 * tested without a browser: reaching it from here costs a 377 MB import, so
 * every refusal it makes would otherwise ship unexercised.
 */
function verifyStaged(staged: Database, manifest: Manifest, plan: StagingPlan): void {
  assertPromotable(
    {
      schema: staged.selectValue("SELECT v FROM meta WHERE k = 'schema'"),
      rev: staged.selectValue("SELECT v FROM meta WHERE k = 'rev'"),
      notice: staged.selectValue("SELECT v FROM meta WHERE k = 'notice'"),
      records: staged.selectValue('SELECT count(*) FROM cve'),
      promoted: staged.selectValue('PRAGMA user_version'),
    },
    manifest.rev,
    plan,
    sessionSchema
  )
}

/**
 * Record the promotion in the database's own header.
 *
 * A pragma takes no bind parameter, so the counter is interpolated — which is
 * why it is re-derived here as an integer rather than trusted from the caller.
 */
function promote(staged: Database, generation: number): void {
  const value = Math.trunc(generation)
  if (!Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff) {
    throw new Error(`refusing to promote with generation ${generation}`)
  }
  staged.exec('PRAGMA query_only=OFF')
  try {
    staged.exec(`PRAGMA user_version=${value}`)
  } finally {
    staged.exec('PRAGMA query_only=ON')
  }
}

interface ImportReport {
  compressedTotal: number
  rawBytes: number
  vfs: Vfs
  concurrency: number
  cacheMib: number
  fetchMs: number
  digestMs: number
  decompressMs: number
  writeMs: number
  openMs: number
  indexMs: number
  verifyMs: number
  chunksTotal: number
  chunksFetched: number
  overallStart: number
}

async function finishImport(run: ImportReport): Promise<void> {
  if (!db) throw new Error('import finished with no database')
  const records = (db.selectValue('SELECT count(*) FROM cve') as number) ?? 0
  const notice = (db.selectValue("SELECT v FROM meta WHERE k = 'notice'") as string) ?? ''

  report('ready', 1, `${records.toLocaleString()} records`)
  post({
    type: 'imported',
    notice,
    timings: {
      fetchMs: Math.round(run.fetchMs),
      digestMs: Math.round(run.digestMs),
      decompressMs: Math.round(run.decompressMs),
      writeMs: Math.round(run.writeMs),
      openMs: Math.round(run.openMs),
      indexMs: Math.round(run.indexMs),
      verifyMs: Math.round(run.verifyMs),
      totalMs: Math.round(performance.now() - run.overallStart),
      compressedBytes: run.compressedTotal,
      rawBytes: run.rawBytes,
      records,
      chunksTotal: run.chunksTotal,
      chunksFetched: run.chunksFetched,
      vfs: run.vfs,
      concurrency: run.concurrency,
      cacheMib: run.cacheMib,
      opfsBytes: await opfsBytes(),
      storageBytes: await storageUsage(),
      wasmHeapBytes: sqlite3?.config.memory.buffer.byteLength ?? 0,
    },
  })
}

/**
 * Bytes actually held in OPFS, by walking it — `storage.estimate()` reports
 * quota accounting, which is padded and rounded and not the same question.
 * Both are recorded because they disagree, and Q-003's footprint number has to
 * say which one it is.
 */
async function opfsBytes(): Promise<number | null> {
  const walk = async (dir: FileSystemDirectoryHandle): Promise<number> => {
    let total = 0
    for await (const entry of dir.values()) {
      if (entry.kind === 'file') total += (await entry.getFile()).size
      else total += await walk(entry)
    }
    return total
  }
  try {
    return await walk(await opfsRoot())
  } catch {
    // null, not 0: an unmeasurable footprint must not be transcribable as an
    // empty one — this number sets a budget.
    return null
  }
}

async function storageUsage(): Promise<number | null> {
  try {
    return (await navigator.storage.estimate()).usage ?? null
  } catch {
    return null
  }
}

/**
 * The `SyncDb` the applier runs against, over an open connection.
 *
 * Three methods, because that is all delta apply needs and because it is the
 * seam that lets the same applier be tested against `node:sqlite` outside a
 * browser (lib/sync.ts) — where the fts5 `'delete'` protocol can be checked
 * with `integrity-check` at `rank = 1`, which is far too expensive to run here
 * (RE-005).
 */
function syncDb(database: Database): SyncDb {
  // The applier deals in `unknown` because it is written against no particular
  // driver; every value it binds came out of `parseDelta`, which has already
  // established it is a number, a string or null. This is where that becomes
  // the driver's own type.
  const bind = (params?: readonly unknown[]) => (params ? ([...params] as SqlValue[]) : undefined)
  return {
    run(sql, params) {
      database.exec({ sql, bind: bind(params) })
    },
    row(sql, params) {
      let out: unknown[] | null = null
      database.exec({
        sql,
        bind: bind(params),
        rowMode: 'array',
        // Literal false stops iteration: these are all single-row lookups and a
        // `SELECT ... WHERE id = ?` that somehow matched more should not be
        // walked to the end.
        callback: (row: unknown[]): false => {
          out ??= row
          return false
        },
      })
      return out
    },
    column(sql, params) {
      const out: unknown[] = []
      database.exec({
        sql,
        bind: bind(params),
        // An integer rowMode is "this column only", which is what the existence
        // probes want — one value per row rather than a one-element array.
        rowMode: 0,
        callback: (value: unknown) => {
          out.push(value)
        },
      })
      return out
    },
  }
}

/**
 * Fetch one delta file and turn it into a `Delta`, or refuse it.
 *
 * Same treatment as a snapshot chunk: the compressed bytes are checked against
 * the length and SHA-256 the manifest published *before* they are decompressed,
 * and the expanded length is checked after. The result then goes through
 * `parseDelta`, which is what decides the payload is one this build can apply
 * at all (D-055).
 *
 * No `cache: 'no-cache'`: a delta file is immutable at its URL, so the ordinary
 * cache is exactly right — unlike the manifest, which is the thing that changes.
 */
async function loadDelta(entry: DeltaEntry, signal: AbortSignal, beat: () => void): Promise<Delta> {
  const name = `delta ${entry.from}-${entry.to}`
  const response = await fetch(deltaUrl(entry), { signal })
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`)
  const compressed = await readBody(response, entry.bytes, name, beat)
  if ((await digest(compressed)) !== entry.sha256) throw new Error(`${name}: checksum mismatch`)

  const bytes = brotliDecompress(compressed)
  if (bytes.length !== entry.raw_bytes) {
    throw new Error(`${name}: expanded to ${bytes.length} bytes, not ${entry.raw_bytes}`)
  }
  return parseDelta(JSON.parse(new TextDecoder().decode(bytes)), entry)
}

/**
 * Walk the local copy up to the manifest's head, one delta at a time.
 *
 * Each file is its own transaction rather than the whole chain being one. A
 * chain is a sequence of steps between real published revisions, and stopping
 * part way through leaves the database at one of them — consistent, queryable,
 * and with less to do next time. Wrapping the chain would throw away every
 * applied file because the last one failed, which is the opposite trade.
 *
 * Writes are enabled for the apply and disabled again immediately, so the
 * window in which this connection can write is the transaction and not the
 * fetch before it.
 */
async function catchUp(
  manifest: Manifest,
  database: Database,
  signal: AbortSignal,
  watch: StallWatch
): Promise<SyncOutcome> {
  const started = performance.now()
  const watermark = database.selectValue("SELECT v FROM meta WHERE k = 'rev'")
  if (!isRevision(watermark)) {
    throw new Error(`the local copy carries no usable revision (meta.rev = ${watermark})`)
  }

  const chain = planSync(manifest, watermark)
  if (chain === null) {
    // Retention is finite (D-042, D-060): a copy older than the oldest delta
    // still served cannot be walked forward, and saying so is the honest
    // answer. It is not an error the user caused.
    throw new Error(
      `this copy is at revision ${watermark} and the origin no longer serves a path from ` +
        `there to revision ${manifest.rev} — download the corpus again to catch up`
    )
  }

  const outcome: SyncOutcome = {
    from: watermark,
    to: watermark,
    applied: 0,
    upserts: 0,
    inserts: 0,
    deletes: 0,
    bytes: 0,
    ms: 0,
  }
  const target = syncDb(database)
  for (const [index, entry] of chain.entries()) {
    report('sync', index / chain.length, `revision ${entry.to} — ${index + 1} of ${chain.length}`)
    const delta = await loadDelta(entry, signal, () => watch.beat())
    database.exec('PRAGMA query_only=OFF')
    let counts
    try {
      counts = applyDelta(target, delta)
    } finally {
      database.exec('PRAGMA query_only=ON')
      // Applying a delta is one synchronous transaction — 14 s per file at full
      // scale — during which no tick can run. Beat before the next fetch, or
      // the first tick after it reports the apply as a stalled download.
      watch.beat()
    }
    outcome.applied += 1
    outcome.upserts += counts.upserts
    outcome.inserts += counts.inserts
    outcome.deletes += counts.deletes
    outcome.bytes += entry.bytes
    outcome.to = counts.to
  }

  outcome.ms = performance.now() - started
  return outcome
}

/**
 * Bring the local copy to head, and say what that took.
 *
 * Also runs at the end of an import, because a snapshot lands at its own
 * revision and the head is above it as soon as one delta has been published
 * since (D-055) — a download that stopped there would be stale on arrival.
 */
async function syncToHead(options: ImportOptions = {}): Promise<void> {
  if (!db) throw new Error('no local copy — download the corpus first')
  const transfers = new AbortController()
  // Deltas are small — 218 KB for a real day (D-058) — so a sync that stops
  // advancing is a connection that died rather than a slow one, and the same
  // watch applies. A stall here leaves the copy at whichever published revision
  // the last completed file took it to (D-063).
  const watch = watchForStalls({
    timeoutMs: stallTimeout(options.stallMs),
    onStall: (idleMs) =>
      transfers.abort(
        stallError(
          'The sync',
          idleMs,
          'The local copy is unchanged at the last revision that applied; syncing again ' +
            'picks up from there.'
        )
      ),
  })
  let outcome: SyncOutcome
  try {
    report('manifest', null, 'Reading manifest')
    const manifest = await fetchManifest(transfers.signal, () => watch.beat())
    outcome = await catchUp(manifest, db, transfers.signal, watch)
  } catch (error) {
    // Same Fetch distinction as the snapshot path: body consumption reports a
    // generic AbortError, while the signal retains the stall message.
    throw transfers.signal.aborted ? transfers.signal.reason : error
  } finally {
    watch.stop()
    // Same reason the import path aborts: a delta still in flight when this
    // ends has nobody left to receive it.
    transfers.abort()
  }

  report(
    'ready',
    1,
    outcome.applied === 0
      ? `already at revision ${outcome.to}`
      : `revision ${outcome.to} — ${outcome.upserts.toLocaleString()} records updated`
  )
  post({ type: 'synced', outcome })
  // The revision, the timestamp and the record counts on screen all just
  // changed; status is what the page reads them from.
  await status()
}

/** Run the benchmark set (Q-003's query-latency budgets) in declaration order. */
function bench(): void {
  // Cancellable like any other query: the sweep runs ten shapes and at a stock
  // page cache one of them took 92 s (D-050), so the button the progress panel
  // is already showing has to mean something here too.
  finishQuery('demo', () => benchAll())
}

function benchAll(): void {
  const database = requireDb()
  const results: BenchResult[] = []
  for (const [index, query] of BENCH_QUERIES.entries()) {
    // Countable work, so this one gets real progress rather than a spinner.
    report(
      'query',
      index / BENCH_QUERIES.length,
      `${index + 1} / ${BENCH_QUERIES.length}: ${query.name}`
    )
    // Through the same path a user's query takes, progress handler included, so
    // the recorded number is what the app actually costs rather than what
    // SQLite costs. `?ops=0` runs the sweep with no handler installed, which is
    // how M3 priced the handler against the M1 baseline. `quiet` because this
    // loop already reports where it is, per query rather than per second.
    const result = runSql(database, query.sql, { limit: ROW_LIMIT, quiet: true })
    results.push({ name: query.name, ms: result.ms, rows: result.rows.length })
  }
  report('ready', 1, `${results.length} queries`)
  // Read here, not at import: aggregates and the temp b-trees behind GROUP BY
  // are exactly what can grow the heap past its index-building high-water, and
  // the page-cache decision (D-050) turns on whether they do.
  post({ type: 'bench', results, wasmHeapBytes: sqlite3?.config.memory.buffer.byteLength ?? 0 })
}

/** What the build actually offers, reported rather than assumed (D-009 means
 * the diagnostics panel is the only support channel we get). */
function capabilities(): string {
  if (!sqlite3) return 'sqlite3 not initialised'
  const oo1 = sqlite3.oo1 as Record<string, unknown>
  const vfs = sqlite3.capi.sqlite3_vfs_find('opfs')
  const pool = sqlite3.capi.sqlite3_vfs_find('opfs-sahpool')
  return [
    `version=${sqlite3.version?.libVersion ?? '?'}`,
    `OpfsDb=${typeof oo1.OpfsDb}`,
    `vfs:opfs=${vfs ? 'yes' : 'no'}`,
    `vfs:opfs-sahpool=${pool ? 'yes' : 'no'}`,
    `isolated=${self.crossOriginIsolated}`,
  ].join(' ')
}

/**
 * Register `opfs-sahpool` on first use. Installing it is not free — it opens
 * and holds one file handle per pool entry — so a build that never asks for it
 * never pays. Capacity 3 covers the database plus a journal with one spare;
 * the default of 6 just holds more handles open for nothing.
 */
async function installSahPool(): Promise<SAHPoolUtil> {
  if (!sqlite3) throw new Error('sqlite3 not initialised')
  sahPool ??= await sqlite3.installOpfsSAHPoolVfs({ initialCapacity: 3 })
  return sahPool
}

/**
 * @param flags oo1 open flags. `'c'` creates when absent, `'w'` refuses to —
 * which is what the staged path wants, so that a missing staging file fails by
 * name instead of becoming an empty database that fails later as "no such
 * table: meta".
 */
async function openDatabase(
  vfs: Vfs,
  file: string,
  cacheMib = DEFAULT_CACHE_MIB,
  flags: 'c' | 'w' = 'c'
): Promise<Database> {
  if (!sqlite3) throw new Error('sqlite3 not initialised')
  // Q-004 picked `opfs`, which needs COOP/COEP — already served (D-030) —
  // over `opfs-sahpool` (D-051). Both stay reachable so the sweep in
  // tests/e2e/measure.spec.ts can re-run the comparison.
  const database =
    vfs === 'opfs-sahpool'
      ? new (await installSahPool()).OpfsSAHPoolDb(`/${file}`)
      : new sqlite3.oo1.OpfsDb(`/${file}`, flags)
  // Negative cache_size is KiB rather than pages, which is the unit we can
  // actually budget in (D-050). temp_store=MEMORY because there is no usable
  // temp file here anyway: every GROUP BY that spills would otherwise spill
  // into the same OPFS the query is already waiting on.
  database.exec(`PRAGMA cache_size=-${Math.max(1, Math.trunc(cacheMib)) * 1024}`)
  database.exec('PRAGMA temp_store=MEMORY')
  // First line of defense for the query path: reads only. This is a
  // connection flag, not a guarantee — hostile SQL can flip it back — so it
  // does not discharge D-044's structural read-only commitment (authorizer,
  // M3); it exists so a stray write is an error today rather than a habit.
  database.exec('PRAGMA query_only=ON')
  return database
}

/**
 * Build the full-text indexes locally rather than shipping them (D-035).
 * Descriptions, vendors and products only: reference URLs would shred into
 * hosts, slugs and file names and pollute the same term space as the prose.
 *
 * Built a rowid range at a time rather than with fts5's own `'rebuild'`, which
 * is one opaque statement. At full scale this is 58 of the 64 seconds an import
 * takes — the single longest thing the app ever does — and D-052 requires
 * anything past about a second to report real progress wherever the work is
 * countable. Here it is countable, so an indeterminate bar was the wrong answer
 * rather than the only one.
 *
 * It costs about 1%, which is what made it the right trade. Measured 2026-08-04
 * against the live artifact (rev 2, 372,322 records) through this browser and
 * this VFS, three runs each in one session: 58.0 / 58.3 / 58.4 s batched
 * against 57.3 / 57.6 / 57.8 s for `'rebuild'` — ~0.7 s for about 96 progress
 * updates through the longest wait the app has. The index is the same size
 * either way (64.7 MB, measured natively) because inside a transaction fts5
 * flushes its in-memory hash on its own schedule regardless, so the batches buy
 * extra statements and not extra segments to merge. Committing per batch *would*
 * have bought those, which is why they share one transaction.
 */
function buildSearchIndexes(
  database: Database,
  onProgress: (fraction: number, detail: string) => void,
  options: ImportOptions = {}
): void {
  // Statistics are collected here only when the artifact did not arrive with
  // them (D-067). A published artifact carries `sqlite_stat1` — 21 rows the
  // pipeline collects in under a second on the server — and re-deriving them
  // costs 20.4 s of OPFS reads in the browser for exactly the same plans. The
  // check is what makes the client correct against both: a generation
  // published before the pipeline change still gets good plans, at that price.
  // `?analyze=0` reproduces the M1 baseline — indexes built, no statistics —
  // which is the only way to re-run the comparison the tuning was decided on.
  const analyze = options.analyze !== false && !hasStatistics(database)
  let base = 0
  // Outside the try: if this throws, writes were never enabled and there is
  // nothing to restore.
  database.exec('PRAGMA query_only=OFF')
  // The restore is in a `finally` because this is the one place that turns
  // writes back on, and the build steps 354,521 rows of attacker-influenced
  // description text through fts5. If that throws mid-batch, a trailing pragma
  // inside the same exec never runs and the connection stays writable for the
  // rest of its life — disarming the very defense the pragma is there to be.
  // `Database.transaction` has rolled the batch back by the time we get here.
  try {
    const textShare = analyze ? 1 - ANALYZE_SHARE : 1
    for (const { index, share } of indexPlan()) {
      onProgress(base, index.label)
      fillIndex(database, index, share * textShare, (fraction, rows) => {
        onProgress(
          base + share * textShare * fraction,
          `${rows.toLocaleString()} ${index.label} indexed`
        )
      })
      base += share * textShare
    }
    // Statistics, but only if the artifact arrived without them (D-067).
    //
    // What they buy is measured: the reference-host scan, the slowest shape in
    // the benchmark, drops from 605 ms to ~395 ms and the CWE aggregate from
    // 88 ms to ~55 ms, with no shape regressing. What they cost *here* is
    // 20.4 s of OPFS reads on top of an already 65-second import, against
    // under a second on the server — which is why the pipeline collects them
    // and this is the fallback for a generation published before it did.
    // Stats going stale as deltas land is harmless: SQLite treats them as
    // estimates, and a plan chosen from last month's distribution of a
    // 372k-record corpus is the same plan.
    if (analyze) {
      onProgress(textShare, 'collecting query statistics')
      // Everything, including the full-text shadow tables. Analysing only the
      // published schema's tables was measured and saved nothing — 78.6 s
      // against 79.1 s, inside the noise — so the simpler statement wins
      // (D-067).
      database.exec('ANALYZE')
    }
  } finally {
    database.exec('PRAGMA query_only=ON')
  }
}

/**
 * Whether this database already carries query statistics.
 *
 * The published artifact does (D-067): the pipeline runs `ANALYZE` in under a
 * second on the server, and `sqlite_stat1` is 21 rows. Deriving the same rows
 * in the browser means reading every index back through OPFS — 20.4 s at full
 * scale — so the client only does it for a generation that arrived without
 * them. An empty table counts as absent, because that is what a build which
 * analysed nothing would leave.
 */
function hasStatistics(database: Database): boolean {
  const present = database.selectValue(
    "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = 'sqlite_stat1'"
  )
  if (present !== 1) return false
  return Number(database.selectValue('SELECT count(*) FROM sqlite_stat1') ?? 0) > 0
}

/**
 * Populate one fts5 index from its content table, one rowid range at a time.
 *
 * The rowid range is the progress metric because it is the only one that is
 * free: `min`/`max` over an INTEGER PRIMARY KEY are b-tree seeks (SEARCH, not
 * SCAN), where `count(*)` would scan the 122 MB the build is about to read
 * anyway. It is a proxy and not the truth — descriptions have grown over the
 * years, so half the id space is 40% of the text rather than 50% — which costs
 * a bar that runs a little fast early and a little slow late, and never one
 * that goes backwards. The row count in the detail line is exact, and counts
 * rows rather than ids, so the holes D-056's retirement leaves in the id space
 * are not reported as records.
 */
function fillIndex(
  database: Database,
  index: SearchIndex,
  share: number,
  onBatch: (fraction: number, rows: number) => void
): void {
  const sql = indexSql(index)
  database.exec(sql.drop)
  database.exec(sql.create)

  const lo = database.selectValue(sql.min)
  const hi = database.selectValue(sql.max)
  // An empty content table has no bounds and needs no batches. The index still
  // exists, which is what `assertPromotionCompleted` counts.
  if (typeof lo !== 'number' || typeof hi !== 'number') return

  const span = hi - lo + 1
  let rows = 0
  // One transaction for the whole index, not one per batch: see the note above
  // on why committing per batch is what would have made this expensive. It is
  // also what makes a failed build leave no half-populated index behind —
  // `transaction` rolls back when the callback throws.
  database.transaction(() => {
    for (const [from, to] of batchRanges(lo, hi, indexBatches(share))) {
      database.exec({ sql: sql.insert, bind: [from, to] })
      rows += Number(database.changes())
      onBatch((to - lo) / span, rows)
    }
  })
}

/** What discovery concluded, and whether it saw the whole picture. */
interface Discovery {
  live: { vfs: Vfs; file: string } | null
  /**
   * A complete local copy of another schema version, when there is no live one
   * (M3). Reported so the page can say what happened; kept on disk so the next
   * download can reclaim its slot rather than the user losing it to a sweep
   * they were never told about.
   */
  obsolete: { file: string; schema: number } | null
  /** False if any candidate could not be examined; a sweep is then unsafe. */
  conclusive: boolean
}

/**
 * Which VFS and which file, if any, already hold a *promoted* database.
 * Answered from OPFS rather than remembered, because the Worker has no storage
 * of its own and a reload starts it empty. `opfs` is checked first and without
 * installing the pool, so the default path never pays for the alternative.
 *
 * A staging file is never returned: it carries no promotion counter, so a
 * half-downloaded database cannot be mistaken for the local copy (D-061).
 */
async function storedIn(): Promise<Discovery> {
  const root = await opfsRoot()
  const { file, obsolete, conclusive } = await findLive(root)
  if (file) return { live: { vfs: 'opfs', file }, obsolete: null, conclusive }
  if (obsolete) return { live: null, obsolete, conclusive }

  // A missing pool directory means nothing was ever imported through it. Any
  // other failure — installation, enumeration — is "I could not tell", and
  // must not be reported as absence for the same reason the `opfs` half must
  // not: the caller turns absence into deletions.
  try {
    const pooled = await root
      .getDirectoryHandle('.opfs-sahpool')
      .then(() => true)
      .catch((error: unknown) => {
        if (isNotFound(error)) return false
        throw error
      })
    if (pooled) {
      const pool = await installSahPool()
      if (pool.getFileNames().includes(`/${POOL_DB_FILE}`)) {
        return { live: { vfs: 'opfs-sahpool', file: POOL_DB_FILE }, obsolete: null, conclusive }
      }
    }
  } catch {
    return { live: null, obsolete: null, conclusive: false }
  }
  return { live: null, obsolete: null, conclusive }
}

/**
 * Drop whatever is not the live database and not a staged download still worth
 * resuming. Best-effort, and run on the *read* path on purpose: a promotion
 * that could not remove the old slot otherwise sits there holding 441 MB until
 * someone clears storage by hand.
 *
 * What it deliberately does **not** reclaim is a staged download whose record
 * still parses. This function has no manifest — `status` performs no network
 * request, and giving it one would put a fetch on the reopen path the M5
 * offline story depends on — so it cannot tell a resumable download from one
 * aimed at a generation the origin has since rotated away. Both are kept. The
 * abandoned case is not a permanent leak: the next download picks the same
 * slot, finds the record does not bind, and overwrites it. Until then it costs
 * the snapshot's expanded size (D-061).
 */
async function tidy(live: string | null): Promise<void> {
  const root = await opfsRoot()
  const text = await readTextEntry(root, STAGING_RECORD_FILE)
  let record: StagingRecord | null = null
  if (text !== null) {
    try {
      record = parseStagingRecord(JSON.parse(text))
    } catch {
      record = null
    }
  }
  const keep = [live, record?.file, record ? STAGING_RECORD_FILE : null].filter(
    (name): name is string => typeof name === 'string'
  )
  await sweep(root, keep)
}

/** Nothing is known, so nothing is claimed and nothing is deleted. */
function postUnknown(): void {
  post({
    type: 'status',
    ready: false,
    storage: 'unknown',
    rev: null,
    generated: null,
    notice: null,
    localSchema: null,
    schema: sessionSchema,
  })
}

/**
 * Report what is on disk — and reclaim orphans, but only once that report is
 * backed by an open database.
 *
 * The ordering is the load-bearing part. `tidy` deletes everything not on its
 * keep list, and the keep list comes from discovery, so *any* uncertainty in
 * discovery has to stop the sweep rather than shrink the keep list. Two
 * failures of that shape were reproduced against an earlier version: an
 * unreadable entry reported as "nothing here" swept the live database, and a
 * slot chosen from raw header bytes could be one whose promotion never
 * committed (D-061).
 */
async function status(): Promise<void> {
  let found: Discovery
  try {
    found = await storedIn()
  } catch {
    postUnknown()
    return
  }

  if (!found.live) {
    // A copy of another schema version is neither a live copy nor an empty
    // origin: the bytes are there and this build cannot read them (M3). It is
    // announced with both version numbers and **not** swept — the local
    // database is a rebuildable cache (D-013), which licenses replacing it,
    // not deleting it out from under a user who has not been told. The slot is
    // reclaimed by the next download's promotion sweep.
    if (found.obsolete && found.conclusive) {
      post({
        type: 'status',
        ready: false,
        storage: 'obsolete',
        rev: null,
        generated: null,
        notice: null,
        localSchema: found.obsolete.schema,
        schema: sessionSchema,
      })
      return
    }
    // Only a *conclusive* look at an origin with no promoted database licenses
    // reclaiming what is left. Otherwise something here could not be examined,
    // and it may be the copy the user is relying on.
    if (found.conclusive) {
      if (!db) await tidy(null).catch(() => undefined)
      post({
        type: 'status',
        ready: false,
        storage: 'empty',
        rev: null,
        generated: null,
        notice: null,
        localSchema: null,
        schema: sessionSchema,
      })
    } else {
      postUnknown()
    }
    return
  }
  const live = found.live

  try {
    if (!db) {
      // Deliberately not `db ??= await openDatabase(...)`: that tests `db`,
      // awaits, and then assigns unconditionally — so a status racing an
      // import overwrites the connection the import just installed. Re-check
      // after the await and drop the loser.
      const opened = await openDatabase(live.vfs, live.file)
      if (db) opened.close()
      else {
        db = opened
        liveFile = live.vfs === 'opfs' ? live.file : null
      }
    }
    const storedSchema = db.selectValue("SELECT v FROM meta WHERE k = 'schema'")
    if (typeof storedSchema !== 'number') throw new Error('local copy carries no numeric schema')
    const localSchema = storedSchema
    // The pool VFS cannot be classified through named OPFS entries, so its
    // schema gate happens after opening. It is still a local copy of another
    // version: keep it, refuse to query it, and announce both versions just as
    // the default VFS does.
    if (localSchema !== sessionSchema) {
      db.close()
      db = null
      liveFile = null
      post({
        type: 'status',
        ready: false,
        storage: 'obsolete',
        rev: null,
        generated: null,
        notice: null,
        localSchema,
        schema: sessionSchema,
      })
      return
    }
    const rev = (db.selectValue("SELECT v FROM meta WHERE k = 'rev'") as number) ?? null
    const generated = (db.selectValue("SELECT v FROM meta WHERE k = 'generated'") as number) ?? null
    // D-008 travels with the data, so it is read from the database rather
    // than remembered by the page that happened to import it.
    const notice = (db.selectValue("SELECT v FROM meta WHERE k = 'notice'") as string) ?? null
    // Only here, and only on a conclusive look: the database discovery chose is
    // open and answering, so the keep list names a copy that demonstrably
    // exists — and nothing else on disk went unexamined.
    if (found.conclusive) await tidy(liveFile).catch(() => undefined)
    post({
      type: 'status',
      ready: true,
      storage: 'ready',
      rev,
      generated,
      notice,
      localSchema,
      schema: sessionSchema,
    })
  } catch {
    // Discovery named a file we then could not open or read. That is not an
    // empty origin — it is an unknown one, and it must not authorise a sweep.
    postUnknown()
  }
}

/** Thrown by `runSql` when the user stopped the query. Not a failure. */
class Cancelled extends Error {
  constructor(readonly ms: number) {
    super(`cancelled after ${elapsedLabel(ms)}`)
    this.name = 'Cancelled'
  }
}

interface RunOptions {
  params?: SqlParam[]
  /** Rows to collect before stopping. */
  limit: number
  /**
   * Install the authorizer, because this SQL is the user's rather than this
   * build's. Everything the app itself runs is a literal in the tree.
   */
  guarded?: boolean
  /** Suppress the "still running" reports — the benchmark posts its own. */
  quiet?: boolean
}

/**
 * Run one read, under the progress handler and (for user SQL) the authorizer.
 *
 * This is the only place a query reaches SQLite from the UI, which is what
 * makes the three M3 properties structural rather than per-caller: a long query
 * says it is running (D-052 §3), it can be stopped (D-052's M3 consequence),
 * and user SQL cannot write (D-044).
 *
 * The progress callback is the whole mechanism. It is the only code that runs
 * during a query — the Worker's event loop does not turn — so it is both where
 * the cancellation flag is read and where the elapsed report is posted from.
 * `postMessage` from a blocked thread is fine: delivery is the receiver's
 * problem, and the receiver is the main thread, which is idle.
 */
function runSql(database: Database, sql: string, options: RunOptions): QueryResult {
  if (!sqlite3) throw new Error('sqlite3 not initialised')
  const capi = sqlite3.capi
  const handle = database.pointer
  const rows: unknown[][] = []
  const columns: string[] = []
  let truncated = false
  const started = performance.now()
  let lastReport = started
  // A refusal is reported by the authorizer callback, which SQLite turns into
  // a bare SQLITE_AUTH. Keeping the reason here is what turns "not authorized"
  // into "this console is read-only: INSERT is refused".
  let denial: string | null = null

  if (progressOps > 0 && handle) {
    capi.sqlite3_progress_handler(
      handle,
      progressOps,
      () => {
        if (cancelRequested(cancelFlag)) return 1
        if (options.quiet) return 0
        const now = performance.now()
        if (now - started < QUERY_QUIET_MS || now - lastReport < QUERY_REPORT_MS) return 0
        lastReport = now
        report('query', null, `running — ${elapsedLabel(now - started)} · Cancel to stop`)
        return 0
      },
      0
    )
  }
  if (options.guarded && handle) {
    capi.sqlite3_set_authorizer(
      handle,
      (_arg, code, arg1, arg2) => {
        const verdict = authorize(code, arg1 === 0 ? null : arg1, arg2 === 0 ? null : arg2)
        if (verdict.ok) return AUTH_OK
        denial ??= verdict.reason ?? 'refused'
        return AUTH_DENY
      },
      0
    )
  }

  try {
    database.exec({
      sql,
      bind: options.params ? ([...options.params] as SqlValue[]) : undefined,
      rowMode: 'array',
      columnNames: columns,
      callback: (row: unknown[]): false | undefined => {
        if (rows.length >= options.limit) {
          truncated = true
          // Stops iteration — the cap is a memory bound on this Worker, not a
          // display preference, so it has to stop SQLite rather than filter
          // afterwards.
          return false
        }
        rows.push(row)
        return undefined
      },
    })
  } catch (error) {
    const ms = performance.now() - started
    if (isInterrupt(error)) throw new Cancelled(ms)
    if (denial) throw new Error(denial)
    throw error
  } finally {
    // Both are per-connection and both must come off before the app's own
    // writes run: the authorizer would refuse the sync path's INSERTs, and the
    // handler would keep a cancellation flag live across a delta apply.
    if (handle) {
      if (progressOps > 0) capi.sqlite3_progress_handler(handle, 0, 0, 0)
      if (options.guarded) clearAuthorizer(handle)
    }
  }

  return {
    columns: [...columns],
    rows,
    ms: Math.round(performance.now() - started),
    truncated,
    sql,
    params: [...(options.params ?? [])],
  }
}

/**
 * Take the authorizer off the connection.
 *
 * The C API removes it when the callback is NULL, and the WASM bindings honour
 * that — the distribution's own close-time cleanup calls it exactly this way,
 * and it is what lets the app's writes (sync, index building) run on the same
 * connection a console query just used. The published TypeScript declaration
 * describes only the installing form, so the cast is the type catching up with
 * the API rather than a claim about behaviour: `tests/unit/authorizer.test.ts`
 * checks that writes work again after a guarded query.
 */
function clearAuthorizer(handle: number): void {
  if (!sqlite3) return
  const remove = sqlite3.capi.sqlite3_set_authorizer as unknown as (
    db: number,
    xAuth: number,
    cbArg: number
  ) => void
  remove(handle, 0, 0)
}

/** Post a finished result, or the fact that the user stopped it. */
function finishQuery(
  kind: 'demo' | 'console' | 'search',
  work: () => void,
  onCancel?: () => void
): void {
  // Once per top-level request, not once per SQL statement. A structured
  // search may run its result query and then a count; clearing between them can
  // erase a click that landed in that narrow gap and leave the count running.
  // The same applies between shapes in the benchmark sweep.
  armCancel(cancelFlag)
  try {
    work()
  } catch (error) {
    if (error instanceof Cancelled) {
      report('ready', 1, `cancelled after ${elapsedLabel(error.ms)}`)
      post({ type: 'cancelled', kind, ms: Math.round(error.ms) })
      onCancel?.()
      return
    }
    throw error
  }
}

function query(sql: string): void {
  const database = requireDb()
  // Reported before the call, not after: `db.exec` blocks this Worker until it
  // finishes, so this is the last chance to tell anyone it started (D-052).
  // The handler takes over from here with an elapsed figure; there is still no
  // fraction, because SQLite reports no position within a statement.
  report('query', null, 'Running query')
  finishQuery('demo', () => {
    const result = runSql(database, sql, { limit: ROW_LIMIT })
    report('ready', 1, `${result.rows.length.toLocaleString()} rows in ${result.ms} ms`)
    post({ type: 'result', kind: 'demo', result })
  })
}

/**
 * Run whatever the user typed (M3).
 *
 * Two things make this safe to expose over a database the app also writes to.
 * The authorizer refuses every action but reading (lib/authorizer.ts), so a
 * write is a refusal from SQLite's parser rather than from a regular
 * expression over the text. And the row cap plus cancellation mean a query that
 * asks for everything, or for something that never finishes, costs a bounded
 * amount of memory and as much time as the user is willing to wait.
 *
 * `query_only` stays on underneath as it always was; it is no longer the
 * defence, it is a second one.
 */
function consoleQuery(sql: string): void {
  const database = requireDb()
  const trimmed = sql.trim()
  if (!trimmed) throw new Error('nothing to run')
  report('query', null, 'Running your SQL')
  finishQuery('console', () => {
    const result = runSql(database, trimmed, { limit: CONSOLE_ROW_LIMIT, guarded: true })
    report(
      'ready',
      1,
      `${result.rows.length.toLocaleString()} rows in ${result.ms} ms${result.truncated ? ' (capped)' : ''}`
    )
    post({ type: 'result', kind: 'console', result })
  })
}

/**
 * Resolve one axis's names to the lookup ids the compiled SQL binds.
 *
 * Names, not ids, are what the UI and a permalink carry (lib/filters.ts), and
 * an id means nothing outside the artifact that issued it (D-055). Resolution
 * is also where "there is no vendor called that" is answered — separately from
 * "no CVE matches", which is what an unresolved name would otherwise look like.
 */
function resolveAxis(
  database: Database,
  axis: LookupAxis,
  values: string[] | undefined
): { ids: number[]; unmatched: string[] } {
  const ids: number[] = []
  const unmatched: string[] = []
  for (const value of values ?? []) {
    if (!value.trim()) continue
    let found = false
    database.exec({
      sql: LOOKUP_SQL[axis],
      bind: [lookupKey(axis, value)],
      rowMode: 0,
      callback: (id: unknown) => {
        if (typeof id === 'number') {
          ids.push(id)
          found = true
        }
      },
    })
    if (!found) unmatched.push(value)
  }
  return { ids, unmatched }
}

/** The structured query surface: every confirmed filter axis (M3). */
function search(request: SearchRequest): void {
  const database = requireDb()
  const filters: Filters = request.filters ?? {}
  report('query', null, 'Running query')

  finishQuery('search', () => {
    const resolved: Resolved = {}
    const unmatched: Unmatched[] = []
    for (const axis of LOOKUP_AXES) {
      const outcome = resolveAxis(database, axis, filters[axis])
      // Preserve an empty resolution when names were requested. `undefined`
      // means no filter; `[]` means the requested names do not exist and compiles
      // to false in the shared layer. Dropping the empty array would return the
      // whole corpus for a typo.
      if (filters[axis]?.some((value) => value.trim())) resolved[axis] = outcome.ids
      if (outcome.unmatched.length) unmatched.push({ axis, values: outcome.unmatched })
    }

    const groupBy = request.groupBy ?? null
    const state =
      filters.state === 'rejected' || filters.state === 'all' ? filters.state : 'published'
    const built = groupBy
      ? groupSql(filters, resolved, groupBy, request.limit)
      : rowsSql(filters, resolved, {
          limit: request.limit,
          offset: request.offset,
          sort: request.sort,
        })
    const result = runSql(database, built.sql, {
      params: built.params,
      limit: request.limit && request.limit > 0 ? Math.min(request.limit, ROW_LIMIT) : ROW_LIMIT,
    })

    // The count is a second query and its own decision: it is what a capped
    // list cannot tell you, and over the whole corpus with no filters it is a
    // scan, so the caller asks for it rather than paying for it every time.
    let matches: number | null = null
    if (request.count) {
      const counted = countSql(filters, resolved)
      const rows = runSql(database, counted.sql, { params: counted.params, limit: 1, quiet: true })
      const value = rows.rows[0]?.[0]
      matches = typeof value === 'number' ? value : null
    }

    report(
      'ready',
      1,
      `${result.rows.length.toLocaleString()} rows in ${result.ms} ms${result.truncated ? ' (capped)' : ''}`
    )
    post({ type: 'result', kind: 'search', result, matches, unmatched, groupBy, state })
  })
}

function requireDb(): Database {
  if (!db) throw new Error('no database — download the corpus first')
  return db
}

/**
 * Clear the local copy from *both* VFSes. Deriving the target from module
 * state was wrong: a Worker that reloaded since the import has none, and the
 * pool's files are invisible to `removeEntry` — so "Clear local copy" could
 * report success while leaving 441 MB of corpus on disk, which is the one
 * failure this button must not have.
 */
async function reset(): Promise<void> {
  db?.close()
  db = null
  liveFile = null
  await clearStorage()
  // `empty` rather than `unknown`: `clearStorage` throws unless every entry
  // really went, so reaching this line is proof the origin is empty.
  post({
    type: 'status',
    ready: false,
    storage: 'empty',
    rev: null,
    generated: null,
    notice: null,
    localSchema: null,
    schema: sessionSchema,
  })
}

/**
 * Remove the database from both VFSes.
 *
 * Every error here used to be swallowed, which made the one failure this must
 * not have — reporting a clear that did not happen — the *default* behaviour.
 * A file another tab holds open throws `NoModificationAllowedError` rather than
 * disappearing, and if that is silently ignored while an import then writes the
 * other VFS, `storedIn()` prefers the stale copy on the next reload and the
 * user queries a database they believe they deleted.
 *
 * So: only "not found" is tolerated, and only per-VFS. Anything else propagates
 * and the caller reports a failure.
 *
 * Staged replacement widened this: there are now up to two database files, the
 * journals SQLite writes beside them, and a resume record. A clear that leaves
 * a half-downloaded 441 MB slot behind has not cleared what the user asked
 * about, so this enumerates rather than naming one file — and unlike `sweep`,
 * every failure propagates.
 */
async function clearStorage(): Promise<void> {
  const root = await opfsRoot()
  const ours: string[] = []
  for await (const entry of root.values()) {
    if (isOurEntry(entry.name)) ours.push(entry.name)
  }
  // The resume record first, and keep going after a failure. Returning early
  // left the outcome to OPFS enumeration order: a slot another tab holds open
  // would abort the loop, and whether the record outlived the file it describes
  // came down to which name came first. A record that survives its file is the
  // input to the worst failure this design has (D-061).
  ours.sort((a, b) => Number(b === STAGING_RECORD_FILE) - Number(a === STAGING_RECORD_FILE))
  const failed: string[] = []
  for (const name of ours) {
    await removeIfPresent(root, name).catch(() => failed.push(name))
  }
  if (failed.length > 0) {
    throw new Error(`could not remove ${failed.join(', ')} — another tab may have them open`)
  }

  await unlinkPoolCopy(root)
}

/**
 * Remove the `opfs-sahpool` copy, if one was ever made.
 *
 * Split out because two callers need it for different reasons: "Clear local
 * copy", which must not report a clear it did not achieve, and a staged
 * promotion, which inherits M1's rule that an import leaves exactly one copy
 * behind. The pool's files are invisible to `removeEntry`, so this is the only
 * way to reach them.
 */
async function unlinkPoolCopy(root: FileSystemDirectoryHandle): Promise<void> {
  // Only touch the pool if it was ever used: installing it opens and holds a
  // file handle per entry, which a default-path session should never pay for.
  // A missing pool directory is "not there", not a failure.
  const pooled = await root
    .getDirectoryHandle('.opfs-sahpool')
    .then(() => true)
    .catch((error: unknown) => {
      if (isNotFound(error)) return false
      throw error
    })
  if (!sahPool && !pooled) return

  const pool = await installSahPool()
  // `unlink` returns whether it removed anything; false means it was already
  // absent, which is fine. A genuine failure throws.
  pool.unlink(`/${POOL_DB_FILE}`)
}

/**
 * Loaded at runtime rather than bundled: @sqlite.org/sqlite-wasm uses a bare
 * dynamic import that Turbopack cannot resolve, and serving the distribution
 * statically also lets its own asset URLs resolve the way upstream expects.
 * scripts/copy-wasm.mjs puts it there.
 */
const SQLITE_ENTRY = '/sqlite/index.mjs'

async function loadSqlite(): Promise<Sqlite3Static> {
  // The specifier is held in a variable deliberately: it is a runtime URL, not
  // a module in the graph, and a literal would make TypeScript try to resolve
  // it at compile time.
  const loaded = (await import(
    /* turbopackIgnore: true */ /* webpackIgnore: true */ SQLITE_ENTRY
  )) as { default: () => Promise<Sqlite3Static> }
  return loaded.default()
}

const ready = (async () => {
  await initBrotli()
  sqlite3 = await loadSqlite()
})()

/**
 * Requests are serialized. `onmessage` is async and the browser does not wait
 * for one call to settle before delivering the next, so without this a
 * double-click on Download runs two imports at once: on `opfs` they race the
 * truncate against each other's writes, and on `opfs-sahpool` they resolve the
 * *same* pool handle (`nextAvailableSAH()` does not reserve it) and interleave
 * bytes into one file that ends up looking valid.
 */
let queue: Promise<void> = Promise.resolve()

self.onmessage = (event: MessageEvent<Request>) => {
  queue = queue.then(() => handle(event.data))
}

async function handle(request: Request): Promise<void> {
  try {
    await ready
    // Every request that carries options sets the session's schema version
    // first, because discovery reads it from module state rather than taking it
    // as an argument through the crash-safety path (see `sessionSchema`).
    if ('options' in request) sessionSchema = speaks(request.options)
    switch (request.type) {
      case 'status':
        await status()
        break
      case 'control':
        // The shared cancellation flag, and the session's query knobs. Sent
        // once when the page mounts; a Worker that never receives it runs
        // queries that cannot be cancelled, which is the honest degradation
        // where `SharedArrayBuffer` is unavailable (lib/cancel.ts).
        cancelFlag = ArrayBuffer.isView(request.cancel) ? request.cancel : null
        progressOps = queryOps(request.options)
        sessionSchema = speaks(request.options)
        break
      case 'import':
        await importSnapshot(request.options)
        // Not a separate step the user has to know about: the snapshot is
        // published at its own revision and the head moves on daily (D-058), so
        // a download that stopped at `snapshot.rev` would be stale the moment
        // it finished. `imported` has already been posted by the time this
        // runs, so a catch-up that fails reports itself without retracting a
        // download that succeeded.
        await syncToHead(request.options)
        break
      case 'sync':
        await syncToHead(request.options)
        break
      case 'query':
        query(request.sql)
        break
      case 'console':
        consoleQuery(request.sql)
        break
      case 'search':
        search(request.request)
        break
      case 'bench':
        bench()
        break
      case 'reset':
        await reset()
        break
    }
  } catch (error) {
    report('error', null, '')
    const kind =
      request.type === 'console'
        ? 'console'
        : request.type === 'search'
          ? 'search'
          : request.type === 'query' || request.type === 'bench'
            ? 'demo'
            : undefined
    post({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
      ...(kind ? { kind } : {}),
    })
    // Resync, and on the staged path this is where the good news arrives: a
    // failed download leaves the previous database untouched, so `status` says
    // "still ready" and the page keeps its query surface instead of offering a
    // fresh Download. A failed clear may equally have left a copy behind. The
    // page cannot work either of those out from an error string.
    await status().catch(() => undefined)
  }
}
