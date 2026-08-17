import { describe, expect, it } from 'vitest'

import {
  addDays,
  addMonths,
  axisBounds,
  bucketsBetween,
  clampDay,
  datePresets,
  endOfMonth,
  fitGrain,
  format,
  formatDayLong,
  isDay,
  matchPreset,
  monthGrid,
  parseDayInput,
  quickRanges,
  secondsToDay,
  startOfMonth,
  weekStart,
  withinBounds,
  yearBounds,
  yearsBack,
} from '../../lib/dates'
import { defaultReport } from '../../lib/report'
import type { Coverage } from '../../lib/protocol'

/**
 * The date range control's arithmetic (M9).
 *
 * Two failures this file exists to stop coming back.
 *
 * **The typed year.** The native control committed `0002` the moment someone
 * typed the `2` of `2025`, because a controlled `<input type="date">` fires a
 * change per *segment*. The replacement commits only whole strings, so the
 * parser is the thing that has to be right — including refusing partial input
 * rather than guessing at it.
 *
 * **The zone.** Every boundary in this app is UTC (lib/draft.ts): a picker that
 * did its arithmetic in local time would move each edge by the reader's offset
 * and drop a day's records at each end. Nothing here may go through a local
 * `Date` accessor, which is what the vitest `TZ` below actually tests — the
 * suite runs under a non-UTC zone so a local-time slip fails instead of
 * passing everywhere the author happens to live.
 */

describe('day arithmetic is UTC and string-first', () => {
  it('rejects days that do not exist rather than rolling them forward', () => {
    expect(isDay('2025-03-04')).toBe(true)
    expect(isDay('2024-02-29')).toBe(true)
    // 2025 is not a leap year: `Date.UTC` would call this 1 March.
    expect(isDay('2025-02-29')).toBe(false)
    expect(isDay('2025-13-01')).toBe(false)
    expect(isDay('2025-3-4')).toBe(false)
    expect(isDay('')).toBe(false)
  })

  it('adds days and months without drifting across a DST boundary', () => {
    // Northern-hemisphere DST changes fall in these windows; a local-time
    // implementation loses or gains an hour here and lands on the wrong day.
    expect(addDays('2025-03-08', 1)).toBe('2025-03-09')
    expect(addDays('2025-11-01', 1)).toBe('2025-11-02')
    expect(addDays('2025-01-01', -1)).toBe('2024-12-31')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
  })

  it('clamps the day of the month rather than rolling it forward', () => {
    // The bug this prevents: a "previous month" arrow that skips February
    // whenever the cursor happens to sit on the 31st.
    expect(addMonths('2025-01-31', 1)).toBe('2025-02-28')
    expect(addMonths('2025-03-31', -1)).toBe('2025-02-28')
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29')
    expect(addMonths('2025-06-15', 7)).toBe('2026-01-15')
    expect(addMonths('2025-06-15', -18)).toBe('2023-12-15')
  })

  it('formats and bounds months', () => {
    expect(startOfMonth('2025-08-16')).toBe('2025-08-01')
    expect(endOfMonth('2025-02-10')).toBe('2025-02-28')
    expect(endOfMonth('2024-02-10')).toBe('2024-02-29')
    expect(format(2025, 12, 31)).toBe('2025-12-31')
  })

  it('reads unix seconds as the UTC day they fall in', () => {
    expect(secondsToDay(Date.parse('2026-08-16T23:30:00Z') / 1000)).toBe('2026-08-16')
    expect(secondsToDay(Date.parse('2026-08-16T00:30:00Z') / 1000)).toBe('2026-08-16')
    expect(secondsToDay(null)).toBe('')
    expect(secondsToDay(Number.NaN)).toBe('')
  })

  it('describes a day in words, for the calendar cell a screen reader reads', () => {
    expect(formatDayLong('2026-08-16')).toBe('Sunday, 16 August 2026')
  })
})

describe('the month grid', () => {
  it('is always six full weeks, Sunday first, with the neighbours marked', () => {
    const weeks = monthGrid(2026, 8)
    expect(weeks).toHaveLength(6)
    for (const week of weeks) expect(week).toHaveLength(7)
    // 1 August 2026 is a Saturday, so the first row is 26–31 July then the 1st.
    expect(weeks[0]![0]!.day).toBe('2026-07-26')
    expect(weeks[0]![0]!.inMonth).toBe(false)
    expect(weeks[0]![6]!.day).toBe('2026-08-01')
    expect(weeks[0]![6]!.inMonth).toBe(true)
    const inMonth = weeks.flat().filter((cell) => cell.inMonth)
    expect(inMonth).toHaveLength(31)
  })

  it('holds six weeks even for a February that fits in four', () => {
    // February 2027 starts on a Monday and has 28 days — exactly four weeks
    // plus a lead day. A grid that shrank here would make the calendar jump
    // under the pointer as months change.
    const weeks = monthGrid(2027, 2)
    expect(weeks).toHaveLength(6)
    expect(weeks.flat().filter((cell) => cell.inMonth)).toHaveLength(28)
  })
})

