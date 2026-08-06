import { describe, expect, it } from 'vitest'

import {
  CHART_TYPES,
  emptyReport,
  fromFragment,
  MAX_FRAGMENT_BYTES,
  parseReport,
  REPORT_VERSION,
  toFragment,
  type Report,
} from '../../lib/report'

/**
 * The report definition (M4, D-044).
 *
 * These objects arrive from three places that are all outside this build's
 * control: a URL fragment someone was handed, `localStorage` written by an
 * older version of the app, and — from M7 — a model's tool call. So the tests
 * here are mostly about *refusal*: what happens to a definition that is
 * malformed, hostile, or simply from the future.
 *
 * The failure worth guarding hardest is not a crash. It is a definition that
 * parses into something subtly different from what its author saw — a dropped
 * state filter changing a denominator (D-022), an unknown dimension quietly
 * defaulting to another one — because that renders a plausible chart of the
 * wrong thing, which is precisely what vision criterion 7 rules out.
 */

const good = (over: Partial<Report> = {}): unknown => ({
  v: REPORT_VERSION,
  filters: { state: 'published', vendor: ['cisco'] },
  rows: 'month',
  series: 'severity',
  chart: 'stackedBar',
  ...over,
})

function parsed(value: unknown): Report {
  const result = parseReport(value)
  if (!result.ok) throw new Error(`expected a valid report, got: ${result.error}`)
  return result.report
}

describe('parseReport', () => {
  it('accepts a well-formed definition', () => {
    const report = parsed(good())
    expect(report.rows).toBe('month')
    expect(report.series).toBe('severity')
    expect(report.filters.vendor).toEqual(['cisco'])
  })

  it('refuses anything that is not a report object', () => {
    for (const value of [null, undefined, 42, 'report', [], true]) {
      expect(parseReport(value).ok).toBe(false)
    }
  })

  it('refuses a definition from a newer build by saying so', () => {
    const result = parseReport(good({ v: REPORT_VERSION + 1 }))
    expect(result.ok).toBe(false)
    // The message has to name the situation: a permalink outlives the build
    // that wrote it, and "invalid link" would send the reader looking for a
    // typo that is not there.
    if (!result.ok) expect(result.error).toMatch(/newer version/i)
  })

  it('refuses an unknown dimension rather than defaulting past it', () => {
    expect(parseReport(good({ rows: 'sqlite_master' as never })).ok).toBe(false)
    expect(parseReport(good({ series: 'password' as never })).ok).toBe(false)
    expect(parseReport(good({ chart: 'pie' as never })).ok).toBe(false)
  })

  it('refuses the same dimension on both axes', () => {
    // A diagonal, not a cross-tab: every off-diagonal cell is empty by
    // construction, and the reader would have to work out why.
    expect(parseReport(good({ rows: 'vendor', series: 'vendor' })).ok).toBe(false)
  })

  it('treats an absent series as a one-dimension aggregate', () => {
    expect(parsed(good({ series: null })).series).toBeNull()
    const { series: _dropped, ...withoutSeries } = good() as Record<string, unknown>
    expect(parsed(withoutSeries).series).toBeNull()
  })

  it('defaults the record state to PUBLISHED (D-022)', () => {
    // The one default that changes every number on screen. A definition with
    // no state, or with a state this build does not recognise, must not widen
    // the corpus by ~5% without saying so.
    expect(parsed(good({ filters: {} })).filters.state).toBe('published')
    expect(parsed(good({ filters: { state: 'everything' } as never })).filters.state).toBe(
      'published'
    )
    expect(parsed(good({ filters: { state: 'all' } })).filters.state).toBe('all')
  })

  it('refuses severity and CVSS-version codes this schema does not have', () => {
    expect(parseReport(good({ filters: { severity: [4, 99] } as never })).ok).toBe(false)
    // 31 is v3.1 and 4 is v4.0 — codes, not magnitudes (D-047). 40 is neither.
    expect(parseReport(good({ filters: { cvssVersion: [31, 40] } as never })).ok).toBe(false)
    expect(parsed(good({ filters: { severity: [4, 2], cvssVersion: [31, 4] } })).filters).toEqual({
      severity: [4, 2],
      cvssVersion: [31, 4],
      state: 'published',
    })
  })

  it('refuses a lookup axis that is not a list of names', () => {
    expect(parseReport(good({ filters: { vendor: 'cisco' } as never })).ok).toBe(false)
    expect(parseReport(good({ filters: { cwe: { length: 1 } } as never })).ok).toBe(false)
  })

  it('refuses malformed or oversized lookup axes instead of dropping predicates', () => {
    expect(parseReport(good({ filters: { vendor: [42] } as never })).ok).toBe(false)
    expect(parseReport(good({ filters: { vendor: [''] } })).ok).toBe(false)
    const many = Array.from({ length: 5_000 }, (_, i) => `vendor-${i}`)
    expect(parseReport(good({ filters: { vendor: many } })).ok).toBe(false)
  })

  it('refuses malformed scalar filters instead of broadening the report', () => {
    expect(parseReport(good({ filters: { text: 42 } as never })).ok).toBe(false)
    expect(parseReport(good({ filters: { scoreMin: '9' } as never })).ok).toBe(false)
    expect(parseReport(good({ filters: { publishedFrom: Number.POSITIVE_INFINITY } })).ok).toBe(
      false
    )
  })

  it('drops fields it does not know instead of refusing', () => {
    // Forward compatibility in the direction that matters: a definition from a
    // newer build at the same version opens here at the parts this one reads.
    const report = parsed(good({ sparkline: true, filters: { kev: true } } as never))
    expect(report.rows).toBe('month')
    expect('sparkline' in report).toBe(false)
  })

  it('stamps the version it actually produced', () => {
    expect(parsed(good({ v: 1 })).v).toBe(REPORT_VERSION)
  })

  it('opens on a default report', () => {
    const report = parsed(emptyReport())
    expect(report.filters.state).toBe('published')
    expect(CHART_TYPES).toContain(report.chart)
  })
})

