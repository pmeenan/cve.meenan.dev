/**
 * The chart model: cells from `crossSql` turned into ordered rows and series,
 * with the colour each series gets (M4).
 *
 * Kept out of the component deliberately. Ordering and colour assignment are
 * where a chart becomes wrong rather than ugly — a stack whose bands are in a
 * different order per bar, a severity ramp that reads as categorical, an
 * absence folded into a zero — and all three are testable as data. The SVG is
 * then a rendering of a value this file already decided.
 *
 * Charts are hand-rolled inline SVG (M4's shape decision): no dependency to
 * audit under D-002, and the accessibility story is ours rather than a
 * library's defaults.
 *
 * **Colours are CSS custom properties, never literals.** The page renders in
 * whatever colour scheme the reader's system asks for, so a hex value baked
 * into a `fill` would be validated in one theme and shipped in two. The values
 * behind these names live in `app/globals.css` — one block per scheme — and
 * `tests/unit/chart.test.ts` reads that file and checks both palettes against
 * the background they are actually drawn on.
 */

import {
  ABSENCE_DIMENSIONS,
  absenceLabel,
  CODE_LABELS,
  KEV_DIMENSIONS,
  SSVC_DIMENSIONS,
  TIME_DIMENSIONS,
  type Dimension,
} from './filters'

/**
 * How many series a chart draws before the colours stop meaning anything.
 *
 * Eight is the categorical ceiling — beyond it, two slots are close enough that
 * a reader has to consult the legend for every segment, which is not reading a
 * chart. Severity is exempt because its six bands are an ordered ramp rather
 * than eight arbitrary identities.
 */
export const CHART_SERIES_MAX = 8

/** Severity has one band per code plus one for "never scored". */
const SEVERITY_SERIES_MAX = 6

/** The widest SSVC axis is Exploitation: none / poc / active, plus "not assessed". */
const SSVC_SERIES_MAX = 4

/**
 * Where each SSVC code sits on the severity scale.
 *
 * The SSVC axes are **scales**, not identities — none → poc → active is an
 * escalation, and so is partial → total. Rather than build and check a second
 * palette in two themes, they reuse the severity bands (D-083's hue scale:
 * blue for the benign end, orange between, dark red at the top), spaced so
 * every adjacency clears the separation floor. The legend names the bands, so
 * there is no reading in which a red band means "CRITICAL" here.
 *
 * `tests/unit/chart.test.ts` asserts the resulting adjacencies — including the
 * neutral against the *top* band, which is where it lands on these axes and
 * not where it lands on severity's.
 */
const SSVC_RAMP: Partial<Record<Dimension, Record<string, number>>> = {
  ssvcExpl: { '0': 0, '1': 2, '2': 4 },
  ssvcAuto: { '0': 0, '1': 4 },
  ssvcImpact: { '0': 0, '1': 4 },
}

/**
 * The severity stack, bottom to top.
 *
 * CRITICAL sits at the baseline (M4 shape decision): stacked segments share
 * only that edge, so the bottom series is the only one whose length a reader
 * can compare accurately across buckets — and the founding question is about
 * CRITICAL over time. The unscored band lands at the top, where it cannot
 * distort the trend beneath it.
 *
 * `null` is in the list on purpose. About half the corpus has never been scored
 * (189,742 of 372,322), so a severity chart that dropped those records would
 * understate every bucket while looking complete — the same failure D-022
 * guards against for REJECTED records.
 */
const SEVERITY_STACK: (number | null)[] = [4, 3, 2, 1, 0, null]

export interface Cell {
  row: string | number | null
  rowLabel: string
  series: string | number | null
  seriesLabel: string
  cves: number
}

export interface ChartSeries {
  /** Stable identity for React keys and for matching cells; `''` is the null bucket. */
  key: string
  label: string
  /** A `var(--…)` reference, resolved by the stylesheet in the reader's theme. */
  color: string
}

export interface ChartRow {
  key: string
  label: string
  /** One count per series, in `series` order. Absent cells are 0, not omitted. */
  values: number[]
  total: number
}

