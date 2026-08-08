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
  absenceLabel,
  CODE_LABELS,
  CVSS_VERSIONS,
  DIMENSION_LABELS,
  KEV_CODES,
  KEV_RANSOMWARE_CODES,
  LOOKUP_AXES,
  NOT_ASSESSED,
  SEVERITIES,
  SSVC_AUTO,
  SSVC_EXPL,
  SSVC_IMPACT,
  type Dimension,
  type Filters,
  type LookupAxis,
  type SortKey,
  type StateFilter,
} from './filters'

/**
 * The code axes the form offers as checkbox groups, each with its canonical
 * order and whether "not assessed" is one of the boxes.
 *
 * One list rather than a branch per axis, so adding an axis cannot leave it
 * with a form control and no chip, or a chip and no round trip — the failure
 * that would make a permalink silently drop a filter (M4's round-trip property).
 */
export const CODE_AXES = [
  { field: 'severity', codes: SEVERITIES, absence: false },
  { field: 'cvssVersion', codes: CVSS_VERSIONS, absence: false },
  // The SSVC axes offer "not assessed" as a box, because half the corpus is in
  // that state and `IN (…)` cannot express it (D-070, `NOT_ASSESSED`).
  { field: 'ssvcExpl', codes: SSVC_EXPL, absence: true },
  { field: 'ssvcAuto', codes: SSVC_AUTO, absence: true },
  { field: 'ssvcImpact', codes: SSVC_IMPACT, absence: true },
  // KEV membership has **no** "not assessed" box: absence from the catalog is
  // itself one of the two codes — *not known-exploited, per CISA* — rather than
  // a missing assessment (D-076). Ransomware use does have one, for a listed
  // record whose value this build does not recognise.
  { field: 'kev', codes: KEV_CODES, absence: false },
  { field: 'kevRansomware', codes: KEV_RANSOMWARE_CODES, absence: true },
] as const satisfies readonly {
  field: keyof Draft & Dimension
  codes: readonly number[]
  absence: boolean
}[]

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
  /** SSVC codes, with `NOT_ASSESSED` for the records nobody assessed (D-070). */
  ssvcExpl: number[]
  ssvcAuto: number[]
  ssvcImpact: number[]
  /** KEV membership and ransomware use (M6). */
  kev: number[]
  kevRansomware: number[]
  scoreMin: string
  scoreMax: string
  publishedFrom: string
  publishedTo: string
  updatedFrom: string
  updatedTo: string
  yearFrom: string
  yearTo: string
  /** The catalog's own dates, as calendar days like the corpus ones. */
  kevAddedFrom: string
  kevAddedTo: string
  kevDueFrom: string
  kevDueTo: string
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
  ssvcExpl: [],
  ssvcAuto: [],
  ssvcImpact: [],
  kev: [],
  kevRansomware: [],
  scoreMin: '',
  scoreMax: '',
  publishedFrom: '',
  publishedTo: '',
  updatedFrom: '',
  updatedTo: '',
  yearFrom: '',
  yearTo: '',
  kevAddedFrom: '',
  kevAddedTo: '',
  kevDueFrom: '',
  kevDueTo: '',
  state: 'published',
}

/** Seconds added to a `to` date so the boundary includes the whole day, in UTC. */
const DAY_END = 86_399

const SCALARS = ['scoreMin', 'scoreMax', 'yearFrom', 'yearTo'] as const
const DATES = [
  'publishedFrom',
  'publishedTo',
  'updatedFrom',
  'updatedTo',
  'kevAddedFrom',
  'kevAddedTo',
  'kevDueFrom',
  'kevDueTo',
] as const

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
  for (const axis of CODE_AXES) {
    const selected = draft[axis.field]
    // "Not assessed" sorts last, like the band it selects sits last on an axis.
    if (selected.length) filters[axis.field] = order(selected, [...axis.codes, NOT_ASSESSED])
  }
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
  for (const axis of CODE_AXES) draft[axis.field] = [...(filters[axis.field] ?? [])]
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
export function describeDraft(draft: Draft): Chip[] {
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
  for (const axis of CODE_AXES) {
    const selected = draft[axis.field]
    if (!selected.length) continue
    chips.push({
      key: axis.field,
      label: `${DIMENSION_LABELS[axis.field]}: ${selected.map((code) => codeLabel(axis.field, code)).join(', ')}`,
      clears: [axis.field],
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
  pushRange(chips, 'kevAdded', 'Added to KEV', draft.kevAddedFrom, draft.kevAddedTo, [
    'kevAddedFrom',
    'kevAddedTo',
  ])
  pushRange(chips, 'kevDue', 'KEV due date', draft.kevDueFrom, draft.kevDueTo, [
    'kevDueFrom',
    'kevDueTo',
  ])
  return chips
}

/**
 * A selected code as a word, with the sentinel naming the absence it selects.
 *
 * Exported because the filter form renders the same labels on its checkboxes,
 * and the two drifting apart is how one band ends up with two names — which is
 * how a reader concludes they are two bands.
 */
export function codeLabel(axis: Dimension, code: number): string {
  if (code === NOT_ASSESSED) return absenceLabel(axis)
  return CODE_LABELS[axis]?.[code] ?? String(code)
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
