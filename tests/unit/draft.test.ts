import { describe, expect, it } from 'vitest'

import {
  clearChip,
  describeDraft,
  draftToFilters,
  EMPTY_DRAFT,
  filtersToDraft,
  type Draft,
} from '../../lib/draft'
import { NOT_ASSESSED, type Filters } from '../../lib/filters'

/**
 * The filter form's state and the two conversions around it (M4).
 *
 * The property that matters is the **round trip**. M4 has three paths that
 * arrive with a `Filters` already built and have to populate a form from it: a
 * permalink, a saved report, and from M7 a model's tool call. If
 * `filtersToDraft` loses a field, the form describes a different report than
 * the one that just ran — and the next Run silently changes the answer.
 *
 * The other trap is dates. `<input type="date">` is a calendar day with no
 * zone; the corpus stores UTC. Reading the box as local time moves every
 * boundary by the reader's offset and quietly drops a day's records at each end.
 */

const FULL: Draft = {
  text: 'buffer overflow',
  cveId: 'CVE-2021-44228',
  vendor: 'cisco, juniper',
  product: 'ios xe',
  cna: 'mitre',
  cwe: 'CWE-79',
  host: 'github.com',
  severity: [3, 4],
  cvssVersion: [31, 4],
  // Including the sentinel, which is the round trip's hardest case: it is not a
  // stored code, so a conversion that filtered it out would look correct until
  // a permalink to "not assessed" came back selecting nothing (D-070).
  ssvcExpl: [2, NOT_ASSESSED],
  ssvcAuto: [1],
  ssvcImpact: [0, 1],
  scoreMin: '7',
  scoreMax: '10',
  publishedFrom: '2024-01-01',
  publishedTo: '2024-12-31',
  updatedFrom: '2025-01-01',
  updatedTo: '2025-06-30',
  yearFrom: '2020',
  yearTo: '2026',
  state: 'all',
}

describe('the round trip', () => {
  it('survives every axis', () => {
    expect(filtersToDraft(draftToFilters(FULL))).toEqual(FULL)
  })

  it('survives an empty form', () => {
    expect(filtersToDraft(draftToFilters(EMPTY_DRAFT))).toEqual(EMPTY_DRAFT)
  })

  it('is stable: converting twice changes nothing further', () => {
    // A permalink is opened, edited and re-shared. A conversion that drifted by
    // a day each round would be invisible until someone compared two links.
    const once = draftToFilters(FULL)
    const twice = draftToFilters(filtersToDraft(once))
    expect(twice).toEqual(once)
  })
})

describe('draftToFilters', () => {
  it('omits empty fields rather than sending them empty', () => {
    expect(draftToFilters(EMPTY_DRAFT)).toEqual({ state: 'published' })
  })

  it('splits comma-separated names and drops the blanks', () => {
    const filters = draftToFilters({ ...EMPTY_DRAFT, vendor: ' cisco , , juniper ' })
    expect(filters.vendor).toEqual(['cisco', 'juniper'])
  })

  it('reads dates as UTC, with the `to` edge covering its whole day', () => {
    const filters = draftToFilters({
      ...EMPTY_DRAFT,
      publishedFrom: '2024-03-01',
      publishedTo: '2024-03-01',
    })
    expect(filters.publishedFrom).toBe(Date.parse('2024-03-01T00:00:00Z') / 1000)
    // The last second of the same day: a one-day range has to include the day.
    expect(filters.publishedTo).toBe(Date.parse('2024-03-01T23:59:59Z') / 1000)
  })

  it('ignores a date box that is not a date', () => {
    expect(draftToFilters({ ...EMPTY_DRAFT, publishedFrom: '2024' }).publishedFrom).toBeUndefined()
  })

  it('carries the record-state choice through unchanged (D-022)', () => {
    expect(draftToFilters({ ...EMPTY_DRAFT, state: 'all' }).state).toBe('all')
    expect(draftToFilters({ ...EMPTY_DRAFT, state: 'rejected' }).state).toBe('rejected')
  })
})

