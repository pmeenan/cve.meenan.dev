'use client'

/**
 * The report builder (M4).
 *
 * A report is `filters × rows × series × chart` (D-069), and this is the
 * surface that builds one. Three things about its shape are deliberate.
 *
 * **Filters are chips over a disclosure, not a wall of inputs.** A report is
 * read far more often than it is edited, and the question a reader has is "what
 * is this counting" — which is a sentence, not a form. The full form is one
 * click away and is the *same component* Explore uses, so the two tabs cannot
 * drift into disagreeing about what an axis means.
 *
 * **D-022's default is a chip, not an implication.** "PUBLISHED records only"
 * is shown in the same row as everything the user chose. A default that is
 * implied is a default nobody checks, and the one thing a report must never do
 * is change its denominator quietly.
 *
 * **The time grain is a dimension, not a second control.** `year`, `quarter`
 * and `month` are ordinary choices in the Rows and Series pickers (D-069), which
 * is what keeps the definition flat enough to validate out of a URL fragment
 * with a field check rather than a consistency check.
 */

import { useState } from 'react'

import { buildChart } from '@/lib/chart'
import { draftToFilters, filtersToDraft, type Draft } from '@/lib/draft'
import { DIMENSION_LABELS, DIMENSIONS, TIME_DIMENSIONS, type Dimension } from '@/lib/filters'
import { EXPORT_FORMATS, EXPORT_LIMIT, type ExportFormat } from '@/lib/export'
import type { QueryResult, Unmatched } from '@/lib/protocol'
import {
  CHART_ROWS,
  CHART_TYPES,
  TABLE_ROWS,
  toFragment,
  type ChartType,
  type Report,
} from '@/lib/report'

import { Chart, ChartTable } from './chart'
import { Field, FilterChips, FilterForm } from './filter-form'

export interface ReportOutcome {
  result: QueryResult
  matches: number | null
  unmatched: Unmatched[]
  /** The definition the Worker actually ran, echoed back rather than re-read. */
  report: Report
}

const CHART_LABELS: Record<ChartType, string> = {
  stackedBar: 'Stacked bars',
  groupedBar: 'Grouped bars',
  line: 'Lines over time',
  table: 'Table only',
}

/** The time grains, offered first — a report over time is the common case. */
const TIME = DIMENSIONS.filter((dimension) => TIME_DIMENSIONS.has(dimension))
const ATTRIBUTES = DIMENSIONS.filter((dimension) => !TIME_DIMENSIONS.has(dimension))

