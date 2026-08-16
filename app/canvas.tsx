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
import { axisBounds } from '@/lib/dates'
import { describeDraft, draftToFilters, filtersToDraft } from '@/lib/draft'
import { DIMENSION_LABELS, type Dimension } from '@/lib/filters'
import { EXPORT_FORMATS, EXPORT_LIMIT, type ExportFormat } from '@/lib/export'
import type { Coverage, CveDetail, QueryResult, Unmatched } from '@/lib/protocol'
import { CHART_ROWS, TABLE_ROWS, toFragment, type ChartType, type Report } from '@/lib/report'

import { Chart, ChartTable } from './chart'
import { DateRangeField } from './date-range'
import { Detail } from './detail'
import { GroupTable, RecordTable, recordGrid, groupGrid, type SearchOutcome } from './explore'
import { FilterChips } from './filter-form'

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
  area: 'Stacked area',
  table: 'Table',
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
  coverage,
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
  /** The copy's date extent, which bounds the range control (M9). */
  coverage: Coverage | null
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
  /**
   * The *live* definition's filters, for the canvas's own editable controls
   * (the date range) — the drawer edits the same object, so the two agree.
   * Distinct from `draft` above, which is the ran definition and labels only.
   */
  const liveDraft = filtersToDraft(report.filters)

  /**
   * Edit the published-date window and re-run — the canvas's own range control.
   *
   * Both edges at once, because the picker commits a *range*: setting them one
   * at a time would run the report against a half-applied window, which on the
   * hosted tier is a second round trip for an answer nobody asked for.
   */
  const setRange = (from: string, to: string) => {
    onRun({
      ...report,
      filters: draftToFilters({ ...liveDraft, publishedFrom: from, publishedTo: to }),
    })
  }

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
            {/* The chart types as a row of icon toggles (M9): each is one
                click, the active one is pressed, and a type the axes cannot
                draw stays visible but disabled — a line or area over vendors
                is a trend that does not exist. */}
            <div
              className="chart-picker"
              role="group"
              aria-label="Chart type"
              data-chart-picker="1"
            >
              {(Object.keys(CHART_LABELS) as ChartType[]).map((type) => (
                <button
                  key={type}
                  type="button"
                  className="quiet icon"
                  aria-pressed={report.chart === type}
                  aria-label={CHART_LABELS[type]}
                  title={CHART_LABELS[type]}
                  data-chart-type={type}
                  disabled={(type === 'line' || type === 'area') && !isTimeDimension(report.rows)}
                  onClick={() =>
                    onChangeReport({
                      ...report,
                      chart: type,
                      limit:
                        type === 'table'
                          ? TABLE_ROWS
                          : report.chart === 'table' && report.limit === TABLE_ROWS
                            ? CHART_ROWS
                            : report.limit,
                    })
                  }
                >
                  <ChartTypeIcon type={type} />
                </button>
              ))}
            </div>
            {/* One copy control (M9): what it copies follows what is shown —
                the chart as a PNG, or the Table view's numbers as a grid. The
                relabelled model, complete: display renames applied, every
                series present, because the numbers are the audit channel. */}
            <button
              type="button"
              className="quiet icon"
              data-copy={report.chart === 'table' ? 'table' : 'chart'}
              aria-label={report.chart === 'table' ? 'Copy table' : 'Copy chart as image'}
              title={report.chart === 'table' ? 'Copy table' : 'Copy chart as image'}
              disabled={!model}
              onClick={() =>
                report.chart === 'table'
                  ? model &&
                    reportOutcome &&
                    copyNumbers(
                      chartGrid(
                        relabelModel(model, seriesLabels),
                        title,
                        reportOutcome.report.rows,
                        reportOutcome.report.series
                      )
                    )
                  : copyPng()
              }
            >
              <CopyIcon />
            </button>
          </div>
        )}
        {view === 'records' && searchOutcome && (
          <div className="canvas-tools">
            <button
              type="button"
              className="quiet icon"
              data-copy="table"
              aria-label="Copy table"
              title="Copy table"
              onClick={() =>
                copyNumbers(
                  searchOutcome.groupBy
                    ? groupGrid(searchOutcome.result, searchOutcome.groupBy, title)
                    : recordGrid(searchOutcome.result, title)
                )
              }
            >
              <CopyIcon />
            </button>
          </div>
        )}
      </div>

      {/* The published-date window and the time bucket, as canvas controls
          (M9): the range is the filter every trend question edits, so it
          lives at the top of the chart rather than in the drawer — the same
          `publishedFrom`/`publishedTo` predicates, so the drawer, the chips
          and a permalink all agree. Changing either re-runs immediately. */}
      {view === 'report' && (
        <div className="canvas-range" data-canvas-range="1">
          <DateRangeField
            label="Published"
            name="canvas-published"
            idPrefix="canvas-pub"
            inline
            from={liveDraft.publishedFrom}
            to={liveDraft.publishedTo}
            bounds={axisBounds(coverage, 'published')}
            disabled={disabled}
            onChange={setRange}
          />
          {isTimeDimension(report.rows) && (
            <fieldset className="granularity" data-granularity={report.rows}>
              <legend className="visually-hidden">Time buckets</legend>
              {(
                [
                  ['month', 'Monthly'],
                  ['quarter', 'Quarterly'],
                  ['year', 'Yearly'],
                ] as const
              ).map(([dimension, label]) => (
                <label key={dimension} className="check">
                  <input
                    type="radio"
                    name="canvas-granularity"
                    value={dimension}
                    checked={report.rows === dimension}
                    // The split axis cannot double as the buckets — a report
                    // refuses rows === series, so the radio does too.
                    disabled={disabled || report.series === dimension}
                    onChange={() => onRun({ ...report, rows: dimension })}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
          )}
        </div>
      )}

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

      {/* Visible as the Table view's spreadsheet; under a chart it stays in
          the DOM visually hidden — the screen-reader and audit channel (M9). */}
      <ChartTable
        model={model}
        rowsDimension={rows}
        seriesDimension={series}
        labels={seriesLabels}
        view={report.chart === 'table' ? 'spreadsheet' : 'audit'}
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

/**
 * One glyph per chart type, drawn to read at a glance in 16 px. Decorative
 * (`aria-hidden`); the button's aria-label and title carry the name.
 */
function ChartTypeIcon({ type }: { type: ChartType }) {
  switch (type) {
    case 'stackedBar':
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
          <rect x="2" y="9" width="4" height="5" />
          <rect x="2" y="5" width="4" height="3" opacity="0.5" />
          <rect x="10" y="6" width="4" height="8" />
          <rect x="10" y="2" width="4" height="3" opacity="0.5" />
        </svg>
      )
    case 'groupedBar':
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
          <rect x="1.5" y="6" width="2.6" height="8" />
          <rect x="4.6" y="9" width="2.6" height="5" opacity="0.5" />
          <rect x="9" y="3" width="2.6" height="11" />
          <rect x="12.1" y="7" width="2.6" height="7" opacity="0.5" />
        </svg>
      )
    case 'line':
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true" fill="none">
          <polyline
            points="1.5,12.5 6,6.5 10,9.5 14.5,3"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
    case 'area':
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M1.5 13.5v-2l4.5-5 4 3 4.5-5.5v9.5z" fill="currentColor" opacity="0.6" />
          <polyline
            points="1.5,11.5 6,6.5 10,9.5 14.5,4"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
    case 'table':
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true" fill="none">
          <path
            d="M2 3h12v10H2zM2 6.5h12M2 10h12M6.5 3v10"
            stroke="currentColor"
            strokeWidth="1.3"
          />
        </svg>
      )
  }
}

/** The standard copy glyph — two stacked sheets. Decorative; the button labels itself. */
function CopyIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
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
