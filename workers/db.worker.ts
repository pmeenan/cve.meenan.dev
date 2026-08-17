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

import {
  authorize,
  AUTH_DENY,
  AUTH_OK,
  CONSOLE_ROW_LIMIT,
  MAX_GUARDED_CELL_BYTES,
  RESULT_CHAR_BUDGET,
  rowCost,
  TOOL_DEADLINE_MS,
} from '../lib/authorizer'
import {
  armCancel,
  cancelRequested,
  elapsedLabel,
  isInterrupt,
  PROGRESS_OPS,
  QUERY_QUIET_MS,
  QUERY_REPORT_MS,
} from '../lib/cancel'
import { assess, gateMessage, probeSyncAccess, type CapabilityReport } from '../lib/capabilities'
import { parseDelta } from '../lib/delta'
import {
  countSql,
  crossSql,
  groupSql,
  lookupKey,
  LOOKUP_AXES,
  LOOKUP_SQL,
  rowsSql,
  ROW_LIMIT,
  usesKev,
  type Filters,
  type LookupAxis,
  type Resolved,
  type SqlParam,
} from '../lib/filters'
import {
  cwesSql,
  existsSql,
  isCveId,
  kevSql,
  productsSql,
  recordSql,
  referencesSql,
  versionsSql,
  type DetailQuery,
} from '../lib/detail'
import {
  CELL_COLUMNS,
  EXPORT_BATCH,
  EXPORT_LIMIT,
  exportFilename,
  exportWriter,
  recordColumns,
  type ExportHeader,
} from '../lib/export'
import {
  insertParams,
  isNewerCatalog,
  parseCwes,
  KEV_DDL,
  KEV_INSERT,
  KEV_META,
  KEV_URL,
  MAX_KEV_BYTES,
  parseCatalog,
  type KevCatalog,
  type KevStatus,
} from '../lib/kev'
import { CHART_ROWS, parseReport, TABLE_ROWS } from '../lib/report'
import { isRemoteDb, RemoteDb, remoteQuery } from '../lib/remote'
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
import {
  busyMessage,
  parseTabMessage,
  TAB_CHANNEL,
  WRITER_LOCK,
  type TabMessage,
  type WriterOp,
} from '../lib/tabs'
import {
  limitFreeSpace,
  planSpace,
  readStorage,
  spaceMessage,
  type StorageReport,
} from '../lib/storage'
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
  type Catalog,
  type ChunkEntry,
  type Coverage,
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
  type CveDetail,
  type DetailKev,
  type DetailReference,
  type DetailVersion,
  type ExportRequest,
  type QueryKind,
  type ReportRequest,
  type Response as WorkerMessage,
  type SearchRequest,
  type SyncOutcome,
  type Timings,
  type ToolCall,
  type ToolOutcome,
  type Unmatched,
  type Vfs,
} from '../lib/protocol'
import { searchReport } from '../lib/tools'

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

/**
 * The hosted query tier standing in for a local copy (D-084).
 *
 * `remoteDb` is the shim `requireDb` hands out; `remoteEligible` is the
 * license to hand it out, and it is granted in exactly one place — a
 * `hosted` probe that read the server copy's `meta` and found a schema this
 * build speaks. Until that has happened, "no local copy" stays the refusal it
 * always was: a query must never fall through to the network because a status
 * check simply had not finished yet.
 */
let remoteDb: Database | null = null
let remoteEligible = false
/** `?remote=0` — the page asked for the local tier or nothing. */
let sessionRemote = true

function post(message: WorkerMessage): void {
  ;(self as DedicatedWorkerGlobalScope).postMessage(message)
}

function report(phase: Progress['phase'], fraction: number | null, detail: string): void {
  post({ type: 'progress', progress: { phase, fraction, detail } })
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory()
}

/**
 * The capability verdict, probed once and remembered (M5, D-016).
 *
 * Once, because the probe creates and removes a scratch OPFS entry and nothing
 * it asks about can change within a session — a browser does not grow
 * synchronous access handles between two clicks. The *storage* half is re-read
 * every time, because that changes constantly.
 */
let capabilities: CapabilityReport | null = null

/** Whether the remembered verdict rests on a probe that actually ran. */
let definite = false

/**
 * A forced probe verdict (`ImportOptions.probe`), or null for the real one.
 *
 * Session state for the same reason `sessionSchema` is: `environment()` is
 * reached from paths that have no options in hand, and threading a diagnostic
 * knob through them would put it in the middle of the crash-safety code.
 */
let sessionProbe: 'async' | 'unavailable' | null = null

/**
 * What this browser can do, and how much room it has.
 *
 * Runs before anything is fetched: a gate that fires after the download has
 * started is a gate that has already cost the user the thing it exists to
 * prevent. The OPFS handle is taken defensively — a browser with no OPFS at all
 * throws here, and that is one of the answers rather than a crash.
 */
async function environment(): Promise<{
  capabilities: CapabilityReport
  storage: StorageReport
}> {
  // Re-probed while the answer is *indefinite*. A probe that could not run —
  // OPFS momentarily unavailable, a scratch file that would not open — is not
  // evidence about the browser, and caching it would brick the session on a
  // transient failure with no way back but a reload. A definite answer, `sync`
  // or `async`, cannot change within a session and is remembered.
  if (capabilities && !definite) capabilities = null
  if (!capabilities) {
    let root: FileSystemDirectoryHandle | null = null
    try {
      root = await opfsRoot()
    } catch {
      root = null
    }
    const probed = sessionProbe ?? (await probeSyncAccess(root))
    capabilities = assess({
      crossOriginIsolated: typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : false,
      hasWasm: typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function',
      hasSharedArrayBuffer: typeof SharedArrayBuffer === 'function',
      hasOpfs: root !== null,
      hasStreams: typeof ReadableStream === 'function',
      // The check the naive interface test cannot make: Safari 15.2–16.3 has
      // `createSyncAccessHandle` and returns Promises from the handle's
      // methods, which SQLite calls synchronously (D-016). `sessionProbe` can
      // only substitute a *worse* answer (`ImportOptions.probe`).
      syncAccess: probed,
    })
    definite = probed === 'sync' || probed === 'async'
  }
  return { capabilities, storage: await readStorage(navigator.storage) }
}

/** The gate, applied where it matters: before a transfer, not after one. */
async function assertSupported(): Promise<void> {
  const { capabilities: report } = await environment()
  if (!report.supported) throw new Error(gateMessage(report))
}

// --- Multi-tab (M5, lib/tabs.ts) -----------------------------------------

/**
 * The channel this tab shares with every other tab of this origin.
 *
 * Created lazily and tolerantly: `BroadcastChannel` is at the D-016 floor
 * everywhere, but a Worker that failed to construct one must still be able to
 * download — losing multi-tab coordination costs a stale second tab, and
 * throwing here would cost the corpus.
 */
let tabs: BroadcastChannel | null = null
try {
  tabs = typeof BroadcastChannel === 'function' ? new BroadcastChannel(TAB_CHANNEL) : null
} catch {
  tabs = null
}

/** What another tab last said it was doing, for the message a blocked tab shows. */
let othersDoing: WriterOp | null = null

function announce(message: TabMessage): void {
  try {
    tabs?.postMessage(message)
  } catch {
    /* A channel that will not carry an announcement is not a reason to fail an
       operation that has already succeeded. */
  }
}

if (tabs) {
  tabs.onmessage = (event: MessageEvent) => {
    const message = parseTabMessage(event.data)
    if (!message) return
    if (message.type === 'writer') {
      othersDoing = message.state === 'start' ? message.op : null
      return
    }
    // Both of the others change what this tab's *own* database says, so they go
    // through the same serialized queue as a request: acting on one while a
    // query is running would close the connection under it.
    queue = queue.then(() => adoptOtherTabsWork(message).catch(() => undefined))
  }
}

/**
 * Catch up with a write another tab performed.
 *
 * A **promotion** is the case that cannot be ignored: the live database is a
 * different OPFS entry now, and this tab is holding the one that was promoted
 * *over*. It would keep answering, correctly, from a generation nobody else can
 * see. Closing and re-running discovery is the whole fix — `status` reopens
 * whichever slot now carries the highest promotion counter (D-061).
 *
 * A **sync** wrote to the file this tab already has open. SQLite's own locking
 * makes the new rows visible to the next read transaction, so nothing has to be
 * reopened; what has to happen is that this tab's revision and freshness line
 * stop disagreeing with the tab next to it, which is what re-running `status`
 * does.
 */
async function adoptOtherTabsWork(message: TabMessage): Promise<void> {
  if (message.type === 'promoted') {
    db?.close()
    db = null
    liveFile = null
  }
  await status()
}

