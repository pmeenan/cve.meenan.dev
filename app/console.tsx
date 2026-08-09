'use client'

import { useState } from 'react'

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

const EXAMPLES: { label: string; sql: string }[] = [
  {
    label: 'Top CWEs',
    sql: `SELECT w.cwe, w.descr, count(*) AS cves
FROM cve c
JOIN cve_cwe x ON x.cve_id = c.id
JOIN cwe w ON w.id = x.cwe_id
WHERE c.state = 1
GROUP BY w.id
ORDER BY cves DESC
LIMIT 20`,
  },
  {
    label: 'Critical CVEs mentioning "deserialization"',
    sql: `SELECT c.cve_id, c.cvss_score, substr(t.descr, 1, 120) AS about
FROM fts
JOIN cve c ON c.id = fts.rowid
JOIN cve_text t ON t.cve_id = c.id
WHERE fts MATCH 'deserialization' AND c.state = 1 AND c.cvss_sev = 4
ORDER BY c.cvss_score DESC
LIMIT 20`,
  },
  {
    label: 'What the schema looks like',
    sql: `SELECT name, sql FROM sqlite_schema WHERE type = 'table' ORDER BY name`,
  },
]

export function Console({
  disabled,
  onRun,
  result,
  error,
  cancelledMs,
  run,
}: {
  disabled: boolean
  onRun: (sql: string) => void
  result: QueryResult | null
  error: string
  cancelledMs: number | null
  /** Answer counter — rendered as `data-run` so a test can wait for *this* one. */
  run: number
}) {
  const [sql, setSql] = useState(EXAMPLES[0]!.sql)

  return (
    <section>
      <h2>SQL console</h2>
      <p className="muted">
        Read-only, and not by inspecting what you type: SQLite&rsquo;s own authorizer refuses every
        action but reading, for the duration of the statement. Results are capped at{' '}
        {CONSOLE_ROW_LIMIT.toLocaleString()} rows, and a long query can be cancelled.
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
            onChange={(event) => setSql(event.target.value)}
          />
        </label>
        <div className="actions">
          <button type="submit" disabled={disabled}>
            Run SQL
          </button>
          {EXAMPLES.map((example) => (
            <button
              key={example.label}
              type="button"
              className="quiet"
              onClick={() => setSql(example.sql)}
            >
              {example.label}
            </button>
          ))}
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
