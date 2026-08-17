'use client'

import { CONSOLE_CELL_CHARS, CONSOLE_ROW_LIMIT } from '@/lib/authorizer'
import type { QueryResult } from '@/lib/protocol'

/**
 * The raw SQL console (M3).
 *
 * It is safe to offer because of what is *underneath* it, not because of
 * anything this file does: the Worker installs a SQLite authorizer for the
 * duration of the statement, so every action but reading is refused by the
 * parser itself (lib/authorizer.ts), the result set is capped, and the query
 * can be cancelled. There is no inspection of the text here or anywhere — a
 * denylist of words would be the thing D-044 rules out.
 *
 * The data never leaves the browser, so a console over it is a local tool, not
 * an exposed endpoint: the origin serves files and evaluates nothing (D-007,
 * D-032). What the console has to defend against is the user's own mistakes and
 * a link someone sent them — a query that never finishes, one that returns the
 * whole corpus, one that tries to write.
 */

/**
 * The one canned query the panel offers: the schema, because it is the thing a
 * reader cannot type from memory. The panel otherwise carries the SQL of
 * whatever last ran on the canvas (UI polish, 2026-08-16) — the example
 * buttons it used to open on were what a workspace with nothing on it needed,
 * and the canvas never opens empty now.
 */
export const SCHEMA_SQL = `SELECT name, sql FROM sqlite_schema WHERE type = 'table' ORDER BY name`

export function Console({
  disabled,
  hosted,
  onRun,
  result,
  error,
  cancelledMs,
  run,
  sql,
  onSql,
}: {
  disabled: boolean
  /**
   * The hosted tier is answering (D-084): the same read-only guard runs on the
   * server, and the cancel claim does not hold — a remote statement is bounded
   * by the server's deadline, not by a button.
   */
  hosted?: boolean
  onRun: (sql: string) => void
  result: QueryResult | null
  error: string
  cancelledMs: number | null
  /** Answer counter — rendered as `data-run` so a test can wait for *this* one. */
  run: number
  /**
   * Controlled by the page (UI revamp): a report run or a chat answer writes
   * the SQL it executed into this drawer, so "show me the query" and "let me
   * edit the query" are the same surface.
   */
  sql: string
  onSql: (sql: string) => void
}) {
  return (
    <section aria-labelledby="sql-heading">
      <h2 id="sql-heading">SQL</h2>
      <p className="muted">
        The query behind whatever last ran, editable. Read-only, and not by inspecting what you
        type: SQLite&rsquo;s own authorizer refuses every action but reading, for the duration of
        the statement. Results are capped at {CONSOLE_ROW_LIMIT.toLocaleString()} rows
        {hosted
          ? ', and until the corpus is downloaded your SQL runs on this site’s server, ' +
            'bounded by its deadline rather than a Cancel button.'
          : ', and a long query can be cancelled.'}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          onRun(sql)
        }}
      >
        <label className="field">
          <span>SQL</span>
          <textarea
            className="sql-input"
            value={sql}
            spellCheck={false}
            rows={8}
            onChange={(event) => onSql(event.target.value)}
          />
        </label>
        <div className="actions">
          {/* Visible word "Run", accessible name "Run SQL": the visible label
              is contained in the accessible one (WCAG 2.5.3), and the panel
              heading already says SQL. */}
          <button type="submit" disabled={disabled} aria-label="Run SQL">
            Run
          </button>
          <button type="button" className="quiet" onClick={() => onSql(SCHEMA_SQL)}>
            Schema
          </button>
        </div>
      </form>

      {error && (
        <p className="error" data-console-error="1" data-run={run}>
          {error}
        </p>
      )}

      {cancelledMs !== null && (
        <p className="muted" data-console-cancelled="1" data-run={run}>
          Cancelled after {(cancelledMs / 1000).toFixed(1)} s. The database is unchanged — it could
          not have been changed.
        </p>
      )}

      {result && (
        <>
          <p className="muted" data-console-rows={result.rows.length} data-run={run}>
            {result.rows.length.toLocaleString()} rows in {result.ms} ms
            {/* Two different truncations, said differently (D-078). "Capped at
                1,000 rows" is an ordinary answer to a broad query; stopping on
                size means the query produced values a page cannot hold, and
                the fix is narrower columns rather than a LIMIT. */}
            {result.overflowed
              ? ' — stopped early: this query produced more data than the browser will hold. ' +
                'Select fewer or shorter columns.'
              : result.truncated &&
                ` — capped at ${CONSOLE_ROW_LIMIT.toLocaleString()}; there may be more.`}
          </p>
          <div className="scroll" tabIndex={0}>
            <table className="results console">
              <thead>
                <tr>
                  {result.columns.map((column, index) => (
                    <th key={`${column}-${index}`}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, index) => (
                  <tr key={index}>
                    {row.map((cell, cellIndex) => (
                      // Record content, rendered as text and truncated: a
                      // description can be tens of kilobytes and the corpus is
                      // hostile input (rule 4).
                      <td key={cellIndex}>{cellText(cell)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}

function cellText(cell: unknown): string {
  if (cell === null || cell === undefined) return ''
  if (cell instanceof Uint8Array) return `<${cell.length} bytes>`
  const text = String(cell)
  return text.length > CONSOLE_CELL_CHARS ? `${text.slice(0, CONSOLE_CELL_CHARS)}…` : text
}
