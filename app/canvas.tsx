'use client'

/**
 * The report canvas — the centre of the workspace (UI revamp).
 *
 * One surface renders whatever the last question produced: an aggregate as a
 * chart with its numbers, a record search as a grid, one record as the detail
 * panel. Chat, the filter drawer and the SQL drawer all land their results
 * here, which is what makes the app read as one pane of glass rather than five
 * tabs.
 *
 * The audit properties are unchanged from M4: the chart is built from the
 * definition the Worker echoed back, the complete numbers are always one
 * step away, the backing SQL is disclosed on every result, and record content
 * is rendered as text (rule 4). What the revamp adds is presentation control —
 * chart type switching, series hiding, display renames, copy as PNG/table —
 * all of which are views of the result, never a new query.
 */

import { useMemo, useRef, useState } from 'react'

import { buildChart, relabelModel, visibleModel, type ChartModel } from '@/lib/chart'
import { copyChartPng, copyGrid, type GridData } from '@/lib/clipboard'
import { describeDraft, draftToFilters, filtersToDraft } from '@/lib/draft'
import { DIMENSION_LABELS, type Dimension } from '@/lib/filters'
import { EXPORT_FORMATS, EXPORT_LIMIT, type ExportFormat } from '@/lib/export'
import type { CveDetail, QueryResult, Unmatched } from '@/lib/protocol'
import { CHART_ROWS, TABLE_ROWS, toFragment, type ChartType, type Report } from '@/lib/report'

import { Chart, ChartTable } from './chart'
import { Detail } from './detail'
import { GroupTable, RecordTable, recordGrid, groupGrid, type SearchOutcome } from './explore'
import { Field, FilterChips } from './filter-form'

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

