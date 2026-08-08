import { describe, expect, it } from 'vitest'

import {
  daySeconds,
  MAX_KEV_BYTES,
  MAX_KEV_CWES,
  MAX_KEV_ENTRIES,
  MAX_KEV_FIELD_CHARS,
  MAX_KEV_HEADER_CHARS,
  MAX_KEV_NOTE_CHARS,
  MAX_KEV_NOTES,
  insertParams,
  isNewerCatalog,
  parseCatalog,
  parseCwes,
  type KevEntry,
  ransomwareCode,
  RANSOMWARE_KNOWN,
  RANSOMWARE_UNKNOWN,
  releasedSeconds,
  splitNotes,
} from '../../lib/kev'
import { safeUrl } from '../../lib/sanitize'

/**
 * The KEV catalog as the client sees it (M6, D-076).
 *
 * The catalog is stranger input twice over: it arrives over the network, and it
 * is written by a third party. `pipeline/kev.py` validates it on the way out
 * and this validates it again on the way in — deliberately, because a client
 * that trusted the server's check would be trusting a check it cannot see,
 * through a mutable URL with a cache in front of it.
 *
 * So what is tested here is the *refusals*, and the two conversions that decide
 * what a bucket means: `ransomwareCode`, where inventing a value would
 * manufacture a finding, and `daySeconds`, where reading a bare calendar day as
 * local time moves every date-range boundary by the reader's offset.
 */

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cveID: 'CVE-2021-44228',
    vendorProject: 'Apache',
    product: 'Log4j2',
    vulnerabilityName: 'Apache Log4j2 Deserialization of Untrusted Data Vulnerability',
    dateAdded: '2021-12-10',
    shortDescription: 'Apache Log4j2 contains a vulnerability…',
    requiredAction: 'Apply updates per vendor instructions.',
    dueDate: '2021-12-24',
    knownRansomwareCampaignUse: 'Known',
    notes: 'https://example.invalid/a ; BOD 22-01: https://example.invalid/b',
    cwes: ['CWE-502'],
    ...over,
  }
}

function catalog(over: Record<string, unknown> = {}): Record<string, unknown> {
  const entries = (over.vulnerabilities as unknown[]) ?? [entry()]
  return {
    title: 'CISA Catalog of Known Exploited Vulnerabilities',
    catalogVersion: '2026.08.07',
    dateReleased: '2026-08-07T16:45:47.0648Z',
    count: entries.length,
    vulnerabilities: entries,
    ...over,
  }
}

