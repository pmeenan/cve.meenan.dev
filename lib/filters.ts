/**
 * The shared query layer: every confirmed filter axis, compiled to SQL with
 * bound parameters (M3).
 *
 * Two rules are structural here rather than remembered by each caller.
 *
 * **Nothing but an allowlisted identifier is ever interpolated.** Filter values
 * — vendor names, search text, CVE ids, dates — are attacker-influenced twice
 * over: they come from a URL or a form, and they are compared against corpus
 * text. They become `?` placeholders, always. What *is* interpolated is a table
 * or column name this file chose, or a run of `?`s whose length comes from an
 * array's length. `tests/unit/filters.test.ts` asserts that every compiled
 * fragment is free of the values it was built from (rule 4).
 *
 * **REJECTED records are excluded unless asked for** (D-022). ~4.8% of the
 * corpus is REJECTED — 17,801 records of 372,322 in the live artifact — so an
 * aggregate without the predicate overcounts by about a twentieth and looks
 * entirely plausible. The default lives in `compile` because "easy to write and
 * easy to forget" is exactly what a shared layer is for; a report that wants
 * them says so, and the UI has to say so too.
 */

/** Bindable scalar. Everything a filter contributes is one of these. */
export type SqlParam = string | number

/** `cve.state`, as stored. */
export const STATE_PUBLISHED = 1
export const STATE_REJECTED = 2

/**
 * Which records an aggregate is over. `published` is the default everywhere
 * (D-022); the other two are opt-ins the UI must show, because a chart whose
 * denominator changed silently is worse than one that refuses.
 */
export type StateFilter = 'published' | 'rejected' | 'all'

/** `cve.cvss_sev`, as stored, with the labels the UI shows. */
export const SEVERITY_LABELS: Record<number, string> = {
  0: 'NONE',
  1: 'LOW',
  2: 'MEDIUM',
  3: 'HIGH',
  4: 'CRITICAL',
}

/**
 * `cve.cvss_ver`, as stored — **codes, not magnitudes**. 31 is CVSS v3.1 and 4
 * is v4.0, so 31 > 4 is not "newer" (D-047). Comparing them numerically is the
 * defect that shipped once already.
 */
export const CVSS_VERSION_LABELS: Record<number, string> = {
  2: 'v2.0',
  30: 'v3.0',
  31: 'v3.1',
  4: 'v4.0',
}

export const STATE_LABELS: Record<number, string> = {
  [STATE_PUBLISHED]: 'PUBLISHED',
  [STATE_REJECTED]: 'REJECTED',
}

/**
 * The axes whose values are interned lookup rows, so a filter on one is a name
 * the user typed that has to become an id before it can be compared (D-055's
 * ID space is the server's, and the client holds only the ids it was sent).
 *
 * Resolution is deliberately a separate step from compilation: "no vendor is
 * called that" and "no CVE matches that vendor" are different answers, and a
 * layer that folded the first into the second would report an empty table for a
 * typo (the same confusion D-023 warns about for records with no description).
 */
export const LOOKUP_AXES = ['vendor', 'product', 'cna', 'cwe', 'host'] as const

export type LookupAxis = (typeof LOOKUP_AXES)[number]

/**
 * Every confirmed filter axis (M3 scope, from D-033's accepted schema).
 *
 * Names rather than ids on the lookup axes, because this object is what a
 * permalink and the chat layer's report definition will carry (D-044, M4), and
 * an id means nothing outside the artifact that issued it. Ids are resolved
 * against the local database immediately before compiling.
 */
export interface Filters {
  /** Full-text over descriptions (D-035). Parsed by `ftsQuery`, never pasted in. */
  text?: string
  /** An exact canonical CVE ID, e.g. `CVE-2021-44228`. Case-insensitive. */
  cveId?: string
  vendor?: string[]
  product?: string[]
  cna?: string[]
  /** `CWE-787`, or the bare number. */
  cwe?: string[]
  /** Reference *hosts* (D-033) — never the URLs, which are not indexed. */
  host?: string[]
  /** `cve.cvss_sev` codes, 0..4. */
  severity?: number[]
  /** `cve.cvss_ver` codes — 2, 30, 31, 4. */
  cvssVersion?: number[]
  scoreMin?: number
  scoreMax?: number
  /** Unix seconds, inclusive on both ends. */
  publishedFrom?: number
  publishedTo?: number
  updatedFrom?: number
  updatedTo?: number
  yearFrom?: number
  yearTo?: number
  /** Defaults to `published` (D-022). */
  state?: StateFilter
}