export function Canvas({
  view,
  report,
  onChangeReport,
  onRun,
  reportOutcome,
  searchOutcome,
  disabled,
  run,
  cancelledMs,
  exportNote,
  onExport,
  onSave,
  onOpenRecord,
  detailId,
  detail,
  onCloseDetail,
  hiddenSeries,
  onToggleSeries,
  seriesLabels,
  onSeriesLabel,
  dataAsOf,
}: {
  /** What the canvas is showing: the last thing that ran. */
  view: 'report' | 'records'
  report: Report
  /** Definition edits that do not need a re-query (title, chart type). */
  onChangeReport: (report: Report) => void
  /** Definition edits that do — a removed filter chip re-runs immediately. */
  onRun: (report: Report) => void
  reportOutcome: ReportOutcome | null
  searchOutcome: SearchOutcome | null
  disabled: boolean
  run: number
  cancelledMs: { kind: string; ms: number } | null
  exportNote: string
  onExport: (format: ExportFormat, kind: 'records' | 'cells', report: Report) => void
  onSave: (name: string) => void
  onOpenRecord: (cveId: string) => void
  detailId: string | null
  detail: CveDetail | null | undefined
  onCloseDetail: () => void
  hiddenSeries: ReadonlySet<string>
  onToggleSeries: (key: string) => void
  seriesLabels: Readonly<Record<string, string>>
  onSeriesLabel: (key: string, label: string) => void
  /** The copy's build stamp, for the PNG subtitle. */
  dataAsOf: string | null
}) {
  const [name, setName] = useState('')
  const [format, setFormat] = useState<ExportFormat>('csv')
  const [link, setLink] = useState('')
  const [copied, setCopied] = useState('')
  const [copyNote, setCopyNote] = useState('')
  const chartHost = useRef<HTMLDivElement | null>(null)

  /**
   * The definition the visible result actually ran — the Worker's echo, never
   * the editable state. Chips, the row cap, and a copied image's subtitle all
   * derive from this: editing a filter or Buckets in the drawer must not
   * relabel or truncate a chart it was never applied to (M4's rule; a review
   * caught this canvas violating it). The live `report` supplies only
   * presentation — title, chart type, series visibility and display names.
   * The records view has no echoed definition in its outcome, so it falls
   * back to the live state, which "List records" runs verbatim.
   */
  const ran = view === 'report' && reportOutcome ? reportOutcome.report : null
  const draft = filtersToDraft((ran ?? report).filters)
  const title = report.title?.trim() || describeReport(ran ?? report)

  const model = useMemo(
    () =>
      reportOutcome
        ? buildChart(
            reportOutcome.result.rows,
            reportOutcome.report.rows,
            reportOutcome.report.series,
            reportOutcome.report.limit ??
              (reportOutcome.report.chart === 'table' ? TABLE_ROWS : CHART_ROWS)
          )
        : null,
    [reportOutcome]
  )

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
      setCopied('Could not reach the clipboard; the link is below to copy by hand.')
    }
  }

  const copyPng = async () => {
    const svg = chartHost.current?.querySelector<SVGSVGElement>('figure.chart svg')
    if (!svg || !model) {
      setCopyNote('There is no chart on screen to copy.')
      return
    }
    const chips = describeDraft(draft)
      .map((chip) => chip.label)
      .join(' · ')
    // The legend as drawn: display renames applied, hidden series absent. The
    // SVG alone has no colour-to-label mapping — the legend is HTML — so the
    // renderer draws this into the image (a copied multi-series chart with no
    // legend is unreadable at its destination).
    const visible = visibleModel(relabelModel(model, seriesLabels), hiddenSeries)
    const note = await copyChartPng(svg, {
      title,
      subtitle: dataAsOf ? `${chips} — data as of ${dataAsOf}` : chips,
      legend: ran?.series ? visible.series : [],
    })
    setCopyNote(note)
  }

  const copyNumbers = async (grid: GridData) => {
    setCopyNote(await copyGrid(grid))
  }

  return (
    <section className="canvas" aria-labelledby="canvas-title">
      <div className="canvas-head">
        {/* The title is the input: editing it is the common path for a chart
            headed somewhere public, and a separate edit mode would hide that
            it can change. Record-derived text never lands here — it is the
            user's own words (rule 4 still applies downstream). */}
        <input
          id="canvas-title"
          className="canvas-title"
          data-report-title={report.title?.trim() ? '1' : undefined}
          aria-label="Report title"
          placeholder={describeReport(report)}
          value={report.title ?? ''}
          onChange={(event) => onChangeReport({ ...report, title: event.target.value })}
        />
        {view === 'report' && (
          <div className="canvas-tools">
            <Field label="Chart" id="report-chart">
              <select
                id="report-chart"
                value={report.chart}
                onChange={(event) => {
                  const chart = event.target.value as ChartType
                  onChangeReport({
                    ...report,
                    chart,
                    limit:
                      chart === 'table'
                        ? TABLE_ROWS
                        : report.chart === 'table' && report.limit === TABLE_ROWS
                          ? CHART_ROWS
                          : report.limit,
                  })
                }}
              >
                {(Object.keys(CHART_LABELS) as ChartType[]).map((type) => (
                  <option
                    key={type}
                    value={type}
                    // A line over vendors is a trend that does not exist; the
                    // option stays visible so the reader sees why it is off.
                    disabled={type === 'line' && !isTimeDimension(report.rows)}
                  >
                    {CHART_LABELS[type]}
                  </option>
                ))}
              </select>
            </Field>
            <button type="button" className="quiet" onClick={copyPng} data-copy-png="1">
              Copy chart as image
            </button>
            {model && (
              <button
                type="button"
                className="quiet"
                data-copy-table="1"
                onClick={() =>
                  reportOutcome &&
                  // The relabelled model, complete: the copy matches the table
                  // below the chart — display renames applied, every series
                  // present, because the numbers are the audit channel.
                  copyNumbers(
                    chartGrid(
                      relabelModel(model, seriesLabels),
                      title,
                      reportOutcome.report.rows,
                      reportOutcome.report.series
                    )
                  )
                }
              >
                Copy numbers
              </button>
            )}
          </div>
        )}
        {view === 'records' && searchOutcome && (
          <div className="canvas-tools">
            <button
              type="button"
              className="quiet"
              data-copy-table="1"
              onClick={() =>
                copyNumbers(
                  searchOutcome.groupBy
                    ? groupGrid(searchOutcome.result, searchOutcome.groupBy, title)
                    : recordGrid(searchOutcome.result, title)
                )
              }
            >
              Copy table
            </button>
          </div>
        )}
      </div>

      {/* What the visible result counted, as chips — from the ran definition,
          so an unapplied drawer edit never labels the old chart. Removing one
          is an edit that re-runs immediately, based on the ran filters plus
          the live presentation fields (title, chart type). */}
      <FilterChips
        draft={draft}
        onChange={(next) =>
          onRun({
            ...(ran ?? report),
            title: report.title,
            chart: report.chart,
            filters: draftToFilters(next),
          })
        }
        disabled={disabled}
      />

      {copyNote && (
        <p className="muted small" data-copy-note="1" aria-live="polite">
          {copyNote}
        </p>
      )}

      {cancelledMs !== null && (
        <p className="muted" data-report-cancelled="1">
          Cancelled after {(cancelledMs.ms / 1000).toFixed(1)} s. Nothing was changed.
        </p>
      )}

      {view === 'report' && reportOutcome && model && (
        <ReportView
          outcome={reportOutcome}
          model={model}
          report={report}
          run={run}
          hostRef={chartHost}
          hiddenSeries={hiddenSeries}
          onToggleSeries={onToggleSeries}
          seriesLabels={seriesLabels}
          onSeriesLabel={onSeriesLabel}
        />
      )}

      {view === 'records' && (
        <RecordsView
          outcome={searchOutcome}
          run={run}
          onOpenRecord={onOpenRecord}
          detailId={detailId}
          detail={detail}
          onCloseDetail={onCloseDetail}
        />
      )}

      {/* Sharing and exporting, together: everything that takes the result
          somewhere else. Open by default is wrong — it is a second row of
          buttons on every render — but it is one click and remembers nothing. */}
      <details className="share" data-share="1">
        <summary>Save, share &amp; export</summary>
        <div className="actions">
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
          {view === 'report' && (
            <button
              type="button"
              className="quiet"
              disabled={disabled}
              onClick={() => reportOutcome && onExport(format, 'cells', reportOutcome.report)}
            >
              Export these numbers
            </button>
          )}
          <button
            type="button"
            className="quiet"
            disabled={disabled}
            onClick={() =>
              onExport(
                format,
                'records',
                view === 'report' && reportOutcome ? reportOutcome.report : report
              )
            }
          >
            Export matching records
          </button>
        </div>
        <p className="muted small">
          A record export covers the whole match set up to {EXPORT_LIMIT.toLocaleString()} records,
          and says on its own face when it stopped there. Every export carries MITRE&rsquo;s notice
          (D-008).
        </p>
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
        {exportNote && (
          <p className="muted" data-export-note="1">
            {exportNote}
          </p>
        )}
      </details>
    </section>
  )
}

