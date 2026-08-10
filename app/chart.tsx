'use client'

/**
 * Charts, hand-rolled in inline SVG (M4's shape decision).
 *
 * No charting dependency: nothing extra to audit under D-002, and the
 * accessibility story is ours rather than a library's defaults — which matters
 * because the accessible form of a chart is not a `title` attribute, it is the
 * numbers. Every chart here ships its data as a table, and that table is both
 * the accessibility channel and the audit one: it is how a reader checks that
 * the bar they are looking at says what the query returned.
 *
 * The SVG carries `role="img"` and a summary label. It does *not* try to be
 * navigable — a screen reader stepping through 60 `<rect>`s is worse than
 * useless — so the label says what the chart is and points at the table, which
 * is a real table with real headers.
 *
 * Colours come from `lib/chart.ts` as `var(--…)` references and resolve in the
 * reader's own colour scheme (see `app/globals.css`). Severity is an ordinal
 * ramp with CRITICAL at the baseline; identity dimensions get categorical slots.
 *
 * The UI revamp added the legend as a control: each entry can hide its series
 * from the *drawing* — the y-scale re-fits to what is visible — while the
 * table below always renders the complete model, because the numbers are the
 * audit channel and a toggle must not hide data. Series names can also carry
 * display overrides (`labels`), which never travel in a definition.
 */

import { useId } from 'react'

import { niceTicks, relabelModel, shortCount, visibleModel, type ChartModel } from '@/lib/chart'
import { DIMENSION_LABELS, TIME_DIMENSIONS, type Dimension } from '@/lib/filters'
import type { ChartType } from '@/lib/report'

/** The drawing box. Scaled to the container by `width: 100%` on the element. */
const W = 860
const H = 400
const PAD = { top: 14, right: 14, bottom: 92, left: 64 }
const PLOT_W = W - PAD.left - PAD.right
const PLOT_H = H - PAD.top - PAD.bottom

/** Longest x-axis label drawn before it is cut; the full text stays in the table. */
const LABEL_CHARS = 18

const NO_HIDDEN: ReadonlySet<string> = new Set()

