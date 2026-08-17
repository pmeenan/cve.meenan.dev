/**
 * Calendar arithmetic for the date range control (M9).
 *
 * Everything here is **UTC and string-first**. `Draft` holds `yyyy-mm-dd`
 * strings and the corpus holds UTC timestamps (lib/draft.ts), so a picker that
 * reasoned in local time would move every boundary by the reader's offset and
 * drop a day's records at each end — the same trap `draft.ts` documents, one
 * layer up. A `Date` is used only as an arithmetic engine, always through
 * `Date.UTC`, and never allowed to reach the UI as a value.
 *
 * It is a separate module from the component because this is where the
 * interesting failures live — the input parser, the month grid, the clamp
 * against the dataset's own extent — and none of them need a browser to test.
 */

import type { Coverage } from './protocol'

/** A calendar day as `yyyy-mm-dd`: what every date field in the app holds. */
export type Day = string

/** The dataset's extent on one axis, as the two days it spans. */
export interface DayBounds {
  min: Day
  max: Day
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

/** Sunday-first, matching the calendars this corpus's readers live in. */
export const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const
export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

export function isDay(value: string): value is Day {
  if (!DAY_PATTERN.test(value)) return false
  const [year, month, day] = parts(value)
  // `Date.UTC` rolls 2025-02-31 forward to March rather than refusing it, so
  // the round trip is the validity check: a day that survives formatting
  // unchanged is a day that exists.
  return format(year, month, day) === value
}

/** The year, month (1-12) and day of a `yyyy-mm-dd`, unvalidated. */
function parts(day: Day): [number, number, number] {
  return [Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10))]
}

export function dayYear(day: Day): number {
  return parts(day)[0]
}

export function dayMonth(day: Day): number {
  return parts(day)[1]
}

/** A y/m/d as the day it names, normalizing overflow the way `Date.UTC` does. */
export function format(year: number, month: number, day: number): Day {
  const at = new Date(Date.UTC(year, month - 1, day))
  // `setUTCFullYear` is the documented escape from the 0-99 window: `Date.UTC`
  // maps year 27 onto 1927, which would silently rewrite a hand-typed year.
  if (year >= 0 && year < 100) at.setUTCFullYear(year)
  return at.toISOString().slice(0, 10)
}

/** Unix seconds at UTC midnight of a day. */
export function daySeconds(day: Day): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000)
}

/** Unix seconds as the day they fall in, UTC. Empty for a value that is not one. */
export function secondsToDay(seconds: number | null | undefined): Day | '' {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return ''
  const at = new Date(seconds * 1000)
  return Number.isNaN(at.getTime()) ? '' : at.toISOString().slice(0, 10)
}

export function addDays(day: Day, count: number): Day {
  const [year, month, date] = parts(day)
  return format(year, month, date + count)
}

/**
 * Add months, clamping the day of the month rather than rolling it forward.
 *
 * January 31 plus one month is February 28, not March 3. The rolling version
 * is what makes a "previous month" arrow skip February entirely when the
 * cursor happens to sit on the 31st.
 */