/**
 * Lookup ids resolved from the names in `Filters`, per axis. An empty array is
 * meaningful: the axis was requested and none of its names exist in this copy.
 */
export type Resolved = Partial<Record<LookupAxis, number[]>>

/** A compiled predicate: SQL with `?` placeholders, and the values for them. */
export interface Compiled {
  where: string
  params: SqlParam[]
}

/**
 * A bounded query asks SQLite for one sentinel row beyond the collection limit.
 * The Worker consumes at most `limit` rows and uses the sentinel to report that
 * the answer was capped; putting the exact cap in SQL would make truncation
 * indistinguishable from an answer that happened to have exactly that many rows.
 */
export interface BoundedSql {
  sql: string
  params: SqlParam[]
  limit: number
}

/**
 * How a lookup name is matched to a row, per axis.
 *
 * Vendor, product and CNA names are stored as upstream wrote them —
 * `pipeline/normalize.py` strips whitespace and nothing else — so matching is
 * case-insensitive against `lower(name)`. Hosts are already lowercased at
 * ingest. CWE is matched on the `CWE-NNN` identifier, and `normalizeCwe`
 * accepts a bare number so that typing `79` works.
 *
 * None of these use an index: `vendor` is 24,436 rows and `product` 80,213, so
 * a scan is milliseconds and an index would cost download bytes for every user
 * to save them (D-033 dropped exactly this kind of index).
 */
export const LOOKUP_SQL: Record<LookupAxis, string> = {
  vendor: 'SELECT id, name FROM vendor WHERE lower(name) = ?',
  product: 'SELECT id, name FROM product WHERE lower(name) = ?',
  cna: 'SELECT id, name FROM cna WHERE lower(name) = ?',
  cwe: 'SELECT id, cwe AS name FROM cwe WHERE lower(cwe) = ?',
  host: 'SELECT id, name FROM host WHERE lower(name) = ?',
}

/** The form `LOOKUP_SQL` compares against, per axis. */
export function lookupKey(axis: LookupAxis, value: string): string {
  const trimmed = value.trim()
  return axis === 'cwe' ? normalizeCwe(trimmed) : trimmed.toLowerCase()
}

/** `787`, `cwe-787` and `CWE-787` are the same CWE; anything else is passed through. */
export function normalizeCwe(value: string): string {
  const trimmed = value.trim().toLowerCase()
  return /^\d+$/.test(trimmed) ? `cwe-${trimmed}` : trimmed
}

/**
 * Compile the filters into one `WHERE` clause over `cve c`.
 *
 * Link-table axes compile to `EXISTS`, not to a join: a record with eight
 * affected products must not appear eight times in a list or count eight times
 * in an aggregate, and a join would do both. Every `EXISTS` correlates on
 * `cve_id`, which is the leading column of each link table's primary key, so
 * the access path is a seek rather than a scan (schema.sql's first load-bearing
 * property).
 */
