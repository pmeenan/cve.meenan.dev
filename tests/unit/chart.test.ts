import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  buildChart,
  bucketLabel,
  fillTimeGaps,
  niceTicks,
  seriesColor,
  shortCount,
  TIME_FILL_MAX,
  timeSpan,
} from '../../lib/chart'
import { daySeconds } from '../../lib/dates'

/**
 * The chart model and the palette behind it (M4).
 *
 * Two different kinds of claim are checked here.
 *
 * The **model** is where a chart becomes wrong rather than ugly: a stack whose
 * bands are ordered differently per bar, an unscored band folded into a zero, a
 * cap that drops series without saying so. All three are properties of a value,
 * so they are tested as data rather than looked at.
 *
 * The **palette** is a claim about colour that would otherwise be "it looked
 * fine on my monitor". Severity is hue-coded — dark red → red → orange →
 * yellow → light blue, the owner's palette (D-083) — with the never-scored
 * band a neutral gray off the scale. What is measurable is separation and
 * visibility: this test reads `app/globals.css`, pulls both palettes out of
 * it, and checks every band that touches another in a stack, against the
 * background it is actually drawn on. The stylesheet is the source, so the
 * two cannot drift.
 */

// --- the palette --------------------------------------------------------

/** Relative luminance, WCAG's definition — the same one the ratios below use. */
function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16)
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((raw) => {
    const c = raw / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high! + 0.05) / (low! + 0.05)
}

/**
 * OKLab, for the separation between bands that touch in a stack.
 *
 * The palette is hue-coded (D-083), so a pure luminance ratio no longer
 * measures what a reader sees — yellow beside light blue is unmistakable at a
 * luminance ratio of 1.02. OKLab distance is the standard perceptual measure
 * that counts hue and chroma as well as lightness.
 */
function oklab(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((raw) => {
    const c = raw / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

/** OKLab distance ×100 — the scale on which ~2 is a just-noticeable difference. */
function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = oklab(a)
  const [l2, a2, b2] = oklab(b)
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2) * 100
}

const CSS = readFileSync('app/globals.css', 'utf-8')

/**
 * Read one scheme's custom properties out of the stylesheet.
 *
 * The light values are in the first `:root` block and the dark ones inside the
 * `prefers-color-scheme: dark` media query, so "the last definition wins"
 * reproduces what a browser in that scheme resolves.
 */
function palette(scheme: 'light' | 'dark'): Record<string, string> {
  const source =
    scheme === 'light' ? CSS.slice(0, CSS.indexOf('@media (prefers-color-scheme: dark)')) : CSS
  const found: Record<string, string> = {}
  for (const match of source.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/g)) {
    found[match[1]!] = match[2]!
  }
  return found
}

/**
 * The floors, stated once.
 *
 * `MIN_ADJACENT_DE` is the OKLab separation (×100) between bands that touch in
 * a stacked bar — the boundary a reader has to see. Twelve is several times a
 * just-noticeable difference; the hairline stroke in `--surface` on every band
 * carries the boundary where two colours are closest. `MIN_BACKGROUND` is
 * lower than WCAG's 3:1 for graphical objects on purpose and is not a claim to
 * meet it: a six-band palette cannot both span the hue scale and hold 3:1 at
 * the band nearest the page (dark red on white, dark red on near-black). The
 * hairline is what carries the boundary against the background; this floor
 * keeps the fill itself from disappearing into it.
 */
const MIN_ADJACENT_DE = 12
const MIN_BACKGROUND = 2.0

/** The severity stack, baseline to top, plus the unscored neutral above NONE. */
const STACK = ['--sev-4', '--sev-3', '--sev-2', '--sev-1', '--sev-0', '--sev-x'] as const

