'use client'

/**
 * The filter surface: every confirmed filter axis, in one form (M3, refactored
 * for M4).
 *
 * What M3 owed was that each axis is *queryable* and that a person can see it
 * answering, so this was a form and two tables. M4 kept the shape and moved two
 * things out: the form's fields are now the shared `FilterForm` that the Report
 * tab also uses, and the draft-to-`Filters` conversion is `lib/draft.ts`. Both
 * moved for the same reason — Explore and Report must not drift into
 * disagreeing about what an axis means, and a permalink has to be able to
 * populate a form as well as read one.
 *
 * What M4 added here is the drill-in: a CVE id in the record list is a button
 * that opens the per-CVE detail view, which is the only surface that reaches
 * the references and version ranges D-033 put in the schema.
 */

import { useState } from 'react'

import { draftToFilters, EMPTY_DRAFT, SORT_LABELS, type Draft } from '@/lib/draft'
import {
  CVSS_VERSION_LABELS,
  DIMENSION_LABELS,
  DIMENSIONS,
  SEVERITY_LABELS,
  STATE_LABELS,
  type Dimension,
  type SortKey,
  type StateFilter,
} from '@/lib/filters'
import { EXPORT_LIMIT, type ExportFormat } from '@/lib/export'
import type { CveDetail, QueryResult, SearchRequest, Unmatched } from '@/lib/protocol'

import { Detail } from './detail'
import { Field, FilterForm } from './filter-form'

/** How many records a list asks for. Bounded again in the Worker (D-052 §4). */
const PAGE_ROWS = 100

export interface SearchOutcome {
  result: QueryResult
  matches: number | null
  unmatched: Unmatched[]
  groupBy: Dimension | null
  state: StateFilter
}