describe('parseCatalog', () => {
  it('accepts the shape CISA publishes', () => {
    const parsed = parseCatalog(catalog())
    expect(parsed.version).toBe('2026.08.07')
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0]!.cve).toBe('CVE-2021-44228')
    expect(parsed.entries[0]!.ransomware).toBe(RANSOMWARE_KNOWN)
    expect(parsed.entries[0]!.addedAt).toBe(daySeconds('2021-12-10'))
    expect(parsed.releasedAt).toBe(releasedSeconds('2026-08-07T16:45:47.0648Z'))
  })

  it('refuses anything that is not a catalog object', () => {
    for (const value of [null, [], 'a string', 42, undefined]) {
      expect(() => parseCatalog(value)).toThrow()
    }
  })

  it('bounds the three strings the UI renders on every session', () => {
    // They are the only catalog values that reach the DOM on every session —
    // the freshness line, the diagnostics panel, and the preamble of every
    // export. Unbounded, a hostile catalog wedges a multi-megabyte string into
    // the front page for good: it survives a reload, works offline, and only a
    // successful refresh clears it.
    const long = 'x'.repeat(MAX_KEV_HEADER_CHARS + 1)
    expect(() => parseCatalog(catalog({ catalogVersion: long }))).toThrow(/over/)
    // A `dateReleased` long enough to matter is also not a timestamp, so it is
    // refused either way — asserted so a future relaxation of one check does
    // not silently remove the other.
    expect(() => parseCatalog(catalog({ dateReleased: long }))).toThrow()
    // `title` is deliberately *not* bounded here: the client neither stores nor
    // renders it, so it reaches nothing. `pipeline/kev.py` bounds it, because
    // the server publishes it verbatim.
    expect(() => parseCatalog(catalog({ title: long }))).not.toThrow()
  })

  it('does not echo a whole hostile field back into the app’s own voice', () => {
    // A refusal is rendered on the front page and in diagnostics. Echoing a
    // 20,000-character `dateAdded` whole would put that much attacker-authored
    // prose there, in the app's voice — React escapes it, so it is not
    // injection; it is the app appearing to say something it did not.
    const shout = 'YOUR LOCAL CVE COPY IS COMPROMISED. CALL 1-800-555-0100. '.repeat(300)
    let message = ''
    try {
      parseCatalog(catalog({ vulnerabilities: [entry({ dateAdded: shout })] }))
    } catch (error) {
      message = String((error as Error).message)
    }
    expect(message).toMatch(/dateAdded/)
    expect(message.length).toBeLessThan(200)
  })

  it('refuses a missing catalogVersion or dateReleased', () => {
    // These are what the UI renders as provenance — "per CISA, as of …" — and a
    // freshness line with nothing behind it is worse than none.
    expect(() => parseCatalog(catalog({ catalogVersion: '' }))).toThrow(/catalogVersion/)
    expect(() => parseCatalog(catalog({ dateReleased: undefined }))).toThrow(/dateReleased/)
  })

  it('refuses a dateReleased that is not a timestamp', () => {
    // It is rendered, and its age is computed from it. A non-empty string that
    // is not a date puts "Invalid Date" on screen beside a known-exploited
    // list. The pipeline refuses the same thing; this repeats it because the
    // client does not trust the server's validation.
    for (const bad of ['banana', '<img src=x onerror=alert(1)>', 'when we felt like it']) {
      expect(() => parseCatalog(catalog({ dateReleased: bad })), bad).toThrow(/not a timestamp/)
    }
  })

  it('refuses a count that disagrees with the list', () => {
    // The one check that catches a body truncated somewhere it still parses.
    expect(() => parseCatalog(catalog({ count: 1662 }))).toThrow(/1662/)
  })

  it('refuses an empty catalog', () => {
    // "Nothing is known to be exploited" is a finding CISA has never published,
    // and it is what a reset or truncated feed would look like.
    expect(() => parseCatalog({ ...catalog(), vulnerabilities: [], count: 0 })).toThrow()
  })

  it('refuses a body over the byte bound before parsing it', () => {
    expect(() => parseCatalog(catalog(), MAX_KEV_BYTES + 1)).toThrow(/over/)
  })

  it('refuses a malformed or duplicated cveID', () => {
    for (const bad of ['CVE-21-44228', 'cve-2021-44228 x', '../../etc/passwd', '']) {
      expect(() => parseCatalog(catalog({ vulnerabilities: [entry({ cveID: bad })] }))).toThrow()
    }
    // One entry per CVE is what makes the join 1:1 — and it is also the table's
    // primary key, so refusing here turns a constraint failure mid-transaction
    // into a message.
    expect(() => parseCatalog(catalog({ vulnerabilities: [entry(), entry()] }))).toThrow(/twice/)
  })

  it('refuses a missing required field, by name', () => {
    for (const field of [
      'vendorProject',
      'product',
      'vulnerabilityName',
      'shortDescription',
      'requiredAction',
      'notes',
      'knownRansomwareCampaignUse',
    ]) {
      expect(() =>
        parseCatalog(catalog({ vulnerabilities: [entry({ [field]: undefined })] }))
      ).toThrow(new RegExp(field))
    }
  })

  it('refuses dates that are not calendar days', () => {
    for (const bad of ['2021/12/10', '2021-12-10T00:00:00Z', '', 'yesterday']) {
      expect(() => parseCatalog(catalog({ vulnerabilities: [entry({ dateAdded: bad })] }))).toThrow(
        /dateAdded/
      )
    }
  })

  it('bounds every string and both lists', () => {
    const long = 'x'.repeat(MAX_KEV_FIELD_CHARS + 1)
    expect(() =>
      parseCatalog(catalog({ vulnerabilities: [entry({ shortDescription: long })] }))
    ).toThrow()
    expect(() =>
      parseCatalog(
        catalog({ vulnerabilities: [entry({ cwes: new Array(MAX_KEV_CWES + 1).fill('CWE-79') })] })
      )
    ).toThrow()
    expect(() => parseCatalog(catalog({ vulnerabilities: [entry({ cwes: [long] })] }))).toThrow()
    expect(() => parseCatalog(catalog({ vulnerabilities: [entry({ cwes: 'CWE-79' })] }))).toThrow(
      /cwes/
    )
  })

  it('bounds the entry count before it walks a single entry', () => {
    // A sparse array: the bound is checked against `length`, so nothing here
    // has to be a real entry — which is the point of checking it there rather
    // than discovering the size 100,000 validations in.
    const many = new Array<unknown>(MAX_KEV_ENTRIES + 1)
    expect(() =>
      parseCatalog({ ...catalog(), vulnerabilities: many, count: MAX_KEV_ENTRIES + 1 })
    ).toThrow(/over/)
  })
})

