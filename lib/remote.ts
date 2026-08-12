/**
 * The hosted query tier's client half (D-084).
 *
 * A visitor with no local copy still lands in the workspace: their queries are
 * compiled exactly as the local tier compiles them and then POSTed — SQL text,
 * bound parameters and a row limit — to the same-origin `api/sql.php`, which
 * runs them read-only against the server's copy of the same database and
 * returns rows. "Make available offline" replaces this tier with the local one.
 *
 * **Synchronous on purpose.** The Worker's entire query layer — `runSql`, axis
 * resolution, the KEV gate — is synchronous code written against a database
 * object that blocks the Worker thread. A synchronous XHR (legal in a Worker,
 * unlike a document) lets the remote tier stand in for that object without
 * rewriting every handler into async, and keeps the two tiers running the
 * *same* handler code — which is the property that stops them drifting apart
 * in what they answer. The cost is real and accepted: a remote query cannot be
 * cancelled mid-flight, only bounded by `REMOTE_TIMEOUT_MS` and by the
 * server's own deadline.
 *
 * Everything here that can be decided without a network is a pure function,
 * because this file is unit-tested and the Worker is not (`pnpm check` cannot
 * execute it).
 */

import type { SqlParam } from './filters'

/** Where the hosted tier lives. Same-origin, like the chat relay (D-057). */
export const SQL_URL = '/api/sql.php'

/**
 * How long one remote query may take, wall clock, including the queue on the
 * server side. Above the server's own execution deadline (~5 s of CPU) with
 * room for the network, so the server's readable refusal usually arrives
 * before this fires and the generic message below is the fallback, not the
 * norm.
 */
export const REMOTE_TIMEOUT_MS = 30_000

/**
 * Client-side mirrors of the server's request bounds. The server enforces its
 * own copies (it trusts nothing a browser sends); these exist so an oversized
 * request fails here with a readable message instead of a 413.
 * `tests/unit/hosted-parity.test.ts` holds the two ends equal.
 */
export const MAX_REMOTE_SQL_CHARS = 65_536
export const MAX_REMOTE_PARAMS = 1_000
export const MAX_REMOTE_ROWS = 20_000

/** What one remote execution returns. The envelope `api/sql.php` speaks. */
export interface RemoteResult {
  columns: string[]
  rows: unknown[][]
  /** The server's row cap (ours or its own) stopped collection. */
  truncated: boolean
  /**
   * Truncation was by *size*, not row count (D-078) — the server's character
   * budget or per-cell cap stopped it. Distinct from `truncated` for the same
   * reason the local tier keeps them apart: "capped at N rows" and "this result
   * was too large to hold" call for different sentences.
   */
  overflowed: boolean
  /** Engine time on the server, milliseconds — the analogue of `QueryResult.ms`. */
  ms: number
}

/**
 * Turn one HTTP outcome into a result or a readable refusal.
 *
 * Pure, and the messages are written for the surfaces that show them: the SQL
 * console, a chat tool refusal, the status strip. The server's own `error`
 * strings pass through verbatim — it writes them for the same audience
 * (an authorizer denial names the refused action, like the local tier's).
 */
export function parseRemoteResponse(status: number, body: string): RemoteResult {
  if (status === 0) {
    throw new Error('the hosted query tier could not be reached — check your connection')
  }
  if (status === 429) {
    throw new Error('the hosted query tier is busy right now — wait a moment and try again')
  }
  if (status === 503) {
    throw new Error('the hosted query tier is temporarily unavailable')
  }
  if (status !== 200) {
    throw new Error(`the hosted query tier answered HTTP ${status}`)
  }
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    // Deliberately not echoing the body — it is not ours and did not parse.
    throw new Error('the hosted query tier returned something that is not a result')
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error('the hosted query tier returned something that is not a result')
  }
  const record = value as Record<string, unknown>
  if (typeof record.error === 'string' && record.error) {
    throw new Error(record.error)
  }
  const columns = record.columns
  const rows = record.rows
  if (
    !Array.isArray(columns) ||
    !columns.every((name) => typeof name === 'string') ||
    !Array.isArray(rows) ||
    !rows.every((row) => Array.isArray(row))
  ) {
    throw new Error('the hosted query tier returned something that is not a result')
  }
  return {
    columns: columns as string[],
    rows: rows as unknown[][],
    truncated: record.truncated === true,
    overflowed: record.overflowed === true,
    ms: typeof record.ms === 'number' && Number.isFinite(record.ms) ? record.ms : 0,
  }
}

