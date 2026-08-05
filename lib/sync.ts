/**
 * Delta apply: the local half of Sync (M2).
 *
 * A delta is a step from one specific revision to the next (D-031), and this is
 * what takes it: lookups first, then tombstones, then whole-record
 * replacements, then the watermark — all inside one transaction, so a crash or
 * a refusal leaves the database exactly where it was and the watermark still
 * agreeing with the rows.
 *
 * It lives here rather than in the Worker for the reason `lib/staging.ts` and
 * `lib/search.ts` do: reaching it from there costs a 63 MB download, so every
 * guard it makes would otherwise ship unexercised. Driven through the small
 * `SyncDb` surface below, the same code runs against `node:sqlite` in
 * `tests/unit/sync.test.ts` and against SQLite/WASM in the browser.
 *
 * `pipeline/tests/apply.py` is the reference implementation the *wire format*
 * was proven sufficient against (D-055). This file has to agree with it and
 * does one thing more: it maintains the full-text indexes the client builds for
 * itself (D-035), which the pipeline has none of. That maintenance is the part
 * that can be wrong silently — see `dropText`.
 *
 * Record text is attacker-influenced (AGENTS.md rule 4). Every value here is a
 * bound parameter; the only interpolated strings are table and column names out
 * of the constants below.
 */
import { LOOKUP_ARITY } from './delta'
import { LOOKUP_ORDER, type Delta, type DeltaRecord, type LookupTable } from './protocol'
import { SEARCH_INDEXES, type SearchIndex } from './search'

/**
 * The database surface apply needs, and nothing else.
 *
 * Deliberately tiny: `Database` from `@sqlite.org/sqlite-wasm` cannot be
 * constructed outside a browser, and a test that mocked it would be testing the
 * mock. Three methods is small enough that the `node:sqlite` adapter in the
 * tests is obviously the same thing as the Worker's.
 */
export interface SyncDb {
  /** Execute one statement, binding `params` positionally. */
  run(sql: string, params?: readonly unknown[]): void
  /** The first row of a query as column values in order, or null for no rows. */
  row(sql: string, params?: readonly unknown[]): unknown[] | null
  /** Every value of a single-column query. */
  column(sql: string, params?: readonly unknown[]): unknown[]
}

/**
 * A record's dependent rows, in the order they are dropped. Every one of these
 * is keyed by `cve_id` holding the record's *row id* — which is why replacement
 * is a delete by that id rather than a per-table merge (D-031).
 */
const DEPENDENT_TABLES = ['cve_text', 'cve_cwe', 'cve_prod', 'cve_ref', 'cve_ver'] as const

/**
 * Lookup table columns, positionally — the same order `pipeline/schema.sql`
 * declares them and the same order the wire tuples arrive in.
 *
 * Named in the INSERT rather than left positional (which is all apply needs)
 * because full-text maintenance has to know *which* column a name lives in, and
 * deriving that from a position would be a silent-corruption bug waiting for
 * the day a column is added. `tests/unit/sync.test.ts` checks every entry here
 * against the published schema itself, so this list cannot drift from it.
 */
export const LOOKUP_COLUMNS: Record<LookupTable, readonly string[]> = {
  cna: ['id', 'name'],
  cwe: ['id', 'cwe', 'descr'],
  vendor: ['id', 'name'],
  product: ['id', 'vendor_id', 'name'],
  host: ['id', 'name'],
  url: ['id', 'url', 'host_id'],
  vtype: ['id', 'name'],
}

/**
 * The full-text index over each content table that has one, keyed by the table.
 *
 * Read out of `SEARCH_INDEXES` rather than repeated: a fourth index added there
 * and forgotten here would be maintained by nobody, and the symptom is a search
 * that quietly returns text the record no longer contains (RE-005).
 */
const FTS_BY_CONTENT = new Map<string, SearchIndex>(
  SEARCH_INDEXES.map((index) => [index.content, index])
)

/** The description index, which every record change has to maintain. */
const TEXT_INDEX = FTS_BY_CONTENT.get('cve_text')