export function compile(filters: Filters, resolved: Resolved = {}): Compiled {
  const clauses: string[] = []
  const params: SqlParam[] = []

  // D-022, first and unconditional: every other clause narrows what this
  // already excluded.
  const state = filters.state
  if (state !== 'rejected' && state !== 'all') {
    clauses.push('c.state = ?')
    params.push(STATE_PUBLISHED)
  } else if (state === 'rejected') {
    clauses.push('c.state = ?')
    params.push(STATE_REJECTED)
  }

  if (filters.cveId) {
    clauses.push('lower(c.cve_id) = ?')
    params.push(filters.cveId.trim().toLowerCase())
  }

  const match = ftsQuery(filters.text)
  if (match !== null) {
    // The fts5 table is external-content over `cve_text`, whose rowid is
    // `cve.id` — so a match set is a set of record ids and needs no join back
    // through a second table (D-035).
    clauses.push('c.id IN (SELECT rowid FROM fts WHERE fts MATCH ?)')
    params.push(match)
  } else if (filters.text?.trim()) {
    // A non-empty string with no searchable token (for example `!!!`) is not
    // an absent filter. Returning the whole corpus for it would make a failed
    // search look like a successful broad one.
    clauses.push('0')
  }

  pushIn(clauses, params, 'c.cvss_sev', filters.severity)
  pushIn(clauses, params, 'c.cvss_ver', filters.cvssVersion)
  pushRange(clauses, params, 'c.cvss_score', filters.scoreMin, filters.scoreMax)
  pushRange(clauses, params, 'c.published', filters.publishedFrom, filters.publishedTo)
  pushRange(clauses, params, 'c.updated', filters.updatedFrom, filters.updatedTo)
  pushRange(clauses, params, 'c.year', filters.yearFrom, filters.yearTo)

  pushResolvedIn(clauses, params, 'c.cna_id', lookupResolution(filters.cna, resolved.cna))
  pushResolvedExists(
    clauses,
    params,
    'SELECT 1 FROM cve_cwe x WHERE x.cve_id = c.id AND x.cwe_id IN',
    lookupResolution(filters.cwe, resolved.cwe)
  )
  pushResolvedExists(
    clauses,
    params,
    'SELECT 1 FROM cve_prod cp WHERE cp.cve_id = c.id AND cp.product_id IN',
    lookupResolution(filters.product, resolved.product)
  )
  pushResolvedExists(
    clauses,
    params,
    'SELECT 1 FROM cve_prod cp JOIN product p ON p.id = cp.product_id ' +
      'WHERE cp.cve_id = c.id AND p.vendor_id IN',
    lookupResolution(filters.vendor, resolved.vendor)
  )
  // References by host, never by URL (D-033): `url` carries no index on its
  // text and FTS deliberately does not cover it (D-035), so a host is the only
  // reference axis that is a lookup rather than a scan.
  pushResolvedExists(
    clauses,
    params,
    'SELECT 1 FROM cve_ref r JOIN url u ON u.id = r.url_id ' +
      'WHERE r.cve_id = c.id AND u.host_id IN',
    lookupResolution(filters.host, resolved.host)
  )

  return { where: clauses.length ? clauses.join(' AND ') : '1', params }
}

/** `column IN (?, ?)`, or nothing at all for an absent or empty list. */
function pushIn(
  clauses: string[],
  params: SqlParam[],
  column: string,
  values: number[] | undefined
): void {
  if (!values?.length) return
  clauses.push(`${column} IN (${placeholders(values.length)})`)
  params.push(...values)
}

function pushExists(
  clauses: string[],
  params: SqlParam[],
  prefix: string,
  ids: number[] | undefined
): void {
  if (!ids?.length) return
  clauses.push(`EXISTS (${prefix} (${placeholders(ids.length)}))`)
  params.push(...ids)
}

/**
 * A resolved lookup has three states, not two: `undefined` means the axis was
 * not requested, ids mean the requested names matched, and an empty array means
 * names were requested but none exist in this copy. The last case must compile
 * to false. Treating it like an absent filter returns the whole corpus for a
 * typo, precisely the quiet wrongness the separate resolution step exists to
 * prevent.
 */
function pushResolvedIn(
  clauses: string[],
  params: SqlParam[],
  column: string,
  ids: number[] | undefined
): void {
  if (ids === undefined) return
  if (ids.length === 0) {
    clauses.push('0')
    return
  }
  pushIn(clauses, params, column, ids)
}

function pushResolvedExists(
  clauses: string[],
  params: SqlParam[],
  prefix: string,
  ids: number[] | undefined
): void {
  if (ids === undefined) return
  if (ids.length === 0) {
    clauses.push('0')
    return
  }
  pushExists(clauses, params, prefix, ids)
}

/**
 * Require a resolution whenever names were supplied. If a future caller
 * forgets the separate lookup step, failing closed to no matches is safer than
 * silently dropping that axis and returning unrelated records.
 */
function lookupResolution(names: string[] | undefined, ids: number[] | undefined) {
  return names?.some((name) => name.trim()) ? (ids ?? []) : undefined
}