describe('the severity palette separates and stays visible, in both themes', () => {
  for (const scheme of ['light', 'dark'] as const) {
    describe(scheme, () => {
      const colors = palette(scheme)
      const background = colors['--bg']!
      const bands = STACK.map((name) => {
        const value = colors[name]
        if (!value) throw new Error(`${name} is not defined for the ${scheme} scheme`)
        return [name, value] as const
      })

      it('separates every pair of bands that touch in the severity stack', () => {
        // The stack order is fixed (SEVERITY_STACK): CRITICAL at the baseline,
        // then HIGH, MEDIUM, LOW, NONE, with the unscored neutral on top. Each
        // adjacency is a boundary a reader has to see. The palette is
        // hue-coded (D-083), so the measure is perceptual distance rather than
        // the old luminance ratio — yellow beside light blue is unmistakable
        // at a luminance ratio near 1.
        for (let at = 1; at < bands.length; at += 1) {
          const separation = deltaE(bands[at]![1], bands[at - 1]![1])
          expect(separation, `${bands[at]![0]} vs ${bands[at - 1]![0]}`).toBeGreaterThanOrEqual(
            MIN_ADJACENT_DE
          )
        }
      })

      it('keeps every band visible against the page it is drawn on', () => {
        for (const [name, hex] of bands) {
          expect(contrast(hex, background), name).toBeGreaterThanOrEqual(MIN_BACKGROUND)
        }
      })

      it('separates every adjacency an SSVC stack actually has (D-070)', () => {
        // These axes are scales and reuse the severity bands — spaced across
        // them — rather than taking categorical slots. The adjacencies are
        // different from severity's: the neutral lands on *top of the highest*
        // band here, not above NONE, so those pairs need their own assertions.
        const stacks: string[][] = [
          ['--sev-0', '--sev-2', '--sev-4', '--sev-x'], // Exploitation
          ['--sev-0', '--sev-4', '--sev-x'], // Automatable, Technical impact
        ]
        for (const stack of stacks) {
          for (let at = 1; at < stack.length; at += 1) {
            const separation = deltaE(colors[stack[at]!]!, colors[stack[at - 1]!]!)
            expect(separation, `${stack[at]} vs ${stack[at - 1]}`).toBeGreaterThanOrEqual(
              MIN_ADJACENT_DE
            )
          }
        }
      })

      it('keeps every categorical slot visible too', () => {
        for (let slot = 1; slot <= 8; slot += 1) {
          const hex = colors[`--cat-${slot}`]
          expect(hex, `--cat-${slot} is not defined for ${scheme}`).toBeTruthy()
          expect(contrast(hex!, background), `--cat-${slot}`).toBeGreaterThanOrEqual(2.5)
        }
      })
    })
  }
})

describe('seriesColor', () => {
  it('gives severity the ramp and everything else a categorical slot', () => {
    expect(seriesColor('severity', '4', 0)).toBe('var(--sev-4)')
    expect(seriesColor('severity', '', 5)).toBe('var(--sev-x)')
    expect(seriesColor('vendor', 'cisco', 0)).toBe('var(--cat-1)')
    expect(seriesColor('vendor', 'other', 7)).toBe('var(--cat-8)')
  })

  it('gives every absence band the same off-ramp neutral (D-070)', () => {
    // Not just severity's. "Nobody assessed this" is an absence on the SSVC
    // axes too, and a categorical slot there would put it on the scale.
    for (const dimension of ['ssvcExpl', 'ssvcAuto', 'ssvcImpact'] as const) {
      expect(seriesColor(dimension, '', 3)).toBe('var(--sev-x)')
    }
    // And the coded bands take the ramp, spaced — these are scales, so D-073's
    // ordinal argument applies to them as it does to severity.
    expect(seriesColor('ssvcExpl', '0', 0)).toBe('var(--sev-0)')
    expect(seriesColor('ssvcExpl', '1', 1)).toBe('var(--sev-2)')
    expect(seriesColor('ssvcExpl', '2', 2)).toBe('var(--sev-4)')
    expect(seriesColor('ssvcAuto', '1', 1)).toBe('var(--sev-4)')
    // A missing *lookup* row is a different thing and keeps its slot: there is
    // no scale for it to be mistaken for.
    expect(seriesColor('vendor', '', 0)).toBe('var(--cat-1)')
  })

  it('names an unassessed bucket rather than blanking it', () => {
    expect(bucketLabel('ssvcExpl', null, null)).toBe('(not assessed)')
    // And a stated `none` reads as the finding it is, not as the absence.
    expect(bucketLabel('ssvcExpl', 0, 0)).toBe('None')
    expect(bucketLabel('ssvcAuto', 1, 1)).toBe('Yes')
    expect(bucketLabel('ssvcImpact', 1, 1)).toBe('Total')
  })

  it('wraps rather than producing a colour that is not defined', () => {
    expect(seriesColor('vendor', 'x', 8)).toBe('var(--cat-1)')
  })
})