/** How many ids one existence query carries. Well under any variable limit. */
const PROBE_BATCH = 400

export interface SyncCounts {
  /** The watermark this delta started from, and the one it left behind. */
  from: number
  to: number
  upserts: number
  deletes: number
}

/**
 * Apply one delta, or leave the database exactly as it was.
 *
 * The transaction is the whole safety story (D-031): the watermark is written
 * inside it, so there is no window in which the rows and the revision disagree,
 * and a failure at any point below — a drifted ID space, a dangling reference,
 * a full disk — rolls back to a consistent database at the old revision. Which
 * is also what makes re-running safe: the run that failed changed nothing, and
 * the run that succeeded moved the watermark past `from`, so a repeat of the
 * same file is refused rather than applied twice.
 *
 * `BEGIN IMMEDIATE` rather than a deferred begin: the write lock is taken up
 * front, so a second tab syncing at the same time loses here — before any work
 * — instead of at the first write, half way through a chain.
 */
export function applyDelta(db: SyncDb, delta: Delta): SyncCounts {
  // Before the transaction, because it needs no database: a delta that
  // contradicts itself is refused without taking a write lock.
  assertSelfConsistent(delta)

  db.run('BEGIN IMMEDIATE')
  try {
    assertWatermark(db, delta.from)
    // Pairings have to be checked before tombstones mutate the rows they are
    // evidence about. Otherwise a malformed delta can delete the CVE currently
    // at row N and then insert a different CVE at N, hiding exactly the ID-space
    // reuse D-056 says must be refused.
    assertRecordIds(db, delta)
    applyLookups(db, delta)
    // After the lookups are in, so one existence check covers both "shipped in
    // this file" and "already local" — which together are the only two places
    // a reference is allowed to point.
    assertClosure(db, delta)

    // Tombstones before upserts gives a whole-record replacement deterministic
    // ordering. Any attempt to reuse the row id a tombstone frees was already
    // refused by `assertRecordIds`; D-056 says ids are never reissued.
    for (const cve of delta.delete) dropByCveId(db, cve)
    for (const record of delta.upsert) upsertRecord(db, record)

    // `meta.rev` is the watermark, and it advances in this transaction with the
    // rows it describes. `generated` moves with it because it dates the same
    // content — the staleness indicator reads it.
    db.run('INSERT OR REPLACE INTO meta(k, v) VALUES(?, ?)', ['rev', delta.to])
    db.run('INSERT OR REPLACE INTO meta(k, v) VALUES(?, ?)', ['generated', delta.generated])
    db.run('COMMIT')
  } catch (error) {
    // If the failure was the COMMIT itself there may be no transaction left to
    // roll back, and a throw from here would replace the real error with a
    // confusing one.
    try {
      db.run('ROLLBACK')
    } catch {
      /* the transaction is already gone; the original error is the one to report */
    }
    throw error
  }

  return {
    from: delta.from,
    to: delta.to,
    upserts: delta.upsert.length,
    deletes: delta.delete.length,
  }
}

/**
 * Refuse any upsert whose stable row-id pairing disagrees with this copy.
 *
 * This is a preflight over the whole delta rather than only a check immediately
 * before each insert: tombstones are intentionally applied before upserts, and
 * one of them may otherwise erase the row that proves an upsert is reusing an
 * id. It stays inside the transaction so every pairing describes the same
 * database revision guarded by `assertWatermark`.
 */
function assertRecordIds(db: SyncDb, delta: Delta): void {
  for (const record of delta.upsert) assertRecordId(db, record)
}

function assertRecordId(db: SyncDb, record: DeltaRecord): void {
  const byCve = db.row('SELECT id FROM cve WHERE cve_id = ?', [record.cve])
  if (byCve !== null && Number(byCve[0]) !== record.id) {
    throw new Error(
      `${record.cve} is row ${byCve[0]} in this copy but ${record.id} in the delta: the ` +
        "server's ID space has drifted, and this copy has to be re-downloaded rather than synced"
    )
  }
  const byId = db.row('SELECT cve_id FROM cve WHERE id = ?', [record.id])
  if (byId !== null && byId[0] !== record.cve) {
    throw new Error(
      `row ${record.id} is ${byId[0]} in this copy but ${record.cve} in the delta: the ` +
        "server's ID space has drifted, and this copy has to be re-downloaded rather than synced"
    )
  }
}