function pushRange(
  clauses: string[],
  params: SqlParam[],
  column: string,
  from: number | undefined,
  to: number | undefined
): void {
  if (typeof from === 'number' && Number.isFinite(from)) {
    clauses.push(`${column} >= ?`)
    params.push(from)
  }
  if (typeof to === 'number' && Number.isFinite(to)) {
    clauses.push(`${column} <= ?`)
    params.push(to)
  }
}

/** `?, ?, ?` — built from a count, never from a value. */
function placeholders(count: number): string {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error(`bad placeholder count ${count}`)
  return new Array(count).fill('?').join(', ')
}

/**
 * Turn what a user typed into an fts5 query string, or null if it holds nothing
 * searchable.
 *
 * The string is a *bound parameter*, so this is not about SQL injection — it is
 * about fts5's own query syntax, which is a second parser this text reaches.
 * `AND`, `OR`, `NOT`, `NEAR`, `^`, `:`, `-`, `(` and `"` all mean something
 * there, so a search for `NEAR(` or an unbalanced quote is a syntax error the
 * user cannot diagnose, and `descr : foo` silently means something else. Every
 * token is therefore emitted as a quoted fts5 string, which is the form that
 * has no syntax inside it at all.
 *
 * What the user keeps: multiple words mean *all of them* (`AND`, which is what
 * a search box implies), `"a phrase"` stays a phrase, and a trailing `*` is a
 * prefix search — the three behaviours a search box is expected to have.
 */
export function ftsQuery(text: string | undefined): string | null {
  if (!text) return null
  const terms: string[] = []
  // A quoted span is one term; everything else splits on anything that is not a
  // letter, a digit, an underscore or a hyphen. Hyphens are kept inside tokens
  // so `cross-site` stays one phrase rather than becoming two terms.
  const pattern = /"([^"]*)"|([\p{L}\p{N}_][\p{L}\p{N}_-]*)(\*?)/gu
  for (const found of text.matchAll(pattern)) {
    const phrase = found[1] ?? found[2] ?? ''
    const cleaned = phrase.trim()
    if (!cleaned) continue
    // Doubling is fts5's own escape for a quote inside a quoted string. A
    // phrase from a `"…"` span cannot contain one, but a defensive escape here
    // costs nothing and survives a future change to the pattern.
    const quoted = `"${cleaned.replace(/"/g, '""')}"`
    terms.push(found[3] === '*' ? `${quoted}*` : quoted)
  }
  return terms.length ? terms.join(' AND ') : null
}

/** How results are ordered. An allowlist, because this reaches SQL as text. */
export type SortKey = 'published' | 'updated' | 'score' | 'cve'

const SORT_SQL: Record<SortKey, string> = {
  published: 'c.published DESC, c.id DESC',
  updated: 'c.updated DESC, c.id DESC',
  // NULLS LAST: two thirds of the corpus carries no CVSS score at all (189,742
  // of 372,322), and SQLite sorts NULL first descending — so the default
  // ordering would open on a page of blanks.
  score: 'c.cvss_score DESC NULLS LAST, c.id DESC',
  cve: 'c.cve_id DESC',
}

/**
 * How many rows a result set may carry back to the UI.
 *
 * A cap rather than a page count: the Worker holds every row in memory and
 * posts it structured-cloned to the page, so an unbounded `SELECT *` over
 * 372,322 records is two copies of the corpus in RAM before anything renders.
 * The UI says when it truncated (D-052's rule that silence is the enemy applies
 * to results as much as to waits).
 */
export const ROW_LIMIT = 500

/** The maximum a caller may ask for, whatever it asks for. */
export const MAX_ROW_LIMIT = 5_000

export interface RowOptions {
  limit?: number
  offset?: number
  sort?: SortKey
}

/**
 * The record list: one row per matching CVE, with enough to identify it.
 *
 * `cve_text` is a LEFT JOIN because 4.46% of records have no English
 * description (D-023) — an inner join would silently drop them from every
 * result set, which is the quiet wrongness vision criterion 7 exists to
 * prevent.
 */