describe('filtersToDraft', () => {
  it('fills a form from a definition a permalink carried', () => {
    const filters: Filters = { state: 'published', vendor: ['cisco'], severity: [4], scoreMin: 9 }
    const draft = filtersToDraft(filters)
    expect(draft.vendor).toBe('cisco')
    expect(draft.severity).toEqual([4])
    expect(draft.scoreMin).toBe('9')
  })

  it('defaults an absent state to PUBLISHED rather than leaving the radio unset', () => {
    expect(filtersToDraft({}).state).toBe('published')
  })

  it('does not share arrays with the module’s empty draft', () => {
    // Mutating a module constant once leaves every future form pre-filled.
    const draft = filtersToDraft({ severity: [1] })
    draft.severity.push(2)
    expect(EMPTY_DRAFT.severity).toEqual([])
  })
})

describe('describeDraft', () => {
  it('always states the record-state default, and marks it as one (D-022)', () => {
    // The single filter that changes every number on screen. A default that is
    // implied is a default nobody checks.
    const chips = describeDraft(EMPTY_DRAFT)
    expect(chips[0]!.key).toBe('state')
    expect(chips[0]!.label).toMatch(/PUBLISHED records only/)
    expect(chips[0]!.standing).toBe(true)
  })

  it('marks a deliberate widening as a choice, not a default', () => {
    const chips = describeDraft({ ...EMPTY_DRAFT, state: 'all' })
    expect(chips[0]!.standing).toBeFalsy()
    expect(chips[0]!.label).toMatch(/REJECTED included/)
  })

  it('names every filter that is set, and nothing that is not', () => {
    const chips = describeDraft(FULL)
    const keys = chips.map((chip) => chip.key)
    expect(keys).toContain('vendor')
    expect(keys).toContain('severity')
    expect(keys).toContain('published')
    expect(keys).toContain('score')
    expect(describeDraft(EMPTY_DRAFT)).toHaveLength(1)
  })

  it('shows severity by name rather than by stored code', () => {
    const chips = describeDraft({ ...EMPTY_DRAFT, severity: [4] })
    expect(chips.find((chip) => chip.key === 'severity')!.label).toContain('CRITICAL')
  })

  it('describes a half-open range as half-open', () => {
    const from = describeDraft({ ...EMPTY_DRAFT, scoreMin: '9' })
    expect(from.find((chip) => chip.key === 'score')!.label).toBe('CVSS score from 9')
    const to = describeDraft({ ...EMPTY_DRAFT, scoreMax: '3' })
    expect(to.find((chip) => chip.key === 'score')!.label).toBe('CVSS score to 3')
  })
})

describe('clearChip', () => {
  it('clears both ends of a range together', () => {
    const draft: Draft = { ...EMPTY_DRAFT, scoreMin: '7', scoreMax: '10' }
    const chip = describeDraft(draft).find((entry) => entry.key === 'score')!
    const cleared = clearChip(draft, chip)
    expect(cleared.scoreMin).toBe('')
    expect(cleared.scoreMax).toBe('')
  })

  it('clears a list axis to an empty list, not to the shared constant', () => {
    const draft: Draft = { ...EMPTY_DRAFT, severity: [1, 2] }
    const chip = describeDraft(draft).find((entry) => entry.key === 'severity')!
    const cleared = clearChip(draft, chip)
    expect(cleared.severity).toEqual([])
    expect(cleared.severity).not.toBe(EMPTY_DRAFT.severity)
  })

  it('leaves every other axis alone', () => {
    const draft: Draft = { ...EMPTY_DRAFT, vendor: 'cisco', cwe: 'CWE-79' }
    const chip = describeDraft(draft).find((entry) => entry.key === 'vendor')!
    const cleared = clearChip(draft, chip)
    expect(cleared.vendor).toBe('')
    expect(cleared.cwe).toBe('CWE-79')
  })
})