/**
 * Run a write operation as the only writer, or refuse and say who is writing.
 *
 * `ifAvailable` rather than waiting: a queued download that begins twenty
 * minutes later, when the user has moved on, is worse than being told now. The
 * lock is held for the *whole* operation — including the promotion at the end
 * of a download — because the window that matters is the one where two tabs
 * disagree about which file is live.
 *
 * Where Web Locks are unavailable the operation simply runs. That is the
 * pre-M5 behaviour, and it is honest: the alternative is refusing to work at
 * all on a browser whose only failing is that its user might open a second tab.
 */
async function asWriter(op: WriterOp, work: () => Promise<void>): Promise<void> {
  const locks = navigator.locks
  if (!locks || typeof locks.request !== 'function') {
    announce({ type: 'writer', op, state: 'start' })
    try {
      await work()
    } finally {
      announce({ type: 'writer', op, state: 'end' })
    }
    return
  }
  let ran = false
  await locks.request(WRITER_LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) return
    ran = true
    announce({ type: 'writer', op, state: 'start' })
    try {
      await work()
    } finally {
      announce({ type: 'writer', op, state: 'end' })
    }
  })
  if (!ran) throw new Error(busyMessage(othersDoing))
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

/**
 * Stream a JSON body whose length nobody published, bounded by `limit`.
 *
 * The two responses in this app that are not named by the manifest — the
 * manifest itself, and the KEV catalog (D-076 §2, deliberately outside it) —
 * so `readBody`'s exact-length contract does not apply and a bound has to stand
 * in for it. Streamed rather than `.json()`ed so the stall watch gets a beat per
 * network read: a body delivered slowly but continuously must not be reported
 * as stalled (D-052).
 *
 * Returns the byte count alongside the text, because the validator's message is
 * more useful when it can name it.
 */
async function readBoundedText(
  response: Response,
  limit: number,
  label: string,
  beat: () => void
): Promise<{ text: string; bytes: number }> {
  const body = response.body
  if (!body) {
    const text = await response.text()
    beat()
    // No stream to measure, so the bound is applied to what arrived. UTF-16
    // length is a lower bound on UTF-8 bytes, which is the safe direction.
    if (text.length > limit) throw new Error(`${label}: exceeds the ${limit} byte client limit`)
    return { text, bytes: text.length }
  }

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    // An empty stream chunk is not forward progress: the policy is explicitly
    // about bytes received, not callbacks delivered.
    if (value.length === 0) continue
    received += value.length
    if (received > limit) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`${label}: exceeds the ${limit} byte client limit`)
    }
    text += decoder.decode(value, { stream: true })
    beat()
  }
  text += decoder.decode()
  return { text, bytes: received }
}

async function readManifest(response: Response, beat: () => void): Promise<Manifest> {
  const { text } = await readBoundedText(response, MAX_MANIFEST_BYTES, 'manifest', beat)
  return JSON.parse(text) as Manifest
}

async function fetchManifest(
  signal?: AbortSignal,
  beat: () => void = () => undefined
): Promise<Manifest> {
  // `no-store`, not `no-cache`. `no-cache` means *revalidate*, and with no
  // network there is nothing to revalidate against — Firefox then serves the
  // stale manifest from its HTTP cache and a sync attempted offline reports
  // "already current" instead of failing. That is the exact confusion D-048
  // keeps the service worker away from `/data/` to prevent, arriving one layer
  // lower. `no-store` makes the freshness signal a network request or nothing,
  // which is what it is for; the file is a few kilobytes.
  const response = await fetch(manifestUrl(), { cache: 'no-store', signal })
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

  // Before the manifest, before anything: a browser that cannot run the import
  // must be told at the gate rather than tens of seconds and hundreds of
  // megabytes in, which is where the naive interface check leaves it (D-016).
  await assertSupported()

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
    await assertImportSpace(rawBytes, options)
    db?.close()
    db = null
    liveFile = null
    await clearStorage()
    // Deleting a 441 MB database is not instant either.
    watch.beat()
    report('download', 0, `0 / ${chunks.length} chunks`)
    writeMs = await importThroughSahPool(makePull(chunks, 0))
    watch.stop()
    report('verify', null, `Opening database — ${sqliteBuild()}`)
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
    // The chosen slot is exactly where this run writes. Its current allocation
    // is already included in storage `usage`, whether its resume bitmap is
    // usable or it will be overwritten, so charge only for the rest of the
    // imported footprint. Capped at rawBytes because a stale indexed database
    // is truncated back to the artifact length before new chunks land.
    await assertImportSpace(rawBytes, options, Math.min(size ?? 0, rawBytes))
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
    report('verify', null, `Verifying the staged copy — ${sqliteBuild()}`)
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
    // Announced *before* the sweep, and before this tab does anything else with
    // it: another tab is still holding the slot this download promoted over,
    // and until it lets go the sweep cannot reclaim that slot and the tab is
    // answering from a generation nobody else can see (lib/tabs.ts).
    announce({ type: 'promoted', rev: localRevision(staged) })
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

/** Refuse a demonstrably doomed import before its first snapshot chunk. */
async function assertImportSpace(
  rawBytes: number,
  options: ImportOptions,
  reusableBytes = 0
): Promise<void> {
  const reported = await readStorage(navigator.storage)
  // `freeBytes` substitutes a *smaller* free figure and nothing else, so the
  // refusal can be seen without filling a disk (RE-020).
  const pretend = Math.trunc(Number(options.freeBytes))
  const storage =
    Number.isFinite(pretend) && pretend >= 0 ? limitFreeSpace(reported, pretend) : reported
  const space = planSpace(rawBytes, storage, reusableBytes)
  if (!space.fits) throw new Error(spaceMessage(space))
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
  if (outcome.applied > 0) {
    // Only when something actually applied. A sync that found nothing to do
    // changed no other tab's answer, and announcing it would make every tab
    // re-run discovery for a no-op (lib/tabs.ts).
    announce({ type: 'synced', rev: outcome.to, generated: localGenerated(db) })
  }
  // The revision, the timestamp and the record counts on screen all just
  // changed; status is what the page reads them from.
  await status()
}

// --- The KEV overlay (M6, D-076) -----------------------------------------

/**
 * Whether this copy holds a KEV catalog.
 *
 * The table is created by the apply that fills it, so its absence is the signal
 * — but the *table* is not the whole answer: an apply is one transaction that
 * writes the rows and the `meta` keys together, so `kev_version` being present
 * is what says a complete catalog is there. Both are checked, because a table
 * with no meta row is a state nothing should query and nothing should report.
 */
function localKev(database: Database): KevStatus | null {
  const present = database.selectValue(
    "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = 'kev'"
  )
  if (present !== 1) return null
  const version = database.selectValue('SELECT v FROM meta WHERE k = ?', [KEV_META.version])
  if (typeof version !== 'string' || !version) return null
  const num = (key: string): number | null => {
    const value = database.selectValue('SELECT v FROM meta WHERE k = ?', [key])
    return typeof value === 'number' ? value : null
  }
  return {
    version,
    released: String(database.selectValue('SELECT v FROM meta WHERE k = ?', [KEV_META.released])),
    releasedAt: num(KEV_META.releasedAt),
    fetched: num(KEV_META.fetched) ?? 0,
    entries: num(KEV_META.entries) ?? 0,
    unmatched: num(KEV_META.unmatched) ?? 0,
  }
}

/**
 * Refuse a KEV query on a copy that has no catalog, by name.
 *
 * Without this the query fails with `no such table: kev`, which tells a user
 * nothing they can act on — and the alternative (creating the table empty on
 * open) would be worse: every record would answer "not in KEV", which is a
 * finding rather than a missing feature. This is reached from a permalink and,
 * in M7, from a model's tool call, so it cannot be left to the UI to avoid.
 */
function assertKevLoaded(database: Database): void {
  if (localKev(database) === null) {
    throw new Error(
      'this copy has no CISA KEV catalog yet, so it cannot answer a KEV question — ' +
        'use Refresh KEV on the Data tab. Nothing else about your local copy is affected.'
    )
  }
}

/**
 * Fetch the catalog, bounded and validated as the stranger input it is.
 *
 * `no-store`, not `no-cache`: `no-cache` means *revalidate*, and with no network
 * there is nothing to revalidate against — Firefox then serves the stale file
 * from its HTTP cache and a refresh attempted offline reports success having
 * fetched nothing (RE-023, the same trap the manifest fell into). A KEV
 * freshness line is a claim about what CISA currently lists; it has to be a
 * network request or nothing.
 */
async function fetchKev(signal: AbortSignal, beat: () => void): Promise<KevCatalog> {
  const response = await fetch(KEV_URL, { cache: 'no-store', signal })
  if (!response.ok) throw new Error(`KEV catalog: HTTP ${response.status}`)
  // Bounded and streamed: nothing publishes this file's length, so the bound
  // stands in for the manifest's, and a slow response still beats the watch.
  const { text, bytes } = await readBoundedText(response, MAX_KEV_BYTES, 'KEV catalog', beat)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // Deliberately not echoing the body: it is a stranger's bytes, and the
    // useful fact is that the origin served something that is not a catalog.
    throw new Error('the KEV catalog did not parse as JSON')
  }
  return parseCatalog(value, bytes)
}