export function addMonths(day: Day, count: number): Day {
  const [year, month, date] = parts(day)
  const target = month - 1 + count
  const targetYear = year + Math.floor(target / 12)
  const targetMonth = ((target % 12) + 12) % 12
  const last = daysInMonth(targetYear, targetMonth + 1)
  return format(targetYear, targetMonth + 1, Math.min(date, last))
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export function startOfMonth(day: Day): Day {
  const [year, month] = parts(day)
  return format(year, month, 1)
}

export function endOfMonth(day: Day): Day {
  const [year, month] = parts(day)
  return format(year, month, daysInMonth(year, month))
}

/** Chronological order, which for `yyyy-mm-dd` is also lexical order. */
export function compareDay(a: Day, b: Day): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function clampDay(day: Day, bounds: DayBounds | null): Day {
  if (!bounds) return day
  if (compareDay(day, bounds.min) < 0) return bounds.min
  if (compareDay(day, bounds.max) > 0) return bounds.max
  return day
}

export function withinBounds(day: Day, bounds: DayBounds | null): boolean {
  return !bounds || (compareDay(day, bounds.min) >= 0 && compareDay(day, bounds.max) <= 0)
}

/**
 * The six-week grid a month is drawn on, Sunday-first.
 *
 * Always six rows, always full: a grid that changes height as you page through
 * months makes the calendar jump under the pointer, and the leading and
 * trailing days belong to the neighbouring months rather than being blanks, so
 * a range that spans a month boundary reads as continuous.
 */
export function monthGrid(year: number, month: number): { day: Day; inMonth: boolean }[][] {
  const first = format(year, month, 1)
  const lead = new Date(`${first}T00:00:00Z`).getUTCDay()
  const start = addDays(first, -lead)
  const weeks: { day: Day; inMonth: boolean }[][] = []
  for (let week = 0; week < 6; week += 1) {
    const row: { day: Day; inMonth: boolean }[] = []
    for (let index = 0; index < 7; index += 1) {
      const day = addDays(start, week * 7 + index)
      row.push({ day, inMonth: dayYear(day) === year && dayMonth(day) === month })
    }
    weeks.push(row)
  }
  return weeks
}

/** `2025-03-04` as "Tuesday, 4 March 2025" — what a screen reader should hear. */
export function formatDayLong(day: Day): string {
  const [year, month, date] = parts(day)
  const weekday = WEEKDAY_NAMES[new Date(`${day}T00:00:00Z`).getUTCDay()] ?? ''
  return `${weekday}, ${date} ${MONTH_NAMES[month - 1]} ${year}`
}

export function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1]} ${year}`
}

/**
 * What someone typed, as a day — or null if it is not one yet.
 *
 * This is the fix for the defect that made the native control unusable: a
 * controlled `<input type="date">` fires `change` for every *segment*, so
 * typing `2025` into the year of an otherwise-complete date commits the year
 * `0002` on the first keystroke, React re-renders the box with it, and the
 * remaining `025` lands somewhere else entirely. A text field that commits
 * only when the whole string parses cannot do that.
 *
 * The parser is deliberately generous in the directions people actually type,
 * and refuses everything else rather than guessing:
 *
 *   - `2025`            — the whole year: Jan 1 on a `from`, Dec 31 on a `to`
 *   - `2025-03`         — the whole month, same edge rule
 *   - `2025-03-04`      — the day, with `-`, `/` or `.` as the separator
 *   - `20250304`        — the same day, compact
 *
 * The `edge` is what makes a year or a month useful shorthand: "2025" in the
 * left box and "2025" in the right box together mean the whole of 2025, which
 * is the range a reader typing two years is asking for.
 */
export function parseDayInput(raw: string, edge: 'from' | 'to'): Day | null {
  const text = raw.trim()
  if (!text) return null

  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text)
  if (compact) return exact(Number(compact[1]), Number(compact[2]), Number(compact[3]))

  const pieces = text.split(/[-/.]/).map((piece) => piece.trim())
  if (pieces.some((piece) => !/^\d{1,4}$/.test(piece))) return null

  const year = Number(pieces[0])
  if (!pieces[0] || pieces[0].length !== 4 || !Number.isFinite(year)) return null

  if (pieces.length === 1) return edge === 'from' ? format(year, 1, 1) : format(year, 12, 31)

  const month = Number(pieces[1])
  if (!Number.isFinite(month) || month < 1 || month > 12) return null

  if (pieces.length === 2) {
    return edge === 'from' ? format(year, month, 1) : format(year, month, daysInMonth(year, month))
  }
  if (pieces.length !== 3) return null
  return exact(year, month, Number(pieces[2]))
}

function exact(year: number, month: number, day: number): Day | null {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null
  return format(year, month, day)
}

/** One offered shortcut. `from`/`to` empty means "unbounded on that edge". */
export interface DatePreset {
  key: string
  label: string
  from: Day | ''
  to: Day | ''
}

/**
 * The shortcuts offered beside the calendar.
 *
 * Ordered by how often they are the answer, and **filtered against the
 * dataset's own extent**: on a copy whose records start this year, offering
 * "2024" is offering a range that can only produce an empty chart. A preset
 * that would land entirely outside the data is dropped rather than shown
 * disabled — there is no useful thing to say about it.
 *
 * "All time" is first and always present, because it is the state the workspace
 * opens in and the way back to it.
 */
export function datePresets(bounds: DayBounds | null, today: Day): DatePreset[] {
  const presets: DatePreset[] = [{ key: 'all', label: 'All time', from: '', to: '' }]
  const year = dayYear(today)
  const candidates: DatePreset[] = [
    { key: '30d', label: 'Last 30 days', from: addDays(today, -29), to: today },
    { key: '90d', label: 'Last 90 days', from: addDays(today, -89), to: today },
    { key: '12m', label: 'Last 12 months', from: addDays(addMonths(today, -12), 1), to: today },
    { key: '24m', label: 'Last 24 months', from: addDays(addMonths(today, -24), 1), to: today },
    { key: 'ytd', label: 'Year to date', from: format(year, 1, 1), to: today },
    {
      key: 'prev-year',
      label: String(year - 1),
      from: format(year - 1, 1, 1),
      to: format(year - 1, 12, 31),
    },
  ]
  for (const preset of candidates) {
    if (!overlaps(preset, bounds)) continue
    presets.push({
      key: preset.key,
      label: preset.label,
      // Clamped, so a preset never sets a boundary outside the data — the
      // calendar refuses those days, and a preset that could reach them would
      // be the one way to produce a range the picker cannot then show.
      from: preset.from ? clampDay(preset.from, bounds) : '',
      to: preset.to ? clampDay(preset.to, bounds) : '',
    })
  }
  return presets
}

/**
 * The Monday on or before a day. Weekly buckets are labelled by their Monday
 * (`WEEK_EXPR`, lib/filters.ts), so a window that opens on one opens on a
 * whole week rather than a stub that would read as a dip at the left edge.
 */
export function weekStart(day: Day): Day {
  // getUTCDay() is 0 for Sunday, so a Sunday steps back six.
  return addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7))
}

/**
 * The lower edge of a "last N years" window: `years` back from `today`, then
 * back to the Monday of that week — the arithmetic the opening report and the
 * canvas's quick ranges share, so "2 years" reads pressed on the report the
 * workspace opens with.
 */
export function yearsBack(today: Day, years: number): Day {
  const [year, month, date] = parts(today)
  return weekStart(format(year - years, month, date))
}

/**
 * The quick ranges over the chart (UI polish, 2026-08-16): a relative window
 * from a lower edge only. The upper edge is left *unset* on purpose — it
 * displays the copy's last day and filters nothing — because "the last two
 * years" is a question about the data's head, not about the day it was
 * asked, and writing today into the range would pin every permalink to it.
 *
 * Unlike the calendar's shortcuts these are **not clamped** into the copy:
 * they are relative to today, not to the data, so a permalink for "10 yr"
 * means the same on the one-year development slice as on the corpus, and a
 * lower edge before the first record filters nothing. The opening report
 * (`defaultReport`) is built the same way, which is what lets "2 yr" read
 * pressed on it before the copy's extent is even known.
 */
export const QUICK_RANGES: readonly { key: string; label: string; years: number | 'ytd' | null }[] =
  [
    { key: 'all', label: 'All time', years: null },
    { key: '10y', label: '10 yr', years: 10 },
    { key: '5y', label: '5 yr', years: 5 },
    { key: '2y', label: '2 yr', years: 2 },
    { key: '1y', label: '1 yr', years: 1 },
    { key: 'ytd', label: 'YTD', years: 'ytd' },
  ]

export function quickRanges(today: Day): DatePreset[] {
  return QUICK_RANGES.map(({ key, label, years }) => ({
    key,
    label,
    from:
      years === null
        ? ''
        : years === 'ytd'
          ? format(dayYear(today), 1, 1)
          : yearsBack(today, years),
    to: '',
  }))
}

/** A time grain the canvas offers, finest first. */
export type Grain = 'week' | 'month' | 'year'
export const GRAINS: readonly Grain[] = ['week', 'month', 'year']

/** How many buckets of a grain a window spans, both ends inclusive. */
export function bucketsBetween(grain: Grain, from: Day, to: Day): number {
  if (compareDay(from, to) > 0) return 0
  const [fromYear, fromMonth] = parts(from)
  const [toYear, toMonth] = parts(to)
  if (grain === 'year') return toYear - fromYear + 1
  if (grain === 'month') return (toYear - fromYear) * 12 + (toMonth - fromMonth) + 1
  return Math.round((daySeconds(weekStart(to)) - daySeconds(weekStart(from))) / 604_800) + 1
}

/**
 * The finest grain, no finer than `grain`, whose buckets over a window fit
 * under `cap`. The canvas coarsens rather than truncates: a time axis over its
 * cap is cut at the *old* end (`crossSql` keeps the recent buckets), so
 * "all time" by week would silently be the last eight years — and 1,400 bars
 * are not a chart anyway. Never refines: a reader who chose Yearly keeps it.
 */
export function fitGrain(grain: Grain, from: Day, to: Day, cap: number): Grain {
  let at = GRAINS.indexOf(grain)
  while (at < GRAINS.length - 1 && bucketsBetween(GRAINS[at]!, from, to) > cap) at++
  return GRAINS[at]!
}

function overlaps(preset: DatePreset, bounds: DayBounds | null): boolean {
  if (!bounds) return true
  if (preset.from && compareDay(preset.from, bounds.max) > 0) return false
  if (preset.to && compareDay(preset.to, bounds.min) < 0) return false
  return true
}

/** The date axes a range control is offered for. */
export type DateAxis = 'published' | 'updated' | 'kevAdded' | 'kevDue'

/**
 * One axis of a `Coverage` as the two days it spans, or null when the copy has
 * nothing to say about it — an unmeasured axis, or a KEV axis on a copy with no
 * catalog. Null means "unbounded", which is where every date control was before
 * coverage existed, so an unknown extent degrades to the old behaviour rather
 * than to an empty calendar.
 */
export function axisBounds(coverage: Coverage | null, axis: DateAxis): DayBounds | null {
  if (!coverage) return null
  const min = secondsToDay(coverage[`${axis}Min`])
  const max = secondsToDay(coverage[`${axis}Max`])
  if (!min || !max || compareDay(min, max) > 0) return null
  return { min, max }
}

/** The identifier years the copy holds, for the year selects (D-044's rename). */
export function yearBounds(coverage: Coverage | null): { min: number; max: number } | null {
  if (!coverage) return null
  const { yearMin, yearMax } = coverage
  if (typeof yearMin !== 'number' || typeof yearMax !== 'number' || yearMin > yearMax) return null
  return { min: yearMin, max: yearMax }
}

/** Which preset a range is currently equal to, so the rail can show it pressed. */
export function matchPreset(presets: DatePreset[], from: string, to: string): string | null {
  return presets.find((preset) => preset.from === from && preset.to === to)?.key ?? null
}
