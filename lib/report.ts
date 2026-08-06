/**
 * The report definition — M4's shared primitive (D-044).
 *
 * One serializable object is built by the report UI, carried by a permalink,
 * stored by a saved report, and — from M7 — emitted by the chat layer. That is
 * three and a half consumers of one shape, which is why it is defined here
 * rather than falling out of whatever the builder happened to hold in state.
 *
 * Two properties follow from where these objects come from.
 *
 * **It is validated, never cast.** A definition arrives from a URL fragment
 * written by a stranger, from `localStorage` written by an older build, and
 * later from a model's tool call. `as Report` would let any of those decide
 * what SQL runs. `parseReport` returns a value or an error naming the field —
 * and refuses an unknown dimension rather than defaulting past it, because a
 * report that silently grouped by something other than what it says is the
 * quiet wrongness vision criterion 7 rules out.
 *
 * **It travels in the fragment, never the query string** (`toFragment`). A
 * report definition is made of predicates — a vendor, a search term, a date
 * range — and D-014 forbids the server to learn those, with D-032 keeping it
 * structurally unable to. A query string reaches nginx in the request line and
 * lands in its access log; a fragment is never sent. This is a privacy
 * property, not a URL-style preference.
 */

import {
  DIMENSIONS,
  LOOKUP_AXES,
  type Dimension,
  type Filters,
  type SortKey,
  type StateFilter,
} from './filters'

/**
 * The definition's own version.
 *
 * Bumped when a change would make an older definition mean something different
 * — not when a field is added that older definitions simply lack. A permalink
 * outlives the build that wrote it, so a definition this build cannot read has
 * to say so rather than render a report its author never saw.
 */
export const REPORT_VERSION = 1

export const CHART_TYPES = ['stackedBar', 'groupedBar', 'line', 'table'] as const
export type ChartType = (typeof CHART_TYPES)[number]

/** How many rows a chart shows before it stops being readable. */
export const CHART_ROWS = 12
/** The cap a table view asks for. Bounded again in `crossSql`. */
export const TABLE_ROWS = 250

export interface Report {
  v: number
  /** The user's own words. Never rendered as markup (rule 4 applies to it too). */
  title?: string
  filters: Filters
  /** The primary axis: bars, or the x-axis of a line chart. */
  rows: Dimension
  /** The split within each row. `null` is a plain one-dimension aggregate. */
  series: Dimension | null
  chart: ChartType
  /** Only meaningful for the record list, which a report reaches via `rows: null`. */
  sort?: SortKey
  /** Row buckets to ask for. Clamped by the query layer regardless. */
  limit?: number
}

/** A report with nothing chosen: the state the Report tab opens in. */
export function emptyReport(): Report {
  return {
    v: REPORT_VERSION,
    filters: { state: 'published' },
    rows: 'month',
    series: 'severity',
    chart: 'stackedBar',
    limit: CHART_ROWS,
  }
}

export type ParseResult = { ok: true; report: Report } | { ok: false; error: string }

/**
 * The longest fragment we will look at.
 *
 * A fragment is a stranger's input and decoding is the first thing that touches
 * it, so it is bounded before any of it is parsed. Generous next to a real
 * definition — a filter with a hundred vendor names is a few kilobytes — and
 * far below what would make JSON parsing itself the attack.
 */
export const MAX_FRAGMENT_BYTES = 16_384

/** How many values one lookup axis may carry, so a definition cannot become a scan. */
const MAX_AXIS_VALUES = 200
/** Bound on any single free-text field, matching nothing in particular but bounded. */
const MAX_TEXT = 512

/**
 * Validate an unknown value into a `Report`.
 *
 * Unknown fields are dropped rather than rejected: a definition written by a
 * newer build should still open here at the parts this one understands, which
 * is what makes adding a field a non-breaking change and a version bump a
 * deliberate one.
 */
export function parseReport(value: unknown): ParseResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'not a report object' }
  }
  const raw = value as Record<string, unknown>

  const v = raw.v
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    return { ok: false, error: 'missing or invalid report version' }
  }
  if (v > REPORT_VERSION) {
    return {
      ok: false,
      error:
        `This link was made by a newer version of the app (report format ${v}; ` +
        `this build reads ${REPORT_VERSION}). Reload the page to pick up the ` +
        `current version, then open the link again.`,
    }
  }

  const rows = raw.rows
  if (!isDimension(rows))
    return { ok: false, error: `not a dimension this build knows: ${label(rows)}` }

  const series = raw.series ?? null
  if (series !== null && !isDimension(series)) {
    return { ok: false, error: `not a dimension this build knows: ${label(series)}` }
  }
  // Both axes the same is not a cross-tab, it is a diagonal — every off-diagonal
  // cell empty by construction. Refused rather than rendered as a mostly-blank
  // chart the reader would have to diagnose.
  if (series !== null && series === rows) {
    return { ok: false, error: 'rows and series are the same dimension' }
  }

  const chart = raw.chart
  if (!isChartType(chart)) return { ok: false, error: `not a chart type: ${label(chart)}` }

  const filters = parseFilters(raw.filters)
  if (!filters.ok) return filters

  const report: Report = {
    v: REPORT_VERSION,
    filters: filters.filters,
    rows,
    series,
    chart,
  }
  if (typeof raw.title === 'string' && raw.title.trim()) {
    report.title = raw.title.trim().slice(0, MAX_TEXT)
  }
  if (isSortKey(raw.sort)) report.sort = raw.sort
  if (typeof raw.limit === 'number' && Number.isInteger(raw.limit) && raw.limit > 0) {
    report.limit = raw.limit
  }
  return { ok: true, report }
}

