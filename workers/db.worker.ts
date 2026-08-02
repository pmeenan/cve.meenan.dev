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
 */
import initBrotli, { decompress as brotliDecompress } from 'brotli-dec-wasm/web'
import type { Database, SAHPoolUtil, Sqlite3Static } from '@sqlite.org/sqlite-wasm'

import { isNotFound, writeFully } from '../lib/opfs'
import { BENCH_QUERIES } from '../lib/queries'
import {
  assertUsable,
  chunkUrl,
  manifestUrl,
  DEFAULT_CACHE_MIB,
  DEFAULT_CONCURRENCY,
  DEFAULT_VFS,
  type BenchResult,
  type ChunkEntry,
  type ImportOptions,
  type Manifest,
  type Progress,
  type Request,
  type Response,
  type Timings,
  type Vfs,
} from '../lib/protocol'

/** The database's name inside OPFS. */
const DB_FILE = 'cve.sqlite'

let sqlite3: Sqlite3Static | null = null
let db: Database | null = null
/** Installed lazily: it costs a directory of pre-opened handles (Q-004). */
let sahPool: SAHPoolUtil | null = null
/** Which VFS the open database came through, so `reset` cleans the right one. */
let openedVfs: Vfs = DEFAULT_VFS

function post(message: Response): void {
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

async function fetchManifest(): Promise<Manifest> {
  const response = await fetch(manifestUrl(), { cache: 'no-cache' })
  if (!response.ok) throw new Error(`manifest: HTTP ${response.status}`)
  const manifest = (await response.json()) as Manifest
  assertUsable(manifest)
  return manifest
}

interface ChunkResult {
  chunk: ChunkEntry
  bytes: Uint8Array
  fetchMs: number
  digestMs: number
  decompressMs: number
}

async function loadChunk(manifest: Manifest, chunk: ChunkEntry): Promise<ChunkResult> {
  const started = performance.now()
  // No Content-Encoding on these: they are opaque bytes and we decode them
  // ourselves, so progress and resume both count the bytes that crossed the
  // wire (D-040).
  const response = await fetch(chunkUrl(manifest, chunk))
  if (!response.ok) throw new Error(`${chunk.name}: HTTP ${response.status}`)
  const compressed = new Uint8Array(await response.arrayBuffer())
  const fetched = performance.now()

  const actual = await digest(compressed)
  // Stamped separately: verifying 62.7 MB of SHA-256 is not decompression, and
  // folding it into decompressMs would publish a number under the wrong name.
  const digested = performance.now()
  if (actual !== chunk.sha256) {
    throw new Error(`${chunk.name}: checksum mismatch`)
  }

  const bytes = brotliDecompress(compressed)
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
  limit: number
): AsyncGenerator<ChunkResult> {
  const inFlight = new Map<number, Promise<ChunkResult>>()
  let started = 0
  const fill = () => {
    while (inFlight.size < limit && started < chunks.length) {
      const index = started++
      const pending = loadChunk(manifest, chunks[index]!)
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
 * access handle. Needs COOP/COEP, which production serves (D-030).
 */
async function writeToOpfsFile(rawBytes: number, pull: Pull): Promise<number> {
  // Timed from here, not from the first write: `importThroughSahPool` cannot
  // separate its own handle setup from its writes, so this path must include
  // the same span — opening the handle, the 377 MB truncate, and the close —
  // or the two VFSes get compared under one column heading while measuring
  // different things.
  const started = performance.now()
  let pullMs = 0
  const root = await opfsRoot()
  const handle = await root.getFileHandle(DB_FILE, { create: true })
  const access = await handle.createSyncAccessHandle()
  try {
    access.truncate(rawBytes)
    for (;;) {
      const pullStart = performance.now()
      const result = await pull()
      pullMs += performance.now() - pullStart
      if (!result) break
      // Positional write: each chunk carries its absolute offset, so resuming
      // a download is just "which offsets are done" (M2). `writeFully` because
      // a short write is permitted by the spec and silently corrupts the file.
      writeFully(access, result.bytes, result.chunk.offset)
    }
    access.flush()
  } finally {
    // Awaited deliberately: these are declared synchronous in the current spec
    // but Chrome has shipped promise-returning forms, and the exclusive lock is
    // not released until close() settles. Opening the OPFS VFS while it is
    // still held hangs with no error (RE-007).
    await access.close()
  }
  return performance.now() - started - pullMs
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
  await pool.importDb(`/${DB_FILE}`, async () => {
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
  const overallStart = performance.now()
  const concurrency = clamp(options.concurrency, DEFAULT_CONCURRENCY, MAX_CONCURRENCY)
  const vfs = options.vfs ?? DEFAULT_VFS
  const cacheMib = clamp(options.cacheMib, DEFAULT_CACHE_MIB, MAX_CACHE_MIB)

  report('manifest', null, 'Reading manifest')
  const manifest = await fetchManifest()
  const { chunks, raw_bytes: rawBytes } = manifest.snapshot
  const compressedTotal = chunks.reduce((sum, c) => sum + c.bytes, 0)

  // Close any open handle before replacing the file underneath it. M2 replaces
  // this with a staged file and an atomic promotion; today's import truncates
  // the live database, which is exactly why M2 lists that as a task.
  db?.close()
  db = null
  // Clear *both* VFSes first. Writing only the chosen one would leave the
  // other's copy behind — which `storedIn()` might then prefer on the next
  // reload, and which `opfsBytes()` would count into the footprint budget.
  await clearStorage()

  let fetchMs = 0
  let digestMs = 0
  let decompressMs = 0
  let writeMs = 0
  let written = 0

  const loader = orderedChunks(manifest, chunks, concurrency)
  /** One chunk, with the transport accounting both VFS paths share. */
  const pull = async (): Promise<ChunkResult | undefined> => {
    const { value, done } = await loader.next()
    if (done || !value) return undefined
    fetchMs += value.fetchMs
    digestMs += value.digestMs
    decompressMs += value.decompressMs
    written += 1
    report(
      'download',
      written / chunks.length,
      `${written} / ${chunks.length} chunks (${(compressedTotal / 1e6).toFixed(1)} MB)`
    )
    return value
  }

  report('download', 0, `0 / ${chunks.length} chunks`)
  if (vfs === 'opfs-sahpool') {
    writeMs = await importThroughSahPool(pull)
  } else {
    writeMs = await writeToOpfsFile(rawBytes, pull)
  }

  report('index', null, `Opening database — ${capabilities()}`)
  const openStart = performance.now()
  db = await openDatabase(vfs, cacheMib)
  const openMs = performance.now() - openStart

  const indexStart = performance.now()
  buildSearchIndexes(db)
  const indexMs = performance.now() - indexStart

  const records = (db.selectValue('SELECT count(*) FROM cve') as number) ?? 0
  const notice = (db.selectValue("SELECT v FROM meta WHERE k = 'notice'") as string) ?? ''

  report('ready', 1, `${records.toLocaleString()} records`)
  post({
    type: 'imported',
    notice,
    timings: {
      fetchMs: Math.round(fetchMs),
      digestMs: Math.round(digestMs),
      decompressMs: Math.round(decompressMs),
      writeMs: Math.round(writeMs),
      openMs: Math.round(openMs),
      indexMs: Math.round(indexMs),
      totalMs: Math.round(performance.now() - overallStart),
      compressedBytes: compressedTotal,
      rawBytes,
      records,
      vfs,
      concurrency,
      cacheMib,
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

/** Run the benchmark set (Q-003's query-latency budgets) in declaration order. */
function bench(): void {
  if (!db) throw new Error('no database — download the corpus first')
  const results: BenchResult[] = []
  for (const [index, query] of BENCH_QUERIES.entries()) {
    // Countable work, so this one gets real progress rather than a spinner.
    report(
      'query',
      index / BENCH_QUERIES.length,
      `${index + 1} / ${BENCH_QUERIES.length}: ${query.name}`
    )
    const started = performance.now()
    let rows = 0
    db.exec({
      sql: query.sql,
      rowMode: 'array',
      callback: () => {
        rows += 1
      },
    })
    results.push({ name: query.name, ms: Math.round(performance.now() - started), rows })
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

async function openDatabase(vfs: Vfs, cacheMib = DEFAULT_CACHE_MIB): Promise<Database> {
  if (!sqlite3) throw new Error('sqlite3 not initialised')
  // Q-004 picked `opfs`, which needs COOP/COEP — already served (D-030) —
  // over `opfs-sahpool` (D-051). Both stay reachable so the sweep in
  // tests/e2e/measure.spec.ts can re-run the comparison.
  const database =
    vfs === 'opfs-sahpool'
      ? new (await installSahPool()).OpfsSAHPoolDb(`/${DB_FILE}`)
      : new sqlite3.oo1.OpfsDb(`/${DB_FILE}`, 'c')
  openedVfs = vfs
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
 */
function buildSearchIndexes(database: Database): void {
  // The restore is in a `finally` because this is the one place that turns
  // writes back on, and `rebuild` steps 372k rows of attacker-influenced
  // description text through fts5. If that throws mid-batch, a trailing pragma
  // inside the same exec never runs and the connection stays writable for the
  // rest of its life — disarming the very defense the pragma is there to be.
  try {
    database.exec(`
      PRAGMA query_only=OFF;
      DROP TABLE IF EXISTS fts;
      DROP TABLE IF EXISTS fts_vendor;
      DROP TABLE IF EXISTS fts_product;
      CREATE VIRTUAL TABLE fts USING fts5(descr, content='cve_text', content_rowid='cve_id');
      INSERT INTO fts(fts) VALUES('rebuild');
      CREATE VIRTUAL TABLE fts_vendor USING fts5(name, content='vendor', content_rowid='id');
      INSERT INTO fts_vendor(fts_vendor) VALUES('rebuild');
      CREATE VIRTUAL TABLE fts_product USING fts5(name, content='product', content_rowid='id');
      INSERT INTO fts_product(fts_product) VALUES('rebuild');
    `)
  } finally {
    database.exec('PRAGMA query_only=ON')
  }
}

/**
 * Which VFS, if any, already holds a database. Answered from OPFS rather than
 * remembered, because the Worker has no storage of its own and a reload starts
 * it empty. `opfs` is checked first and without installing the pool, so the
 * default path never pays for the alternative.
 */
async function storedIn(): Promise<Vfs | null> {
  try {
    const root = await opfsRoot()
    const handle = await root.getFileHandle(DB_FILE)
    if ((await handle.getFile()).size > 0) return 'opfs'
  } catch {
    /* not there */
  }
  try {
    const root = await opfsRoot()
    await root.getDirectoryHandle('.opfs-sahpool')
    const pool = await installSahPool()
    if (pool.getFileNames().includes(`/${DB_FILE}`)) return 'opfs-sahpool'
  } catch {
    /* no pool directory, so nothing was ever imported through it */
  }
  return null
}

async function status(): Promise<void> {
  const vfs = await storedIn()
  if (!vfs) {
    post({ type: 'status', ready: false, rev: null, generated: null, notice: null })
    return
  }
  try {
    if (!db) {
      // Deliberately not `db ??= await openDatabase(...)`: that tests `db`,
      // awaits, and then assigns unconditionally — so a status racing an
      // import overwrites the connection the import just installed. Re-check
      // after the await and drop the loser.
      const opened = await openDatabase(vfs)
      if (db) opened.close()
      else db = opened
    }
    post({
      type: 'status',
      ready: true,
      rev: (db.selectValue("SELECT v FROM meta WHERE k = 'rev'") as number) ?? null,
      generated: (db.selectValue("SELECT v FROM meta WHERE k = 'generated'") as number) ?? null,
      // D-008 travels with the data, so it is read from the database rather
      // than remembered by the page that happened to import it.
      notice: (db.selectValue("SELECT v FROM meta WHERE k = 'notice'") as string) ?? null,
    })
  } catch {
    post({ type: 'status', ready: false, rev: null, generated: null, notice: null })
  }
}

function query(sql: string): void {
  if (!db) throw new Error('no database — download the corpus first')
  // Reported before the call, not after: `db.exec` blocks this Worker until it
  // finishes, so this is the last chance to tell anyone it started (D-052).
  // There is no progress to give — SQLite does not report any mid-statement —
  // so the phase is deliberately indeterminate rather than a fake fraction.
  report('query', null, 'Running query')
  const started = performance.now()
  const rows: unknown[][] = []
  const columns: string[] = []
  db.exec({
    sql,
    rowMode: 'array',
    columnNames: columns,
    callback: (row: unknown[]) => {
      rows.push(row)
    },
  })
  const ms = Math.round(performance.now() - started)
  report('ready', 1, `${rows.length.toLocaleString()} rows in ${ms} ms`)
  post({ type: 'rows', columns, rows, ms })
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
  await clearStorage()
  post({ type: 'status', ready: false, rev: null, generated: null, notice: null })
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
 */
async function clearStorage(): Promise<void> {
  const root = await opfsRoot()
  await root.removeEntry(DB_FILE).catch((error: unknown) => {
    if (!isNotFound(error)) throw error
  })

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
  pool.unlink(`/${DB_FILE}`)
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
    switch (request.type) {
      case 'status':
        await status()
        break
      case 'import':
        await importSnapshot(request.options)
        break
      case 'query':
        query(request.sql)
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
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    // Resync: a failed import has already closed and truncated the previous
    // database, and a failed clear may have left one behind. Either way the
    // page's idea of what exists is now stale, and it cannot work that out from
    // an error string.
    await status().catch(() => undefined)
  }
}