export function rowsSql(
  filters: Filters,
  resolved: Resolved = {},
  options: RowOptions = {}
): BoundedSql {
  const { where, params } = compile(filters, resolved)
  const limit = clampLimit(options.limit)
  const offset = clampOffset(options.offset)
  // Falls back rather than trusting the key: this arrives in a message from the
  // page and, in M4, out of a permalink, so an unknown one is a value from
  // outside — and `ORDER BY undefined` would be a broken statement built from
  // it. The allowlist is the whole defence, so its miss case has to be safe.
  const sort = SORT_SQL[options.sort as SortKey] ?? SORT_SQL.published
  return {
    sql:
      `SELECT c.cve_id AS cve, c.state, c.published, c.updated, c.cvss_ver, c.cvss_score, ` +
      `c.cvss_sev, n.name AS cna, substr(t.descr, 1, 400) AS description ` +
      `FROM cve c LEFT JOIN cna n ON n.id = c.cna_id LEFT JOIN cve_text t ON t.cve_id = c.id ` +
      `WHERE ${where} ORDER BY ${sort} LIMIT ? OFFSET ?`,
    params: [...params, limit + 1, offset],
    limit,
  }
}

/** How many records match, which is the number a list of 500 cannot tell you. */
export function countSql(
  filters: Filters,
  resolved: Resolved = {}
): { sql: string; params: SqlParam[] } {
  const { where, params } = compile(filters, resolved)
  return { sql: `SELECT count(*) AS matches FROM cve c WHERE ${where}`, params }
}

/**
 * The axes an aggregate can group by — every filter axis, plus three time
 * grains.
 *
 * All three are computed from `c.published`. The stored `c.year` is the year in
 * the CVE identifier, not necessarily the year the record was published. They
 * are separate dimensions rather
 * than one dimension with a grain parameter because that keeps the report
 * definition flat — one field naming an axis — which is both simpler to
 * validate coming out of a URL fragment and simpler for a small model to emit
 * correctly (D-044, M7).
 */
export const DIMENSIONS = [
  'year',
  'quarter',
  'month',
  'severity',
  'cvssVersion',
  'state',
  'cna',
  'vendor',
  'product',
  'cwe',
  'host',
] as const

export type Dimension = (typeof DIMENSIONS)[number]

/** Dimensions whose buckets are points in time, ordered by the axis not by size. */
export const TIME_DIMENSIONS = new Set<Dimension>(['year', 'quarter', 'month'])

/** What each axis is called on screen. Beside the other label maps, and typed
 * against `Dimension`, so adding an axis cannot leave a picker showing a key. */
export const DIMENSION_LABELS: Record<Dimension, string> = {
  year: 'Year',
  quarter: 'Quarter',
  month: 'Month',
  severity: 'Severity',
  cvssVersion: 'CVSS version',
  state: 'State',
  cna: 'CNA',
  vendor: 'Vendor',
  product: 'Product',
  cwe: 'CWE',
  host: 'Reference host',
}

/**
 * Dimensions whose buckets are a stored code the UI maps to a label — ordered
 * by the code, because they are scales (severity) or version identifiers, not
 * rankings.
 */
const CODE_DIMENSIONS = new Set<Dimension>(['severity', 'cvssVersion', 'state'])

/**
 * The time grains, as SQL over `c.published` (unix seconds).
 *
 * Both yield a sortable string, so ordering the axis is ordering the bucket and
 * no separate sort key is needed. A record with no publication date buckets to
 * NULL rather than to a wrong period — `strftime` propagates it — which the UI
 * renders as "(none recorded)" the same way an absent lookup is rendered.
 */
const YEAR_EXPR = "strftime('%Y', c.published, 'unixepoch')"
const MONTH_EXPR = "strftime('%Y-%m', c.published, 'unixepoch')"
const QUARTER_EXPR =
  `${YEAR_EXPR} || '-Q' || ` +
  "((CAST(strftime('%m', c.published, 'unixepoch') AS INTEGER) + 2) / 3)"

/** Storage codes are identifiers: 4 (v4.0) belongs after 31 (v3.1). */
const CVSS_VERSION_ORDER =
  'CASE WHEN c.cvss_ver = 2 THEN 0 WHEN c.cvss_ver = 30 THEN 1 ' +
  'WHEN c.cvss_ver = 31 THEN 2 WHEN c.cvss_ver = 4 THEN 3 ' +
  'WHEN c.cvss_ver IS NULL THEN 5 ELSE 4 END'