type FiltersResult = { ok: true; filters: Filters } | { ok: false; error: string }

/**
 * Validate the filter half.
 *
 * Everything here ends up as a bound parameter in `lib/filters.ts`, so this is
 * not the SQL-injection defence — that is structural and lives there. What this
 * is for is refusing shapes that would make a *runnable* query answer the wrong
 * question: a number where an array belongs, a severity code this schema has
 * never had, an axis carrying ten thousand names.
 */
function parseFilters(value: unknown): FiltersResult {
  if (value === undefined || value === null) return { ok: true, filters: { state: 'published' } }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'filters is not an object' }
  }
  const raw = value as Record<string, unknown>
  const filters: Filters = {}

  if (raw.text !== undefined && typeof raw.text !== 'string') {
    return { ok: false, error: 'text is not a string' }
  }
  if (typeof raw.text === 'string' && raw.text.trim()) filters.text = raw.text.slice(0, MAX_TEXT)
  if (raw.cveId !== undefined && typeof raw.cveId !== 'string') {
    return { ok: false, error: 'cveId is not a string' }
  }
  if (typeof raw.cveId === 'string' && raw.cveId.trim()) {
    filters.cveId = raw.cveId.trim().slice(0, MAX_TEXT)
  }

  for (const axis of LOOKUP_AXES) {
    const names = raw[axis]
    if (names === undefined) continue
    if (!Array.isArray(names)) return { ok: false, error: `${axis} is not a list of names` }
    if (names.length > MAX_AXIS_VALUES) {
      return { ok: false, error: `${axis} has too many names` }
    }
    if (names.some((name) => typeof name !== 'string' || !name.trim())) {
      return { ok: false, error: `${axis} contains something that is not a name` }
    }
    const cleaned = (names as string[]).map((name) => name.trim().slice(0, MAX_TEXT))
    if (cleaned.length) filters[axis] = cleaned
  }

  // Codes rather than free integers: `cvss_sev` is 0..4 and `cvss_ver` is one of
  // four labels where 31 is v3.1 and 4 is v4.0 (D-047). An unrecognised code
  // cannot match anything. Refusing it is safer than dropping that predicate,
  // which would silently widen the report to every severity or version.
  const severity = parseCodes(raw.severity, [0, 1, 2, 3, 4])
  if (severity === null) return { ok: false, error: 'severity is not a list of severity codes' }
  if (severity.length) filters.severity = severity

  const versions = parseCodes(raw.cvssVersion, [2, 30, 31, 4])
  if (versions === null) return { ok: false, error: 'cvssVersion is not a list of version codes' }
  if (versions.length) filters.cvssVersion = versions

  for (const key of [
    'scoreMin',
    'scoreMax',
    'publishedFrom',
    'publishedTo',
    'updatedFrom',
    'updatedTo',
    'yearFrom',
    'yearTo',
  ] as const) {
    const at = raw[key]
    if (at === undefined) continue
    if (typeof at !== 'number' || !Number.isFinite(at)) {
      return { ok: false, error: `${key} is not a finite number` }
    }
    filters[key] = at
  }

  filters.state = isStateFilter(raw.state) ? raw.state : 'published'
  return { ok: true, filters }
}

/** A list of allowlisted codes, or `null` if the list or any member is invalid. */
function parseCodes(value: unknown, allowed: number[]): number[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  if (value.some((code) => typeof code !== 'number' || !allowed.includes(code))) return null
  return [...new Set(value as number[])]
}

function isDimension(value: unknown): value is Dimension {
  return typeof value === 'string' && (DIMENSIONS as readonly string[]).includes(value)
}

function isChartType(value: unknown): value is ChartType {
  return typeof value === 'string' && (CHART_TYPES as readonly string[]).includes(value)
}

function isSortKey(value: unknown): value is SortKey {
  return value === 'published' || value === 'updated' || value === 'score' || value === 'cve'
}

function isStateFilter(value: unknown): value is StateFilter {
  return value === 'published' || value === 'rejected' || value === 'all'
}

/** What an invalid value is called in an error, without echoing it back at length. */
function label(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value.slice(0, 60))
  if (value === null) return 'null'
  return typeof value
}

/**
 * Encode a report for a URL fragment.
 *
 * base64url of the JSON: the fragment survives copy-paste, mail clients and
 * chat apps without percent-encoding turning it into something the reader has
 * to trust. Not compressed — a real definition is a few hundred bytes, and a
 * compressor would be a second parser reached by stranger-supplied bytes for no
 * benefit anyone would notice.
 */
export function toFragment(report: Report): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(report)))
}

/** Decode a fragment written by `toFragment`. Bounded before it is parsed. */
export function fromFragment(fragment: string): ParseResult {
  const trimmed = fragment.startsWith('#') ? fragment.slice(1) : fragment
  if (!trimmed) return { ok: false, error: 'empty link' }
  if (trimmed.length > MAX_FRAGMENT_BYTES)
    return { ok: false, error: 'link is too long to be a report' }
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return { ok: false, error: 'not a report link' }
  let json: string
  try {
    json = new TextDecoder().decode(base64UrlDecode(trimmed))
  } catch {
    return { ok: false, error: 'this link is damaged and could not be read' }
  }
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return { ok: false, error: 'this link is damaged and could not be read' }
  }
  return parseReport(value)
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}
