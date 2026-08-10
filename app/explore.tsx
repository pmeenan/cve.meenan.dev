'use client'

/**
 * The record tables (M3, refactored twice since).
 *
 * M4 made this file the Explore tab; the UI revamp dissolved that tab into the
 * workspace — the filter form now lives in the filter drawer
 * (`filters-panel.tsx`) and results render on the canvas. What remains here is
 * what both the canvas and the chat panel share: the record list, the grouped
 * table, and their copyable-grid forms. One renderer per shape, used
 * everywhere a record row appears, so two surfaces cannot drift into
 * disagreeing about what a column means (D-044).
 */

import { bucketLabel as chartBucketLabel } from '@/lib/chart'
import type { GridData } from '@/lib/clipboard'
import { SEVERITY_LABELS, type Dimension, type StateFilter } from '@/lib/filters'
import type { QueryResult, Unmatched } from '@/lib/protocol'

export interface SearchOutcome {
  result: QueryResult
  matches: number | null
  unmatched: Unmatched[]
  groupBy: Dimension | null
  state: StateFilter
}

export function GroupTable({ result, dimension }: { result: QueryResult; dimension: Dimension }) {
  const total = result.rows.reduce((sum, row) => sum + Number(row[2] ?? 0), 0)
  return (
    <table className="results groups">
      <thead>
        <tr>
          <th scope="col">Value</th>
          <th scope="col">CVEs</th>
          <th scope="col">Share</th>
        </tr>
      </thead>
      <tbody>
        {result.rows.map((row, index) => {
          const count = Number(row[2] ?? 0)
          return (
            <tr key={index}>
              <td>{bucketLabel(row, dimension)}</td>
              <td>{count.toLocaleString()}</td>
              <td>
                {/* Share of what is on screen, not of the corpus — the table is
                    capped, so calling it a corpus share would be wrong. */}
                <span
                  className="bar-cell"
                  style={{ width: `${total > 0 ? (count / total) * 100 : 0}%` }}
                />
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/**
 * The label for a grouped row.
 *
 * The severity, CVSS-version and state dimensions group by a stored *code*
 * (D-047: 31 is v3.1 and 4 is v4.0, so they are labels rather than magnitudes),
 * and the SQL returns the code in both columns. Mapping happens here rather
 * than in SQL because a `CASE` in the query would put display strings in the
 * query layer and still not cover a code we have never seen.
 */
function bucketLabel(row: unknown[], dimension: Dimension): string {
  // The chart layer's, not a second copy: two namings of one bucket is how a
  // table and the chart above it end up disagreeing about which band is which.
  return chartBucketLabel(dimension, row[0], row[1])
}

/**
 * The record list.
 *
 * Shared by the canvas and the chat panel (M7's shape decision): two renderers
 * of one row set is how two surfaces end up disagreeing about what a column
 * means, and it is the parallel presentation path D-044 rules out. The chat
 * panel's version is narrower by CSS, not by markup.
 */
export function RecordTable({
  result,
  onOpenRecord,
}: {
  result: QueryResult
  onOpenRecord: (cveId: string) => void
}) {
  return (
    <table className="results records">
      <thead>
        <tr>
          <th scope="col">CVE</th>
          <th scope="col">Published</th>
          <th scope="col">Severity</th>
          <th scope="col">Score</th>
          <th scope="col">CNA</th>
          <th scope="col">Description</th>
        </tr>
      </thead>
      <tbody>
        {result.rows.map((row, index) => {
          const cve = String(row[0] ?? '')
          return (
            <tr key={index}>
              {/* Every cell is record content: attacker-influenced text rendered
                  as text, never as markup, and no URL from a record is turned
                  into a link here (rule 4). React escapes it; the point is that
                  nothing downstream un-escapes it. The id is a button rather
                  than a link because it opens a panel in this page — a real
                  `href` would promise a navigation that does not happen. */}
              <td className="mono">
                <button
                  type="button"
                  className="quiet link"
                  aria-label={`Open record ${cve}`}
                  onClick={() => onOpenRecord(cve)}
                >
                  {cve}
                </button>
              </td>
              <td className="mono">{day(row[2])}</td>
              <td>{severity(row[6])}</td>
              <td className="mono">{row[5] === null ? '' : String(row[5])}</td>
              <td>{String(row[7] ?? '')}</td>
              <td className="descr">{String(row[8] ?? '')}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/**
 * The record list as a copyable grid — the same columns, the same formatting,
 * so what pastes into a spreadsheet is what the table showed.
 */
export function recordGrid(result: QueryResult, title: string): GridData {
  return {
    title,
    columns: ['CVE', 'Published', 'Severity', 'Score', 'CNA', 'Description'],
    rows: result.rows.map((row) => [
      String(row[0] ?? ''),
      day(row[2]),
      severity(row[6]),
      row[5] === null || row[5] === undefined ? null : String(row[5]),
      String(row[7] ?? ''),
      String(row[8] ?? ''),
    ]),
  }
}

/** The grouped count as a copyable grid. The share bar is presentation, not data. */
export function groupGrid(result: QueryResult, dimension: Dimension, title: string): GridData {
  return {
    title,
    columns: ['Value', 'CVEs'],
    rows: result.rows.map((row) => [bucketLabel(row, dimension), Number(row[2] ?? 0)]),
  }
}

function severity(value: unknown): string {
  return typeof value === 'number' ? (SEVERITY_LABELS[value] ?? String(value)) : ''
}

/** Unix seconds as an ISO day; the corpus stores whole timestamps we do not need. */
function day(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  return new Date(value * 1000).toISOString().slice(0, 10)
}