/**
 * Replace the local overlay with `catalog`, in one transaction.
 *
 * One transaction covering the table, the rows and the `meta` keys that
 * describe them, so a failure anywhere leaves the previous catalog intact and
 * answering — the same rule delta apply follows (D-063), and for the same
 * reason: a half-applied known-exploited list is worse than a stale one.
 *
 * `cveID` resolves to `cve.id` here, at load, rather than at query time: it is
 * 1,662 lookups once against 372,322 rows scanned per query. An entry naming a
 * CVE this copy does not hold keeps its row with a null `cve_id` and is counted
 * — dropping it would make the catalog look like it matched perfectly (D-076).
 */
function applyKev(database: Database, catalog: KevCatalog, fetchedAt: number): number {
  database.exec('PRAGMA query_only=OFF')
  try {
    database.transaction(() => {
      // Dropped rather than deleted-from: a schema this build changed later
      // would otherwise be filled with rows shaped for the old one, and the
      // table is 1,662 rows.
      database.exec('DROP TABLE IF EXISTS kev')
      for (const statement of KEV_DDL) database.exec(statement)
      for (const entry of catalog.entries) {
        database.exec({ sql: KEV_INSERT, bind: insertParams(entry) as SqlValue[] })
      }
      const unmatched =
        (database.selectValue('SELECT count(*) FROM kev WHERE cve_id IS NULL') as number) ?? 0
      const meta: [string, string | number][] = [
        [KEV_META.version, catalog.version],
        [KEV_META.released, catalog.released],
        [KEV_META.releasedAt, catalog.releasedAt],
        [KEV_META.fetched, fetchedAt],
        [KEV_META.entries, catalog.entries.length],
        [KEV_META.unmatched, unmatched],
      ]
      for (const [key, value] of meta) {
        database.exec({ sql: 'INSERT OR REPLACE INTO meta(k, v) VALUES(?, ?)', bind: [key, value] })
      }
    })
  } finally {
    database.exec('PRAGMA query_only=ON')
  }
  return catalog.entries.length
}

/**
 * Fetch and apply, reporting either outcome — and **never** failing the
 * operation that called it.
 *
 * A download that fetched 372,322 records and then could not reach `kev.json`
 * has downloaded the corpus. So this swallows its own failure into a `kev`
 * message: the corpus operation reports success, the previous catalog stays,
 * and its age is what the freshness line goes on reporting. The one thing that
 * would be dishonest is silence, which is why the message is posted on both
 * paths.
 */
async function refreshKev(options: ImportOptions = {}): Promise<void> {
  const started = performance.now()
  const database = db
  if (!database) {
    post({
      type: 'kev',
      kev: null,
      error: 'no local copy — download the corpus first',
      applied: null,
      ms: 0,
    })
    return
  }
  // Nothing below may leave the phase anywhere but `ready`: the page derives
  // *busy* from it, so an unreported ending disables every button in the app.

  const transfers = new AbortController()
  const watch = watchForStalls({
    timeoutMs: stallTimeout(options.stallMs),
    onStall: (idleMs) =>
      transfers.abort(
        stallError(
          'The KEV catalog fetch',
          idleMs,
          'Your corpus and the catalog you already had are both untouched.'
        )
      ),
  })
  try {
    report('sync', null, 'Reading the CISA KEV catalog')
    const catalog = await fetchKev(transfers.signal, () => watch.beat())
    watch.stop()
    // Re-read rather than reusing the connection captured before the fetch:
    // this runs under the writer lock so no other tab can have promoted, but a
    // closed connection is not a thing to find out about mid-transaction.
    const live = db ?? database
    // **The client's own roll-backwards guard**, not just the pipeline's. This
    // build validates the catalog again rather than trusting the server, and
    // the ordering half is the half that defends against the thing that makes
    // that necessary: a mutable URL with a cache in front of it. Without it one
    // poisoned response replaces a current catalog with an old one, and because
    // "Not in KEV" is a real value here rather than an absence, the app then
    // positively asserts *not known-exploited, per CISA* for everything listed
    // since — persisted, offline-honest, and agreeing across tabs (D-077 §3).
    //
    // Refusing is safe because it is not sticky in the dangerous direction:
    // `parseCatalog` will not accept a future-dated catalog, so nothing can
    // install a floor that real catalogs cannot clear. A copy that somehow
    // holds one is repaired by "Clear local copy" and a fresh download, which
    // the message says.
    const held = localKev(live)
    if (held && isNewerCatalog(catalog, held) === false) {
      throw new Error(
        `the origin served KEV catalog ${catalog.version}, which is older than the ` +
          `${held.version} this copy already holds — keeping the one you have. If that is ` +
          'wrong, clear the local copy and download again.'
      )
    }
    // Applied unconditionally rather than only when `catalogVersion` moved,
    // which is a deliberate widening of M6's shape decision. It is 1,662 rows —
    // milliseconds — and the version is not the only thing that can go stale:
    // `cve_id` is resolved at load, so a sync that brought in the records
    // CISA listed last week turns unmatched entries into matched ones, and an
    // unchanged catalog against a changed corpus is exactly when that happens.
    const applied = applyKev(live, catalog, Math.floor(Date.now() / 1000))
    const status = localKev(live)
    // Back to `ready`, and this is not cosmetic: the page derives *busy* from
    // the phase, and every button on the Data and Explore tabs is disabled
    // while it is anything else. A refresh that finished without saying so left
    // the whole app permanently unusable — found by `tests/e2e/kev.spec.ts`
    // waiting ten minutes for a Run button that was never going to enable.
    report('ready', 1, `KEV catalog ${status?.version ?? ''} — ${applied.toLocaleString()} entries`)
    post({ type: 'kev', kev: status, error: null, applied, ms: performance.now() - started })
    // Same file, new rows — like a sync rather than a promotion, so no tab has
    // to reopen; what has to happen is that every tab's KEV freshness line
    // stops disagreeing with the one next to it.
    if (status) announce({ type: 'kev' })
  } catch (error) {
    const message = transfers.signal.aborted ? transfers.signal.reason : error
    // `ready`, not `error`: the corpus operation that triggered this succeeded
    // and the copy is queryable, so the app must not be left disabled or have
    // its panels cleared. The failure is carried on the `kev` message instead,
    // which is what the freshness line reports beside a catalog that still
    // works (D-077 §2).
    report('ready', 1, 'KEV catalog unchanged — the refresh failed')
    post({
      type: 'kev',
      // The catalog that is still there, which is the point: reporting `null`
      // would read as "you have no catalog" when what happened is "you still
      // have yesterday's".
      kev: localKev(database),
      error: message instanceof Error ? message.message : String(message),
      applied: null,
      ms: performance.now() - started,
    })
  } finally {
    watch.stop()
    transfers.abort()
  }
}

/** `meta.generated` of an open copy — the stamp the freshness line reads. */
function localGenerated(database: Database): number | null {
  const value = database.selectValue("SELECT v FROM meta WHERE k = 'generated'")
  return typeof value === 'number' ? value : null
}

/** Run the benchmark set (Q-003's query-latency budgets) in declaration order. */
function bench(): void {
  // Cancellable like any other query: the sweep runs ten shapes and at a stock
  // page cache one of them took 92 s (D-050), so the button the progress panel
  // is already showing has to mean something here too.
  finishQuery('demo', () => benchAll())
}

function benchAll(): void {
  // The benchmark prices *this browser's* engine (Q-003); numbers measured
  // through a network round trip to the server would be about the network.
  if (!db) throw new Error('the benchmark measures the local engine, so it needs a local copy')
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

/** What the SQLite build actually offers, reported rather than assumed (D-009
 * means the diagnostics panel is the only support channel we get). Distinct
 * from `environment()` above, which is about the *browser*. */
function sqliteBuild(): string {
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
    kev: null,
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
        kev: null,
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
        kev: null,
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
        kev: null,
      })
      return
    }
    const rev = (db.selectValue("SELECT v FROM meta WHERE k = 'rev'") as number) ?? null
    const generated = (db.selectValue("SELECT v FROM meta WHERE k = 'generated'") as number) ?? null
    // D-008 travels with the data, so it is read from the database rather
    // than remembered by the page that happened to import it.
    const notice = (db.selectValue("SELECT v FROM meta WHERE k = 'notice'") as string) ?? null
    // Read from the copy for the same reason, which is also what makes the KEV
    // freshness line work offline and agree across tabs (M6).
    const kev = localKev(db)
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
      kev,
    })
  } catch {
    // Discovery named a file we then could not open or read. That is not an
    // empty origin — it is an unknown one, and it must not authorise a sweep.
    postUnknown()
  }
}