export interface ChartModel {
  rows: ChartRow[]
  series: ChartSeries[]
  /** The largest single value, for a grouped chart's y-axis. */
  max: number
  /** The largest row total, for a stacked chart's y-axis. */
  maxTotal: number
  total: number
  /** Series the cap dropped, named so the omission is reported rather than silent. */
  droppedSeries: number
  /** Rows the cap dropped. */
  droppedRows: number
}

/**
 * Order the series for a stack.
 *
 * Severity is the case with a required answer (above). The other code
 * dimensions are identifiers rather than magnitudes — 31 is v3.1 and 4 is v4.0
 * (D-047) — so they take the order the query layer already imposed, which is
 * semantic. Everything else is an identity dimension and is ordered by size,
 * because "which are the big ones" is the question being asked.
 */
function orderSeries(dimension: Dimension, keys: Map<string, { label: string; total: number }>) {
  const entries = [...keys.entries()]
  if (dimension === 'severity') {
    const rank = new Map(SEVERITY_STACK.map((code, at) => [code === null ? '' : String(code), at]))
    return entries.sort(
      ([a], [b]) => (rank.get(a) ?? SEVERITY_STACK.length) - (rank.get(b) ?? SEVERITY_STACK.length)
    )
  }
  if (
    dimension === 'cvssVersion' ||
    dimension === 'state' ||
    SSVC_DIMENSIONS.has(dimension) ||
    KEV_DIMENSIONS.has(dimension) ||
    TIME_DIMENSIONS.has(dimension)
  ) {
    // The SQL emitted these in semantic order — for the SSVC axes, codes
    // ascending with the unassessed band last (D-070); for the KEV axes,
    // *listed* first, because it is the small band (1,662 of 372,322) and the
    // baseline is the only position a reader can compare across buckets
    // (D-073's argument for CRITICAL, applied to the band that matters here) —
    // and the map's insertion order preserves it. Re-sorting by size would put
    // "Not in KEV" at the baseline and make the interesting series a sliver
    // floating on top of it.
    return entries
  }
  return entries.sort(([, a], [, b]) => b.total - a.total)
}

/**
 * How many series this dimension may draw.
 *
 * The capped dimensions are identities, where the cap is what keeps the colours
 * meaningful. A scale's bands are all of it — dropping one would delete a band
 * from a chart that is required to show every band it has (D-070, D-073) — so
 * severity gets its six and the SSVC axes their four at most.
 */
function seriesCap(dimension: Dimension): number {
  if (dimension === 'severity') return SEVERITY_SERIES_MAX
  if (SSVC_DIMENSIONS.has(dimension)) return SSVC_SERIES_MAX
  // The KEV axes are two and four buckets, all of them meaningful — including
  // the complement, which carries the denominator. Under the categorical cap
  // they would never be trimmed anyway; naming them here is what stops a future
  // change to that cap from silently deleting the "Not in KEV" band and
  // turning every KEV chart into an assertion about the 0.4% of the corpus
  // CISA lists (M6, D-076).
  if (KEV_DIMENSIONS.has(dimension)) return 4
  return CHART_SERIES_MAX
}

/**
 * The colour for one series.
 *
 * Severity is hue-coded (D-083): dark red for CRITICAL down to light blue for
 * NONE, the conventional reading of a severity scale. The unscored band is
 * deliberately *off* the scale: it is a neutral gray, because it is an absence
 * rather than a level, and a reader must not be able to place it on the scale.
 *
 * Every other dimension is an identity, and identities get categorical slots.
 */
export function seriesColor(dimension: Dimension, key: string, index: number): string {
  // The absence band, on any axis where NULL means "nobody assessed this"
  // rather than "no lookup row": the same off-ramp neutral, so an absence is
  // never placeable on the scale beside the levels (D-070, D-073).
  if (key === '' && ABSENCE_DIMENSIONS.has(dimension)) return 'var(--sev-x)'
  if (dimension === 'severity') return `var(--sev-${key})`
  const slot = SSVC_RAMP[dimension]?.[key]
  if (slot !== undefined) return `var(--sev-${slot})`
  return `var(--cat-${(index % CHART_SERIES_MAX) + 1})`
}