// --- the model ----------------------------------------------------------

/** Cross-tab rows as `crossSql` returns them: bucket, label, series, series label, count. */
const CELLS: unknown[][] = [
  ['2025-01', '2025-01', 4, 4, 10],
  ['2025-01', '2025-01', 2, 2, 30],
  ['2025-01', '2025-01', null, null, 60],
  ['2025-02', '2025-02', 4, 4, 5],
  ['2025-02', '2025-02', 3, 3, 15],
]

describe('buildChart', () => {
  it('stacks severity with CRITICAL at the baseline and unscored on top', () => {
    // The founding question's series gets the readable position — stacked
    // segments share only the baseline, so the bottom band is the only one a
    // reader can compare accurately across buckets (M4 shape decision).
    const model = buildChart(CELLS, 'month', 'severity', 12)
    expect(model.series.map((entry) => entry.label)).toEqual([
      'CRITICAL',
      'HIGH',
      'MEDIUM',
      '(not scored)',
    ])
  })

  it('keeps the unscored band rather than dropping it', () => {
    // About half the corpus has never been scored. A chart that quietly
    // excluded them would understate every bucket while looking complete.
    const model = buildChart(CELLS, 'month', 'severity', 12)
    const unscored = model.series.find((entry) => entry.key === '')
    expect(unscored).toBeTruthy()
    expect(unscored!.color).toBe('var(--sev-x)')
    expect(model.rows[0]!.values[model.series.indexOf(unscored!)]).toBe(60)
  })

  it('fills absent cells with zero so every row has the same shape', () => {
    const model = buildChart(CELLS, 'month', 'severity', 12)
    for (const row of model.rows) expect(row.values).toHaveLength(model.series.length)
    // February has no MEDIUM and no unscored bucket at all.
    const february = model.rows.find((row) => row.key === '2025-02')!
    expect(february.values.reduce((sum, value) => sum + value, 0)).toBe(20)
  })

  it('keeps the query layer’s row order rather than re-sorting', () => {
    // Time ascending is what makes a chart's x-axis run forwards, and the SQL
    // already ordered it (lib/filters.ts). Re-sorting here would second-guess it.
    const model = buildChart(CELLS, 'month', 'severity', 12)
    expect(model.rows.map((row) => row.key)).toEqual(['2025-01', '2025-02'])
  })

  it('orders identity series by size', () => {
    const rows: unknown[][] = [
      ['2025-01', '2025-01', 1, 'small', 3],
      ['2025-01', '2025-01', 2, 'large', 30],
    ]
    const model = buildChart(rows, 'month', 'vendor', 12)
    expect(model.series.map((entry) => entry.label)).toEqual(['large', 'small'])
  })

  it('reports what the caps dropped instead of dropping it silently', () => {
    const many: unknown[][] = []
    for (let at = 0; at < 20; at += 1) many.push(['r1', 'r1', at, `series-${at}`, 20 - at])
    for (let at = 0; at < 20; at += 1) many.push([`row-${at}`, `row-${at}`, 0, 'series-0', 1])
    const model = buildChart(many, 'vendor', 'cwe', 5)
    expect(model.series).toHaveLength(8)
    expect(model.droppedSeries).toBe(12)
    expect(model.rows).toHaveLength(5)
    expect(model.droppedRows).toBeGreaterThan(0)
  })

  it('totals only the series on the chart, so a bar matches its own row', () => {
    const many: unknown[][] = []
    for (let at = 0; at < 12; at += 1) many.push(['r1', 'r1', at, `series-${at}`, 100])
    const model = buildChart(many, 'vendor', 'cwe', 5)
    // Eight series survive the cap; the row total is 800, not 1,200 — the bar
    // and its table row have to agree.
    expect(model.rows[0]!.total).toBe(800)
    expect(model.maxTotal).toBe(800)
  })

  it('handles a one-dimension aggregate', () => {
    const rows: unknown[][] = [
      [2024, 2024, 100],
      [2025, 2025, 200],
    ]
    const model = buildChart(rows, 'year', null, 12)
    expect(model.series).toHaveLength(1)
    expect(model.rows.map((row) => row.total)).toEqual([100, 200])
    expect(model.max).toBe(200)
  })

  it('produces an empty model rather than throwing on no rows', () => {
    const model = buildChart([], 'year', 'severity', 12)
    expect(model.rows).toEqual([])
    expect(model.total).toBe(0)
  })

  it('keeps the KEV bands in the query layer’s order, not by size (M6)', () => {
    // "In KEV" is 0.4% of the corpus. Sorted by size it lands on top of a stack
    // whose baseline is its own complement — and the baseline is the only
    // position whose length a reader can compare across buckets, which is the
    // whole of D-073's argument for CRITICAL. The SQL emits listed first; this
    // is the check that nothing here re-sorts it away.
    const rows: unknown[][] = [
      ['2025-01', '2025-01', 1, 1, 4],
      ['2025-01', '2025-01', 0, 0, 900],
    ]
    const model = buildChart(rows, 'month', 'kev', 12)
    expect(model.series.map((entry) => entry.label)).toEqual([
      'In KEV (per CISA)',
      'Not in KEV (per CISA)',
    ])
  })

  it('never drops a KEV band to the categorical cap', () => {
    // The complement carries the denominator. A cap that trimmed it would turn
    // every KEV chart into an assertion about the listed 0.4% alone.
    const rows: unknown[][] = [
      ['2025-01', '2025-01', 1, 1, 5],
      ['2025-01', '2025-01', 0, 0, 5],
      ['2025-01', '2025-01', 2, 2, 5],
      ['2025-01', '2025-01', null, null, 5],
    ]
    const model = buildChart(rows, 'month', 'kevRansomware', 12)
    expect(model.series).toHaveLength(4)
    expect(model.droppedSeries).toBe(0)
  })
})