describe('the client’s own ordering guard (D-077 §3)', () => {
  // The pipeline has one too. This one exists because *this* file's premise is
  // that the server's validation is a check the client cannot see, through a
  // mutable URL with a cache in front of it — and the ordering half is the half
  // that defends against exactly that.
  const at = (version: string, released: string) => ({
    version,
    releasedAt: releasedSeconds(released)!,
  })

  it('refuses a catalog older than the one already held', () => {
    // The attack this stops: one poisoned response replaces a current catalog
    // with a 2019 one, and because "Not in KEV" is a real value here rather
    // than an absence, the app then positively asserts *not known-exploited,
    // per CISA* for everything listed since — persisted, offline-honest, and
    // agreeing across tabs.
    const held = at('2026.08.07', '2026-08-07T00:00:00Z')
    expect(isNewerCatalog(at('2019.01.01', '2019-01-01T00:00:00Z'), held)).toBe(false)
    expect(isNewerCatalog(at('2026.08.08', '2026-08-08T00:00:00Z'), held)).toBe(true)
    // Equal is accepted: CISA corrects entries in place.
    expect(isNewerCatalog(at('2026.08.07', '2026-08-07T00:00:00Z'), held)).toBe(true)
  })

  it('orders dotted versions numerically, and a same-day re-release after the first', () => {
    // `2026.8.9` vs `2026.08.10` is the pair a string comparison gets wrong,
    // and `…07.1` after `…07` is the shape a same-day second release would
    // most plausibly take.
    expect(
      isNewerCatalog(
        at('2026.08.10', '2026-08-10T00:00:00Z'),
        at('2026.8.9', '2026-08-09T00:00:00Z')
      )
    ).toBe(true)
    expect(
      isNewerCatalog(
        at('2026.8.9', '2026-08-09T00:00:00Z'),
        at('2026.08.10', '2026-08-10T00:00:00Z')
      )
    ).toBe(false)
    expect(
      isNewerCatalog(
        at('2026.08.07.1', '2026-08-07T01:00:00Z'),
        at('2026.08.07', '2026-08-07T00:00:00Z')
      )
    ).toBe(true)
  })

  it('will not let an implausible version become an ordering basis', () => {
    // `20260.08.09` is one fat-finger from real and would outrank every genuine
    // catalog until the year 20260. It falls back to `dateReleased` instead of
    // being refused, because refusing on a version-scheme change is the other
    // wedge.
    const held = at('20260.08.09', '2026-08-08T00:00:00Z')
    expect(isNewerCatalog(at('2026.08.09', '2026-08-09T00:00:00Z'), held)).toBe(true)
  })

  it('cannot be ordered against a stored catalog with no usable release stamp', () => {
    // Only reachable for an older build's stored row. The caller treats it as
    // "no floor" rather than as a refusal, or a bad stored value would be
    // defended forever.
    expect(
      isNewerCatalog(at('2026.08.08', '2026-08-08T00:00:00Z'), {
        version: 'rolling',
        releasedAt: null,
      })
    ).toBeNull()
  })

  it('refuses a catalog stamped in the future, which is what makes the guard safe', () => {
    // Unbounded, a future-dated catalog is applied once and then *defended*
    // against every real one — and `describeFreshness` clamps a future stamp to
    // zero, so it would render as "less than an hour old" forever.
    const now = Date.parse('2026-08-08T00:00:00Z')
    const future = { ...catalog(), dateReleased: '2099-01-01T00:00:00Z' }
    expect(() => parseCatalog(future, undefined, now)).toThrow(/days from now/)
    // Two days of slack for clock skew is accepted.
    const soon = { ...catalog(), dateReleased: '2026-08-09T00:00:00Z' }
    expect(() => parseCatalog(soon, undefined, now)).not.toThrow()
  })
})

describe('the cwes round trip', () => {
  it('reads back exactly what insertParams wrote', () => {
    // Two halves of one format in one file. A writer and a reader that drift
    // apart is a column that silently stops meaning anything, and the only
    // reader is the detail view — where an empty CWE list looks like a record
    // that has none.
    const written = insertParams({
      ...(parseCatalog(catalog()).entries[0] as KevEntry),
      cwes: ['CWE-502', 'CWE-20'],
    })
    expect(parseCwes(written[written.length - 1])).toEqual(['CWE-502', 'CWE-20'])
    expect(
      parseCwes(insertParams({ ...(parseCatalog(catalog()).entries[0] as KevEntry), cwes: [] })[13])
    ).toEqual([])
  })

  it('reads anything else as no CWEs rather than throwing', () => {
    // The database is a file other builds have written to; a `JSON.parse` that
    // threw would take the whole detail view down for the least load-bearing
    // field on it.
    for (const bad of ['', 'not json', '{"a":1}', '[1,2]', null, 42]) {
      expect(parseCwes(bad)).toEqual(bad === '[1,2]' ? [] : [])
    }
  })
})