/**
 * Refuse a delta that contradicts itself, before it touches the database.
 *
 * `lib/delta.ts` validates each row's *shape* and says explicitly that these
 * three are apply's job — because they are about the payload as a whole rather
 * than about any one row, and each of them silently loses data:
 *
 *   * two upserts for one row id, or one CVE ID, apply in array order and the
 *     earlier one is simply gone;
 *   * a CVE in both `upsert` and `delete` depends entirely on which section
 *     runs first, and the record would vanish on one client and survive on
 *     another;
 *   * two lookup rows sharing an id leave whichever came last, and the ids that
 *     pointed at the other one now name the wrong thing.
 */
function assertSelfConsistent(delta: Delta): void {
  const ids = new Set<number>()
  const cves = new Set<string>()
  for (const record of delta.upsert) {
    if (ids.has(record.id)) throw new Error(`delta upserts row ${record.id} twice`)
    if (cves.has(record.cve)) throw new Error(`delta upserts ${record.cve} twice`)
    ids.add(record.id)
    cves.add(record.cve)
  }
  for (const cve of delta.delete) {
    if (cves.has(cve)) throw new Error(`delta both upserts and deletes ${cve}`)
  }
  for (const table of LOOKUP_ORDER) {
    const seen = new Set<unknown>()
    for (const row of delta.lookups[table] as readonly (readonly unknown[])[]) {
      const id = row[0]
      if (seen.has(id)) throw new Error(`delta carries ${table} row ${String(id)} twice`)
      seen.add(id)
    }
  }
}

/**
 * The local watermark must be exactly the delta's `from`.
 *
 * A delta is a step from one revision, not a patch that fits anywhere: applying
 * one to a database at a different revision would produce rows from two
 * generations with no error and no way to notice.
 */
function assertWatermark(db: SyncDb, from: number): void {
  const row = db.row('SELECT v FROM meta WHERE k = ?', ['rev'])
  const local = row === null ? null : row[0]
  if (local !== from) {
    throw new Error(
      `delta starts at rev ${from} but this copy is at ${local === null ? 'no revision' : local}`
    )
  }
}

/**
 * Insert the lookup rows, maintaining the vendor and product indexes.
 *
 * `INSERT OR REPLACE` because a delta may legitimately re-ship a row whose
 * *content* changed under an id the client already holds (`extra` in
 * `pipeline/delta.py`), not only rows above the floor. That is exactly the case
 * the index has to be told about: replacing a name without deleting the old one
 * from fts5 leaves the old terms matching a row whose text no longer contains
 * them, which no `integrity-check` short of `rank = 1` reports (RE-005).
 *
 * A row that arrives unchanged does not touch the index at all — the value is
 * the one already indexed, and a delete/insert pair would churn the index for
 * nothing.
 */
function applyLookups(db: SyncDb, delta: Delta): void {
  for (const table of LOOKUP_ORDER) {
    const rows = delta.lookups[table] as readonly (readonly unknown[])[]
    if (rows.length === 0) continue

    const columns = LOOKUP_COLUMNS[table]
    const sql =
      `INSERT OR REPLACE INTO ${table}(${columns.join(', ')}) ` +
      `VALUES(${columns.map(() => '?').join(', ')})`
    const index = FTS_BY_CONTENT.get(table)
    // Where the indexed text sits in the tuple. -1 for a table with no index,
    // which is never read.
    const at = index ? columns.indexOf(index.column) : -1
    if (index && at < 0) {
      throw new Error(`${table} has no ${index.column} column to index`)
    }

    for (const row of rows) {
      // `parseDelta` has already checked this against the wire shape; checked
      // again because the INSERT's arity comes from `columns` and a mismatch
      // would bind the wrong value into the wrong column.
      if (row.length !== LOOKUP_ARITY[table] || row.length !== columns.length) {
        throw new Error(
          `${table} row ${String(row[0])} carries ${row.length} columns, not ${columns.length}`
        )
      }
      if (!index) {
        db.run(sql, row)
        continue
      }
      const id = row[0]
      const value = row[at]
      const previous = db.row(`SELECT ${index.column} FROM ${table} WHERE ${index.rowid} = ?`, [id])
      if (previous !== null && previous[0] === value) {
        // Byte-identical to what is indexed: the write is a no-op and so is the
        // index maintenance.
        db.run(sql, row)
        continue
      }
      if (previous !== null) ftsDelete(db, index, id, previous[0])
      db.run(sql, row)
      db.run(`INSERT INTO ${index.fts}(rowid, ${index.column}) VALUES(?, ?)`, [id, value])
    }
  }
}