// --- dense time axes ----------------------------------------------------

describe('time axis gap fill', () => {
  it('inserts a zero row for every bucket between the first and last present', () => {
    // A `GROUP BY` returns only the buckets that hold a record, and the chart
    // places buckets ordinally — so a filtered series (one product) with no
    // CVE in March would draw February beside April, and a trend line would
    // jump. The gap is a zero, and it is drawn as one.
    const rows: unknown[][] = [
      ['2025-01', '2025-01', 4, 4, 10],
      ['2025-02', '2025-02', 4, 4, 5],
      ['2025-05', '2025-05', 4, 4, 7],
    ]
    const model = buildChart(rows, 'month', 'severity', 400)
    expect(model.rows.map((row) => row.key)).toEqual([
      '2025-01',
      '2025-02',
      '2025-03',
      '2025-04',
      '2025-05',
    ])
    const march = model.rows.find((row) => row.key === '2025-03')!
    expect(march.label).toBe('2025-03')
    expect(march.values).toEqual([0])
    expect(march.total).toBe(0)
    // The filled rows change nothing about the numbers.
    expect(model.total).toBe(22)
    expect(model.maxTotal).toBe(10)
    expect(model.droppedRows).toBe(0)
  })

  it('walks each grain in its own step, across a year boundary', () => {
    expect(fillTimeGaps('year', ['2023', '2026'])).toEqual(['2023', '2024', '2025', '2026'])
    expect(fillTimeGaps('quarter', ['2024-Q3', '2025-Q2'])).toEqual([
      '2024-Q3',
      '2024-Q4',
      '2025-Q1',
      '2025-Q2',
    ])
    expect(fillTimeGaps('month', ['2024-11', '2025-02'])).toEqual([
      '2024-11',
      '2024-12',
      '2025-01',
      '2025-02',
    ])
    // Weeks are Mondays (`WEEK_EXPR`); 2024-12-30 is the Monday that opens
    // the week the year turns in.
    expect(fillTimeGaps('week', ['2024-12-16', '2025-01-06'])).toEqual([
      '2024-12-16',
      '2024-12-23',
      '2024-12-30',
      '2025-01-06',
    ])
  })

  it('widens to the report’s window, so a quiet vendor’s axis still runs to today', () => {
    // "The last two years" of a vendor whose last record was in May: the
    // weeks since are zeros, because the quiet is the finding.
    const rows: unknown[][] = [
      ['2025-03', '2025-03', 4, 4, 1],
      ['2025-05', '2025-05', 4, 4, 1],
    ]
    const span = {
      from: daySeconds('2025-01-15'),
      to: daySeconds('2025-07-31'),
      openAtFrom: true,
    }
    const model = buildChart(rows, 'month', 'severity', 400, span)
    expect(model.rows.map((row) => row.key)).toEqual([
      '2025-01',
      '2025-02',
      '2025-03',
      '2025-04',
      '2025-05',
      '2025-06',
      '2025-07',
    ])
    // A window edge inside the data changes nothing: it widens, never cuts.
    const inside = buildChart(rows, 'month', 'severity', 400, {
      from: daySeconds('2025-04-01'),
      to: daySeconds('2025-04-01'),
      openAtFrom: true,
    })
    expect(inside.rows.map((row) => row.key)).toEqual(['2025-03', '2025-04', '2025-05'])
  })

  it('opens where the data does unless the report set its lower edge', () => {
    // "All time" for a vendor founded in 2015 is not sixteen years of zeros:
    // with no lower edge of its own the axis opens on the first bucket that
    // holds a record, and still runs on to the window's end.
    const rows: unknown[][] = [
      ['2025-03', '2025-03', 4, 4, 1],
      ['2025-05', '2025-05', 4, 4, 1],
    ]
    const model = buildChart(rows, 'month', 'severity', 400, {
      from: daySeconds('1999-01-04'),
      to: daySeconds('2025-07-31'),
      openAtFrom: false,
    })
    expect(model.rows.map((row) => row.key)).toEqual([
      '2025-03',
      '2025-04',
      '2025-05',
      '2025-06',
      '2025-07',
    ])
  })

  it('does not extend the old end when the query was narrowed to the cap', () => {
    // The query layer keeps the *recent* end of an over-cap time axis. With the
    // row count at the cap the old end may have been cut, and a fill down to
    // the window's lower edge would draw zeros over months that had records.
    // The recent end is still extended: it is the end that was kept.
    const rows: unknown[][] = [
      ['2025-03', '2025-03', 4, 4, 1],
      ['2025-05', '2025-05', 4, 4, 1],
    ]
    const span = { from: daySeconds('2024-01-01'), to: daySeconds('2025-07-31'), openAtFrom: true }
    const model = buildChart(rows, 'month', 'severity', 2, span)
    expect(model.rows.map((row) => row.key)).toEqual([
      '2025-03',
      '2025-04',
      '2025-05',
      '2025-06',
      '2025-07',
    ])
  })

  it('fills nothing when nothing matched, so the empty report still says so', () => {
    // A window of zeros with no series on it would replace "Nothing matched"
    // (app/chart.tsx) with an axis and no bars.
    const span = { from: daySeconds('2025-01-01'), to: daySeconds('2025-12-31'), openAtFrom: true }
    expect(fillTimeGaps('month', [], span)).toEqual([])
    expect(buildChart([], 'month', 'severity', 400, span).rows).toEqual([])
  })

  it('keeps the null bucket in front and leaves a non-time axis alone', () => {
    // A record with no publication date buckets to NULL, which SQL sorts
    // first; it is not on the timeline and is not stepped over.
    expect(fillTimeGaps('year', ['', '2024', '2026'])).toEqual(['', '2024', '2025', '2026'])
    const rows: unknown[][] = [
      ['cisco', 'Cisco', 4, 4, 10],
      ['juniper', 'Juniper', 4, 4, 5],
    ]
    const model = buildChart(rows, 'vendor', 'severity', 12)
    expect(model.rows.map((row) => row.key)).toEqual(['cisco', 'juniper'])
  })

  it('leaves an axis alone rather than guessing when a key is not in the grain’s format', () => {
    // A stray key — a Sunday on a Monday-labelled axis, a two-digit year —
    // means the fill would be inventing buckets against a shape it does not
    // understand. The chart then draws exactly what the query returned.
    expect(fillTimeGaps('week', ['2025-01-05', '2025-01-20'])).toEqual(['2025-01-05', '2025-01-20'])
    expect(fillTimeGaps('year', ['24', '26'])).toEqual(['24', '26'])
    expect(fillTimeGaps('month', ['2025-13', '2026-01'])).toEqual(['2025-13', '2026-01'])
  })

  it('refuses a fill wider than the axis cap', () => {
    // A hostile or absurd pair of keys must not ask for a million rows.
    const wide = fillTimeGaps('year', ['0001', '2025'])
    expect(wide).toEqual(['0001', '2025'])
    // And a fill just inside it goes through — the corpus's every week is
    // well under the cap.
    const weeks = fillTimeGaps('week', ['1999-01-04', '2026-08-10'])
    expect(weeks.length).toBeGreaterThan(1_400)
    expect(weeks.length).toBeLessThan(TIME_FILL_MAX)
  })
})

