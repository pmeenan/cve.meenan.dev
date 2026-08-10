import { describe, expect, it } from 'vitest'

import { escapeHtml, gridToHtml, gridToTsv } from '../../lib/clipboard'
import { buildChart, relabelModel, visibleModel } from '../../lib/chart'
import { inlineSql } from '../../lib/inline-sql'
import { sheetCell } from '../../lib/sanitize'

/**
 * The copy surfaces (UI revamp). The load-bearing claim is D-071's, extended
 * to the clipboard: record content pastes as *text* in every flavour — a
 * formula-leading cell is neutralized, a control character never survives,
 * and markup arrives escaped. A copied grid is the user's own report and
 * carries no attribution block (D-082).
 */

describe('sheetCell', () => {
  it('neutralizes every spreadsheet formula lead with the apostrophe guard', () => {
    expect(sheetCell('=WEBSERVICE("https://evil.example")')).toBe(
      '\'=WEBSERVICE("https://evil.example")'
    )
    expect(sheetCell('+1+2')).toBe("'+1+2")
    expect(sheetCell('-2+3')).toBe("'-2+3")
    expect(sheetCell('@SUM(A1)')).toBe("'@SUM(A1)")
  })

  it('guards a formula hidden behind a leading control character', () => {
    // A leading tab or CR is skipped by the paste parser, so the *next*
    // character leads. stripControls turns it into a space, after which
    // nothing executable leads — assert the result is inert either way.
    expect(sheetCell('\t=cmd()')).toBe(' =cmd()')
    expect(sheetCell('\r=cmd()')).toBe(' =cmd()')
  })

  it('strips control characters so one cell stays one cell', () => {
    expect(sheetCell('a\tb\r\nc')).toBe('a b c')
    expect(sheetCell('a\u0000b\u009Fc')).toBe('a b c')
  })

  it('leaves numbers alone — a negative count is a value, not a formula', () => {
    expect(sheetCell(-5)).toBe('-5')
    expect(sheetCell(3.5)).toBe('3.5')
  })

  it('renders null as an empty cell, not the word null', () => {
    expect(sheetCell(null)).toBe('')
    expect(sheetCell(undefined)).toBe('')
  })
})

describe('gridToTsv', () => {
  it('joins cells with tabs and rows with newlines, header first', () => {
    const tsv = gridToTsv({
      columns: ['Year', 'CVEs'],
      rows: [
        ['2024', 30_000],
        ['2025', 31_500],
      ],
    })
    expect(tsv.split('\n')).toEqual(['Year\tCVEs', '2024\t30000', '2025\t31500'])
  })

  it('applies the formula guard to record-derived cells', () => {
    const tsv = gridToTsv({ columns: ['CNA'], rows: [['=HYPERLINK("https://evil.example")']] })
    expect(tsv.split('\n')[1]).toBe('\'=HYPERLINK("https://evil.example")')
  })

  it('flattens tabs and newlines inside a cell, so one cell stays one cell', () => {
    const tsv = gridToTsv({ columns: ['descr'], rows: [['a\tb\r\nc']] })
    expect(tsv.split('\n')[1]).toBe('a b c')
  })
})

describe('gridToHtml', () => {
  it('escapes record content in cells, headers and the caption (rule 4)', () => {
    const html = gridToHtml({
      title: '<img src=x onerror=alert(1)>',
      columns: ['<script>'],
      rows: [['<b>&"\'</b>']],
    })
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;')
  })

  it('formula-guards cells too — Excel evaluates pasted HTML tables', () => {
    const html = gridToHtml({ columns: ['a'], rows: [['=2+2']] })
    expect(html).toContain('<td>&#39;=2+2</td>')
  })
})

describe('escapeHtml', () => {
  it('escapes the five characters that matter', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;'
    )
  })
})

// --- the legend-toggle view of a chart model ----------------------------

const CROSS_ROWS = [
  // [bucket, label, series, series_label, cves] — two years × two severities.
  [2024, 2024, 4, 4, 10],
  [2024, 2024, 3, 3, 5],
  [2025, 2025, 4, 4, 20],
  [2025, 2025, 3, 3, 1],
]

describe('visibleModel', () => {
  it('returns the same model when nothing is hidden', () => {
    const model = buildChart(CROSS_ROWS, 'year', 'severity', 12)
    expect(visibleModel(model, new Set())).toBe(model)
  })

  it('drops a hidden series from bars, totals and the scale, but keeps every row', () => {
    const model = buildChart(CROSS_ROWS, 'year', 'severity', 12)
    const view = visibleModel(model, new Set(['3']))
    expect(view.series.map((entry) => entry.key)).toEqual(['4'])
    expect(view.rows.map((row) => row.total)).toEqual([10, 20])
    expect(view.maxTotal).toBe(20)
    expect(view.max).toBe(20)
    expect(view.total).toBe(30)
    // The row set is untouched: hiding a band must not re-space the x-axis.
    expect(view.rows.map((row) => row.label)).toEqual(model.rows.map((row) => row.label))
  })

  it('leaves the underlying model untouched for the table below', () => {
    const model = buildChart(CROSS_ROWS, 'year', 'severity', 12)
    visibleModel(model, new Set(['4']))
    expect(model.series).toHaveLength(2)
    expect(model.rows[0]!.total).toBe(15)
  })
})

describe('relabelModel', () => {
  it('renames a series for display without touching its key or colour', () => {
    const model = buildChart(CROSS_ROWS, 'year', 'severity', 12)
    const view = relabelModel(model, { '4': 'Critical severity' })
    const renamed = view.series.find((entry) => entry.key === '4')!
    const original = model.series.find((entry) => entry.key === '4')!
    expect(renamed.label).toBe('Critical severity')
    expect(renamed.color).toBe(original.color)
  })

  it('ignores blank overrides and unknown keys', () => {
    const model = buildChart(CROSS_ROWS, 'year', 'severity', 12)
    expect(relabelModel(model, { '4': '  ', nope: 'x' })).toBe(model)
  })
})

// --- inlining bound values for the console drawer -----------------------

describe('inlineSql', () => {
  it('substitutes numbers plainly and strings quoted', () => {
    expect(inlineSql('SELECT * FROM cve WHERE year >= ? AND vendor = ?', [2024, 'cisco'])).toBe(
      "SELECT * FROM cve WHERE year >= 2024 AND vendor = 'cisco'"
    )
  })

  it('doubles quotes inside a bound string so it cannot escape its literal', () => {
    expect(inlineSql('WHERE name = ?', ["o'brien'; DROP TABLE cve --"])).toBe(
      "WHERE name = 'o''brien''; DROP TABLE cve --'"
    )
  })

  it('leaves a placeholder with no value as-is', () => {
    expect(inlineSql('WHERE a = ? AND b = ?', [1])).toBe('WHERE a = 1 AND b = ?')
  })
})