export function Explore({
  disabled,
  onRun,
  onOpenRecord,
  onExport,
  outcome,
  cancelledMs,
  run,
  detailId,
  detail,
  onCloseDetail,
  exportNote,
}: {
  disabled: boolean
  onRun: (request: SearchRequest) => void
  onOpenRecord: (cveId: string) => void
  onExport: (format: ExportFormat, request: SearchRequest) => void
  outcome: SearchOutcome | null
  cancelledMs: number | null
  /** Answer counter — rendered as `data-run` so a test can wait for *this* one. */
  run: number
  detailId: string | null
  detail: CveDetail | null | undefined
  onCloseDetail: () => void
  exportNote: string
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [groupBy, setGroupBy] = useState<'' | Dimension>('')
  const [sort, setSort] = useState<SortKey>('published')
  const [format, setFormat] = useState<ExportFormat>('csv')
  const request = (): SearchRequest => ({
    filters: draftToFilters(draft),
    groupBy: groupBy === '' ? null : groupBy,
    sort,
    limit: PAGE_ROWS,
    // The count is a second query — over the whole corpus with no filters it is
    // a scan — so it is asked for deliberately. It is worth it: "100 shown" of
    // an unknown total is not an answer.
    count: true,
  })

  return (
    <section aria-labelledby="explore-heading">
      <h2 id="explore-heading">Explore</h2>
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault()
          onRun(request())
        }}
      >
        <FilterForm draft={draft} onChange={setDraft} idPrefix="explore" />

        <div className="row">
          <Field label="Group by" id="explore-group">
            <select
              id="explore-group"
              value={groupBy}
              onChange={(event) => setGroupBy(event.target.value as '' | Dimension)}
            >
              <option value="">No grouping — list records</option>
              {DIMENSIONS.map((dimension) => (
                <option key={dimension} value={dimension}>
                  {DIMENSION_LABELS[dimension]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Sort records by" id="explore-sort">
            <select
              id="explore-sort"
              value={sort}
              disabled={groupBy !== ''}
              onChange={(event) => setSort(event.target.value as SortKey)}
            >
              {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                <option key={key} value={key}>
                  {SORT_LABELS[key]}
                </option>
              ))}
            </select>
          </Field>
          <div className="actions">
            <button type="submit" disabled={disabled}>
              Run
            </button>
            <button
              type="button"
              className="quiet"
              disabled={disabled}
              onClick={() => {
                setDraft(EMPTY_DRAFT)
                setGroupBy('')
                setSort('published')
              }}
            >
              Reset filters
            </button>
            <label className="field inline" htmlFor="explore-format">
              <span>Export as</span>
              <select
                id="explore-format"
                value={format}
                onChange={(event) => setFormat(event.target.value as ExportFormat)}
              >
                <option value="csv">CSV</option>
                <option value="json">JSON</option>
              </select>
            </label>
            <button
              type="button"
              className="quiet"
              disabled={disabled}
              onClick={() => onExport(format, request())}
            >
              Export records
            </button>
          </div>
        </div>
      </form>

      <p className="muted">
        An export covers the whole match set up to {EXPORT_LIMIT.toLocaleString()} records — not
        just what is on screen — and carries MITRE&rsquo;s notice (D-008).
      </p>
      {exportNote && (
        <p className="muted" data-export-note="1">
          {exportNote}
        </p>
      )}

      {cancelledMs !== null && (
        <p className="muted" data-search-cancelled="1">
          Query cancelled after {(cancelledMs / 1000).toFixed(1)} s. Nothing was changed.
        </p>
      )}

      {detailId && <Detail cveId={detailId} detail={detail} onClose={onCloseDetail} />}

      {outcome && <Results outcome={outcome} run={run} onOpenRecord={onOpenRecord} />}
    </section>
  )
}

function Results({
  outcome,
  run,
  onOpenRecord,
}: {
  outcome: SearchOutcome
  run: number
  onOpenRecord: (cveId: string) => void
}) {
  const { result, matches, unmatched, groupBy, state } = outcome
  return (
    <div className="outcome">
      {/* A name that matched nothing is a typo, not an empty corpus. Saying so
          is the same obligation as D-023's "this record has no indexed text"
          rather than "no results". */}
      {unmatched.map((entry) => (
        <p key={entry.axis} className="error" data-unmatched={entry.axis}>
          No {entry.axis} in this copy is called {entry.values.map((v) => `“${v}”`).join(', ')}.
          Those values cannot contribute matches. Group by {entry.axis} with no filter to see the
          names that exist.
        </p>
      ))}
      {state !== 'published' && (
        <p className="stale" data-state-warning={state}>
          {state === 'all'
            ? 'Including REJECTED records: about 4.8% of the corpus, which inflates every count below against the default (D-022).'
            : 'REJECTED records only — these are withdrawn CVE IDs, not vulnerabilities.'}
        </p>
      )}
      <p className="muted" data-matches={matches ?? ''} data-run={run}>
        {matches === null
          ? `${result.rows.length.toLocaleString()} rows`
          : `${matches.toLocaleString()} records match`}
        {groupBy ? ` — grouped by ${DIMENSION_LABELS[groupBy]},` : ' —'}{' '}
        {result.rows.length.toLocaleString()} shown in {result.ms} ms
        {result.truncated && ' (capped)'}
      </p>
      <div className="scroll" tabIndex={0}>
        {groupBy ? (
          <GroupTable result={result} dimension={groupBy} />
        ) : (
          <RecordTable result={result} onOpenRecord={onOpenRecord} />
        )}
      </div>
      {/* The query behind the numbers, always available. Deterministic today;
          the same property the chat layer's answers will have to carry (D-044). */}
      <details className="sql">
        <summary>The SQL that produced this</summary>
        <pre>{result.sql}</pre>
        <p className="muted">Bound values: {result.params.map((p) => String(p)).join(' · ')}</p>
      </details>
    </div>
  )
}

function GroupTable({ result, dimension }: { result: QueryResult; dimension: Dimension }) {
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
  const bucket = row[0]
  const label = row[1]
  if (label !== bucket && typeof label === 'string' && label.length > 0) return label
  if (bucket === null) return '(none recorded)'
  const code = Number(bucket)
  if (dimension === 'severity') return SEVERITY_LABELS[code] ?? String(bucket)
  if (dimension === 'cvssVersion') return CVSS_VERSION_LABELS[code] ?? String(bucket)
  if (dimension === 'state') return STATE_LABELS[code] ?? String(bucket)
  return String(bucket)
}

function RecordTable({
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

function severity(value: unknown): string {
  return typeof value === 'number' ? (SEVERITY_LABELS[value] ?? String(value)) : ''
}

/** Unix seconds as an ISO day; the corpus stores whole timestamps we do not need. */
function day(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  return new Date(value * 1000).toISOString().slice(0, 10)
}