/**
 * The join chains a dimension can need, each declared **once** and shared by
 * every axis that uses it.
 *
 * Sharing is what makes a two-axis aggregate correct rather than merely
 * runnable. Vendor and product both hang off `cve_prod`; joined twice under
 * separate aliases, a vendor × product cross-tab would pair every vendor of a
 * record with every product of it, so a record affecting Cisco/IOS and
 * Juniper/JunOS would report a "Cisco / JunOS" cell that does not exist. One
 * chain per group means product's vendor is *its own* vendor.
 *
 * Independent groups are a different matter: vendor × CWE genuinely is every
 * pairing, and joining both chains is what expresses that.
 */
type JoinGroup = 'prod' | 'cwe' | 'ref' | 'cna'

const JOIN_SQL: Record<JoinGroup, string> = {
  prod:
    'JOIN cve_prod cp ON cp.cve_id = c.id JOIN product p ON p.id = cp.product_id ' +
    'JOIN vendor v ON v.id = p.vendor_id',
  cwe: 'JOIN cve_cwe x ON x.cve_id = c.id JOIN cwe w ON w.id = x.cwe_id',
  ref:
    'JOIN cve_ref r ON r.cve_id = c.id JOIN url u ON u.id = r.url_id ' +
    'JOIN host h ON h.id = u.host_id',
  cna: 'LEFT JOIN cna n ON n.id = c.cna_id',
}

/**
 * Which join groups put more than one row on screen per record. `cna` does not
 * — it is a scalar foreign key reached by a LEFT JOIN — so a grouping that
 * needs only it can count rows. Any of the others means counting
 * `DISTINCT c.id`, because a record affecting five Cisco products is one Cisco
 * CVE, not five.
 */
const MULTIPLYING: ReadonlySet<JoinGroup> = new Set<JoinGroup>(['prod', 'cwe', 'ref'])

/**
 * How each dimension is grouped. Every string here is this file's own SQL — no
 * caller-supplied text reaches any of them.
 */
interface DimensionSql {
  key: string
  label: string
  group: string
  /** Semantic display order when the stored key is not itself ordered. */
  order?: string
  join?: JoinGroup
}

const DIMENSION_SQL: Record<Dimension, DimensionSql> = {
  year: { key: YEAR_EXPR, label: YEAR_EXPR, group: YEAR_EXPR },
  // Computed from the stored timestamp rather than stored: a second column per
  // grain would cost download bytes for every user (the trade D-033 made
  // against indexes), and a grouped scan is doing the work either way.
  quarter: { key: QUARTER_EXPR, label: QUARTER_EXPR, group: QUARTER_EXPR },
  month: { key: MONTH_EXPR, label: MONTH_EXPR, group: MONTH_EXPR },
  severity: { key: 'c.cvss_sev', label: 'c.cvss_sev', group: 'c.cvss_sev' },
  cvssVersion: {
    key: 'c.cvss_ver',
    label: 'c.cvss_ver',
    group: 'c.cvss_ver',
    order: CVSS_VERSION_ORDER,
  },
  state: { key: 'c.state', label: 'c.state', group: 'c.state' },
  cna: { key: 'c.cna_id', label: 'n.name', group: 'c.cna_id', join: 'cna' },
  vendor: { key: 'v.id', label: 'v.name', group: 'v.id', join: 'prod' },
  product: { key: 'p.id', label: "v.name || ' / ' || p.name", group: 'p.id', join: 'prod' },
  cwe: { key: 'w.id', label: "w.cwe || ' — ' || w.descr", group: 'w.id', join: 'cwe' },
  host: { key: 'h.id', label: 'h.name', group: 'h.id', join: 'ref' },
}

/** Aggregate rows a grouped query may return. Generous: 2026 has 28 years of
 * data and a CWE breakdown has 797 possible rows, but a vendor breakdown has
 * 24,436 and nothing renders that. */
export const GROUP_LIMIT = 250

/**
 * Counts by one dimension, under the same filters as the list.
 *
 * Ordered by count for the dimensions where "the top ones" is the question, and
 * by the key itself for the time-like ones, where a chart wants the axis in
 * order.
 */