describe('typing a date', () => {
  it('takes a whole day in the forms people type it', () => {
    expect(parseDayInput('2025-03-04', 'from')).toBe('2025-03-04')
    expect(parseDayInput('2025/03/04', 'from')).toBe('2025-03-04')
    expect(parseDayInput('2025.3.4', 'from')).toBe('2025-03-04')
    expect(parseDayInput('20250304', 'from')).toBe('2025-03-04')
    expect(parseDayInput('  2025-03-04  ', 'from')).toBe('2025-03-04')
  })

  it('reads a bare year or month as the whole of it, per edge', () => {
    // The observation that started this: typing "2025" for a year. It now
    // means the year — the start of it on the left, the end of it on the
    // right — instead of the year 2 with three keystrokes thrown away.
    expect(parseDayInput('2025', 'from')).toBe('2025-01-01')
    expect(parseDayInput('2025', 'to')).toBe('2025-12-31')
    expect(parseDayInput('2025-02', 'from')).toBe('2025-02-01')
    expect(parseDayInput('2025-02', 'to')).toBe('2025-02-28')
    expect(parseDayInput('2024-02', 'to')).toBe('2024-02-29')
  })

  it('refuses partial and impossible input instead of guessing', () => {
    // Each of these is a keystroke on the way to something valid. Committing
    // any of them is the defect: the box would rewrite itself mid-word.
    for (const partial of ['2', '20', '202', '2025-', '2025-0', '2025-03-']) {
      expect(parseDayInput(partial, 'from'), partial).toBeNull()
    }
    expect(parseDayInput('2025-13-01', 'from')).toBeNull()
    expect(parseDayInput('2025-02-30', 'from')).toBeNull()
    expect(parseDayInput('last tuesday', 'from')).toBeNull()
    expect(parseDayInput('', 'from')).toBeNull()
  })
})

describe('bounds from the copy that is answering', () => {
  const bounds = { min: '1999-01-01', max: '2026-08-16' }

  it('clamps a day into the data and reports what is outside it', () => {
    expect(clampDay('1970-01-01', bounds)).toBe('1999-01-01')
    expect(clampDay('2030-01-01', bounds)).toBe('2026-08-16')
    expect(clampDay('2020-06-01', bounds)).toBe('2020-06-01')
    expect(withinBounds('1998-12-31', bounds)).toBe(false)
    expect(withinBounds('1999-01-01', bounds)).toBe(true)
    // No bounds means no clamping: an unknown extent has to degrade to the
    // behaviour the control had before coverage existed, not to a dead calendar.
    expect(clampDay('1970-01-01', null)).toBe('1970-01-01')
    expect(withinBounds('1970-01-01', null)).toBe(true)
  })

  it('turns a coverage message into per-axis bounds', () => {
    const coverage: Coverage = {
      publishedMin: Date.parse('1999-09-29T00:00:00Z') / 1000,
      publishedMax: Date.parse('2026-08-15T18:00:00Z') / 1000,
      updatedMin: null,
      updatedMax: null,
      yearMin: 1999,
      yearMax: 2026,
      kevAddedMin: Date.parse('2021-11-03T00:00:00Z') / 1000,
      kevAddedMax: Date.parse('2026-08-11T00:00:00Z') / 1000,
      kevDueMin: null,
      kevDueMax: null,
    }
    expect(axisBounds(coverage, 'published')).toEqual({
      min: '1999-09-29',
      max: '2026-08-15',
    })
    expect(axisBounds(coverage, 'kevAdded')).toEqual({
      min: '2021-11-03',
      max: '2026-08-11',
    })
    // A copy with no KEV catalog reports nulls, and an axis with nulls is
    // unbounded rather than empty — the control still works, it just offers
    // the whole calendar (D-077's rule, one layer up).
    expect(axisBounds(coverage, 'updated')).toBeNull()
    expect(axisBounds(coverage, 'kevDue')).toBeNull()
    expect(axisBounds(null, 'published')).toBeNull()
    expect(yearBounds(coverage)).toEqual({ min: 1999, max: 2026 })
    expect(yearBounds(null)).toBeNull()
  })
})

