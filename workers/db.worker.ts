/// <reference lib="webworker" />
/**
 * The Worker that owns the database.
 *
 * It owns it because OPFS synchronous access handles are unavailable on the
 * main thread (D-004), which makes every query asynchronous from the UI's
 * point of view regardless of framework.
 *
 * The import path is fetch -> decompress -> positional write, one chunk at a
 * time, so peak memory is bounded by chunks in flight rather than by the corpus
 * (D-040, D-041). Nothing here sends a request parameter: the manifest names
 * every file (D-032).
 */
import initBrotli, { decompress as brotliDecompress } from 'brotli-dec-wasm/web'
import type { Database, Sqlite3Static } from '@sqlite.org/sqlite-wasm'

import {
  assertUsable,
  chunkUrl,
  manifestUrl,
  type ChunkEntry,
  type Manifest,
  type Progress,
  type Request,
  type Response,
  type Timings,
} from '../lib/protocol'

/** The database's name inside OPFS. */
const DB_FILE = 'cve.sqlite'

/** How many chunks to fetch and decompress at once. Q-003 tunes this (D-041). */
const CONCURRENCY = 4

let sqlite3: Sqlite3Static | null = null
let db: Database | null = null

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
    decompressMs: decompressed - fetched,
  }
}

/**
 * Run `worker` over `items` with at most `limit` in flight. Results are handed
 * to `onResult` as they land, so a slow chunk does not hold up the writes for
 * chunks that already arrived.
 */
async function pooled<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
  onResult: (result: R) => Promise<void> | void
): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      const item = items[index]
      if (item === undefined) return
      await onResult(await worker(item))
    }
  })
  await Promise.all(runners)
}

async function importSnapshot(): Promise<void> {
  const overallStart = performance.now()

  report('manifest', null, 'Reading manifest')
  const manifest = await fetchManifest()
  const { chunks, raw_bytes: rawBytes } = manifest.snapshot
  const compressedTotal = chunks.reduce((sum, c) => sum + c.bytes, 0)

  // Close any open handle before replacing the file underneath it.
  db?.close()
  db = null

  const root = await opfsRoot()
  const handle = await root.getFileHandle(DB_FILE, { create: true })
  const access = await handle.createSyncAccessHandle()

  let fetchMs = 0
  let decompressMs = 0
  let writeMs = 0
  let written = 0

  try {
    access.truncate(rawBytes)

    report('download', 0, `0 / ${chunks.length} chunks`)
    await pooled(
      chunks,
      CONCURRENCY,
      (chunk) => loadChunk(manifest, chunk),
      (result) => {
        const started = performance.now()
        // Positional write: chunk k covers [k*chunk_bytes, ...), so chunks may
        // land out of order and resumption is just "which offsets are done".
        access.write(result.bytes as unknown as BufferSource, { at: result.chunk.offset })
        writeMs += performance.now() - started

        fetchMs += result.fetchMs
        decompressMs += result.decompressMs
        written += 1
        report(
          'download',
          written / chunks.length,
          `${written} / ${chunks.length} chunks (${(compressedTotal / 1e6).toFixed(1)} MB)`
        )
      }
    )
    access.flush()
  } finally {
    // Awaited deliberately: these are declared synchronous in the current spec
    // but Chrome has shipped promise-returning forms, and the exclusive lock is
    // not released until close() settles. Opening the OPFS VFS while it is
    // still held hangs with no error (RE-007).
    await access.close()
  }

  report('index', null, `Opening database — ${capabilities()}`)
  const openStart = performance.now()
  db = openDatabase()
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
      decompressMs: Math.round(decompressMs),
      writeMs: Math.round(writeMs),
      openMs: Math.round(openMs),
      indexMs: Math.round(indexMs),
      totalMs: Math.round(performance.now() - overallStart),
      compressedBytes: compressedTotal,
      rawBytes,
      records,
    },
  })
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

function openDatabase(): Database {
  if (!sqlite3) throw new Error('sqlite3 not initialised')
  // Q-004 picks between the `opfs` VFS and `opfs-sahpool`; this build uses
  // `opfs`, which needs COOP/COEP — already served (D-030).
  return new sqlite3.oo1.OpfsDb(`/${DB_FILE}`, 'c')
}

/**
 * Build the full-text indexes locally rather than shipping them (D-035).
 * Descriptions, vendors and products only: reference URLs would shred into
 * hosts, slugs and file names and pollute the same term space as the prose.
 */
function buildSearchIndexes(database: Database): void {
  database.exec(`
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
}

async function hasDatabase(): Promise<boolean> {
  try {
    const root = await opfsRoot()
    const handle = await root.getFileHandle(DB_FILE)
    return (await handle.getFile()).size > 0
  } catch {
    return false
  }
}

async function status(): Promise<void> {
  if (!(await hasDatabase())) {
    post({ type: 'status', ready: false, rev: null, generated: null })
    return
  }
  try {
    db ??= openDatabase()
    post({
      type: 'status',
      ready: true,
      rev: (db.selectValue("SELECT v FROM meta WHERE k = 'rev'") as number) ?? null,
      generated: (db.selectValue("SELECT v FROM meta WHERE k = 'generated'") as number) ?? null,
    })
  } catch {
    post({ type: 'status', ready: false, rev: null, generated: null })
  }
}

function query(sql: string): void {
  if (!db) throw new Error('no database — download the corpus first')
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
  post({ type: 'rows', columns, rows, ms: Math.round(performance.now() - started) })
}

async function reset(): Promise<void> {
  db?.close()
  db = null
  const root = await opfsRoot()
  await root.removeEntry(DB_FILE).catch(() => undefined)
  post({ type: 'status', ready: false, rev: null, generated: null })
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

self.onmessage = async (event: MessageEvent<Request>) => {
  try {
    await ready
    switch (event.data.type) {
      case 'status':
        await status()
        break
      case 'import':
        await importSnapshot()
        break
      case 'query':
        query(event.data.sql)
        break
      case 'reset':
        await reset()
        break
    }
  } catch (error) {
    report('error', null, '')
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