function ReportView({
  outcome,
  model,
  report,
  run,
  hostRef,
  hiddenSeries,
  onToggleSeries,
  seriesLabels,
  onSeriesLabel,
}: {
  outcome: ReportOutcome
  model: ChartModel
  report: Report
  run: number
  hostRef: React.RefObject<HTMLDivElement | null>
  hiddenSeries: ReadonlySet<string>
  onToggleSeries: (key: string) => void
  seriesLabels: Readonly<Record<string, string>>
  onSeriesLabel: (key: string, label: string) => void
}) {
  const { result, matches, unmatched } = outcome
  const state = outcome.report.filters.state ?? 'published'
  // Axes from the definition the Worker echoed back, never the builder's
  // current state — the two diverge while a query is running, and a chart
  // labelled with axes it was not grouped by is quiet wrongness (M4).
  const rows = outcome.report.rows
  const series = outcome.report.series

  return (
    <div className="outcome" ref={hostRef}>
      {unmatched.map((entry) => (
        <p key={entry.axis} className="error" data-unmatched={entry.axis}>
          No {entry.axis} in this copy is called {entry.values.map((v) => `“${v}”`).join(', ')}.
          Those values cannot contribute matches.
        </p>
      ))}
      <StateWarning state={state} />

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
        {series ? ` × ${model.series.length.toLocaleString()} series` : ''} in {result.ms} ms
        {result.truncated && ' (capped)'}
      </p>

      {report.chart !== 'table' && (
        <Chart
          model={model}
          type={report.chart}
          rowsDimension={rows}
          seriesDimension={series}
          hidden={hiddenSeries}
          labels={seriesLabels}
          onToggleSeries={onToggleSeries}
        />
      )}

      {series !== null && model.series.length > 0 && (
        <details className="series-labels" data-series-labels="1">
          <summary>Rename series</summary>
          <div className="series-labels-inner">
            {model.series.map((entry) => (
              <label key={entry.key} className="field inline">
                <span>{entry.label}</span>
                <input
                  value={seriesLabels[entry.key] ?? ''}
                  placeholder={entry.label}
                  aria-label={`Display name for series ${entry.label}`}
                  onChange={(event) => onSeriesLabel(entry.key, event.target.value)}
                />
              </label>
            ))}
          </div>
          <p className="muted small">
            Display names only — they change the legend, the table and a copied image, never the
            saved definition.
          </p>
        </details>
      )}

      <ChartTable
        model={model}
        rowsDimension={rows}
        seriesDimension={series}
        labels={seriesLabels}
      />

      <Backing sql={result.sql} params={result.params} />
    </div>
  )
}

