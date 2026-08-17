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
 * reader's own colour scheme (see `app/globals.css`). Severity is hue-coded
 * with CRITICAL at the baseline (D-083); identity dimensions get categorical
 * slots.
 *
 * The UI revamp added the legend as a control: each entry can hide its series
 * from the *drawing* — the y-scale re-fits to what is visible — while the
 * table below always renders the complete model, because the numbers are the
 * audit channel and a toggle must not hide data. Series names can also carry
 * display overrides (`labels`), which never travel in a definition.
 */

import { useId, useState } from 'react'

import { niceTicks, relabelModel, shortCount, visibleModel, type ChartModel } from '@/lib/chart'
import { DIMENSION_LABELS, TIME_DIMENSIONS, type Dimension } from '@/lib/filters'
import type { ChartType } from '@/lib/report'

/** The drawing box. Scaled to the container by `width: 100%` on the element. */
const W = 860
const H = 400
const PAD = { top: 14, right: 14, bottom: 100, left: 64 }
const PLOT_W = W - PAD.left - PAD.right
const PLOT_H = H - PAD.top - PAD.bottom

/**
 * Longest x-axis label drawn before it is cut; the full text stays in the
 * table. Twenty is a week's Monday plus " (partial)" — the one long label a
 * time axis carries — and `PAD.bottom` is sized for it at the label's slant.
 */
