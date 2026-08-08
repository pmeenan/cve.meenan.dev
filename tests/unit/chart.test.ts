import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { buildChart, bucketLabel, niceTicks, seriesColor, shortCount } from '../../lib/chart'

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
 * fine on my monitor". Severity is an *ordinal* encoding — a lightness-ordered
 * ramp — because hue alone puts MEDIUM and HIGH, the two largest bands, below
 * the separation floor. That is measurable: this test reads `app/globals.css`,
 * pulls both ramps out of it, and checks each against the background it is
 * actually drawn on. The stylesheet is the source, so the two cannot drift.
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
 * `MIN_STEP` is the separation between adjacent bands of the ramp — they touch
 * in a stacked bar, so this is the contrast that decides whether a reader can
 * see the boundary at all. `MIN_BACKGROUND` is lower than WCAG's 3:1 for
 * graphical objects on purpose and is not a claim to meet it: a six-step ramp
 * cannot both span a useful range and hold 3:1 at the end nearest the page. The
 * hairline stroke in `--bg` on every bar (`.chart .bar` in globals.css) is what
 * carries the boundary against the background; this floor keeps the fill itself
 * from disappearing into it.
 */
const MIN_STEP = 1.4
const MIN_BACKGROUND = 2.0

const RAMP = ['--sev-4', '--sev-3', '--sev-2', '--sev-1', '--sev-0'] as const

describe('the severity ramp is ordinal, in both themes', () => {
  for (const scheme of ['light', 'dark'] as const) {
    describe(scheme, () => {
      const colors = palette(scheme)
      const background = colors['--bg']!
      const ramp = RAMP.map((name) => {
        const value = colors[name]
        if (!value) throw new Error(`${name} is not defined for the ${scheme} scheme`)
        return [name, value] as const
      })

      it('is strictly ordered by lightness, CRITICAL furthest from the page', () => {
        const luminances = ramp.map(([, hex]) => luminance(hex))
        const ordered =
          scheme === 'light'
            ? luminances.every((value, at) => at === 0 || value > luminances[at - 1]!)
            : luminances.every((value, at) => at === 0 || value < luminances[at - 1]!)
        expect(ordered, `luminances: ${luminances.map((v) => v.toFixed(3)).join(', ')}`).toBe(true)
      })

      it('separates adjacent bands, which is what a stacked bar needs', () => {
        for (let at = 1; at < ramp.length; at += 1) {
          const ratio = contrast(ramp[at]![1], ramp[at - 1]![1])
          expect(ratio, `${ramp[at]![0]} vs ${ramp[at - 1]![0]}`).toBeGreaterThanOrEqual(MIN_STEP)
        }
      })

      it('keeps every band visible against the page it is drawn on', () => {
        for (const [name, hex] of ramp) {
          expect(contrast(hex, background), name).toBeGreaterThanOrEqual(MIN_BACKGROUND)
        }
      })

      it('puts the unscored band off the ramp, distinct from its stack neighbour', () => {
        // Records with no CVSS score are about half the corpus and are always
        // shown as their own band. It is an absence rather than a level, so it
        // is a neutral — and it sits directly above NONE in the stack, which is
        // the only adjacency it has.
        const unscored = colors['--sev-x']!
        expect(contrast(unscored, colors['--sev-0']!)).toBeGreaterThanOrEqual(MIN_STEP)
        expect(contrast(unscored, background)).toBeGreaterThanOrEqual(MIN_BACKGROUND)
      })

      it('separates every adjacency an SSVC stack actually has (D-070)', () => {
        // These axes are scales too, so they reuse the ramp — spaced across it
        // — rather than taking categorical slots. The adjacencies are different
        // from severity's: the neutral lands on *top of the highest* band here,
        // not above NONE, so that pair needs its own assertion.
        const stacks: string[][] = [
          ['--sev-0', '--sev-2', '--sev-4', '--sev-x'], // Exploitation
          ['--sev-0', '--sev-4', '--sev-x'], // Automatable, Technical impact
        ]
        for (const stack of stacks) {
          for (let at = 1; at < stack.length; at += 1) {
            const ratio = contrast(colors[stack[at]!]!, colors[stack[at - 1]!]!)
            expect(ratio, `${stack[at]} vs ${stack[at - 1]}`).toBeGreaterThanOrEqual(MIN_STEP)
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
