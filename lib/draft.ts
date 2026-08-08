/**
 * The filter form's own state, and the two conversions around it (M4).
 *
 * A form holds strings — that is what an `<input>` gives you — and `Filters`
 * holds numbers, arrays and unix timestamps. M3 had one form, so the conversion
 * lived beside it. M4 has two surfaces over the same axes (Explore and Report)
 * plus a third path that arrives with a `Filters` already built and has to
 * *populate* a form from it: a permalink, a saved report, and from M7 a model's
 * tool call. So the conversion goes both ways and lives here, where it can be
 * tested as a round trip.
 *
 * The round trip is the property that matters. If `filtersToDraft` loses a
 * field, opening a permalink shows a form that does not describe the report it
 * just ran — and the next Run silently changes the answer.
 *
 * Dates are the part with a real trap. `<input type="date">` is a calendar day
 * with no zone, and the corpus stores UTC timestamps: reading the box as local
 * time moves every boundary by the reader's offset and quietly drops a day's
 * records at each end. Both directions here are UTC, and the `to` edge is the
 * last second of its day.
 */

import {
  CVSS_VERSIONS,
  LOOKUP_AXES,
  SEVERITIES,
  type Filters,
  type LookupAxis,
  type SortKey,
  type StateFilter,
} from './filters'

/** What the form holds before it becomes a `Filters`. All strings, because it is a form. */
export interface Draft {
  text: string
  cveId: string
  vendor: string
  product: string
  cna: string
  cwe: string
  host: string
  severity: number[]
  cvssVersion: number[]
  scoreMin: string
  scoreMax: string
  publishedFrom: string
  publishedTo: string
  updatedFrom: string
  updatedTo: string
  yearFrom: string
  yearTo: string
  state: StateFilter
}

export const EMPTY_DRAFT: Draft = {
  text: '',
  cveId: '',
  vendor: '',
  product: '',
  cna: '',
  cwe: '',
  host: '',
  severity: [],
  cvssVersion: [],
  scoreMin: '',
  scoreMax: '',
  publishedFrom: '',
  publishedTo: '',
  updatedFrom: '',
  updatedTo: '',
  yearFrom: '',
  yearTo: '',
  state: 'published',
}

/** Seconds added to a `to` date so the boundary includes the whole day, in UTC. */
const DAY_END = 86_399

const SCALARS = ['scoreMin', 'scoreMax', 'yearFrom', 'yearTo'] as const
const DATES = ['publishedFrom', 'publishedTo', 'updatedFrom', 'updatedTo'] as const

/** The form as a `Filters`. Empty fields are omitted, never sent as empty values. */
export function draftToFilters(draft: Draft): Filters {
  const filters: Filters = { state: draft.state }
  if (draft.text.trim()) filters.text = draft.text.trim()
  if (draft.cveId.trim()) filters.cveId = draft.cveId.trim()
  for (const axis of LOOKUP_AXES) {
    const names = splitNames(draft[axis])
    if (names.length) filters[axis] = names
  }
  // Canonicalized so two forms that hold the same axes produce the same
  // definition — a permalink and a saved report are compared by their encoding.
  // Ordered *semantically*, not numerically: 31 is v3.1 and 4 is v4.0, so
  // sorting the codes as magnitudes would list v4.0 first (D-047).
  if (draft.severity.length) filters.severity = order(draft.severity, SEVERITIES)
  if (draft.cvssVersion.length) filters.cvssVersion = order(draft.cvssVersion, CVSS_VERSIONS)
  for (const key of SCALARS) {
    const raw = draft[key]
    if (!raw.trim()) continue
    const value = Number(raw)
    if (Number.isFinite(value)) filters[key] = value
  }
  for (const key of DATES) {
    const at = parseDay(draft[key])
    if (at === null) continue
    filters[key] = key.endsWith('To') ? at + DAY_END : at
  }
  return filters
}

/**
 * A `Filters` as form state — the direction a permalink needs.
 *
 * A `to` boundary is converted back by *subtracting* the day's last second
 * before formatting, so a range the form produced comes back as the same two
 * calendar days rather than drifting a day later each time it is opened.
 */