/**
 * Refuse a delta whose records point at lookup rows this copy will not have.
 *
 * The emitter checks the same thing from its side (`_check_closure` in
 * `pipeline/delta.py`) against one self-consistent artifact; this checks it
 * against *this* database, which is the only place the client's actual history
 * of applied deltas is known. A reference that dangles produces a record whose
 * vendor, URL or CWE simply does not resolve — it does not error, it
 * undercounts, which is the failure vision criterion 7 exists to prevent.
 *
 * Run after `applyLookups` so "shipped in this delta" needs no separate set.
 */
function assertClosure(db: SyncDb, delta: Delta): void {
  const referenced = new Map<LookupTable, Set<number>>(
    LOOKUP_ORDER.map((table) => [table, new Set<number>()])
  )
  const need = (table: LookupTable, id: number | null | undefined) => {
    if (typeof id === 'number') referenced.get(table)!.add(id)
  }

  for (const record of delta.upsert) {
    need('cna', record.cna)
    for (const id of record.cwe ?? []) need('cwe', id)
    for (const id of record.prod ?? []) need('product', id)
    for (const id of record.ref ?? []) need('url', id)
    for (const version of record.ver ?? []) {
      need('product', version[0])
      need('vtype', version[5])
    }
  }
  // Lookup rows reference lookup rows: a product names its vendor and a URL its
  // host, and either may have stayed below the floor and not been shipped.
  for (const row of delta.lookups.product) need('vendor', row[1])
  for (const row of delta.lookups.url) need('host', row[2])

  for (const table of LOOKUP_ORDER) {
    const wanted = [...referenced.get(table)!]
    if (wanted.length === 0) continue
    const missing: number[] = []
    for (let at = 0; at < wanted.length; at += PROBE_BATCH) {
      const batch = wanted.slice(at, at + PROBE_BATCH)
      const marks = batch.map(() => '?').join(', ')
      const found = new Set(
        db.column(`SELECT id FROM ${table} WHERE id IN (${marks})`, batch).map(Number)
      )
      for (const id of batch) if (!found.has(id)) missing.push(id)
    }
    if (missing.length > 0) {
      throw new Error(
        `delta references ${missing.length} ${table} row(s) this copy does not have ` +
          `(${missing.slice(0, 5).join(', ')}) — the local copy is unchanged`
      )
    }
  }
}

/** Drop the record a tombstone names, if this copy has it. */
function dropByCveId(db: SyncDb, cve: string): void {
  const row = db.row('SELECT id FROM cve WHERE cve_id = ?', [cve])
  // Absent is not an error: a tombstone for a record this copy never held is
  // exactly what a client that downloaded a later snapshot sees.
  if (row !== null) dropRecord(db, Number(row[0]))
}

/**
 * Replace one record whole (D-031): its dependent rows go, and what the delta
 * carries goes in. Absent means absent — a record that lost its CWEs arrives
 * with no `cwe` key, and the rows have to disappear rather than survive.
 *
 * The preflight pairing checks cover both directions, because they fail in
 * different ways. `cve → id` catches a record whose row id moved:
 * applying it would leave the old row untouched and insert a duplicate CVE,
 * which the schema's UNIQUE index turns into a loud error. `id → cve` is the
 * one that destroys data quietly: an upsert for a CVE this copy has never seen,
 * at a row id it has already given to a *different* CVE, would drop that record
 * with no error and no orphan to notice it by. Either way the server's ID space
 * has drifted from this copy's (D-056) and the honest answer is to stop and
 * re-download, not to guess. They run before any tombstone, so a delete cannot
 * hide the existing pairing before this function replaces the row.
 */