function RecordsView({
  outcome,
  run,
  onOpenRecord,
  detailId,
  detail,
  onCloseDetail,
}: {
  outcome: SearchOutcome | null
  run: number
  onOpenRecord: (cveId: string) => void
  detailId: string | null
  detail: CveDetail | null | undefined
  onCloseDetail: () => void
}) {
  return (
    <div className="outcome">
      {detailId && <Detail cveId={detailId} detail={detail} onClose={onCloseDetail} />}
      {outcome && (
        <>
          {outcome.unmatched.map((entry) => (
            <p key={entry.axis} className="error" data-unmatched={entry.axis}>
              No {entry.axis} in this copy is called {entry.values.map((v) => `“${v}”`).join(', ')}.
              Those values cannot contribute matches. Group by {entry.axis} with no filter to see
              the names that exist.
            </p>
          ))}
          <StateWarning state={outcome.state} />
          <p className="muted" data-matches={outcome.matches ?? ''} data-run={run}>
            {outcome.matches === null
              ? `${outcome.result.rows.length.toLocaleString()} rows`
              : `${outcome.matches.toLocaleString()} records match`}
            {outcome.groupBy ? ` — grouped by ${DIMENSION_LABELS[outcome.groupBy]},` : ' —'}{' '}
            {outcome.result.rows.length.toLocaleString()} shown in {outcome.result.ms} ms
            {outcome.result.truncated && ' (capped)'}
          </p>
          <div className="scroll" tabIndex={0}>
            {outcome.groupBy ? (
              <GroupTable result={outcome.result} dimension={outcome.groupBy} />
            ) : (
              <RecordTable result={outcome.result} onOpenRecord={onOpenRecord} />
            )}
          </div>
          <Backing sql={outcome.result.sql} params={outcome.result.params} />
        </>
      )}
    </div>
  )
}

function StateWarning({ state }: { state: string }) {
  if (state === 'published') return null
  return (
    <p className="stale" data-state-warning={state}>
      {state === 'all'
        ? 'Including REJECTED records: about 4.8% of the corpus, which inflates every count below against the default (D-022).'
        : 'REJECTED records only — these are withdrawn CVE IDs, not vulnerabilities.'}
    </p>
  )
}

/** The query behind the numbers, always available (vision criterion 7). */
function Backing({ sql, params }: { sql: string; params: (string | number)[] }) {
  return (
    <details className="sql">
      <summary>The SQL that produced this</summary>
      <pre>{sql}</pre>
      <p className="muted">Bound values: {params.map((p) => String(p)).join(' · ')}</p>
    </details>
  )
}

/** What an untitled report is called, from its own axes. */
function describeReport(report: Report): string {
  return report.series
    ? `${DIMENSION_LABELS[report.rows]} × ${DIMENSION_LABELS[report.series]}`
    : DIMENSION_LABELS[report.rows]
}

function isTimeDimension(dimension: Dimension): boolean {
  return dimension === 'year' || dimension === 'quarter' || dimension === 'month'
}

/** A chart model as a copyable grid — the same cells the table renders. */
function chartGrid(
  model: ChartModel,
  title: string,
  rows: Dimension,
  series: Dimension | null
): GridData {
  const cross = series !== null
  return {
    title,
    columns: [
      DIMENSION_LABELS[rows],
      ...model.series.map((entry) => entry.label),
      ...(cross ? ['Total'] : []),
    ],
    rows: model.rows.map((row) => [row.label, ...row.values, ...(cross ? [row.total] : [])]),
  }
}