export function filtersToDraft(filters: Filters): Draft {
  const draft: Draft = { ...EMPTY_DRAFT, state: filters.state ?? 'published' }
  if (filters.text) draft.text = filters.text
  if (filters.cveId) draft.cveId = filters.cveId
  for (const axis of LOOKUP_AXES) {
    const names = filters[axis]
    if (names?.length) draft[axis] = names.join(', ')
  }
  draft.severity = [...(filters.severity ?? [])]
  draft.cvssVersion = [...(filters.cvssVersion ?? [])]
  for (const key of SCALARS) {
    const value = filters[key]
    if (typeof value === 'number' && Number.isFinite(value)) draft[key] = String(value)
  }
  for (const key of DATES) {
    const value = filters[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    draft[key] = formatDay(key.endsWith('To') ? value - DAY_END : value)
  }
  return draft
}

/** Selected codes in the canonical order, deduplicated, unknown codes last. */
function order(values: number[], canonical: readonly number[]): number[] {
  const rank = (code: number) => {
    const at = canonical.indexOf(code)
    return at === -1 ? canonical.length : at
  }
  return [...new Set(values)].sort((a, b) => rank(a) - rank(b) || a - b)
}

export function splitNames(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

/** A `yyyy-mm-dd` box as unix seconds at UTC midnight, or null if it is not one. */
function parseDay(raw: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
  const at = Date.parse(`${raw}T00:00:00Z`)
  return Number.isNaN(at) ? null : Math.floor(at / 1000)
}

/** Unix seconds as the `yyyy-mm-dd` the box wants, in UTC. */
function formatDay(seconds: number): string {
  const at = new Date(seconds * 1000)
  return Number.isNaN(at.getTime()) ? '' : at.toISOString().slice(0, 10)
}

/**
 * One thing the current filters say, as a removable chip.
 *
 * `remove` names what to clear rather than carrying a mutation, so the chip row
 * stays a pure description of a `Filters` and the surface that owns the state
 * decides what clearing means.
 */
export interface Chip {
  key: string
  label: string
  /** The draft fields this chip covers, cleared together when it is dismissed. */
  clears: (keyof Draft)[]
  /**
   * A chip that describes a *default* rather than a choice. It is not
   * removable — clearing it would mean widening the corpus — and it is shown
   * anyway, because the one thing a report must never do is change its
   * denominator quietly (D-022).
   */
  standing?: boolean
}

/**
 * Describe a draft as chips.
 *
 * The record-state chip is always present. D-022's PUBLISHED-only default is
 * the single filter that changes every number on screen, and a default that is
 * *implied* is a default nobody checks — so it is stated in the same row as
 * everything the user chose, and states which of the three it is.
 */
export function describeDraft(
  draft: Draft,
  labels: { severity: Record<number, string>; cvssVersion: Record<number, string> }
): Chip[] {
  const chips: Chip[] = [
    {
      key: 'state',
      label:
        draft.state === 'published'
          ? 'PUBLISHED records only (default)'
          : draft.state === 'rejected'
            ? 'REJECTED records only'
            : 'All records, REJECTED included',
      clears: [],
      standing: draft.state === 'published',
    },
  ]
  if (draft.text.trim()) {
    chips.push({ key: 'text', label: `Description: ${draft.text.trim()}`, clears: ['text'] })
  }
  if (draft.cveId.trim()) {
    chips.push({ key: 'cveId', label: `ID: ${draft.cveId.trim()}`, clears: ['cveId'] })
  }
  const axisLabels: Record<LookupAxis, string> = {
    vendor: 'Vendor',
    product: 'Product',
    cna: 'CNA',
    cwe: 'CWE',
    host: 'Reference host',
  }
  for (const axis of LOOKUP_AXES) {
    const names = splitNames(draft[axis])
    if (names.length) {
      chips.push({ key: axis, label: `${axisLabels[axis]}: ${names.join(', ')}`, clears: [axis] })
    }
  }
  if (draft.severity.length) {
    chips.push({
      key: 'severity',
      label: `Severity: ${draft.severity.map((code) => labels.severity[code] ?? code).join(', ')}`,
      clears: ['severity'],
    })
  }
  if (draft.cvssVersion.length) {
    chips.push({
      key: 'cvssVersion',
      label: `CVSS: ${draft.cvssVersion.map((code) => labels.cvssVersion[code] ?? code).join(', ')}`,
      clears: ['cvssVersion'],
    })
  }
  pushRange(chips, 'score', 'CVSS score', draft.scoreMin, draft.scoreMax, ['scoreMin', 'scoreMax'])
  pushRange(chips, 'published', 'Published', draft.publishedFrom, draft.publishedTo, [
    'publishedFrom',
    'publishedTo',
  ])
  pushRange(chips, 'updated', 'Updated', draft.updatedFrom, draft.updatedTo, [
    'updatedFrom',
    'updatedTo',
  ])
  pushRange(chips, 'year', 'ID year', draft.yearFrom, draft.yearTo, ['yearFrom', 'yearTo'])
  return chips
}

function pushRange(
  chips: Chip[],
  key: string,
  name: string,
  from: string,
  to: string,
  clears: (keyof Draft)[]
): void {
  if (!from.trim() && !to.trim()) return
  const label =
    from.trim() && to.trim() ? `${from} to ${to}` : from.trim() ? `from ${from}` : `to ${to}`
  chips.push({ key, label: `${name} ${label}`, clears })
}

/** Clear the draft fields a chip covers. Values, not identity — `severity` is a list. */
export function clearChip(draft: Draft, chip: Chip): Draft {
  const next = { ...draft }
  for (const field of chip.clears) {
    const empty = EMPTY_DRAFT[field]
    // Arrays are copied rather than shared with EMPTY_DRAFT, which is a module
    // constant: mutating it once would leave every future form pre-filled.
    ;(next[field] as Draft[typeof field]) = Array.isArray(empty)
      ? ([...empty] as Draft[typeof field])
      : empty
  }
  return next
}

/** The record sort orders the UI offers, with the words it offers them in. */
export const SORT_LABELS: Record<SortKey, string> = {
  published: 'Published, newest first',
  updated: 'Updated, newest first',
  score: 'CVSS score, highest first',
  cve: 'CVE ID, descending',
}