export function groupSql(
  filters: Filters,
  resolved: Resolved,
  dimension: Dimension,
  limit = GROUP_LIMIT
): BoundedSql {
  const shape = shapeOf(dimension)
  const { where, params } = compile(filters, resolved)
  const bounded = clampLimit(limit, GROUP_LIMIT, GROUP_LIMIT)
  const ordered = TIME_DIMENSIONS.has(dimension)
    ? `${axisOrder(shape)} ASC`
    : dimension === 'cvssVersion'
      ? `${axisOrder(shape)} ASC`
      : dimension === 'state'
        ? `${shape.key} DESC`
        : 'cves DESC'
  return {
    sql:
      `SELECT ${shape.key} AS bucket, ${shape.label} AS label, ${countFor([shape])} AS cves ` +
      `FROM cve c ${joinsFor([shape])} WHERE ${where} GROUP BY ${shape.group} ` +
      `ORDER BY ${ordered} LIMIT ?`,
    params: [...params, bounded + 1],
    limit: bounded,
  }
}

/** Refuses by name rather than defaulting past it: this arrives from a URL. */
function shapeOf(dimension: Dimension): DimensionSql {
  const shape = DIMENSION_SQL[dimension]
  if (!shape) throw new Error(`not a dimension this build groups by: ${String(dimension)}`)
  return shape
}

/** Each needed join group emitted once, in a fixed order. */
function joinsFor(shapes: DimensionSql[]): string {
  const groups: JoinGroup[] = []
  for (const shape of shapes) {
    if (shape.join && !groups.includes(shape.join)) groups.push(shape.join)
  }
  return groups.map((group) => JOIN_SQL[group]).join(' ')
}

function countFor(shapes: DimensionSql[]): string {
  const multiplies = shapes.some((shape) => shape.join && MULTIPLYING.has(shape.join))
  return multiplies ? 'count(DISTINCT c.id)' : 'count(*)'
}

/**
 * How many buckets a cross-tab may carry on each axis, and how many cells in
 * total.
 *
 * Rows × series is a *product*, so two axes that are each individually
 * reasonable are not: vendor × product is 24,436 × 80,213. The cell cap is the
 * backstop that makes any pair of axes safe to ask for, and what it stops is a
 * result set the Worker would hold in memory and structured-clone to the page
 * (the same reasoning as ROW_LIMIT).
 */
export const CROSS_ROW_LIMIT = 250
export const CROSS_SERIES_LIMIT = 24
export const CROSS_CELL_LIMIT = 3_000

export interface CrossOptions {
  /** Distinct row buckets. Charts ask for far fewer than the cap. */
  rows?: number
  /** Distinct series buckets. */
  series?: number
}

/**
 * Counts by two dimensions at once — the shape both D-046 benchmark questions
 * are in, and what a stacked or grouped chart renders.
 *
 * The axes are narrowed *before* the cross-tab is computed, each by its own
 * total, rather than by taking the biggest cells: a vendor belongs on the chart
 * because it has many CVEs, not because one of its severity buckets happens to
 * be large. Selecting on cells would drop a vendor whose records are spread
 * evenly across severities in favour of one that is entirely MEDIUM, which is
 * the opposite of what "top vendors" means.
 *
 * Rows come back ordered for reading: time ascending, so a chart's x-axis runs
 * forwards, and everything else by size. The narrowing itself takes time
 * *descending* — with 336 months in the corpus and a cap below that, the
 * interesting end is the recent one, and ordering the cut the same way as the
 * output would silently answer about 1999.
 */