describe('the shortcut rail', () => {
  const wide = { min: '1999-01-01', max: '2026-08-16' }

  it('offers the ranges people ask for, ending today', () => {
    const presets = datePresets(wide, '2026-08-16')
    expect(presets[0]).toEqual({ key: 'all', label: 'All time', from: '', to: '' })
    const byKey = Object.fromEntries(presets.map((preset) => [preset.key, preset]))
    expect(byKey['30d']).toEqual({
      key: '30d',
      label: 'Last 30 days',
      from: '2026-07-18',
      to: '2026-08-16',
    })
    expect(byKey['12m']?.from).toBe('2025-08-17')
    expect(byKey['ytd']?.from).toBe('2026-01-01')
    expect(byKey['prev-year']).toEqual({
      key: 'prev-year',
      label: '2025',
      from: '2025-01-01',
      to: '2025-12-31',
    })
  })

  it('drops and clamps shortcuts a narrow copy cannot answer', () => {
    // The development slice holds one year. "2025" over it can only produce an
    // empty chart, so it is not offered; the ranges that do overlap are
    // clamped into the data rather than reaching outside it.
    const narrow = { min: '2026-01-01', max: '2026-08-16' }
    const presets = datePresets(narrow, '2026-08-16')
    const keys = presets.map((preset) => preset.key)
    expect(keys).not.toContain('prev-year')
    expect(keys).toContain('30d')
    expect(presets.find((preset) => preset.key === '12m')?.from).toBe('2026-01-01')
  })

  it('names the shortcut a range is currently equal to', () => {
    const presets = datePresets(wide, '2026-08-16')
    expect(matchPreset(presets, '', '')).toBe('all')
    expect(matchPreset(presets, '2026-07-18', '2026-08-16')).toBe('30d')
    expect(matchPreset(presets, '2026-07-19', '2026-08-16')).toBeNull()
  })
})

describe('the quick ranges over the chart', () => {
  const wide = { min: '1999-01-01', max: '2026-08-16' }

  it('steps back N years and then to the Monday, so the first week is whole', () => {
    // 2026-08-16 is a Sunday; two years back is a Friday, whose week began on
    // Monday the 12th. A Monday stays put.
    expect(weekStart('2026-08-16')).toBe('2026-08-10')
    expect(weekStart('2026-08-10')).toBe('2026-08-10')
    expect(yearsBack('2026-08-16', 2)).toBe('2024-08-12')
    // Feb 29 minus a year lands on a day that exists (`format` rolls it
    // forward to March 1, which that year is itself a Monday).
    expect(yearsBack('2028-02-29', 1)).toBe('2027-03-01')
  })

  it('sets a lower edge only, relative to today and not to the copy', () => {
    const ranges = quickRanges('2026-08-16')
    expect(ranges.map((range) => range.key)).toEqual(['all', '10y', '5y', '2y', '1y', 'ytd'])
    const byKey = Object.fromEntries(ranges.map((range) => [range.key, range]))
    expect(byKey.all).toEqual({ key: 'all', label: 'All time', from: '', to: '' })
    expect(byKey['2y']).toEqual({ key: '2y', label: '2 yr', from: '2024-08-12', to: '' })
    expect(byKey['10y']?.from).toBe('2016-08-15')
    expect(byKey.ytd?.from).toBe('2026-01-01')
    // Every range leaves the upper edge unset: "the last two years" is a
    // question about the data's head, and today in a permalink would pin it.
    expect(ranges.every((range) => range.to === '')).toBe(true)
  })

  it('reads pressed on the report the workspace opens with', () => {
    // `defaultReport` and the "2 yr" button share `yearsBack`, so Reset and
    // the button land on the same window and the button shows it — on any
    // copy, because neither is clamped into one.
    const ranges = quickRanges('2026-08-16')
    const opening = defaultReport(Date.UTC(2026, 7, 16, 15, 0, 0)).filters.publishedFrom!
    expect(secondsToDay(opening)).toBe('2024-08-12')
    expect(matchPreset(ranges, secondsToDay(opening), '')).toBe('2y')
    expect(matchPreset(ranges, '', '')).toBe('all')
    // An upper edge that is set is a hand-made window, not a quick range.
    expect(matchPreset(ranges, '2024-08-12', '2026-08-16')).toBeNull()
  })

  it('coarsens a grain the window would overflow, and never refines one', () => {
    expect(bucketsBetween('year', '1999-01-01', '2026-08-16')).toBe(28)
    expect(bucketsBetween('month', '2024-08-12', '2026-08-16')).toBe(25)
    expect(bucketsBetween('week', '2024-08-12', '2026-08-16')).toBe(105)
    expect(bucketsBetween('week', '2026-08-16', '2026-08-16')).toBe(1)
    expect(bucketsBetween('week', '2026-08-17', '2026-08-16')).toBe(0)
    // Two years of weeks fits; all time by week does not, and by month does.
    expect(fitGrain('week', '2024-08-12', '2026-08-16', 400)).toBe('week')
    expect(fitGrain('week', '1999-01-01', '2026-08-16', 400)).toBe('month')
    // Nor would month over a window a cap of twelve cannot hold: year is the top.
    expect(fitGrain('week', '1999-01-01', '2026-08-16', 12)).toBe('year')
    expect(fitGrain('year', '2026-01-01', '2026-08-16', 400)).toBe('year')
  })
})