function upsertRecord(db: SyncDb, record: DeltaRecord): void {
  dropRecord(db, record.id)

  const cvss = record.cvss ?? null
  db.run('INSERT INTO cve VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    record.id,
    record.cve,
    record.y,
    record.st,
    record.cna ?? null,
    record.pub ?? null,
    record.upd ?? null,
    cvss?.[0] ?? null,
    cvss?.[1] ?? null,
    cvss?.[2] ?? null,
    cvss?.[3] ?? null,
  ])

  if (record.descr !== undefined) {
    db.run('INSERT INTO cve_text VALUES(?, ?)', [record.id, record.descr])
    if (TEXT_INDEX) {
      db.run(`INSERT INTO ${TEXT_INDEX.fts}(rowid, ${TEXT_INDEX.column}) VALUES(?, ?)`, [
        record.id,
        record.descr,
      ])
    }
  }
  for (const id of record.cwe ?? []) db.run('INSERT INTO cve_cwe VALUES(?, ?)', [record.id, id])
  for (const id of record.prod ?? []) db.run('INSERT INTO cve_prod VALUES(?, ?)', [record.id, id])
  for (const id of record.ref ?? []) db.run('INSERT INTO cve_ref VALUES(?, ?)', [record.id, id])
  for (const version of record.ver ?? []) {
    db.run('INSERT INTO cve_ver VALUES(?, ?, ?, ?, ?, ?, ?)', [record.id, ...version])
  }
}

/** Delete a record's dependent rows and the record, index maintenance included. */
function dropRecord(db: SyncDb, rowid: number): void {
  dropText(db, rowid)
  for (const table of DEPENDENT_TABLES) db.run(`DELETE FROM ${table} WHERE cve_id = ?`, [rowid])
  db.run('DELETE FROM cve WHERE id = ?', [rowid])
}

/**
 * Tell fts5 about a description that is about to stop existing.
 *
 * This is the single most dangerous statement in the file. The index is an
 * *external content* index: fts5 stores no copy of the text, so it cannot work
 * out what to un-index by itself, and a content row deleted or replaced without
 * this leaves the old terms in the index forever — matching a record whose text
 * no longer contains them, or a record that is no longer there at all. Nothing
 * reports it: the tables exist, the row counts are right, and only
 * `INSERT INTO fts(fts, rank) VALUES('integrity-check', 1)` disagrees, which is
 * the one form of the check nobody writes by accident (RE-005).
 *
 * The value handed to `'delete'` is read out of the content table an instant
 * before the row changes, so it is by construction the text that was indexed —
 * which is fts5's requirement, and the reason this cannot be reconstructed from
 * the delta.
 *
 * That check is deliberately not run after a sync at runtime: at full scale it
 * re-tokenizes 122 MB of description text, which costs about what building the
 * index cost in the first place (~58 s) — for a daily delta of a few hundred
 * records. It belongs in the tests, where it runs on every case here, and in
 * M5's diagnostics panel as something a user can ask for.
 */
function dropText(db: SyncDb, rowid: number): void {
  if (!TEXT_INDEX) return
  const existing = db.row(`SELECT ${TEXT_INDEX.column} FROM cve_text WHERE cve_id = ?`, [rowid])
  if (existing === null) return
  ftsDelete(db, TEXT_INDEX, rowid, existing[0])
}

/** fts5's explicit delete protocol for an external-content index. */
function ftsDelete(db: SyncDb, index: SearchIndex, rowid: unknown, value: unknown): void {
  db.run(`INSERT INTO ${index.fts}(${index.fts}, rowid, ${index.column}) VALUES('delete', ?, ?)`, [
    rowid,
    value,
  ])
}