// --- partial buckets ----------------------------------------------------

describe('partial time buckets', () => {
  it('marks a bucket the answer does not cover whole, at either end', () => {
    // The data's last day is a Wednesday, so the current week and month are
    // both partial; the report's lower edge is the 15th, so the first month is
    // too. Marked, faded and labelled — never dropped: the fall-off at the
    // right-hand end is the most misread thing on a time series.
    const rows: unknown[][] = [
      ['2025-01', '2025-01', 4, 4, 10],
      ['2025-02', '2025-02', 4, 4, 5],
      ['2025-03', '2025-03', 4, 4, 2],
    ]
    const span = {
      from: daySeconds('2025-01-15'),
      to: daySeconds('2025-03-12'),
      openAtFrom: true,
    }
    const model = buildChart(rows, 'month', 'severity', 400, span)
    expect(model.rows.map((row) => [row.key, row.partial, row.label])).toEqual([
      ['2025-01', true, '2025-01 (partial)'],
      ['2025-02', false, '2025-02'],
      ['2025-03', true, '2025-03 (partial)'],
    ])
    // A weekly axis over the same window: the week of the 10th runs to the
    // 16th, past the data's last day; the week of the 13th January opens
    // before the window's first day.
    const weeks: unknown[][] = [
      ['2025-01-13', '2025-01-13', 4, 4, 1],
      ['2025-01-20', '2025-01-20', 4, 4, 1],
      ['2025-03-10', '2025-03-10', 4, 4, 1],
    ]
    const weekly = buildChart(weeks, 'week', 'severity', 400, span)
    const flags = new Map(weekly.rows.map((row) => [row.key, row.partial]))
    expect(flags.get('2025-01-13')).toBe(true)
    expect(flags.get('2025-01-20')).toBe(false)
    expect(flags.get('2025-03-03')).toBe(false)
    expect(flags.get('2025-03-10')).toBe(true)
    // Years and quarters by the same rule.
    const years = buildChart(
      [
        ['2024', '2024', 4, 4, 1],
        ['2025', '2025', 4, 4, 1],
      ],
      'year',
      'severity',
      400,
      {
        from: daySeconds('2024-01-01'),
        to: daySeconds('2025-03-12'),
        openAtFrom: true,
      }
    )
    expect(years.rows.map((row) => row.partial)).toEqual([false, true])
    const quarters = buildChart([['2025-Q1', '2025-Q1', 4, 4, 1]], 'quarter', 'severity', 400, {
      to: daySeconds('2025-03-31'),
    })
    expect(quarters.rows[0]!.partial).toBe(false)
  })

  it('marks nothing without a window to judge against, and nothing off a time axis', () => {
    const rows: unknown[][] = [
      ['2025-01', '2025-01', 4, 4, 10],
      ['2025-02', '2025-02', 4, 4, 5],
    ]
    expect(buildChart(rows, 'month', 'severity', 400).rows.every((row) => !row.partial)).toBe(true)
    // A window that covers every bucket whole marks none of them.
    const whole = buildChart(rows, 'month', 'severity', 400, {
      from: daySeconds('2025-01-01'),
      to: daySeconds('2025-02-28'),
      openAtFrom: true,
    })
    expect(whole.rows.every((row) => !row.partial)).toBe(true)
    // A filled bucket at the window's end is partial like any other.
    const filled = buildChart(rows, 'month', 'severity', 400, {
      to: daySeconds('2025-03-05'),
    })
    expect(filled.rows.at(-1)).toMatchObject({ key: '2025-03', total: 0, partial: true })
    // The null bucket and identity axes are never partial.
    const vendors = buildChart([['cisco', 'Cisco', 4, 4, 1]], 'vendor', 'severity', 12, {
      from: daySeconds('2025-01-15'),
      to: daySeconds('2025-03-12'),
    })
    expect(vendors.rows[0]!.partial).toBe(false)
    expect(vendors.rows[0]!.label).toBe('Cisco')
    const nulls = buildChart([[null, null, 4, 4, 1]], 'month', 'severity', 12, {
      to: daySeconds('2025-03-12'),
    })
    expect(nulls.rows[0]).toMatchObject({ key: '', partial: false, label: '(none recorded)' })
  })
})