describe('ransomwareCode', () => {
  it('reads the two values CISA publishes, case-insensitively', () => {
    expect(ransomwareCode('Known')).toBe(RANSOMWARE_KNOWN)
    expect(ransomwareCode('known')).toBe(RANSOMWARE_KNOWN)
    expect(ransomwareCode('Unknown')).toBe(RANSOMWARE_UNKNOWN)
    expect(ransomwareCode(' unknown ')).toBe(RANSOMWARE_UNKNOWN)
  })

  it('gives anything else its own band rather than folding it into Unknown', () => {
    // "Unknown" is CISA having looked and not knowing. Reading a third value as
    // that would manufacture a finding — the same distinction D-070 draws for
    // an SSVC point nobody assessed, and the reason `pipeline/kev.py` reports
    // the distribution instead of enforcing an enum.
    expect(ransomwareCode('Suspected')).toBeNull()
    expect(ransomwareCode('')).toBeNull()
  })
})

describe('daySeconds', () => {
  it('reads a calendar day as UTC midnight', () => {
    // Local time would move every date-range boundary by the reader's offset
    // and quietly drop a day's entries at each end (the trap lib/draft.ts
    // documents for the corpus's own date inputs).
    expect(daySeconds('2021-12-10')).toBe(Date.parse('2021-12-10T00:00:00Z') / 1000)
    expect(daySeconds('2021-12-10T00:00:00Z')).toBeNull()
    expect(daySeconds('')).toBeNull()
  })
})

describe('splitNotes', () => {
  it('splits CISA’s semicolon-separated notes into linkable parts', () => {
    const parts = splitNotes('https://example.invalid/a ; BOD 22-01: https://example.invalid/b')
    expect(parts).toHaveLength(2)
    expect(parts[0]!.url).toBe('https://example.invalid/a')
    expect(parts[1]!.url).toBe('https://example.invalid/b')
    // The label is kept as the part's text, so a reader sees what the link is
    // for — but the anchor still shows the URL.
    expect(parts[1]!.text).toContain('BOD 22-01')
  })

  it('keeps a part with no URL as text', () => {
    const parts = splitNotes('See the vendor advisory ; ')
    expect(parts).toHaveLength(1)
    expect(parts[0]!.url).toBeNull()
  })

  it('hands a hostile scheme to safeUrl rather than dropping it', () => {
    // Deliberately not pre-filtered by scheme: a `javascript:` token has to
    // reach `safeUrl` to be *refused by name*, which is the same treatment the
    // reference list gives — an omitted reference is a fact about the record
    // the reader should have (rule 4).
    const parts = splitNotes('javascript:alert(1) ; https://example.invalid/ok')
    expect(parts[0]!.url).toBe('javascript:alert(1)')
    expect(safeUrl(parts[0]!.url).href).toBeNull()
    expect(safeUrl(parts[1]!.url).href).toBe('https://example.invalid/ok')
  })

  it('bounds how many parts it returns, and how long each one is', () => {
    const many = new Array(MAX_KEV_NOTES + 20).fill('https://example.invalid/x').join(' ; ')
    expect(splitNotes(many)).toHaveLength(MAX_KEV_NOTES)
    const huge = 'x'.repeat(MAX_KEV_NOTE_CHARS + 500)
    expect(splitNotes(huge)[0]!.text).toHaveLength(MAX_KEV_NOTE_CHARS)
  })

  it('scans in linear time on a long part with no URL in it', () => {
    // The pattern this replaced had two alternating quantifiers and backtracked
    // quadratically on exactly this input — one hostile entry cost ~0.3 s of
    // main thread *per render* of its detail view. A ceiling rather than a
    // benchmark: the point is that it is not seconds.
    const hostile = `${'a+.-'.repeat(5_000)}:`
    const started = performance.now()
    splitNotes(hostile)
    expect(performance.now() - started).toBeLessThan(50)
  })

  it('prefers the real http(s) URL over an earlier colon-shaped word', () => {
    // `Note:see https://www.cisa.gov/kev` used to link nothing: the first
    // colon-shaped token won, was refused as `note:` by the allowlist, and the
    // genuine URL beside it was never offered.
    const parts = splitNotes('Note:see https://www.cisa.gov/known-exploited-vulnerabilities')
    expect(parts[0]!.url).toBe('https://www.cisa.gov/known-exploited-vulnerabilities')
  })
})