describe('permalink fragments', () => {
  it('round-trips a report', () => {
    const report = parsed(
      good({
        title: 'Severity over time',
        filters: {
          state: 'all',
          vendor: ['cisco'],
          text: 'overflow',
          publishedFrom: 1_700_000_000,
        },
      })
    )
    const back = fromFragment(toFragment(report))
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.report).toEqual(report)
  })

  it('survives the URL characters that break base64', () => {
    // `+` and `/` are what make plain base64 unusable in a fragment: one is
    // eaten as a space by some clients, the other reads as a path.
    const report = parsed(good({ title: '?#&+/= ünïcode 🔒', filters: { text: 'a+b/c' } }))
    const fragment = toFragment(report)
    expect(fragment).toMatch(/^[A-Za-z0-9_-]+$/)
    const back = fromFragment(fragment)
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.report.title).toBe('?#&+/= ünïcode 🔒')
  })

  it('accepts the fragment with or without its leading hash', () => {
    const fragment = toFragment(parsed(good()))
    expect(fromFragment(`#${fragment}`).ok).toBe(true)
  })

  it('refuses a fragment too long to be a report before parsing it', () => {
    const result = fromFragment('A'.repeat(MAX_FRAGMENT_BYTES + 1))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/too long/)
  })

  it('refuses damaged and hostile fragments without throwing', () => {
    for (const fragment of [
      '',
      'not base64!!',
      '<script>alert(1)</script>',
      '../../etc/passwd',
      'AAAA', // decodes, but is not JSON
      btoa('{"v":1}').replace(/=+$/, ''), // JSON, but not a report
      btoa('[1,2,3]').replace(/=+$/, ''),
    ]) {
      expect(() => fromFragment(fragment)).not.toThrow()
      expect(fromFragment(fragment).ok).toBe(false)
    }
  })

  it('does not let a fragment smuggle a dimension in', () => {
    // The fragment is just transport: everything in it goes through the same
    // validation as a definition built by the UI.
    const smuggled = btoa(
      JSON.stringify({ v: 1, rows: 'sqlite_master', series: null, chart: 'table', filters: {} })
    ).replace(/=+$/, '')
    expect(fromFragment(smuggled).ok).toBe(false)
  })
})