describe('timeSpan', () => {
  const coverage = {
    publishedMin: daySeconds('1999-01-04'),
    publishedMax: daySeconds('2026-08-15'),
    updatedMin: null,
    updatedMax: null,
    yearMin: null,
    yearMax: null,
    kevAddedMin: null,
    kevAddedMax: null,
    kevDueMin: null,
    kevDueMax: null,
  }

  it('is the report’s window clamped into the copy, open where the report is', () => {
    // An unset edge is the copy's own; a set one is kept, and says so.
    expect(timeSpan({}, coverage)).toEqual({
      from: coverage.publishedMin,
      to: coverage.publishedMax,
      openAtFrom: false,
    })
    const from = daySeconds('2024-08-12')
    expect(timeSpan({ publishedFrom: from }, coverage)).toEqual({
      from,
      to: coverage.publishedMax,
      openAtFrom: true,
    })
    // A "10 yr" edge on a copy holding one year draws one year, not nine of
    // zeros; a future upper edge ends at the data.
    expect(timeSpan({ publishedFrom: daySeconds('1990-01-01') }, coverage).from).toBe(
      coverage.publishedMin
    )
    expect(timeSpan({ publishedTo: daySeconds('2030-01-01') }, coverage).to).toBe(
      coverage.publishedMax
    )
  })

  it('stands unclamped without coverage, and an unset edge is unknown', () => {
    const from = daySeconds('1990-01-01')
    expect(timeSpan({ publishedFrom: from }, null)).toEqual({
      from,
      to: undefined,
      openAtFrom: true,
    })
  })
})