/** The request body, bounds applied. Pure, so the bounds are testable. */
export function remoteEnvelope(sql: string, params: readonly SqlParam[], limit: number): string {
  if (sql.length > MAX_REMOTE_SQL_CHARS) {
    throw new Error(`this query is too long for the hosted tier (${sql.length} characters)`)
  }
  if (params.length > MAX_REMOTE_PARAMS) {
    throw new Error(`this query binds too many values for the hosted tier (${params.length})`)
  }
  return JSON.stringify({
    sql,
    params: [...params],
    limit: Math.max(1, Math.min(Math.floor(limit), MAX_REMOTE_ROWS)),
  })
}

/**
 * Run one statement on the hosted tier and wait for it.
 *
 * Blocking, from a Worker only — a document is not allowed to send a
 * synchronous request, and should never import this module.
 */
export function remoteQuery(sql: string, params: readonly SqlParam[], limit: number): RemoteResult {
  const body = remoteEnvelope(sql, params, limit)
  const xhr = new XMLHttpRequest()
  // The third argument is what makes it synchronous.
  xhr.open('POST', SQL_URL, false)
  xhr.setRequestHeader('Content-Type', 'application/json')
  // Legal on a synchronous request inside a Worker (the window-context
  // restriction does not apply), and the only bound the client holds once the
  // request is in flight.
  try {
    xhr.timeout = REMOTE_TIMEOUT_MS
  } catch {
    // A runtime that refuses the assignment still gets the server's deadline.
  }
  try {
    xhr.send(body)
  } catch {
    throw new Error('the hosted query tier could not be reached — check your connection')
  }
  return parseRemoteResponse(xhr.status, xhr.responseText)
}

/** The `exec` options subset the Worker's handlers actually use. */
interface RemoteExecOptions {
  sql: string
  bind?: readonly SqlParam[]
  /** `'array'` for whole rows, `0` for the first column of each row. */
  rowMode?: 'array' | 0
  /** Filled with the result's column names when provided. */
  columnNames?: string[]
  callback?: (row: never) => false | undefined | void
}

/**
 * How many rows an `exec` without an explicit cap may retain. `exec` is used
 * by the handlers for per-name lookups and single meta values; anything
 * row-shaped goes through `runSql`, which passes its own limit. This exists so
 * no call path reaches the server without *some* cap.
 */
export const REMOTE_EXEC_ROWS = 1_000

/**
 * The remote tier, wearing the shape of the Worker's database object.
 *
 * Only the members the query handlers reach are implemented — `exec` in the
 * two row modes they use, and `selectValue` — and `runSql` branches before
 * touching anything engine-specific (`pointer`, limits, the authorizer),
 * because those guards run on the server for this tier. Maintenance surfaces
 * (import, sync, KEV apply, index building) never see this object: they exist
 * to build the local copy this tier is the absence of.
 */
export class RemoteDb {
  /** The marker `isRemoteDb` checks. */
  readonly remote = true as const
  /** `runSql` reads this to decide the engine-guard path; undefined means remote. */
  readonly pointer = undefined

  exec(options: RemoteExecOptions | string): void {
    if (typeof options === 'string') {
      // The handlers only pass plain strings on maintenance paths, which never
      // run remotely. Refusing keeps a future one from silently querying the
      // server without a callback to receive rows.
      throw new Error('remote exec requires structured options')
    }
    const result = remoteQuery(options.sql, options.bind ?? [], REMOTE_EXEC_ROWS)
    if (options.columnNames) {
      options.columnNames.length = 0
      options.columnNames.push(...result.columns)
    }
    if (!options.callback) return
    for (const row of result.rows) {
      const value = options.rowMode === 0 ? row[0] : row
      if (options.callback(value as never) === false) break
    }
  }

  selectValue(sql: string, bind?: readonly SqlParam[]): unknown {
    const result = remoteQuery(sql, bind ?? [], 1)
    return result.rows[0]?.[0]
  }

  close(): void {
    // Nothing is held: every query is its own request.
  }
}

/** Whether a database object is the remote tier standing in for a local copy. */
export function isRemoteDb(database: unknown): boolean {
  return (
    typeof database === 'object' &&
    database !== null &&
    (database as { remote?: unknown }).remote === true
  )
}