export function ReportTab({
  report,
  onChange,
  onRun,
  onExport,
  onSave,
  outcome,
  disabled,
  run,
  cancelledMs,
  exportNote,
}: {
  report: Report
  onChange: (report: Report) => void
  onRun: (report: Report) => void
  onExport: (format: ExportFormat, kind: 'records' | 'cells', report: Report) => void
  onSave: (name: string) => void
  outcome: ReportOutcome | null
  disabled: boolean
  /** Answer counter, rendered as `data-run` so a test waits for *this* answer. */
  run: number
  cancelledMs: number | null
  exportNote: string
}) {
  const [name, setName] = useState('')
  const [format, setFormat] = useState<ExportFormat>('csv')
  const [link, setLink] = useState('')
  const [copied, setCopied] = useState('')
  const draft = filtersToDraft(report.filters)

  const setDraft = (next: Draft) => onChange({ ...report, filters: draftToFilters(next) })
  const set = <K extends keyof Report>(key: K, value: Report[K]) =>
    onChange({ ...report, [key]: value })

  const copyLink = async () => {
    // The fragment, never the query string: a report definition is made of
    // predicates, and a query string reaches nginx's request line and its
    // access log (D-014, D-032, D-069). A fragment is never sent.
    const url = `${location.origin}${location.pathname}#${toFragment(report)}`
    setLink(url)
    try {
      await navigator.clipboard.writeText(url)
      setCopied('Link copied to the clipboard.')
    } catch {
      // Clipboard access is a permission and it can simply be refused. Showing
      // the URL is the honest fallback — the user can still copy it.
      setCopied('Could not reach the clipboard; the link is below to copy by hand.')
    }
  }

  return (
    <section aria-labelledby="report-heading">
      <h2 id="report-heading">Report</h2>
      <p className="muted">
        Counts by one dimension, optionally split by a second. Nothing here leaves the browser — the
        link below carries the whole definition in the URL fragment, which is never sent to the
        server.
      </p>

      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault()
          onRun(report)
        }}
      >
        <div className="row">
          <Field label="Report title" id="report-title">
            <input
              id="report-title"
              value={report.title ?? ''}
              placeholder="CRITICAL CVEs by month"
              onChange={(event) => set('title', event.target.value)}
            />
          </Field>
          <Field label="Rows" id="report-rows">
            <select
              id="report-rows"
              value={report.rows}
              onChange={(event) => {
                const rows = event.target.value as Dimension
                // Changing Rows can make the existing split invalid. The
                // option disappears from the select in that state, but the
                // controlled value would otherwise remain unchanged and the
                // Worker would refuse the next run as a diagonal cross-tab.
                onChange({
                  ...report,
                  rows,
                  series: report.series === rows ? null : report.series,
                })
              }}
            >
              <optgroup label="Over time">
                {TIME.map((dimension) => (
                  <option key={dimension} value={dimension}>
                    {DIMENSION_LABELS[dimension]}
                  </option>
                ))}
              </optgroup>
              <optgroup label="By attribute">
                {ATTRIBUTES.map((dimension) => (
                  <option key={dimension} value={dimension}>
                    {DIMENSION_LABELS[dimension]}
                  </option>
                ))}
              </optgroup>
            </select>
          </Field>
          <Field label="Split by" id="report-series">
            <select
              id="report-series"
              value={report.series ?? ''}
              onChange={(event) =>
                set('series', event.target.value === '' ? null : (event.target.value as Dimension))
              }
            >
              <option value="">No split — one count per row</option>
              <optgroup label="Over time">
                {TIME.filter((dimension) => dimension !== report.rows).map((dimension) => (
                  <option key={dimension} value={dimension}>
                    {DIMENSION_LABELS[dimension]}
                  </option>
                ))}
              </optgroup>
              <optgroup label="By attribute">
                {ATTRIBUTES.filter((dimension) => dimension !== report.rows).map((dimension) => (
                  <option key={dimension} value={dimension}>
                    {DIMENSION_LABELS[dimension]}
                  </option>
                ))}
              </optgroup>
            </select>
          </Field>
          <Field label="Chart" id="report-chart">
            <select
              id="report-chart"
              value={report.chart}
              onChange={(event) => {
                const chart = event.target.value as ChartType
                onChange({
                  ...report,
                  chart,
                  // Table mode opens at its documented wider default; moving
                  // back to a chart restores the readable chart default. A
                  // subsequent explicit Buckets choice is still respected by
                  // both the Worker and the renderer.
                  limit:
                    chart === 'table'
                      ? TABLE_ROWS
                      : report.chart === 'table' && report.limit === TABLE_ROWS
                        ? CHART_ROWS
                        : report.limit,
                })
              }}
            >
              {CHART_TYPES.map((type) => (
                <option key={type} value={type}>
                  {CHART_LABELS[type]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Buckets" id="report-limit">
            <select
              id="report-limit"
              value={String(report.limit ?? CHART_ROWS)}
              onChange={(event) => set('limit', Number(event.target.value))}
            >
              {[6, 12, 24, 48, TABLE_ROWS].map((value) => (
                <option key={value} value={value}>
                  {value === TABLE_ROWS ? `${TABLE_ROWS} (table)` : String(value)}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <FilterChips draft={draft} onChange={setDraft} disabled={disabled} />

        <details className="filter-disclosure">
          <summary>Edit filters</summary>
          <div className="filters-inner">
            <FilterForm draft={draft} onChange={setDraft} idPrefix="report" />
          </div>
        </details>

        <div className="actions">
          <button type="submit" disabled={disabled}>
            Run report
          </button>
          <button type="button" className="quiet" disabled={disabled} onClick={copyLink}>
            Copy link
          </button>
          <label className="field inline" htmlFor="report-save-name">
            <span>Save as</span>
            <input
              id="report-save-name"
              value={name}
              placeholder="Cisco criticals"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="quiet"
            disabled={disabled || !name.trim()}
            onClick={() => {
              onSave(name)
              setName('')
            }}
          >
            Save report
          </button>
        </div>

        {link && (
          <p className="muted" data-permalink="1">
            {copied}{' '}
            <input
              readOnly
              className="permalink"
              value={link}
              aria-label="Permalink to this report"
            />
          </p>
        )}
      </form>

      {cancelledMs !== null && (
        <p className="muted" data-report-cancelled="1">
          Report cancelled after {(cancelledMs / 1000).toFixed(1)} s. Nothing was changed.
        </p>
      )}

      {outcome && (
        <ReportResult
          outcome={outcome}
          run={run}
          format={format}
          setFormat={setFormat}
          onExport={onExport}
          disabled={disabled}
          exportNote={exportNote}
        />
      )}
    </section>
  )
}

function ReportResult({
  outcome,
  run,
  format,
  setFormat,
  onExport,
  disabled,
  exportNote,
}: {
  outcome: ReportOutcome
  run: number
  format: ExportFormat
  setFormat: (format: ExportFormat) => void
  onExport: (format: ExportFormat, kind: 'records' | 'cells', report: Report) => void
  disabled: boolean
  exportNote: string
}) {
  const { result, matches, unmatched, report } = outcome
  // Built from the definition the Worker echoed back, not from the builder's
  // current state: the two diverge the moment someone edits a picker while a
  // query is running, and a chart labelled with axes it was not grouped by is
  // exactly the quiet wrongness vision criterion 7 rules out.
  const model = buildChart(
    result.rows,
    report.rows,
    report.series,
    report.limit ?? (report.chart === 'table' ? TABLE_ROWS : CHART_ROWS)
  )
  const state = report.filters.state ?? 'published'

  return (
    <div className="outcome">
      {unmatched.map((entry) => (
        <p key={entry.axis} className="error" data-unmatched={entry.axis}>
          No {entry.axis} in this copy is called {entry.values.map((v) => `“${v}”`).join(', ')}.
          Those values cannot contribute matches.
        </p>
      ))}
      {state !== 'published' && (
        <p className="stale" data-state-warning={state}>
          {state === 'all'
            ? 'Including REJECTED records: about 4.8% of the corpus, which inflates every count below against the default (D-022).'
            : 'REJECTED records only — these are withdrawn CVE IDs, not vulnerabilities.'}
        </p>
      )}

      {report.title && <h3 data-report-title="1">{report.title}</h3>}
      {/* The Worker's own numbers, for the full-scale sweep in
          tests/e2e/measure.spec.ts — read from here rather than re-parsed out
          of the rounded label beside them, the same convention the import and
          benchmark panels use. */}
      <p
        className="muted"
        data-report-matches={matches ?? ''}
        data-run={run}
        data-json={JSON.stringify({
          ms: result.ms,
          buckets: model.rows.length,
          series: model.series.length,
          cells: result.rows.length,
          truncated: result.truncated,
          matches,
        })}
      >
        {matches === null ? 'Counted' : `${matches.toLocaleString()} records match`} —{' '}
        {model.rows.length.toLocaleString()} buckets
        {report.series ? ` × ${model.series.length.toLocaleString()} series` : ''} in {result.ms} ms
        {result.truncated && ' (capped)'}
      </p>

      {report.chart !== 'table' && (
        <Chart
          model={model}
          type={report.chart}
          rowsDimension={report.rows}
          seriesDimension={report.series}
        />
      )}

      <ChartTable model={model} rowsDimension={report.rows} seriesDimension={report.series} />

      <div className="actions export-actions">
        <label className="field inline" htmlFor="export-format">
          <span>Export as</span>
          <select
            id="export-format"
            value={format}
            onChange={(event) => setFormat(event.target.value as ExportFormat)}
          >
            {EXPORT_FORMATS.map((value) => (
              <option key={value} value={value}>
                {value.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="quiet"
          disabled={disabled}
          onClick={() => onExport(format, 'cells', report)}
        >
          Export these numbers
        </button>
        <button
          type="button"
          className="quiet"
          disabled={disabled}
          onClick={() => onExport(format, 'records', report)}
        >
          Export matching records
        </button>
      </div>
      <p className="muted">
        {/* The cap is disclosed here and again inside the file, because a
            truncated export that looks complete will be read as complete. */}
        A record export covers the whole match set up to {EXPORT_LIMIT.toLocaleString()} records,
        and says on its own face when it stopped there. Every export carries MITRE&rsquo;s notice
        (D-008).
      </p>
      {exportNote && (
        <p className="muted" data-export-note="1">
          {exportNote}
        </p>
      )}

      <details className="sql">
        <summary>The SQL that produced this</summary>
        <pre>{result.sql}</pre>
        <p className="muted">Bound values: {result.params.map((p) => String(p)).join(' · ')}</p>
      </details>
    </div>
  )
}