/**
 * What a bucket is called on screen.
 *
 * The code dimensions come back from SQL as the stored code in both the bucket
 * and the label column, because a `CASE` in the query would put display strings
 * in the query layer (lib/filters.ts makes the same call). NULL is named rather
 * than blanked: "(not scored)" is a fact about the record, and an empty cell
 * reads as a rendering bug.
 */
export function bucketLabel(dimension: Dimension, bucket: unknown, label: unknown): string {
  if (label !== bucket && typeof label === 'string' && label.length > 0) return label
  if (bucket === null || bucket === undefined) {
    if (dimension === 'severity') return '(not scored)'
    if (dimension === 'cvssVersion') return '(no CVSS)'
    // "not assessed" rather than "none recorded": nobody recorded an SSVC
    // assessment *and* `none` is one of the answers it could have recorded, so
    // the two have to read differently (D-070).
    // The absence axes, each named by the one function every surface uses: a
    // band with a different name on the chart than on its own filter checkbox
    // reads as a different band (M6).
    if (SSVC_DIMENSIONS.has(dimension) || dimension === 'kevRansomware') {
      return absenceLabel(dimension)
    }
    return '(none recorded)'
  }
  const code = Number(bucket)
  return CODE_LABELS[dimension]?.[code] ?? String(bucket)
}

/**
 * Build the model from the query layer's rows.
 *
 * `rows` are the raw result rows: `[bucket, label, cves]` for a one-dimension
 * aggregate, `[bucket, label, series, series_label, cves]` for a cross-tab.
 * Row order is taken from SQL, which already ordered it for reading — time
 * ascending, everything else by the row's own total.
 */
export function buildChart(
  rows: readonly unknown[][],
  rowsDimension: Dimension,
  seriesDimension: Dimension | null,
  rowCap: number
): ChartModel {
  const cross = seriesDimension !== null
  const rowOrder: string[] = []
  const rowMeta = new Map<string, { label: string; total: number }>()
  const seriesMeta = new Map<string, { label: string; total: number }>()
  const cells = new Map<string, number>()

  for (const raw of rows) {
    const rowKey = keyOf(raw[0])
    const rowLabel = bucketLabel(rowsDimension, raw[0], raw[1])
    const seriesKey = cross ? keyOf(raw[2]) : ''
    const seriesLabel = cross ? bucketLabel(seriesDimension, raw[2], raw[3]) : 'CVEs'
    const count = Number(raw[cross ? 4 : 2] ?? 0)

    if (!rowMeta.has(rowKey)) {
      rowMeta.set(rowKey, { label: rowLabel, total: 0 })
      rowOrder.push(rowKey)
    }
    rowMeta.get(rowKey)!.total += count
    if (!seriesMeta.has(seriesKey)) seriesMeta.set(seriesKey, { label: seriesLabel, total: 0 })
    seriesMeta.get(seriesKey)!.total += count
    cells.set(`${rowKey} ${seriesKey}`, (cells.get(`${rowKey} ${seriesKey}`) ?? 0) + count)
  }

  const orderedSeries = orderSeries(seriesDimension ?? 'severity', seriesMeta)
  const cap = cross ? seriesCap(seriesDimension) : 1
  const keptSeries = orderedSeries.slice(0, cap)
  const droppedSeries = orderedSeries.length - keptSeries.length

  const series: ChartSeries[] = keptSeries.map(([key, meta], at) => ({
    key,
    label: meta.label,
    color: cross ? seriesColor(seriesDimension, key, at) : 'var(--cat-1)',
  }))

  const keptRows = rowOrder.slice(0, Math.max(1, rowCap))
  const droppedRows = rowOrder.length - keptRows.length

  let max = 0
  let maxTotal = 0
  let total = 0
  const model: ChartRow[] = keptRows.map((key) => {
    const values = series.map((entry) => cells.get(`${key} ${entry.key}`) ?? 0)
    // The row total is over the series *on the chart*, so the bar's height and
    // its table row agree. A row whose total came from dropped series would
    // draw shorter than its own label claims.
    const rowTotal = values.reduce((sum, value) => sum + value, 0)
    for (const value of values) max = Math.max(max, value)
    maxTotal = Math.max(maxTotal, rowTotal)
    total += rowTotal
    return { key, label: rowMeta.get(key)!.label, values, total: rowTotal }
  })

  return { rows: model, series, max, maxTotal, total, droppedSeries, droppedRows }
}