describe('bucketLabel', () => {
  it('names an absence rather than blanking it', () => {
    expect(bucketLabel('severity', null, null)).toBe('(not scored)')
    expect(bucketLabel('cvssVersion', null, null)).toBe('(no CVSS)')
    expect(bucketLabel('vendor', null, null)).toBe('(none recorded)')
  })

  it('maps stored codes through the right table', () => {
    // State and severity both use 1 and 2. Using the dimension to choose the
    // table is what stops PUBLISHED rendering as LOW.
    expect(bucketLabel('severity', 2, 2)).toBe('MEDIUM')
    expect(bucketLabel('state', 2, 2)).toBe('REJECTED')
    // 31 is v3.1 and 4 is v4.0 — codes, not magnitudes (D-047).
    expect(bucketLabel('cvssVersion', 31, 31)).toBe('v3.1')
    expect(bucketLabel('cvssVersion', 4, 4)).toBe('v4.0')
  })

  it('prefers a real label when SQL supplied one', () => {
    expect(bucketLabel('vendor', 7, 'Cisco')).toBe('Cisco')
  })

  it('keeps the KEV complement a value and its unread band an absence (M6)', () => {
    // Three different facts that a two-way split would collapse: CISA lists it,
    // CISA does not list it (a finding — *not known-exploited, per CISA*), and
    // CISA listed it and stated something this build cannot read. Every label
    // carries its provenance, which is how "per CISA" stays a statement about
    // the catalog rather than an endorsement by it (D-076).
    expect(bucketLabel('kev', 1, 1)).toBe('In KEV (per CISA)')
    expect(bucketLabel('kev', 0, 0)).toBe('Not in KEV (per CISA)')
    expect(bucketLabel('kevRansomware', 2, 2)).toBe('Not in KEV (per CISA)')
    expect(bucketLabel('kevRansomware', 1, 1)).toBe('Known ransomware use')
    expect(bucketLabel('kevRansomware', 0, 0)).toBe('Unknown (per CISA)')
    // Not "Unknown", which is CISA having looked, and not the complement.
    expect(bucketLabel('kevRansomware', null, null)).toBe('(not stated by CISA)')
  })
})

describe('axis helpers', () => {
  it('picks ticks a reader can hold in their head', () => {
    expect(niceTicks(9_732)).toEqual([0, 2_500, 5_000, 7_500, 10_000])
    expect(niceTicks(3)).toEqual([0, 1, 2, 3])
    expect(niceTicks(0)).toEqual([0])
    expect(niceTicks(-5)).toEqual([0])
  })

  it('always covers the maximum, so no bar is drawn outside the plot', () => {
    for (const max of [1, 7, 99, 101, 1_234, 372_322]) {
      const ticks = niceTicks(max)
      expect(ticks[ticks.length - 1], `max ${max}`).toBeGreaterThanOrEqual(max)
    }
  })

  it('never puts a fraction of a record on the scale', () => {
    for (const max of [1, 2, 3, 4, 5]) {
      for (const tick of niceTicks(max)) expect(Number.isInteger(tick), `max ${max}`).toBe(true)
    }
  })

  it('shortens big numbers for an axis', () => {
    expect(shortCount(950)).toBe('950')
    expect(shortCount(1_500)).toBe('1.5k')
    expect(shortCount(15_000)).toBe('15k')
    expect(shortCount(1_500_000)).toBe('1.5M')
  })
})