export function crossSql(
  filters: Filters,
  resolved: Resolved,
  rows: Dimension,
  series: Dimension | null,
  options: CrossOptions = {}
): BoundedSql {
  const rowLimit = clampLimit(options.rows, CROSS_ROW_LIMIT, CROSS_ROW_LIMIT)
  if (series === null) return groupSql(filters, resolved, rows, rowLimit)

  const rowShape = shapeOf(rows)
  const seriesShape = shapeOf(series)
  const seriesLimit = clampLimit(options.series, CROSS_SERIES_LIMIT, CROSS_SERIES_LIMIT)
  const cellLimit = Math.min(rowLimit * seriesLimit, CROSS_CELL_LIMIT)
  const { where, params } = compile(filters, resolved)

  // Each axis narrowed on its own terms, through its own joins only — a
  // vendor's total must not be computed through the CWE chain, which would
  // count it once per CWE.
  const topRows =
    `SELECT ${rowShape.key} AS bucket FROM cve c ${joinsFor([rowShape])} WHERE ${where} ` +
    `GROUP BY ${rowShape.group} ORDER BY ${narrowOrder(rows, rowShape)} LIMIT ?`
  const topSeries =
    `SELECT ${seriesShape.key} AS bucket FROM cve c ${joinsFor([seriesShape])} WHERE ${where} ` +
    `GROUP BY ${seriesShape.group} ORDER BY ${narrowOrder(series, seriesShape)} LIMIT ?`

  // `IS` rather than `IN`: a NULL bucket is a real answer — records with no
  // CVSS severity are about half the corpus and are shown as their own band
  // rather than dropped — and `x IN (SELECT …)` is never true for NULL, so a
  // plain IN would delete exactly the band the chart is required to show.
  const rowIn =
    `(${rowShape.key} IN (SELECT bucket FROM top_rows) OR ` +
    `(${rowShape.key} IS NULL AND EXISTS (SELECT 1 FROM top_rows WHERE bucket IS NULL)))`
  const seriesIn =
    `(${seriesShape.key} IN (SELECT bucket FROM top_series) OR ` +
    `(${seriesShape.key} IS NULL AND EXISTS (SELECT 1 FROM top_series WHERE bucket IS NULL)))`

  const sql =
    `WITH top_rows AS (${topRows}), top_series AS (${topSeries}) ` +
    `SELECT ${rowShape.key} AS bucket, ${rowShape.label} AS label, ` +
    `${seriesShape.key} AS series, ${seriesShape.label} AS series_label, ` +
    `${countFor([rowShape, seriesShape])} AS cves ` +
    `FROM cve c ${joinsFor([rowShape, seriesShape])} ` +
    `WHERE ${where} AND ${rowIn} AND ${seriesIn} ` +
    `GROUP BY ${rowShape.group}, ${seriesShape.group} ` +
    `ORDER BY ${rowOrder(rows, rowShape, countFor([rowShape, seriesShape]))}, ` +
    `${seriesOrder(series, seriesShape)} LIMIT ?`

  return {
    sql,
    params: [...params, rowLimit, ...params, seriesLimit, ...params, cellLimit + 1],
    limit: cellLimit,
  }
}

/**
 * How an axis is cut down to its cap: time takes the recent end, else the big
 * end — by *records*, not by joined rows, or a vendor with many products per
 * record would outrank one with many records.
 */
function narrowOrder(dimension: Dimension, shape: DimensionSql): string {
  return TIME_DIMENSIONS.has(dimension) ? `${shape.key} DESC` : `${countFor([shape])} DESC`
}

/**
 * How rows are ordered for reading.
 *
 * A cross-tab returns cells, so ordering by cell size would interleave rows —
 * a vendor's CRITICAL cell landing pages away from its LOW one. Every row's
 * cells therefore sort together, by that row's own total, which is what the
 * window function computes: the ordering is over rows even though the result
 * set is cells.
 */
function rowOrder(dimension: Dimension, shape: DimensionSql, count: string): string {
  if (TIME_DIMENSIONS.has(dimension) || CODE_DIMENSIONS.has(dimension)) {
    return `${axisOrder(shape)} ASC`
  }
  return `sum(${count}) OVER (PARTITION BY ${shape.group}) DESC, ${shape.key}`
}

/** How cells are ordered within a row: scales by their value, identity by size. */
function seriesOrder(dimension: Dimension, shape: DimensionSql): string {
  if (TIME_DIMENSIONS.has(dimension) || CODE_DIMENSIONS.has(dimension)) {
    return `${axisOrder(shape)} ASC`
  }
  return 'cves DESC'
}

function axisOrder(shape: DimensionSql): string {
  return shape.order ?? shape.key
}

function clampLimit(
  value: number | undefined,
  fallback = ROW_LIMIT,
  maximum = MAX_ROW_LIMIT
): number {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(n, maximum)
}

function clampOffset(value: number | undefined): number {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n) || n < 0) return 0
  // Bounded because it reaches SQL as a number and OFFSET makes SQLite walk
  // every skipped row; a URL asking for offset 10^9 is a request to scan the
  // corpus for nothing.
  return Math.min(n, 1_000_000)
}