/** A bucket value as a map key. `null` is its own bucket, spelled `''`. */
function keyOf(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

/**
 * The model with some series hidden — the legend-toggle view (UI revamp).
 *
 * A *view* of the model, not a new query: the hidden series' counts leave the
 * bars and the y-scale so the visible ones can be compared, but the full table
 * below the chart still renders the complete model — the numbers are the audit
 * channel and hiding a band must not hide its data. Rows are kept even when
 * every visible value is zero, because a vanishing bucket would re-space the
 * x-axis under the reader's toggle.
 */
export function visibleModel(model: ChartModel, hidden: ReadonlySet<string>): ChartModel {
  if (hidden.size === 0) return model
  const keptAt: number[] = []
  const series = model.series.filter((entry, at) => {
    const kept = !hidden.has(entry.key)
    if (kept) keptAt.push(at)
    return kept
  })
  let max = 0
  let maxTotal = 0
  let total = 0
  const rows = model.rows.map((row) => {
    const values = keptAt.map((at) => row.values[at] ?? 0)
    const rowTotal = values.reduce((sum, value) => sum + value, 0)
    for (const value of values) max = Math.max(max, value)
    maxTotal = Math.max(maxTotal, rowTotal)
    total += rowTotal
    return { ...row, values, total: rowTotal }
  })
  return { ...model, rows, series, max, maxTotal, total }
}

/**
 * The model with the reader's own series names.
 *
 * Display-only: the overrides never travel in a report definition or a
 * permalink, and an override for a key the model does not hold is ignored
 * rather than inventing a series. An empty or whitespace name falls back to
 * the real label, because a blank legend entry is a swatch with no meaning.
 */
export function relabelModel(
  model: ChartModel,
  labels: Readonly<Record<string, string>>
): ChartModel {
  const overridden = model.series.map((entry) => {
    const label = labels[entry.key]?.trim()
    return label ? { ...entry, label } : entry
  })
  if (overridden.every((entry, at) => entry === model.series[at])) return model
  return { ...model, series: overridden }
}

/**
 * Axis ticks at values a reader can hold in their head.
 *
 * 1, 2, 5 × a power of ten, chosen so there are about `count` of them. Without
 * this an axis reads 0 / 3,847 / 7,694, which is a scale nobody can use to
 * estimate a bar they are looking at.
 */
export function niceTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0]
  const magnitude = 10 ** Math.floor(Math.log10(max / Math.max(1, count)))
  const candidates = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude)
  // The smallest step that keeps the axis to about `count` intervals. Choosing
  // the *smallest* matters: a larger one is always available and always coarser,
  // and an axis of 0 / 5,000 / 10,000 for a maximum of 9,732 gives a reader two
  // gridlines to estimate against.
  const chosen = candidates.find((step) => Math.ceil(max / step) <= count) ?? candidates.at(-1)!
  // Every value on these axes is a count of records, so a fractional step would
  // put 0.25 CVEs on the scale.
  const step = Math.max(chosen, 1)
  const ticks: number[] = []
  // Runs past `max` by construction rather than stopping near it: an axis whose
  // last tick is below the largest bar draws that bar outside the plot.
  for (let at = 0; ; at += step) {
    ticks.push(at)
    if (at >= max) break
  }
  return ticks
}

/** Big numbers on an axis, where four characters is all there is room for. */
export function shortCount(value: number): string {
  if (!Number.isFinite(value)) return ''
  const abs = Math.abs(value)
  if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`
  if (abs >= 1e3) return `${(value / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`
  return String(value)
}