/**
 * Probe the hosted query tier (D-084) and answer with `hostedStatus`.
 *
 * Two remote queries, not eleven: the whole `meta` table in one, and the `kev`
 * table's existence in the other. What it establishes mirrors what `status`
 * establishes about a local copy — schema, revision, build stamp, notice, KEV
 * catalog — because the page renders both through the same strip.
 *
 * The schema comparison is the gate. During a deploy the server's copy and
 * this build can briefly disagree, and compiled SQL from one schema against
 * the other is exactly the quiet wrongness `status` refuses for a local copy
 * (M3) — so the hosted tier is refused the same way, with both numbers in the
 * message.
 */
async function hostedStatus(): Promise<void> {
  if (!sessionRemote) {
    remoteEligible = false
    post({ type: 'hostedStatus', ok: false, error: 'the hosted tier is off for this session' })
    return
  }
  try {
    const probe = (remoteDb ??= new RemoteDb() as unknown as Database)
    const meta = new Map<string, unknown>()
    probe.exec({
      sql: 'SELECT k, v FROM meta',
      rowMode: 'array',
      callback: (row: unknown[]) => {
        if (typeof row[0] === 'string') meta.set(row[0], row[1])
      },
    })
    const schema = meta.get('schema')
    if (typeof schema !== 'number') {
      throw new Error('the hosted copy reports no schema version')
    }
    if (schema !== sessionSchema) {
      throw new Error(
        `the hosted copy speaks schema ${schema} and this build speaks ${sessionSchema} — ` +
          'reload in a moment; a deploy is likely mid-flight'
      )
    }
    const kevTable = probe.selectValue(
      "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = 'kev'"
    )
    const version = meta.get(KEV_META.version)
    const num = (key: string): number | null => {
      const value = meta.get(key)
      return typeof value === 'number' ? value : null
    }
    // The same two-part check `localKev` makes: the table, and the meta row
    // the applying transaction wrote with it.
    const kev: KevStatus | null =
      kevTable === 1 && typeof version === 'string' && version
        ? {
            version,
            released: String(meta.get(KEV_META.released) ?? ''),
            releasedAt: num(KEV_META.releasedAt),
            fetched: num(KEV_META.fetched) ?? 0,
            entries: num(KEV_META.entries) ?? 0,
            unmatched: num(KEV_META.unmatched) ?? 0,
          }
        : null
    remoteEligible = true
    post({
      type: 'hostedStatus',
      ok: true,
      rev: typeof meta.get('rev') === 'number' ? (meta.get('rev') as number) : null,
      generated:
        typeof meta.get('generated') === 'number' ? (meta.get('generated') as number) : null,
      notice: typeof meta.get('notice') === 'string' ? (meta.get('notice') as string) : null,
      kev,
    })
  } catch (error) {
    remoteEligible = false
    post({
      type: 'hostedStatus',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
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
  /**
   * Stop after this long, and report it as a refusal (D-044's "timed-out").
   *
   * Only for SQL this build did not write. The app's own statements have no
   * deadline: an import's index build legitimately runs for a minute, and a
   * deadline there would be a data-loss bug rather than a safety rail.
   */
  deadlineMs?: number
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
  // The hosted tier: the statement, its parameters and the row cap travel to
  // `api/sql.php`, and every engine-side guard below — authorizer, length
  // limit, character budget, deadline — is enforced by the server instead,
  // uniformly and for *every* statement, because the server trusts nothing a
  // browser sends (D-084). Cancellation has no remote analogue: the bound is
  // the transport timeout plus the server's own deadline.
  if (isRemoteDb(database)) {
    const started = performance.now()
    const remote = remoteQuery(sql, (options.params ?? []) as SqlParam[], options.limit)
    return {
      columns: remote.columns,
      rows: remote.rows,
      ms: Math.round(performance.now() - started),
      truncated: remote.truncated,
      ...(remote.overflowed ? { overflowed: true } : {}),
      sql,
      params: [...(options.params ?? [])],
    }
  }
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
  /** Set by the progress handler when the deadline passed, so the interrupt is nameable. */
  let expired = false
  /** Set by the row callback when the character budget stopped collection. */
  let overflowed = false
  /** Characters retained so far, against `RESULT_CHAR_BUDGET`. */
  let budgetSpent = 0
  /** The connection's own length limit, restored in the `finally`. -1 is "unset". */
  let priorLength = -1

  if (progressOps > 0 && handle) {
    capi.sqlite3_progress_handler(
      handle,
      progressOps,
      () => {
        if (cancelRequested(cancelFlag)) return 1
        const now = performance.now()
        if (options.deadlineMs !== undefined && now - started > options.deadlineMs) {
          // Non-zero interrupts the statement, exactly as cancellation does.
          // Distinguished by `expired` below, because "you stopped it" and "it
          // ran too long" are different things to tell a user.
          expired = true
          return 1
        }
        if (options.quiet) return 0
        if (now - started < QUERY_QUIET_MS || now - lastReport < QUERY_REPORT_MS) return 0
        lastReport = now
        report('query', null, `running — ${elapsedLabel(now - started)} · Cancel to stop`)
        return 0
      },
      0
    )
  }
  // A guarded query with no connection handle would run *unguarded*: the only
  // remaining defence would be `query_only`, which the same statement string can
  // flip off. Refuse rather than proceed — this is unreachable on an open
  // database, and the point of saying so is that it stays unreachable.
  if (options.guarded && !handle) {
    throw new Error('the database connection is not in a state where read-only can be enforced')
  }
  if (options.guarded && handle) {
    // Bound what SQLite will *build*, not just what we keep. The budget in the
    // row callback runs after the value already exists as a JS string, so it
    // stops a gigabyte from being retained and cloned but not from being
    // materialized once; `SQLITE_LIMIT_LENGTH` stops it earlier, inside the
    // engine, with `SQLITE_TOOBIG`. Restored below, because the app's own
    // writes go through this same connection and a delta record is allowed to
    // be larger than any cell a person reads.
    priorLength = capi.sqlite3_limit(handle, capi.SQLITE_LIMIT_LENGTH, MAX_GUARDED_CELL_BYTES)
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
        // …and the row cap is not the whole memory bound, because a row can be
        // any size at all. Guarded queries carry a character budget as well,
        // measured on what is actually retained. Checked *before* the row is
        // kept, so the last row over the line is dropped rather than held.
        if (options.guarded) {
          budgetSpent += rowCost(row)
          if (budgetSpent > RESULT_CHAR_BUDGET) {
            truncated = true
            overflowed = true
            return false
          }
        }
        rows.push(row)
        return undefined
      },
    })
  } catch (error) {
    const ms = performance.now() - started
    if (expired) {
      throw new Error(
        `this query ran for longer than ${Math.round((options.deadlineMs ?? 0) / 1000)} s and was ` +
          'stopped. Narrow it — a filter on state, a date range, or a LIMIT — and try again.'
      )
    }
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
      // Unconditionally, and before anything else can use the connection: a
      // 1 MB value limit left behind would make the *sync* path fail on any
      // record longer than that, which is a data bug arriving hours later and
      // nowhere near this line.
      if (priorLength >= 0) capi.sqlite3_limit(handle, capi.SQLITE_LIMIT_LENGTH, priorLength)
    }
  }

  return {
    columns: [...columns],
    rows,
    ms: Math.round(performance.now() - started),
    truncated,
    ...(overflowed ? { overflowed: true } : {}),
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
function finishQuery(kind: QueryKind, work: () => void, onCancel?: () => void): void {
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

/**
 * The corpus's own date extent, one statement per axis pair (M9).
 *
 * Written as scalar subqueries rather than `SELECT min(a), max(a), min(b) …`
 * for a reason worth keeping: SQLite optimizes a *lone* `min()` or `max()` into
 * an index seek, and loses that the moment two aggregates share a query. Split
 * this way, `published` and `year` are index seeks; only `updated` — which has
 * no index — scans, and it scans one column of one table.
 *
 * Both tiers run it: on the hosted tier this is one more POST of read-only SQL
 * whose text is this build's own constant (D-084).
 */
const COVERAGE_SQL =
  'SELECT (SELECT min(published) FROM cve), (SELECT max(published) FROM cve),' +
  ' (SELECT min(updated) FROM cve), (SELECT max(updated) FROM cve),' +
  ' (SELECT min(year) FROM cve), (SELECT max(year) FROM cve)'

/** Every axis unbounded — what a copy that cannot be measured reports. */
const NO_COVERAGE: Coverage = {
  publishedMin: null,
  publishedMax: null,
  updatedMin: null,
  updatedMax: null,
  yearMin: null,
  yearMax: null,
  kevAddedMin: null,
  kevAddedMax: null,
  kevDueMin: null,
  kevDueMax: null,
}

const KEV_COVERAGE_SQL =
  'SELECT (SELECT min(added_at) FROM kev), (SELECT max(added_at) FROM kev),' +
  ' (SELECT min(due_at) FROM kev), (SELECT max(due_at) FROM kev)'

/**
 * Nobody asked for this query, and everything about how it runs follows from
 * that.
 *
 * **It reports no phase.** `quiet` suppresses the progress handler's "still
 * running" line, which is not cosmetic: the page derives *busy* from the phase
 * and disables every button while it holds, and this handler posts no `ready`
 * afterwards — so a coverage query that announced itself would leave the
 * workspace disabled behind a query the reader never ran. It is exactly how a
 * two-tab run hung with `Re-download data` permanently greyed out.
 *
 * **It never raises.** A failure here means the date controls stay unbounded,
 * which is where they were before this message existed. An error banner over
 * the workspace for a background probe would report a problem the reader
 * cannot act on, about something they did not do.
 */
function coverage(): void {
  try {
    const database = requireDb()
    const corpus = runSql(database, COVERAGE_SQL, { limit: 1, quiet: true }).rows[0] ?? []
    // Guarded by the same rule every other KEV query is: the table exists only
    // once a catalog has been applied, and a copy without one must answer "no
    // KEV dates" rather than fail the whole message (M6, D-077).
    const kev =
      localKev(database) === null
        ? []
        : (runSql(database, KEV_COVERAGE_SQL, { limit: 1, quiet: true }).rows[0] ?? [])
    post({
      type: 'coverage',
      coverage: {
        publishedMin: seconds(corpus[0]),
        publishedMax: seconds(corpus[1]),
        updatedMin: seconds(corpus[2]),
        updatedMax: seconds(corpus[3]),
        yearMin: seconds(corpus[4]),
        yearMax: seconds(corpus[5]),
        kevAddedMin: seconds(kev[0]),
        kevAddedMax: seconds(kev[1]),
        kevDueMin: seconds(kev[2]),
        kevDueMax: seconds(kev[3]),
      } satisfies Coverage,
    })
  } catch {
    // No copy, a reset that raced the tier check, or a stale cancellation flag
    // interrupting a query this handler never armed.
    post({ type: 'coverage', coverage: NO_COVERAGE })
  }
}

/**
 * One page of the vendor or product catalog (UI polish, 2026-08-16).
 *
 * Keyset pagination on the primary key rather than one statement, because the
 * hosted tier caps a statement at 20,000 rows (`MAX_ROWS` in `api/sql.php`)
 * and there are 80,213 products. The same page size runs locally, so both
 * tiers walk the same statements — the hosted-parity property (D-084).
 *
 * The product page carries how many CVE-product rows list each product, from
 * the `(product_id, cve_id)` index — a range count per row, cheap enough for
 * a one-off read and what lets the picker rank Cisco above "Francisco".
 */
const CATALOG_PAGE = 20_000
const CATALOG_VENDOR_SQL = 'SELECT id, name FROM vendor WHERE id > ? ORDER BY id LIMIT ?'
const CATALOG_PRODUCT_SQL =
  'SELECT p.id, p.vendor_id, p.name, ' +
  '(SELECT count(*) FROM cve_prod cp WHERE cp.product_id = p.id) ' +
  'FROM product p WHERE p.id > ? ORDER BY p.id LIMIT ?'
/** A hard stop on how many pages are walked, so a corrupt copy cannot loop. */
const CATALOG_MAX_PAGES = 40

/**
 * Every vendor and product name, for the canvas pickers. The same discipline
 * as `coverage`: nobody asked, so it reports no phase and never raises — a
 * copy whose catalog cannot be read gets pickers that accept typed names,
 * which is what a filter is anyway.
 */
function catalog(): void {
  try {
    const database = requireDb()
    const vendors: Catalog['vendors'] = []
    let after = 0
    for (let page = 0; page < CATALOG_MAX_PAGES; page += 1) {
      const rows = runSql(database, CATALOG_VENDOR_SQL, {
        params: [after, CATALOG_PAGE],
        limit: CATALOG_PAGE,
        quiet: true,
      }).rows
      for (const row of rows) {
        const id = Number(row[0])
        if (!Number.isInteger(id)) continue
        vendors.push([id, String(row[1] ?? '')])
        after = id
      }
      if (rows.length < CATALOG_PAGE) break
    }
    const products: Catalog['products'] = []
    after = 0
    for (let page = 0; page < CATALOG_MAX_PAGES; page += 1) {
      const rows = runSql(database, CATALOG_PRODUCT_SQL, {
        params: [after, CATALOG_PAGE],
        limit: CATALOG_PAGE,
        quiet: true,
      }).rows
      for (const row of rows) {
        const id = Number(row[0])
        if (!Number.isInteger(id)) continue
        products.push([id, Number(row[1]), String(row[2] ?? ''), Number(row[3]) || 0])
        after = id
      }
      if (rows.length < CATALOG_PAGE) break
    }
    post({ type: 'catalog', catalog: { vendors, products } })
  } catch {
    post({ type: 'catalog', catalog: null })
  }
}

/** A cell as a finite number, or null — an empty table's `min()` is NULL. */
function seconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
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
  // Before anything is compiled: the `kev` table only exists once a catalog has
  // been loaded, and a KEV predicate against a copy that has none would fail
  // with `no such table` — or, if the table were created empty on open, would
  // quietly answer that nothing is known to be exploited (M6).
  if (usesKev(filters, request.groupBy)) assertKevLoaded(database)
  report('query', null, 'Running query')

  finishQuery('search', () => {
    // Preserving an empty resolution is what keeps "no vendor is called that"
    // and "no CVE matches that vendor" different answers (`resolveFilters`).
    const { resolved, unmatched } = resolveFilters(database, filters)

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
      // The builders put one sentinel row beyond this limit in SQL. Seeing it is
      // how runSql distinguishes an exact-size answer from a capped one.
      limit: built.limit,
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

/**
 * Resolve every lookup axis a `Filters` names, once.
 *
 * Shared by `search`, `report` and `export` so the three cannot disagree about
 * what an unmatched name means: `undefined` is "no filter on this axis" and an
 * empty array is "these names exist nowhere in this copy", which compiles to
 * false rather than to nothing (lib/filters.ts).
 */
function resolveFilters(
  database: Database,
  filters: Filters
): { resolved: Resolved; unmatched: Unmatched[] } {
  const resolved: Resolved = {}
  const unmatched: Unmatched[] = []
  for (const axis of LOOKUP_AXES) {
    const outcome = resolveAxis(database, axis, filters[axis])
    if (filters[axis]?.some((value) => value.trim())) resolved[axis] = outcome.ids
    if (outcome.unmatched.length) unmatched.push({ axis, values: outcome.unmatched })
  }
  return { resolved, unmatched }
}

/**
 * Run a report definition (M4).
 *
 * The definition is **re-validated here**, not trusted because the page sent
 * it. The page may have built it from a URL fragment a stranger wrote, from an
 * older build's `localStorage`, and from M7 from a model's tool call — and the
 * Worker is the last place before SQL. `parseReport` refuses an unknown
 * dimension by name rather than defaulting past it (D-069), so a definition
 * this build cannot honour produces an error the user can read instead of a
 * chart of something else.
 */
function runReport(request: ReportRequest): void {
  const database = requireDb()
  const parsed = parseReport(request.report)
  if (!parsed.ok) throw new Error(parsed.error)
  const definition = parsed.report
  const filters: Filters = definition.filters ?? {}
  // A report arrives from a URL fragment and, in M7, from a model, so this is
  // the last place before SQL that can tell a KEV report from a KEV report this
  // copy cannot answer (M6).
  if (usesKev(filters, definition.rows, definition.series)) assertKevLoaded(database)
  report('query', null, 'Running report')

  finishQuery('report', () => {
    const { resolved, unmatched } = resolveFilters(database, filters)
    const rowCap = definition.limit ?? (definition.chart === 'table' ? TABLE_ROWS : CHART_ROWS)
    const built = crossSql(filters, resolved, definition.rows, definition.series, { rows: rowCap })
    const result = runSql(database, built.sql, { params: built.params, limit: built.limit })

    let matches: number | null = null
    if (request.count !== false) {
      const counted = countSql(filters, resolved)
      const rows = runSql(database, counted.sql, { params: counted.params, limit: 1, quiet: true })
      const value = rows.rows[0]?.[0]
      matches = typeof value === 'number' ? value : null
    }

    report(
      'ready',
      1,
      `${result.rows.length.toLocaleString()} buckets in ${result.ms} ms${result.truncated ? ' (capped)' : ''}`
    )
    post({
      type: 'result',
      kind: 'report',
      result,
      matches,
      unmatched,
      report: definition,
      state: filters.state === 'rejected' || filters.state === 'all' ? filters.state : 'published',
    })
  })
}

/** One bounded detail section, with the sentinel row turned into a truncation flag. */
function section(
  database: Database,
  query: DetailQuery
): { rows: unknown[][]; truncated: boolean } {
  const result = runSql(database, query.sql, {
    params: query.params,
    limit: query.limit,
    quiet: true,
  })
  return { rows: result.rows, truncated: result.truncated }
}

function text(value: unknown): string {
  return typeof value === 'string'
    ? value
    : value === null || value === undefined
      ? ''
      : String(value)
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * A nullable text column, keeping NULL distinct from `''`.
 *
 * The difference is the whole point of three of D-070's five fields: "this
 * record has no title" and "this record's title is the empty string" would
 * render identically as `''`, and only the first is true.
 */
function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value)
}

/**
 * One record in full (M4).
 *
 * Five queries rather than one join, each bounded (lib/detail.ts). A record
 * that does not exist is `detail: null` rather than an error: "no record has
 * that id" is an answer, and reporting it as a failure would send the reader
 * looking for a broken app instead of a typo.
 */
function detail(cveId: string): void {
  const database = requireDb()
  // Shaped before it becomes a query, because this arrives from a URL fragment
  // and, in M7, from a model. Not a claim that the record exists.
  if (!isCveId(cveId)) throw new Error(`not a CVE identifier: ${String(cveId).slice(0, 40)}`)
  report('query', null, 'Reading record')

  finishQuery('detail', () => {
    const payload = readDetail(database, cveId)
    if (!payload) {
      report('ready', 1, 'no such record')
      post({ type: 'detail', cveId, detail: null })
      return
    }
    report('ready', 1, `${payload.record.cve} in ${payload.ms} ms`)
    post({ type: 'detail', cveId, detail: payload })
  })
}

/**
 * Read one record in full, or null when nothing carries that id.
 *
 * Separated from the message handling above because the chat layer's
 * `cve_detail` tool reads the *same* record through the same five bounded
 * queries (M7). Two readers assembling a `CveDetail` from their own joins is
 * how the panel and the chat answer end up disagreeing about a record.
 */
function readDetail(database: Database, cveId: string): CveDetail | null {
  {
    const started = performance.now()
    const found = section(database, recordSql(cveId))
    const row = found.rows[0]
    if (!row) return null

    const cwes = section(database, cwesSql(cveId))
    const products = section(database, productsSql(cveId))
    const versions = section(database, versionsSql(cveId))
    const references = section(database, referencesSql(cveId))
    // Only when this copy holds a catalog: without one the table does not
    // exist, and a detail view that failed on `no such table` would make the
    // overlay's absence look like a broken record (M6).
    const kevRow = localKev(database) ? section(database, kevSql(cveId)).rows[0] : undefined
    const truncated: string[] = []
    for (const [name, part] of [
      ['CWEs', cwes],
      ['affected products', products],
      ['version ranges', versions],
      ['references', references],
    ] as const) {
      if (part.truncated) truncated.push(name)
    }

    const payload: CveDetail = {
      record: {
        cve: text(row[0]),
        state: num(row[1]),
        year: num(row[2]),
        published: num(row[3]),
        updated: num(row[4]),
        cvssVersion: num(row[5]),
        score: num(row[6]),
        severity: num(row[7]),
        vector: row[8] === null ? null : text(row[8]),
        cna: row[9] === null ? null : text(row[9]),
        // Kept as null rather than '': a record with no English description is
        // a fact the UI has to state, and an empty string would render as a
        // blank box indistinguishable from a layout bug (D-023). The same holds
        // for the three below, where null additionally means something specific
        // — "nobody assessed this" rather than a code (D-070).
        description: nullableText(row[10]),
        title: nullableText(row[11]),
        reason: nullableText(row[12]),
        reserved: num(row[13]),
        ssvcExpl: num(row[14]),
        ssvcAuto: num(row[15]),
        ssvcImpact: num(row[16]),
      },
      cwes: cwes.rows.map((entry) => ({ cwe: text(entry[0]), descr: text(entry[1]) })),
      products: products.rows.map((entry) => ({
        vendor: text(entry[0]),
        product: text(entry[1]),
        defaultStatus: num(entry[2]),
      })),
      versions: versions.rows.map((entry): DetailVersion => ({
        vendor: text(entry[0]),
        product: text(entry[1]),
        status: num(entry[2]),
        version: entry[3] === null ? null : text(entry[3]),
        lt: entry[4] === null ? null : text(entry[4]),
        lte: entry[5] === null ? null : text(entry[5]),
        vtype: entry[6] === null ? null : text(entry[6]),
        defaultStatus: num(entry[7]),
      })),
      references: references.rows.map((entry): DetailReference => ({
        url: text(entry[0]),
        host: text(entry[1]),
      })),
      kev: kevFrom(kevRow),
      truncated,
      ms: Math.round(performance.now() - started),
    }

    return payload
  }
}

/**
 * One `kevSql` row as a `DetailKev`, or null when there is no row.
 *
 * One reader, because the detail view and the chat layer's `kev_lookup` ask the
 * same question of the same table and a second assembly here is how they would
 * come to disagree about a record — the same reason `readDetail` exists rather
 * than two copies of the five section queries.
 */
function kevFrom(row: unknown[] | undefined): DetailKev | null {
  if (!row) return null
  return {
    added: text(row[0]),
    due: text(row[1]),
    name: text(row[2]),
    description: text(row[3]),
    action: text(row[4]),
    // Null stays null: it means CISA stated something this build does not read,
    // which is not the same as `Unknown` — that is CISA having looked (D-076).
    ransomware: num(row[5]),
    notes: text(row[6]),
    cwes: parseCwes(row[7]),
    vendor: text(row[8]),
    product: text(row[9]),
  }
}

/**
 * Execute one chat tool call (M7, D-044).
 *
 * Every arm is a read that already exists for a deterministic surface —
 * `crossSql`, `rowsSql`, `readDetail`, `kevSql`, and the console's guarded
 * `runSql`. That is the containment story, and it is structural: there is no
 * arm that fetches, writes or takes a path, so no argument can produce one.
 * A model cannot reach a code path the UI could not.
 *
 * Failures become a **refusal outcome** rather than an error message. A tool
 * call is one step inside a conversation the page is orchestrating: an error
 * with no call id attached leaves the loop waiting for an answer that will
 * never come, and a refusal is something the model can be told and can act on
 * ("this copy has no KEV catalog" is an answer).
 *
 * **A cancelled call answers too.** `cancelled` carries a kind and no id, so a
 * loop waiting on this call's id would wait forever — a spinner and a Stop
 * button that has already been pressed. So the cancellation path posts a
 * `toolResult` as well: the `cancelled` message is still what the UI reports,
 * and this is what settles the promise. Every path out of here posts exactly
 * one `toolResult` for the id it was given.
 */
function runTool(id: string, call: ToolCall): void {
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)
  report('query', null, `Running ${call.name}`)

  finishQuery(
    'tool',
    () => {
      let outcome: ToolOutcome
      try {
        // `requireDb` inside the guard, not above it: "there is no local copy"
        // is as much a refusal the model should hear as a KEV question asked of
        // a copy with no catalog, and thrown from out here it would reach the
        // page with no call id on it.
        outcome = executeTool(requireDb(), call)
      } catch (error) {
        if (error instanceof Cancelled) throw error
        outcome = {
          kind: 'refused',
          tool: call.name,
          error: error instanceof Error ? error.message : String(error),
        }
      }
      const ms = elapsed()
      // A refusal is not a success, and the progress line is the only place the
      // difference shows for a user who is not reading the panel.
      report(
        'ready',
        1,
        outcome.kind === 'refused' ? `${call.name} refused` : `${call.name} in ${ms} ms`
      )
      post({ type: 'toolResult', id, outcome, ms })
    },
    () => {
      post({
        type: 'toolResult',
        id,
        outcome: { kind: 'refused', tool: call.name, error: 'stopped before it finished' },
        ms: elapsed(),
      })
    }
  )
}

function executeTool(database: Database, call: ToolCall): ToolOutcome {
  switch (call.name) {
    case 'aggregate': {
      // Re-validated here, not trusted because the page validated it. The page
      // is not the last gate before SQL; this is — and this definition came out
      // of a model, which is the sharpest case `parseReport` exists for (D-069).
      const parsed = parseReport(call.report)
      if (!parsed.ok) throw new Error(parsed.error)
      const definition = parsed.report
      const filters: Filters = definition.filters ?? {}
      if (usesKev(filters, definition.rows, definition.series)) assertKevLoaded(database)
      const { resolved, unmatched } = resolveFilters(database, filters)
      const rowCap = definition.limit ?? (definition.chart === 'table' ? TABLE_ROWS : CHART_ROWS)
      const built = crossSql(filters, resolved, definition.rows, definition.series, {
        rows: rowCap,
      })
      const result = runSql(database, built.sql, { params: built.params, limit: built.limit })
      // Always counted, unlike `search`, where the count is opt-in because over
      // the whole corpus with no filters it is a scan. Here it is usually the
      // answer — "how many CRITICAL CVEs" is a count, not a chart — and a model
      // told only "12 buckets" would have to guess the total or fetch it in a
      // second round trip against an 8B model on one GPU.
      const counted = countSql(filters, resolved)
      const rows = runSql(database, counted.sql, { params: counted.params, limit: 1, quiet: true })
      const value = rows.rows[0]?.[0]
      return {
        kind: 'aggregate',
        report: definition,
        result,
        matches: typeof value === 'number' ? value : null,
        unmatched,
      }
    }
    case 'search_records': {
      const definition = parseReport(searchReport(call))
      if (!definition.ok) throw new Error(definition.error)
      const filters = definition.report.filters
      if (usesKev(filters, null)) assertKevLoaded(database)
      const { resolved, unmatched } = resolveFilters(database, filters)
      const built = rowsSql(filters, resolved, {
        limit: call.limit,
        sort: definition.report.sort,
      })
      const result = runSql(database, built.sql, { params: built.params, limit: built.limit })
      const counted = countSql(filters, resolved)
      const rows = runSql(database, counted.sql, { params: counted.params, limit: 1, quiet: true })
      const value = rows.rows[0]?.[0]
      return {
        kind: 'records',
        report: definition.report,
        result,
        matches: typeof value === 'number' ? value : null,
        unmatched,
      }
    }
    case 'cve_detail': {
      if (!isCveId(call.cveId))
        throw new Error(`not a CVE identifier: ${String(call.cveId).slice(0, 40)}`)
      return { kind: 'detail', cveId: call.cveId, detail: readDetail(database, call.cveId) }
    }
    case 'kev_lookup': {
      if (!isCveId(call.cveId))
        throw new Error(`not a CVE identifier: ${String(call.cveId).slice(0, 40)}`)
      // Refused, not answered. A copy with no catalog cannot say "not
      // known-exploited" — that would be inventing CISA's silence out of our
      // own (D-077), and it is the one wrong answer this tool could give that
      // a reader would have no way to notice.
      const catalog = localKev(database)
      if (!catalog) {
        throw new Error(
          'this browser holds no CISA KEV catalog, so nothing can be said about whether ' +
            'the record is known-exploited — refresh the catalog from the Data tab first'
        )
      }
      // `lower(cve_id) = ?`, the form every other id lookup uses
      // (lib/detail.ts) — not `= upper(id)`. The two agree only for as long as
      // every stored id happens to be uppercase, and this call runs both: a
      // divergence would report "this copy has no such record" beside a KEV
      // entry read from the same row.
      const probe = existsSql(call.cveId)
      const exists = runSql(database, probe.sql, {
        params: probe.params,
        limit: 1,
        quiet: true,
      })
      return {
        kind: 'kev',
        cveId: call.cveId,
        kev: kevFrom(section(database, kevSql(call.cveId)).rows[0]),
        catalog,
        known: exists.rows.length > 0,
      }
    }
    case 'sql': {
      // The same guarded path the SQL console uses: the authorizer refuses
      // every action but reading, from inside SQLite's parser (D-065), and the
      // caps are memory bounds on this Worker. Nothing inspects the text.
      //
      // Note what this arm *cannot* do that the others can: `usesKev` has no
      // opinion about arbitrary SQL, so a KEV question asked this way of a copy
      // with no catalog is not gated by `assertKevLoaded`. It is safe only
      // because such a copy has no `kev` table at all, so the statement errors
      // into a refusal rather than answering that nothing is known to be
      // exploited (D-077). If that table is ever created empty on open, this
      // arm becomes the hole.
      const result = runSql(database, call.sql, {
        limit: CONSOLE_ROW_LIMIT,
        guarded: true,
        // D-044 asks for "row-capped, timed-out", and the console has a human
        // watching a Cancel button where this has a model in a loop.
        deadlineMs: TOOL_DEADLINE_MS,
      })
      return { kind: 'sql', result }
    }
    case 'compute':
      // Never runs here: the page routes `compute` to its sandbox (D-088)
      // before a `tool` message would be sent. Refused by name rather than
      // run, so a stray message cannot make this Worker — which holds the
      // database and OPFS — evaluate anything.
      return {
        kind: 'refused',
        tool: 'compute',
        error: 'compute runs in the page sandbox, not in the database worker',
      }
    default:
      // Unreachable through `parseToolCall`, and reachable if anything ever
      // posts a `tool` request without going through it. Falling off the end of
      // the switch returns `undefined`, which TypeScript accepts as exhaustive
      // and which the page then dereferences — so the last gate before SQL
      // refuses by name rather than by omission.
      throw new Error(`no tool called ${String((call as { name?: unknown }).name).slice(0, 40)}`)
  }
}

/** MITRE's notice, out of the copy's own `meta` — never a constant in this build (D-008). */
function localNotice(database: Database): string {
  const value = database.selectValue("SELECT v FROM meta WHERE k = 'notice'")
  return typeof value === 'string' ? value : ''
}

function localRevision(database: Database): number | null {
  const value = database.selectValue("SELECT v FROM meta WHERE k = 'rev'")
  return typeof value === 'number' ? value : null
}

/**
 * Write an export, in batches (M4).
 *
 * The loop is the point. Each pass runs one bounded query, serializes it, posts
 * the text and drops it — so the Worker's live set is one batch of records
 * rather than the match set, the same bound the import holds itself to (D-041).
 * Nothing here accumulates the file.
 *
 * The cap is disclosed twice: in the file's own preamble and in the `exported`
 * message the UI reports from. A truncated export that looked complete would be
 * read as complete, which is worse than no export.
 */
function exportData(request: ExportRequest): void {
  // Local-only by design (D-084): a record export batches up to the export cap
  // through repeated queries, which on the hosted tier is a stream of server
  // round trips racing a rate limit — a partial file by construction. The
  // refusal names the way out rather than the mechanism.
  if (!db) {
    throw new Error(
      'exports run on your local copy of the corpus — use "Make available offline" first'
    )
  }
  const database = requireDb()
  const parsed = parseReport(request.report)
  if (!parsed.ok) throw new Error(parsed.error)
  const definition = parsed.report
  const filters: Filters = definition.filters ?? {}
  const cells = request.kind === 'cells'
  if (usesKev(filters, definition.rows, definition.series)) assertKevLoaded(database)
  // Whether the *file* carries KEV columns, which is a different question from
  // whether the report filters on KEV: an export is a copy (D-071), so a copy
  // made from a database that holds the catalog carries it. Absent columns say
  // "this export does not cover KEV"; empty ones would say every record is not
  // known-exploited, and which of those it is *is* the overlay's claim (M6).
  const kevCatalog = localKev(database)
  const withKev = kevCatalog !== null && !cells
  // Provenance is a separate question from columns. A *cells* export of a
  // report whose axis is `kev` consists of nothing but KEV assertions and
  // carries no KEV columns — so gating the provenance line on `withKev` left
  // the one export that is entirely about the catalog as the one that does not
  // say which catalog. M6's exit criteria ask for provenance wherever KEV is
  // asserted, and D-076 §1 grounds it in the rider CC0 does not waive.
  const assertsKev = withKev || (cells && usesKev(filters, definition.rows, definition.series))
  report('export', null, 'Preparing export')

  finishQuery('export', () => {
    const started = performance.now()
    const { resolved } = resolveFilters(database, filters)

    // The count comes first because the header has to be able to say whether
    // the file is the whole answer, and the header is written before any row.
    const counted = countSql(filters, resolved)
    const countRows = runSql(database, counted.sql, {
      params: counted.params,
      limit: 1,
      quiet: true,
    })
    const countValue = countRows.rows[0]?.[0]
    const matches = typeof countValue === 'number' ? countValue : null

    const first = cells
      ? crossSql(filters, resolved, definition.rows, definition.series, {
          rows: definition.limit ?? (definition.chart === 'table' ? TABLE_ROWS : CHART_ROWS),
        })
      : rowsSql(filters, resolved, {
          limit: EXPORT_BATCH,
          sort: definition.sort,
          full: true,
          kev: withKev,
        })
    const truncated = !cells && matches !== null && matches > EXPORT_LIMIT

    // A cell export is small enough to run before its header is emitted. That
    // ordering is load-bearing: unlike a record export, its bound is a cell
    // cap rather than EXPORT_LIMIT, so a dense cross-tab can hit the sentinel.
    // Refuse before writing any bytes instead of producing a partial file whose
    // ordinary record-cap preamble would incorrectly call it complete.
    const cellResult = cells
      ? runSql(database, first.sql, { params: first.params, limit: first.limit })
      : null
    // A one-axis group uses its sentinel to say there are more buckets than
    // the report explicitly requested; exporting those requested rows is
    // exactly what "these numbers" promises. In a two-axis result, by contrast,
    // the sentinel can only be the independent hard cell cap.
    if (definition.series !== null && cellResult?.truncated) {
      throw new Error(
        'This aggregate reached the cell cap and cannot be exported as a complete table. ' +
          'Use fewer buckets or narrower filters, then run the report again.'
      )
    }

    const header: ExportHeader = {
      notice: localNotice(database),
      columns: cells ? [...CELL_COLUMNS] : [...recordColumns(withKev)],
      title: request.title,
      revision: localRevision(database),
      sql: first.sql,
      params: first.params,
      matches,
      truncated,
      // Provenance travels with the assertion: CC0 requires no notice (D-076
      // §1), but "listed in CISA's KEV" is a statement about a *dated* catalog,
      // and a file that made it without saying which one invites the reader to
      // treat it as current forever.
      kev:
        assertsKev && kevCatalog
          ? { version: kevCatalog.version, released: kevCatalog.released }
          : null,
    }
    const writer = exportWriter(request.format, header)
    post({ type: 'exportChunk', text: writer.begin() })

    let written = 0
    if (cells) {
      // A cross-tab cell is [bucket, label, series, series_label, cves] or
      // [bucket, label, cves]; the file carries the *labels* and the count,
      // because an interned id means nothing outside the artifact that issued
      // it (D-055).
      const rows = cellResult!.rows.map((row) =>
        definition.series === null
          ? [row[1] ?? row[0], '', row[2]]
          : [row[1] ?? row[0], row[3] ?? row[2], row[4]]
      )
      post({ type: 'exportChunk', text: writer.rows(rows) })
      written = rows.length
    } else {
      let offset = 0
      for (;;) {
        const batch = rowsSql(filters, resolved, {
          limit: Math.min(EXPORT_BATCH, EXPORT_LIMIT - written),
          offset,
          sort: definition.sort,
          full: true,
          kev: withKev,
        })
        const result = runSql(database, batch.sql, {
          params: batch.params,
          limit: batch.limit,
          quiet: true,
        })
        if (result.rows.length === 0) break
        post({ type: 'exportChunk', text: writer.rows(result.rows) })
        written += result.rows.length
        offset += result.rows.length
        report(
          'export',
          matches ? Math.min(1, written / Math.min(matches, EXPORT_LIMIT)) : null,
          `${written.toLocaleString()} records written`
        )
        if (written >= EXPORT_LIMIT) break
        if (!result.truncated) break
      }
    }

    post({ type: 'exportChunk', text: writer.end() })
    const ms = Math.round(performance.now() - started)
    report('ready', 1, `${written.toLocaleString()} rows exported in ${ms} ms`)
    post({
      type: 'exported',
      filename: exportFilename(request.title, writer.extension),
      mime: writer.mime,
      records: written,
      matches,
      truncated: truncated && written >= EXPORT_LIMIT,
      ms,
    })
  })
}

function requireDb(): Database {
  if (db) return db
  // The hosted tier (D-084): same compiled SQL, same handlers, executed by
  // `api/sql.php` against the server's copy. Only after a `hosted` probe
  // succeeded — the flag is the difference between "this visitor is on the
  // hosted tier" and "the status check has not finished yet".
  if (remoteEligible && sessionRemote) {
    remoteDb ??= new RemoteDb() as unknown as Database
    return remoteDb
  }
  throw new Error('no database — download the corpus first')
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
    kev: null,
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
    if ('options' in request) {
      sessionSchema = speaks(request.options)
      // A latch, never a re-enable: `?remote=0` opts out of the hosted tier for
      // the session, and the opt-out must survive a later request whose options
      // happen not to carry the flag. Recomputing `!== false` each time would
      // flip it back on the first such message, sending predicates off-device
      // after the user said not to. Only `remote: false` moves it, and only in
      // the off direction; reload is the way back on.
      if (request.options?.remote === false) sessionRemote = false
      const forced = request.options?.probe
      const next = forced === 'async' || forced === 'unavailable' ? forced : null
      // Re-probe when the knob changes, or a reload with `?probe=` would be
      // answered from the verdict cached before it was set.
      if (next !== sessionProbe) capabilities = null
      sessionProbe = next
    }
    switch (request.type) {
      case 'status':
        // The gate's verdict rides alongside the first thing the page asks
        // for, so it is on screen before the Download button can be pressed.
        post({ type: 'environment', ...(await environment()) })
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
        // One writer at a time, across tabs (M5). The lock covers the catch-up
        // too: they are one operation from the user's point of view, and
        // releasing between them would let another tab's sync land against a
        // database this one is about to promote over.
        await asWriter('download', async () => {
          await importSnapshot(request.options)
          // Not a separate step the user has to know about: the snapshot is
          // published at its own revision and the head moves on daily (D-058),
          // so a download that stopped at `snapshot.rev` would be stale the
          // moment it finished. `imported` has already been posted by the time
          // this runs, so a catch-up that fails reports itself without
          // retracting a download that succeeded.
          await syncToHead(request.options)
          // Then KEV, after the catch-up (D-063's ordering, M6's shape
          // decision): a replacement destroyed the overlay along with the
          // database it lived in, so a download ends by rebuilding it. It
          // cannot fail this operation — `refreshKev` reports its own outcome.
          await refreshKev(request.options)
        })
        break
      case 'sync':
        await asWriter('sync', async () => {
          await syncToHead(request.options)
          // A sync refreshes the catalog too, because CISA's cadence is roughly
          // the ingest's and "get me current" should mean both. The fetch is
          // what compares versions: 1.5 MB is cheaper than a UI that makes the
          // user decide which kind of current they meant.
          await refreshKev(request.options)
        })
        break
      case 'kev':
        // Its own action as well, because a refresh that failed has to be
        // retryable without re-running a download or a sync — and a copy
        // imported before this build existed has no catalog at all.
        await asWriter('kev', () => refreshKev(request.options))
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
      case 'report':
        runReport(request.request)
        break
      case 'detail':
        detail(request.cveId)
        break
      case 'export':
        exportData(request.request)
        break
      case 'tool':
        runTool(request.id, request.call)
        break
      case 'coverage':
        coverage()
        break
      case 'catalog':
        catalog()
        break
      case 'bench':
        bench()
        break
      case 'probe':
        post({ type: 'environment', ...(await environment()) })
        break
      case 'hosted':
        await hostedStatus()
        break
      case 'reset':
        // A writer like the other two: `clearStorage` deletes every OPFS entry
        // this app owns, and doing that while another tab is mid-download meant
        // deleting the live copy, failing on the staging slot the downloader
        // holds open, telling the user the clear failed — and then watching the
        // downloader promote a full corpus anyway (M5's data-plane review).
        await asWriter('reset', () => reset())
        break
    }
  } catch (error) {
    report('error', null, '')
    const message = error instanceof Error ? error.message : String(error)
    // A tool call that failed before `runTool`'s own guard still has to come
    // back *as that call*: the chat loop is waiting on this id, and a bare
    // `error` message would leave the conversation stopped with a spinner and
    // no way to retry — the silence D-052 forbids, in a new long-running thing.
    if (request.type === 'tool') {
      post({
        type: 'toolResult',
        id: request.id,
        outcome: { kind: 'refused', tool: request.call?.name ?? 'unknown', error: message },
        ms: 0,
      })
      await status().catch(() => undefined)
      return
    }
    const kind: QueryKind | undefined =
      request.type === 'console'
        ? 'console'
        : request.type === 'search'
          ? 'search'
          : request.type === 'report'
            ? 'report'
            : request.type === 'detail'
              ? 'detail'
              : request.type === 'export'
                ? 'export'
                : request.type === 'query' || request.type === 'bench'
                  ? 'demo'
                  : undefined
    post({ type: 'error', message, ...(kind ? { kind } : {}) })
    // Resync, and on the staged path this is where the good news arrives: a
    // failed download leaves the previous database untouched, so `status` says
    // "still ready" and the page keeps its query surface instead of offering a
    // fresh Download. A failed clear may equally have left a copy behind. The
    // page cannot work either of those out from an error string.
    await status().catch(() => undefined)
  }
}
