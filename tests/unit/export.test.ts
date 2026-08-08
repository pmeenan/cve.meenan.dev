import { describe, expect, it } from 'vitest'

import {
  csvWriter,
  EXPORT_LIMIT,
  exportFilename,
  exportWriter,
  jsonWriter,
  RECORD_COLUMNS,
  type ExportHeader,
} from '../../lib/export'

/**
 * Export (M4).
 *
 * Two obligations are checked here rather than inspected once. **D-008**: every
 * copy of CVE data reproduces MITRE's notice, and an export is a copy — so a
 * writer built without one has to refuse rather than produce a file and
 * apologise. And **rule 4**: the records below carry the payloads a real corpus
 * carries, so the hardening is tested against hostile input rather than clean
 * input (`tests/unit/sanitize.test.ts` covers each primitive; this covers the
 * composition, which is where a guard gets skipped).
 *
 * The third property is truncation being *disclosed*. A file that stops at the
 * cap and does not say so is read as complete, which is worse than no file.
 */

const NOTICE = 'CVE record content: Copyright © 1999-2026, The MITRE Corporation. …'

function header(over: Partial<ExportHeader> = {}): ExportHeader {
  return {
    notice: NOTICE,
    columns: [...RECORD_COLUMNS],
    title: 'Cisco criticals',
    revision: 42,
    sql: 'SELECT … WHERE c.state = ?',
    params: [1],
    matches: 3,
    truncated: false,
    ...over,
  }
}

/** A record shaped like the ones that make exports dangerous. */
const HOSTILE = [
  'CVE-2021-44228',
  1,
  1_639_094_400,
  1_641_340_800,
  31,
  10,
  4,
  "=cmd|' /C calc'!A0",
  'A description with a NUL\u0000 and a bidi override \u202E and a "quote", plus a comma.',
]

describe('the notice is a condition, not a footer (D-008)', () => {
  it('refuses to build a writer for a copy with no notice', () => {
    for (const notice of ['', '   ', '\u0000']) {
      expect(() => csvWriter(header({ notice }))).toThrow(/notice/i)
      expect(() => jsonWriter(header({ notice }))).toThrow(/notice/i)
    }
  })

  it('puts the notice in both formats', () => {
    expect(csvWriter(header()).begin()).toContain('The MITRE Corporation')
    const json = JSON.parse(`${jsonWriter(header()).begin()}]}`) as { notice: string }
    expect(json.notice).toContain('The MITRE Corporation')
  })
})

describe('CSV', () => {
  it('neutralizes formula injection in a record that carries it', () => {
    const writer = csvWriter(header())
    const rows = writer.rows([HOSTILE])
    // The CNA field is the payload. It must not begin a cell with `=`.
    expect(rows).toContain(`"'=cmd`)
    expect(rows).not.toMatch(/,"=cmd/)
  })

  it('strips control characters, so one record stays one record', () => {
    const rows = csvWriter(header()).rows([HOSTILE])
    // Exactly one CRLF: the terminator. A stray newline in a description would
    // split this into two records for every parser that is not fully
    // quoted-aware.
    expect(rows.match(/\r\n/g)).toHaveLength(1)
    expect(rows).not.toContain('\u0000')
    expect(rows).not.toContain('\u202E')
  })

  it('discloses truncation on the file’s own face', () => {
    const plain = csvWriter(header()).begin()
    expect(plain).not.toMatch(/TRUNCATED/)
    const capped = csvWriter(header({ truncated: true, matches: 900_000 })).begin()
    expect(capped).toMatch(/TRUNCATED/)
    expect(capped).toContain(EXPORT_LIMIT.toLocaleString('en-US'))
  })

  it('writes the column header row, quoted like every other row', () => {
    expect(csvWriter(header()).begin()).toContain('"cve","state"')
  })
})

describe('JSON', () => {
  it('round-trips through a parser, in batches', () => {
    const writer = jsonWriter(header())
    // Assembled the way the page assembles it: begin, then batches, then end.
    // Nothing here holds the whole file, which is the property being checked.
    const text = writer.begin() + writer.rows([HOSTILE]) + writer.rows([HOSTILE]) + writer.end()
    const parsed = JSON.parse(text) as {
      notice: string
      rows: Record<string, unknown>[]
      truncated: boolean
      revision: number
    }
    expect(parsed.rows).toHaveLength(2)
    expect(parsed.rows[0]!.cve).toBe('CVE-2021-44228')
    expect(parsed.revision).toBe(42)
    expect(parsed.notice).toContain('MITRE')
  })

  it('names its columns rather than relying on position', () => {
    const writer = jsonWriter(header())
    const parsed = JSON.parse(writer.begin() + writer.rows([HOSTILE]) + writer.end()) as {
      rows: Record<string, unknown>[]
    }
    expect(Object.keys(parsed.rows[0]!)).toEqual([...RECORD_COLUMNS])
  })

  it('strips control characters from string values', () => {
    const writer = jsonWriter(header())
    const parsed = JSON.parse(writer.begin() + writer.rows([HOSTILE]) + writer.end()) as {
      rows: Record<string, string>[]
    }
    expect(parsed.rows[0]!.description).not.toContain('\u0000')
    expect(parsed.rows[0]!.description).not.toContain('\u202E')
    // But it is not apostrophe-guarded: a JSON string is not a spreadsheet cell.
    expect(parsed.rows[0]!.cna).toBe("=cmd|' /C calc'!A0")
  })

  it('produces valid JSON for an export with no rows at all', () => {
    const writer = jsonWriter(header({ matches: 0 }))
    expect(() => JSON.parse(writer.begin() + writer.end())).not.toThrow()
  })
})

describe('exportWriter', () => {
  it('selects by format and carries the right MIME type and extension', () => {
    expect(exportWriter('csv', header()).mime).toMatch(/text\/csv/)
    expect(exportWriter('csv', header()).extension).toBe('csv')
    expect(exportWriter('json', header()).mime).toMatch(/application\/json/)
    expect(exportWriter('json', header()).extension).toBe('json')
  })
})

describe('exportFilename', () => {
  it('reduces a user-typed title to something a filesystem cannot misread', () => {
    expect(exportFilename('Cisco criticals, 2024', 'csv')).toBe('cisco-criticals-2024.csv')
    expect(exportFilename('../../etc/passwd', 'csv')).toBe('etc-passwd.csv')
    expect(exportFilename('a"b\r\nContent-Disposition: x', 'json')).toBe(
      'a-b-content-disposition-x.json'
    )
  })

  it('falls back rather than producing a name that is only an extension', () => {
    expect(exportFilename('', 'csv')).toBe('cve-export.csv')
    expect(exportFilename('!!!', 'csv')).toBe('cve-export.csv')
  })

  it('bounds the length', () => {
    expect(exportFilename('x'.repeat(500), 'csv').length).toBeLessThanOrEqual(64)
  })
})