const LABEL_CHARS = 20
/** Most x-axis labels drawn; past this every k-th bucket is labelled. */
const MAX_LABELS = 26

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
  /**
   * The hovered bucket, for the tooltip — presentation only, the same numbers
   * as the table. `x`/`y` are pixels relative to the figure; the flips keep
   * the tooltip inside it near the right and bottom edges.
   */
  const [tip, setTip] = useState<{
    index: number
    x: number
    y: number
    flipX: boolean
    flipY: boolean
  } | null>(null)
  if (model.rows.length === 0) {
    return (
      <p className="muted" data-chart="empty">
        Nothing matched, so there is nothing to chart.
      </p>
    )
  }

  const named = labels ? relabelModel(model, labels) : model
  const view = visibleModel(named, hidden)

  // A stacked area is a stacked bar drawn continuously: same scale, same order.
  const stacked = type === 'stackedBar' || type === 'area'
  const scaleMax = stacked ? view.maxTotal : view.max
  const ticks = niceTicks(scaleMax)
  const top = ticks[ticks.length - 1] || 1
  const y = (value: number) => PAD.top + PLOT_H * (1 - value / top)
  const band = PLOT_W / view.rows.length
  const labelStep = Math.max(1, Math.ceil(view.rows.length / MAX_LABELS))

  /**
   * Which bucket the pointer is over, from the pointer's place in the SVG's
   * own coordinates. `preserveAspectRatio="meet"` letterboxes when the element
   * is wider than the drawing, so the offset has to be undone before dividing
   * by the band — a naive `x / width * W` points at the wrong bucket on a wide
   * canvas.
   */
  const trackPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const scale = Math.min(rect.width / W, rect.height / H)
    if (scale <= 0) return
    const plotX = (event.clientX - rect.left - (rect.width - W * scale) / 2) / scale
    if (plotX < PAD.left || plotX > PAD.left + PLOT_W) {
      setTip(null)
      return
    }
    const index = Math.min(view.rows.length - 1, Math.max(0, Math.floor((plotX - PAD.left) / band)))
    const x = event.clientX - rect.left
    const pointerY = event.clientY - rect.top
    setTip({
      index,
      x,
      y: pointerY,
      flipX: x > rect.width / 2,
      flipY: pointerY > rect.height * 0.6,
    })
  }

  /** The stacked-area bands: each series a strip between two cumulative sums. */
  const areaBands = () => {
    const running = view.rows.map(() => 0)
    return view.series.map((entry, sIndex) => {
      // The lower edge is the previous series' cumulative line — computed
      // before `running` is advanced, which the upper edge then does.
      const lower = view.rows.map(
        (_, rIndex) => `${PAD.left + band * (rIndex + 0.5)},${y(running[rIndex] ?? 0)}`
      )
      const upper = view.rows.map((row, rIndex) => {
        running[rIndex] = (running[rIndex] ?? 0) + (row.values[sIndex] ?? 0)
        return `${PAD.left + band * (rIndex + 0.5)},${y(running[rIndex] ?? 0)}`
      })
      return (
        <polygon
          key={entry.key}
          className="series-area"
          fill={entry.color}
          points={`${upper.join(' ')} ${lower.reverse().join(' ')}`}
        />
      )
    })
  }
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
        onPointerMove={trackPointer}
        onPointerLeave={() => setTip(null)}
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

        {/* Partial buckets — the current week or month, or an edge the window
            cuts — shaded behind their marks, so a line or an area over them
            reads as provisional too, not only a bar. The label says why. */}
        {view.rows.map((row, rIndex) =>
          row.partial ? (
            <rect
              key={row.key}
              className="partial-band"
              data-partial-band={row.key}
              x={PAD.left + band * rIndex}
              y={PAD.top}
              width={band}
              height={PLOT_H}
            />
          ) : null
        )}

        {/* The hovered bucket's band, behind the marks. */}
        {tip && (
          <rect
            className="hover-band"
            x={PAD.left + band * tip.index}
            y={PAD.top}
            width={band}
            height={PLOT_H}
          />
        )}

        {type === 'line' &&
          view.series.map((entry, sIndex) => (
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
          ))}

        {type === 'area' && areaBands()}

        {(type === 'stackedBar' || type === 'groupedBar') &&
          view.rows.map((row, rIndex) => {
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
                        className={row.partial ? 'bar partial' : 'bar'}
                      />
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
                      className={row.partial ? 'bar partial' : 'bar'}
                    />
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
          // A weekly axis over the cap's seven years is 400 buckets in 782 px: every
          // label drawn is a smear. Every k-th is drawn instead, k chosen so at
          // most `MAX_LABELS` land; the tooltip and the table still carry all
          // of them.
          if (rIndex % labelStep !== 0) return null
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

      {/* The hover tooltip: the hovered bucket's numbers, every visible series.
          Presentation only (`aria-hidden`): the accessible form of these
          numbers is the table, and a tooltip a screen reader cannot reach must
          not be the only place a value lives. */}
      {tip && view.rows[tip.index] && (
        <div
          className="chart-tip"
          aria-hidden="true"
          data-chart-tip={view.rows[tip.index]!.key}
          style={{
            left: tip.x,
            top: tip.y,
            transform:
              `translate(${tip.flipX ? 'calc(-100% - 12px)' : '12px'}, ` +
              `${tip.flipY ? 'calc(-100% - 12px)' : '12px'})`,
          }}
        >
          <p className="tip-title">{view.rows[tip.index]!.label}</p>
          {view.series.map((entry, at) => (
            <p className="tip-row" key={entry.key}>
              <span className="swatch" style={{ background: entry.color }} />
              <span className="tip-label">{entry.label}</span>
              <span className="tip-value">
                {(view.rows[tip.index]!.values[at] ?? 0).toLocaleString()}
              </span>
            </p>
          ))}
          {view.series.length > 1 && (
            <p className="tip-row total">
              <span className="tip-label">Total</span>
              <span className="tip-value">{view.rows[tip.index]!.total.toLocaleString()}</span>
            </p>
          )}
        </div>
      )}

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
        {view.rows.some((row) => row.partial) && (
          <p className="muted small" data-chart-partial="1">
            Faded buckets marked <em>(partial)</em> are not covered whole — the period runs past the
            last day the data holds, or the report’s own date range cuts into it — so their counts
            are not comparable to their neighbours’.
          </p>
        )}
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
 * Always rendered, never a fallback: it is what a screen reader reads and what
 * anyone checking a surprising bar looks at. Row and column headers are real
 * `<th scope>` cells, which is the difference between a table a screen reader
 * can navigate and a grid of unlabelled numbers. It renders the complete model
 * even when the chart above has series hidden — the table is the audit channel.
 *
 * Two presentations (M9): `audit` sits under a chart visually hidden — in the
 * DOM for screen readers and anyone reading the page's structure, off the
 * screen because the Table view is where the numbers are *shown* — and
 * `spreadsheet` is that view: visible, zebra-striped, and sortable. Sorting is
 * a view of the model, never a new query, and it does not travel in a
 * definition.
 */
export function ChartTable({
  model,
  rowsDimension,
  seriesDimension,
  labels,
  view,
}: {
  model: ChartModel
  rowsDimension: Dimension
  seriesDimension: Dimension | null
  /** The same display renames the chart applies, so the two agree. */
  labels?: Readonly<Record<string, string>>
  /** `audit`: visually hidden under a chart. `spreadsheet`: the Table view. */
  view: 'audit' | 'spreadsheet'
}) {
  /** Column 0 is the row label, 1..n the series, n+1 the Total (cross only). */
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null)
  const named = labels ? relabelModel(model, labels) : model
  const cross = seriesDimension !== null
  const columns = 1 + named.series.length + (cross ? 1 : 0)
  // A sort from a previous, wider model is ignored rather than applied to
  // whatever column now sits at that index.
  const active = view === 'spreadsheet' && sort && sort.col < columns ? sort : null
  const rows = active ? sortRows(named.rows, named.series.length, active) : named.rows

  const columnName = (col: number) =>
    col === 0 ? DIMENSION_LABELS[rowsDimension] : (named.series[col - 1]?.label ?? 'Total')

  const header = (label: string, col: number) =>
    view === 'spreadsheet' ? (
      <button
        type="button"
        className="sort-header"
        onClick={() =>
          setSort((current) =>
            current && current.col === col
              ? { col, dir: -current.dir as 1 | -1 }
              : // Labels sort forwards; numbers sort biggest-first, which is
                // the question a count column is usually asked.
                { col, dir: col === 0 ? 1 : -1 }
          )
        }
      >
        {label}
      </button>
    ) : (
      label
    )

  const ariaSort = (col: number) =>
    active?.col === col ? (active.dir === 1 ? 'ascending' : 'descending') : undefined

  const table = (
    <table
      className={view === 'spreadsheet' ? 'results chart-data spreadsheet' : 'results chart-data'}
    >
      <caption className="muted">
        {DIMENSION_LABELS[rowsDimension]}
        {cross ? ` × ${DIMENSION_LABELS[seriesDimension]}` : ''} — CVE counts
        {active
          ? `, sorted by ${columnName(active.col)}, ${active.dir === 1 ? 'ascending' : 'descending'}`
          : TIME_DIMENSIONS.has(rowsDimension)
            ? ', oldest first'
            : ', largest first'}
      </caption>
      <thead>
        <tr>
          <th scope="col" aria-sort={ariaSort(0)}>
            {header(DIMENSION_LABELS[rowsDimension], 0)}
          </th>
          {named.series.map((entry, at) => (
            <th scope="col" key={entry.key} aria-sort={ariaSort(at + 1)}>
              {header(entry.label, at + 1)}
            </th>
          ))}
          {cross && (
            <th scope="col" aria-sort={ariaSort(columns - 1)}>
              {header('Total', columns - 1)}
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} data-partial={row.partial ? '1' : undefined}>
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
  )

  // The audit copy takes no tab stop: a focusable scroll region that cannot be
  // seen is a keyboard trap in all but name.
  if (view === 'audit') return <div className="visually-hidden">{table}</div>
  return (
    <div className="scroll" tabIndex={0}>
      {table}
    </div>
  )
}

/** The reader's sort, applied to a copy — the model's own order is the data's. */
function sortRows(
  rows: ChartModel['rows'],
  seriesCount: number,
  sort: { col: number; dir: 1 | -1 }
): ChartModel['rows'] {
  const value = (row: ChartModel['rows'][number]) =>
    sort.col === 0
      ? row.label
      : sort.col <= seriesCount
        ? (row.values[sort.col - 1] ?? 0)
        : row.total
  return [...rows].sort((a, b) => {
    const [va, vb] = [value(a), value(b)]
    const order =
      typeof va === 'string' || typeof vb === 'string'
        ? String(va).localeCompare(String(vb), undefined, { numeric: true })
        : va - vb
    return order * sort.dir
  })
}