export function Chart({
  model,
  type,
  rowsDimension,
  seriesDimension,
  hidden = NO_HIDDEN,
  labels,
  onToggleSeries,
}: {
  model: ChartModel
  type: ChartType
  rowsDimension: Dimension
  seriesDimension: Dimension | null
  /** Series keys the reader has hidden from the drawing. */
  hidden?: ReadonlySet<string>
  /** Display-only series renames, keyed like `hidden`. */
  labels?: Readonly<Record<string, string>>
  /** Offered in the legend when provided; without it the legend is a list. */
  onToggleSeries?: (key: string) => void
}) {
  const titleId = useId()
  if (model.rows.length === 0) {
    return (
      <p className="muted" data-chart="empty">
        Nothing matched, so there is nothing to chart.
      </p>
    )
  }

  const named = labels ? relabelModel(model, labels) : model
  const view = visibleModel(named, hidden)

  const stacked = type === 'stackedBar'
  const scaleMax = stacked ? view.maxTotal : view.max
  const ticks = niceTicks(scaleMax)
  const top = ticks[ticks.length - 1] || 1
  const y = (value: number) => PAD.top + PLOT_H * (1 - value / top)
  const band = PLOT_W / view.rows.length
  const summary =
    `${DIMENSION_LABELS[rowsDimension]} by ` +
    (seriesDimension ? DIMENSION_LABELS[seriesDimension] : 'CVE count') +
    `, ${view.rows.length} buckets, ${view.total.toLocaleString()} CVEs in total. ` +
    'The same numbers are in the table below this chart.'

  return (
    <figure className="chart" data-chart={type}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-labelledby={titleId}
        preserveAspectRatio="xMidYMid meet"
      >
        <title id={titleId}>{summary}</title>

        {/* Gridlines and the y scale. Drawn first so every mark sits over them. */}
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={PAD.left} x2={PAD.left + PLOT_W} y1={y(tick)} y2={y(tick)} className="grid" />
            <text x={PAD.left - 8} y={y(tick) + 4} className="axis" textAnchor="end">
              {shortCount(tick)}
            </text>
          </g>
        ))}

        {type === 'line'
          ? view.series.map((entry, sIndex) => (
              <polyline
                key={entry.key}
                className="series-line"
                stroke={entry.color}
                points={view.rows
                  .map(
                    (row, rIndex) =>
                      `${PAD.left + band * (rIndex + 0.5)},${y(row.values[sIndex] ?? 0)}`
                  )
                  .join(' ')}
              />
            ))
          : view.rows.map((row, rIndex) => {
              const slot = PAD.left + band * rIndex
              const inner = band * 0.72
              const left = slot + (band - inner) / 2
              if (stacked) {
                let base = 0
                return (
                  <g key={row.key}>
                    {view.series.map((entry, sIndex) => {
                      const value = row.values[sIndex] ?? 0
                      const height = (value / top) * PLOT_H
                      const yTop = y(base + value)
                      base += value
                      if (value === 0) return null
                      return (
                        <rect
                          key={entry.key}
                          x={left}
                          y={yTop}
                          width={inner}
                          height={Math.max(height, 0.5)}
                          fill={entry.color}
                          className="bar"
                        >
                          <title>{`${row.label} — ${entry.label}: ${value.toLocaleString()}`}</title>
                        </rect>
                      )
                    })}
                  </g>
                )
              }
              const each = inner / Math.max(1, view.series.length)
              return (
                <g key={row.key}>
                  {view.series.map((entry, sIndex) => {
                    const value = row.values[sIndex] ?? 0
                    if (value === 0) return null
                    const height = (value / top) * PLOT_H
                    return (
                      <rect
                        key={entry.key}
                        x={left + each * sIndex}
                        y={y(value)}
                        width={Math.max(each - 1, 1)}
                        height={Math.max(height, 0.5)}
                        fill={entry.color}
                        className="bar"
                      >
                        <title>{`${row.label} — ${entry.label}: ${value.toLocaleString()}`}</title>
                      </rect>
                    )
                  })}
                </g>
              )
            })}

        {/* The x axis, and its labels. Rotated because an identity bucket is a
            vendor name, not a year — and a horizontal label would either
            overlap its neighbour or be cut to nothing. */}
        <line
          x1={PAD.left}
          x2={PAD.left + PLOT_W}
          y1={PAD.top + PLOT_H}
          y2={PAD.top + PLOT_H}
          className="axis-line"
        />
        {view.rows.map((row, rIndex) => {
          const x = PAD.left + band * (rIndex + 0.5)
          const short =
            row.label.length > LABEL_CHARS ? `${row.label.slice(0, LABEL_CHARS - 1)}…` : row.label
          return (
            <text
              key={row.key}
              className="axis"
              textAnchor="end"
              transform={`translate(${x}, ${PAD.top + PLOT_H + 12}) rotate(-38)`}
            >
              {short}
              {short !== row.label && <title>{row.label}</title>}
            </text>
          )
        })}
      </svg>

      <figcaption>
        {/* The legend is HTML rather than SVG text: it has to reflow on a narrow
            screen, and a swatch beside a word is a list, not a drawing. It lists
            the *complete* series set — a hidden series stays in the legend, as
            the control that brings it back. */}
        <ul className="legend" data-series={named.series.length}>
          {named.series.map((entry) => {
            const isHidden = hidden.has(entry.key)
            const swatch = (
              <span
                className="swatch"
                style={{ background: entry.color }}
                aria-hidden="true"
                data-swatch-hidden={isHidden ? '1' : undefined}
              />
            )
            return (
              <li key={entry.key} data-series-hidden={isHidden ? '1' : undefined}>
                {onToggleSeries ? (
                  <button
                    type="button"
                    className="legend-toggle"
                    aria-pressed={!isHidden}
                    aria-label={`${isHidden ? 'Show' : 'Hide'} series: ${entry.label}`}
                    onClick={() => onToggleSeries(entry.key)}
                  >
                    {swatch}
                    {entry.label}
                  </button>
                ) : (
                  <>
                    {swatch}
                    {entry.label}
                  </>
                )}
              </li>
            )
          })}
        </ul>
        {(model.droppedRows > 0 || model.droppedSeries > 0) && (
          <p className="stale" data-chart-capped="1">
            {model.droppedRows > 0 &&
              `${model.droppedRows.toLocaleString()} more ${DIMENSION_LABELS[
                rowsDimension
              ].toLowerCase()} buckets are not shown. `}
            {model.droppedSeries > 0 &&
              seriesDimension &&
              `At least ${model.droppedSeries.toLocaleString()} more ${DIMENSION_LABELS[
                seriesDimension
              ].toLowerCase()} series are not shown, and their records are not counted in these bars; lower-volume series may also fall outside the aggregate cap. `}
            Narrow the filters, or export the table for the whole set.
          </p>
        )}
      </figcaption>
    </figure>
  )
}

/**
 * The numbers, as a table.
 *
 * Always rendered, never a fallback: it is what a screen reader reads, what a
 * keyboard user reaches, and what anyone checking a surprising bar looks at.
 * Row and column headers are real `<th scope>` cells, which is the difference
 * between a table a screen reader can navigate and a grid of unlabelled
 * numbers. It renders the complete model even when the chart above has series
 * hidden — the table is the audit channel.
 */
export function ChartTable({
  model,
  rowsDimension,
  seriesDimension,
  labels,
}: {
  model: ChartModel
  rowsDimension: Dimension
  seriesDimension: Dimension | null
  /** The same display renames the chart applies, so the two agree. */
  labels?: Readonly<Record<string, string>>
}) {
  const named = labels ? relabelModel(model, labels) : model
  const cross = seriesDimension !== null
  return (
    <div className="scroll" tabIndex={0}>
      <table className="results chart-data">
        <caption className="muted">
          {DIMENSION_LABELS[rowsDimension]}
          {cross ? ` × ${DIMENSION_LABELS[seriesDimension]}` : ''} — CVE counts
          {TIME_DIMENSIONS.has(rowsDimension) ? ', oldest first' : ', largest first'}
        </caption>
        <thead>
          <tr>
            <th scope="col">{DIMENSION_LABELS[rowsDimension]}</th>
            {named.series.map((entry) => (
              <th scope="col" key={entry.key}>
                {entry.label}
              </th>
            ))}
            {cross && <th scope="col">Total</th>}
          </tr>
        </thead>
        <tbody>
          {named.rows.map((row) => (
            <tr key={row.key}>
              {/* Record content is a text node, never markup (rule 4). */}
              <th scope="row">{row.label}</th>
              {row.values.map((value, at) => (
                <td key={named.series[at]?.key ?? at}>{value.toLocaleString()}</td>
              ))}
              {cross && <td className="total">{row.total.toLocaleString()}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
