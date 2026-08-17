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

import {
  KEV_LISTED,
  KEV_NOT_LISTED,
  RANSOMWARE_KNOWN,
  RANSOMWARE_NOT_LISTED,
  RANSOMWARE_UNKNOWN,
} from './kev'

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

/**
 * The version codes in the order a person reads them — v2.0, v3.0, v3.1, v4.0.
 *
 * An explicit list because the object above cannot carry it: JavaScript orders
 * integer-like keys numerically whatever the source says, so
 * `Object.keys(CVSS_VERSION_LABELS)` is `2, 4, 30, 31` and any UI built from it
 * renders v4.0 between v2.0 and v3.0. That is D-047's confusion — the codes are
 * identifiers, not magnitudes — resurfacing in a checkbox list rather than in a
 * comparison.
 */
export const CVSS_VERSIONS = [2, 30, 31, 4] as const

/** Severity codes low to high. `null` — never scored — is not one of them. */
export const SEVERITIES = [0, 1, 2, 3, 4] as const

/**
 * SSVC's three decision points, as stored (D-070). Contributed by CISA's
 * Vulnrichment ADP, and the corpus's only structured exploitation signal.
 *
 * NULL is not in any of these maps. A missing SSVC block is the absence of the
 * assessment — 51.9% of the corpus — and `Exploitation: none` is a *finding*.
 * Collapsing the two would understate every band, which is the failure D-073
 * rejected for unscored CVSS and D-022 guards against for REJECTED records.
 * `NOT_ASSESSED` below is how a filter names the absence without pretending it
 * is a code.
 */
export const SSVC_EXPL_LABELS: Record<number, string> = {
  0: 'None',
  1: 'Proof of concept',
  2: 'Active',
}

export const SSVC_AUTO_LABELS: Record<number, string> = { 0: 'No', 1: 'Yes' }

export const SSVC_IMPACT_LABELS: Record<number, string> = { 0: 'Partial', 1: 'Total' }

export const SSVC_EXPL = [0, 1, 2] as const
export const SSVC_AUTO = [0, 1] as const
export const SSVC_IMPACT = [0, 1] as const

/**
 * The value a *filter* uses to mean "this column is NULL".
 *
 * Filters bind their values into `IN (?, …)`, and SQL's `IN` is never true for
 * NULL — so without a spelling for it, the one band D-070 requires always be
 * visible would be the one band nobody could select. -1 rather than a separate
 * boolean field because the report definition travels in a URL fragment and is
 * emitted by a model (D-044, D-069): one list per axis is one thing to validate
 * and one thing to get right.
 *
 * It is outside every stored code's range on purpose, so a definition written
 * against a future build that added a code cannot collide with it.
 */
export const NOT_ASSESSED = -1

/** What "not assessed" is called wherever a bucket or a chip names it. */
export const NOT_ASSESSED_LABEL = '(not assessed)'

export const STATE_LABELS: Record<number, string> = {
  [STATE_PUBLISHED]: 'PUBLISHED',
  [STATE_REJECTED]: 'REJECTED',
}

/**
 * KEV membership (M6, D-076).
 *
 * **The complement is a real value, not an absence band.** Unlike an SSVC point
 * nobody assessed, absence from CISA's catalog is the finding — *not
 * known-exploited, per CISA* — so it is an ordinary bucket carrying its
 * provenance, never the off-ramp neutral. The labels say "per CISA" because
 * D-076's licence riders forbid presenting anything as a CISA endorsement, and
 * stating the relationship is how that is satisfied: this is what CISA's
 * catalog says, not a verdict of ours.
 */
export const KEV_LABELS: Record<number, string> = {
  [KEV_LISTED]: 'In KEV (per CISA)',
  [KEV_NOT_LISTED]: 'Not in KEV (per CISA)',
}

/**
 * `knownRansomwareCampaignUse`, plus the bucket for records CISA has not listed
 * at all.
 *
 * Four buckets rather than two, and the last two are the ones that matter:
 * `Not in KEV` is the complement (a real value), and NULL is a listed record
 * whose value this build does not recognise. Collapsing either into "Unknown"
 * would assert CISA looked, which is a finding rather than a display choice.
 *
 * **The NULL band takes an ordinary categorical slot, not D-073's off-ramp
 * neutral, and that is deliberate.** The neutral exists so an absence cannot be
 * read as a *level* on a scale; this axis has no scale, so there is no
 * misreading to prevent, and giving one of four categorical bands a grey would
 * only make it look like the least important. What distinguishes it is its
 * label — `KEV_ABSENCE_LABEL`, which every surface uses.
 */
export const KEV_RANSOMWARE_LABELS: Record<number, string> = {
  [RANSOMWARE_KNOWN]: 'Known ransomware use',
  [RANSOMWARE_UNKNOWN]: 'Unknown (per CISA)',
  [RANSOMWARE_NOT_LISTED]: 'Not in KEV (per CISA)',
}

/**
 * What the `kevRansomware` NULL band is called, everywhere.
 *
 * Not `NOT_ASSESSED_LABEL`: "(not assessed)" is right for an SSVC point nobody
 * looked at, and wrong here — CISA *did* look and stated something this build
 * does not read. The chart, the detail view, the filter checkbox and the chip
 * all take this one string, because the same band under three names across four
 * surfaces is how a reader concludes they are three different things.
 */
export const KEV_ABSENCE_LABEL = '(not stated by CISA)'

/**
 * What the NULL band on `axis` is called wherever one is named.
 *
 * One function rather than a constant, because the two absences mean different
 * things: nobody assessed an SSVC point, while CISA *did* look at a KEV entry
 * and stated something this build does not read. Every surface — chart bucket,
 * detail view, filter checkbox, filter chip — goes through here.
 */
export function absenceLabel(axis: Dimension): string {
  return axis === 'kevRansomware' ? KEV_ABSENCE_LABEL : NOT_ASSESSED_LABEL
}

export const KEV_CODES = [KEV_LISTED, KEV_NOT_LISTED] as const
export const KEV_RANSOMWARE_CODES = [
  RANSOMWARE_KNOWN,
  RANSOMWARE_UNKNOWN,
  RANSOMWARE_NOT_LISTED,
] as const

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
  /**
   * SSVC decision points, as stored codes — with `NOT_ASSESSED` naming the
   * records that carry no assessment at all (D-070).
   */
  ssvcExpl?: number[]
  ssvcAuto?: number[]
  ssvcImpact?: number[]
  /**
   * CISA KEV (M6). `kev` is membership; `kevRansomware` adds `NOT_ASSESSED` for
   * a listed record whose ransomware value this build does not recognise.
   *
   * Every one of these compiles to `EXISTS`/`NOT EXISTS` over the `kev` table
   * rather than to a join, for the reason the link-table axes do: a record must
   * not appear or count more than once. Here the join happens to be 1:1 — the
   * catalog carries one entry per CVE, and both the validator and the table's
   * primary key enforce it — but the filter surface does not depend on that,
   * and `tests/unit/filters.test.ts` asserts the 1:1 rather than assuming it.
   */
  kev?: number[]
  kevRansomware?: number[]
  /** `dateAdded` / `dueDate` as unix seconds, inclusive. Each implies membership. */
  kevAddedFrom?: number
  kevAddedTo?: number
  kevDueFrom?: number
  kevDueTo?: number
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
  pushNullable(clauses, params, 'c.ssvc_expl', filters.ssvcExpl)
  pushNullable(clauses, params, 'c.ssvc_auto', filters.ssvcAuto)
  pushNullable(clauses, params, 'c.ssvc_impact', filters.ssvcImpact)
  pushKevMembership(clauses, filters.kev)
  pushKevRansomware(clauses, params, filters.kevRansomware)
  pushKevRange(clauses, params, 'added_at', filters.kevAddedFrom, filters.kevAddedTo)
  pushKevRange(clauses, params, 'due_at', filters.kevDueFrom, filters.kevDueTo)

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

/**
 * `column IN (?, ?)`, with `NOT_ASSESSED` compiling to `column IS NULL` beside
 * it rather than into it.
 *
 * `IN` is never true for NULL, so selecting "not assessed" through `pushIn`
 * would return nothing at all — and an empty table for a band that holds half
 * the corpus reads as "there are none", not "this filter cannot say that"
 * (D-070). The sentinel is stripped before anything is bound, so it never
 * reaches SQL as a value.
 */
function pushNullable(
  clauses: string[],
  params: SqlParam[],
  column: string,
  values: number[] | undefined
): void {
  if (!values?.length) return
  const codes = values.filter((value) => value !== NOT_ASSESSED)
  const absent = values.length !== codes.length
  const arms: string[] = []
  if (codes.length) {
    arms.push(`${column} IN (${placeholders(codes.length)})`)
    params.push(...codes)
  }
  if (absent) arms.push(`${column} IS NULL`)
  // Selecting *only* the sentinel is one arm, which needs no parentheses but
  // gets them anyway: this clause is joined with AND, and an unparenthesised OR
  // would bind looser than the join and widen every other filter.
  if (arms.length) clauses.push(arms.length > 1 ? `(${arms.join(' OR ')})` : arms[0]!)
}

/**
 * The correlated existence probe every KEV *filter* is built on.
 *
 * `kf` rather than `k`: a KEV *dimension* joins the same table as `k`, and an
 * inner alias shadowing an outer one is the kind of correct-but-unreadable SQL
 * that stops being correct the first time someone edits it.
 *
 * `EXISTS` rather than the dimension's `LEFT JOIN` for the reason every
 * link-table axis uses one — a filter must not be able to change how many times
 * a record appears — even though this particular join is 1:1.
 */
const KEV_EXISTS = 'SELECT 1 FROM kev kf WHERE kf.cve_id = c.id'

/**
 * KEV membership: both codes, one code, or neither.
 *
 * Selecting **both** is not a filter — it is every record — so it contributes
 * no clause. Selecting neither recognised code (a definition from a future
 * build, or a hand-edited fragment) compiles to false rather than being dropped,
 * which is the same rule `pushResolvedIn` follows: a filter nobody can satisfy
 * must not silently return the whole corpus.
 */
function pushKevMembership(clauses: string[], values: number[] | undefined): void {
  if (!values?.length) return
  const listed = values.includes(KEV_LISTED)
  const notListed = values.includes(KEV_NOT_LISTED)
  if (listed && notListed) return
  if (listed) clauses.push(`EXISTS (${KEV_EXISTS})`)
  else if (notListed) clauses.push(`NOT EXISTS (${KEV_EXISTS})`)
  else clauses.push('0')
}

/**
 * Ransomware use, including the two buckets that are not stored values.
 *
 * `RANSOMWARE_NOT_LISTED` is the complement and compiles to `NOT EXISTS`;
 * `NOT_ASSESSED` is a listed record whose value this build does not recognise
 * and compiles to `IS NULL` *inside* the probe. Neither can be expressed by
 * `IN (…)` over the stored column, which is the same gap `pushNullable` exists
 * to close for the SSVC axes.
 */
function pushKevRansomware(
  clauses: string[],
  params: SqlParam[],
  values: number[] | undefined
): void {
  if (!values?.length) return
  const arms: string[] = []
  const codes = values.filter((value) => value === RANSOMWARE_KNOWN || value === RANSOMWARE_UNKNOWN)
  if (codes.length) {
    arms.push(`EXISTS (${KEV_EXISTS} AND kf.ransomware IN (${placeholders(codes.length)}))`)
    params.push(...codes)
  }
  if (values.includes(NOT_ASSESSED)) arms.push(`EXISTS (${KEV_EXISTS} AND kf.ransomware IS NULL)`)
  if (values.includes(RANSOMWARE_NOT_LISTED)) arms.push(`NOT EXISTS (${KEV_EXISTS})`)
  // No recognised bucket at all: false, not absent.
  if (!arms.length) {
    clauses.push('0')
    return
  }
  // Parenthesised even at one arm for the reason `pushNullable` gives: this is
  // joined with AND, and an unparenthesised OR would bind looser than the join
  // and widen every other filter.
  clauses.push(arms.length > 1 ? `(${arms.join(' OR ')})` : arms[0]!)
}

/**
 * A date range over one of the catalog's own dates.
 *
 * Inside the probe rather than beside it, so "added between these dates" means
 * *this record's* KEV entry was added then — not "this record is in KEV and
 * some entry was added then". The column name is this file's own; only the
 * bounds are bound.
 */
function pushKevRange(
  clauses: string[],
  params: SqlParam[],
  column: 'added_at' | 'due_at',
  from: number | undefined,
  to: number | undefined
): void {
  const bounds: string[] = []
  if (typeof from === 'number' && Number.isFinite(from)) {
    bounds.push(`kf.${column} >= ?`)
    params.push(from)
  }
  if (typeof to === 'number' && Number.isFinite(to)) {
    bounds.push(`kf.${column} <= ?`)
    params.push(to)
  }
  if (!bounds.length) return
  clauses.push(`EXISTS (${KEV_EXISTS} AND ${bounds.join(' AND ')})`)
}

/**
 * The KEV join, and the two expressions that turn it into buckets.
 *
 * Declared here rather than beside the other dimensions because the export path
 * needs them too, and a `const` referenced above its own declaration is a
 * temporal-dead-zone crash at import rather than a compile error.
 *
 * Not pinned with `CROSS JOIN` and not in `MULTIPLYING`: the catalog holds
 * **one entry per CVE** — the pipeline refuses a duplicate and the table's
 * primary key could not hold one anyway — so this join is 1:1 and cannot make a
 * record count twice. `LEFT`, not inner, because the complement is the whole
 * point: a record with no entry is *not known-exploited, per CISA*, which is a
 * bucket rather than a row to drop. 1,662 rows against 372,322, reached through
 * `i_kev_cve`.
 */
const JOIN_SQL_KEV = 'LEFT JOIN kev k ON k.cve_id = c.id'

/**
 * KEV membership as a bucket, from the LEFT JOIN's own null-ness.
 *
 * `k.cve` rather than `k.cve_id`, and the reason is narrower than it looks:
 * **given this ON clause the two are equivalent**, because a catalog row whose
 * `cve_id` is NULL can never satisfy `k.cve_id = c.id` and so never reaches the
 * join output at all. What `k.cve` buys is that it stays correct if the join
 * ever changes — it is the catalog's own key, NULL exactly when no entry
 * matched, where `cve_id` is NULL for two different reasons and only one of
 * them is "not listed". An earlier version of this comment claimed the two
 * already differ here; they do not, and the unmatched entries are preserved by
 * `KEV_INSERT`'s nullable `cve_id` and reported by the unmatched count, not by
 * this expression.
 */
const KEV_MEMBER = `CASE WHEN k.cve IS NULL THEN ${KEV_NOT_LISTED} ELSE ${KEV_LISTED} END`

/** Listed first: it is the small band, and the one a stack's baseline is for. */
const KEV_MEMBER_ORDER = 'CASE WHEN k.cve IS NULL THEN 1 ELSE 0 END'

/**
 * Ransomware use, with the complement folded in as its own code.
 *
 * NULL survives this expression — a *listed* record whose value this build does
 * not recognise — and lands in the axis's own "(not stated)" bucket rather than
 * being read as `Unknown`, which would assert CISA looked.
 */
const KEV_RANSOMWARE = `CASE WHEN k.cve IS NULL THEN ${RANSOMWARE_NOT_LISTED} ELSE k.ransomware END`

/**
 * Known, Unknown, Not in KEV, then the unrecognised value last (D-070's rule).
 *
 * **One template literal, deliberately not two joined with `+`.** The bundler
 * drops a literal segment when a template carrying `${…}` is concatenated
 * across lines: this expression shipped to the browser as
 * `… k.ransomware = 1WHEN k.ransomware = 0 …`, with ` THEN 0 ` simply gone, and
 * SQLite refused it with `unrecognized token: "1WHEN"`. Unit tests cannot see
 * it — they run the source — so the rule for every interpolated SQL fragment in
 * this file is one literal (RE-028).
 */
const KEV_RANSOMWARE_ORDER = `CASE WHEN k.cve IS NULL THEN 2 WHEN k.ransomware = ${RANSOMWARE_KNOWN} THEN 0 WHEN k.ransomware = ${RANSOMWARE_UNKNOWN} THEN 1 ELSE 99 END`

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

/**
 * Whether answering this needs the `kev` table.
 *
 * The table is created by the apply that fills it (lib/kev.ts), so on a copy
 * that has never fetched a catalog it does not exist — and every KEV predicate
 * and dimension would fail with `no such table: kev`. The caller checks this
 * *before* compiling, because both alternatives are worse: an error the user
 * cannot act on, or — if the table were created empty on open — a report
 * quietly answering "nothing is known to be exploited".
 *
 * `filters` is checked field by field rather than by looking for a `kev` prefix,
 * so a future filter that merely reads like one cannot become a silent
 * requirement.
 */
export function usesKev(
  filters: Filters,
  ...dimensions: (Dimension | null | undefined)[]
): boolean {
  if (dimensions.some((dimension) => dimension != null && KEV_DIMENSIONS.has(dimension)))
    return true
  return (
    Boolean(filters.kev?.length) ||
    Boolean(filters.kevRansomware?.length) ||
    typeof filters.kevAddedFrom === 'number' ||
    typeof filters.kevAddedTo === 'number' ||
    typeof filters.kevDueFrom === 'number' ||
    typeof filters.kevDueTo === 'number'
  )
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
  /**
   * Return the whole description rather than the first 400 characters.
   *
   * On screen the truncation is right — a table cell is not a place to read
   * 4,000 characters — but an export is a copy of the record, and a copy that
   * silently cut every description at 400 characters would be wrong in a way
   * the file could not disclose. Only the export path sets this, and only
   * because it is bounded by batch rather than by result set (lib/export.ts).
   *
   * It also widens the row to `EXPORT_ONLY_COLUMNS` below, for the same reason:
   * a copy that dropped the rejection reason would hand back 17,842 records
   * with no text at all, which is precisely what D-070 exists to stop.
   */
  full?: boolean
  /**
   * Also carry the KEV columns. Only meaningful with `full`.
   *
   * A flag rather than always-on, because the `kev` table only exists once a
   * catalog has been loaded (M6). The distinction is not cosmetic: **absent
   * columns say this export does not cover KEV, and empty ones would say every
   * record is not known-exploited.** Only the export path sets it, and only
   * when the Worker has established a catalog is present.
   */
  kev?: boolean
}

/**
 * The columns an export carries and the record table does not.
 *
 * Kept off the screen because a list of 100 records is a place to *find* a
 * record, not to read one — the detail view renders these — and kept in the
 * file because an export is a copy (D-071). `lib/export.ts`'s `RECORD_COLUMNS`
 * names them in this order, and `tests/unit/export.test.ts` checks the two
 * against each other, because a mismatch would silently label every column
 * after the first one wrongly.
 */
export const EXPORT_ONLY_SQL = [
  't.title',
  't.reason',
  'c.reserved',
  'c.ssvc_expl',
  'c.ssvc_auto',
  'c.ssvc_impact',
] as const

/**
 * The KEV columns an export carries when this copy holds a catalog (M6).
 *
 * `kev_listed` is computed rather than left implicit: a consumer reading a file
 * where `kev_date_added` is empty cannot tell "not in KEV" from "the column was
 * not filled in", and this overlay's whole claim is about which of those it is.
 * CC0 adds nothing to carry (D-076 §1); the file's provenance line names the
 * catalog version, because "per CISA, as of …" is what keeps it a statement
 * about CISA's catalog rather than an endorsement by it.
 */
export const EXPORT_KEV_SQL = [
  KEV_MEMBER,
  'k.added',
  'k.due',
  // **Words, not the stored code**, and this is the one column where it
  // matters: `kev_listed`'s 0/1 is a boolean, but `ransomware`'s 0 means
  // *Unknown, per CISA* — and every spreadsheet reader will read a 0 beside a
  // 1 as "no". That is precisely the misreading `kev_listed` was computed to
  // prevent, and the one this milestone's whole framing is about (D-070's
  // "unknown is not none", applied to a second source). The CASE is this
  // file's own SQL; nothing caller-supplied reaches it.
  // One literal, for the reason `KEV_RANSOMWARE_ORDER` gives: split with `+`,
  // the bundler drops a segment and the browser gets SQL the source never had.
  `CASE WHEN k.cve IS NULL THEN '' WHEN k.ransomware = ${RANSOMWARE_KNOWN} THEN 'Known' WHEN k.ransomware = ${RANSOMWARE_UNKNOWN} THEN 'Unknown (per CISA)' ELSE 'not stated by CISA' END`,
  'k.name',
  'k.action',
] as const

/** The join an export needs for `EXPORT_KEV_SQL`. Shared with the dimensions. */
export const EXPORT_KEV_JOIN = JOIN_SQL_KEV

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
  const description = options.full ? 't.descr' : 'substr(t.descr, 1, 400)'
  const extra = options.full ? `, ${EXPORT_ONLY_SQL.join(', ')}` : ''
  // Only when the caller has established the table exists (M6). `full` alone is
  // not enough: an export from a copy that has never fetched a catalog carries
  // no KEV columns rather than empty ones.
  const withKev = Boolean(options.full && options.kev)
  const kevColumns = withKev ? `, ${EXPORT_KEV_SQL.join(', ')}` : ''
  const kevJoin = withKev ? ` ${EXPORT_KEV_JOIN}` : ''
  return {
    sql:
      `SELECT c.cve_id AS cve, c.state, c.published, c.updated, c.cvss_ver, c.cvss_score, ` +
      `c.cvss_sev, n.name AS cna, ${description} AS description${extra}${kevColumns} ` +
      `FROM cve c LEFT JOIN cna n ON n.id = c.cna_id LEFT JOIN cve_text t ON t.cve_id = c.id` +
      `${kevJoin} ` +
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
 * The axes an aggregate can group by — every filter axis, plus four time
 * grains.
 *
 * All four are computed from `c.published`. The stored `c.year` is the year in
 * the CVE identifier, not necessarily the year the record was published. They
 * are separate dimensions rather
 * than one dimension with a grain parameter because that keeps the report
 * definition flat — one field naming an axis — which is both simpler to
 * validate coming out of a URL fragment and simpler for a small model to emit
 * correctly (D-044, M7).
 *
 * `quarter` stays a dimension the definition accepts — a permalink or a saved
 * report may still carry it, and a model may still ask for it — but the canvas
 * offers `week`, `month` and `year` (UI polish, 2026-08-16).
 */
export const DIMENSIONS = [
  'year',
  'quarter',
  'month',
  'week',
  'severity',
  'cvssVersion',
  'ssvcExpl',
  'ssvcAuto',
  'ssvcImpact',
  'kev',
  'kevRansomware',
  'state',
  'cna',
  'vendor',
  'product',
  'cwe',
  'host',
] as const

export type Dimension = (typeof DIMENSIONS)[number]

/** Dimensions whose buckets are points in time, ordered by the axis not by size. */
export const TIME_DIMENSIONS = new Set<Dimension>(['year', 'quarter', 'month', 'week'])

/** What each axis is called on screen. Beside the other label maps, and typed
 * against `Dimension`, so adding an axis cannot leave a picker showing a key. */
export const DIMENSION_LABELS: Record<Dimension, string> = {
  year: 'Year',
  quarter: 'Quarter',
  month: 'Month',
  week: 'Week',
  severity: 'Severity',
  cvssVersion: 'CVSS version',
  ssvcExpl: 'SSVC exploitation',
  ssvcAuto: 'SSVC automatable',
  ssvcImpact: 'SSVC technical impact',
  kev: 'CISA KEV',
  kevRansomware: 'KEV ransomware use',
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
const CODE_DIMENSIONS = new Set<Dimension>([
  'severity',
  'cvssVersion',
  'ssvcExpl',
  'ssvcAuto',
  'ssvcImpact',
  'kev',
  'kevRansomware',
  'state',
])

/**
 * The code dimensions whose axis reads in an order this file defines rather
 * than by bucket size — `order` on their `DimensionSql`.
 *
 * A list rather than a chain of `||`, because it is consulted in two places and
 * the two drifting apart would mean a chart's rows and its grouped counts
 * disagreeing about what "first" means.
 */
const FIXED_ORDER_DIMENSIONS = new Set<Dimension>([
  'cvssVersion',
  'ssvcExpl',
  'ssvcAuto',
  'ssvcImpact',
  'kev',
  'kevRansomware',
])

/** The two KEV axes, which share a join, an encoding and a complement bucket. */
export const KEV_DIMENSIONS = new Set<Dimension>(['kev', 'kevRansomware'])

/**
 * The code dimensions whose NULL bucket is a **missing assessment** rather than
 * a missing lookup row — so it is always drawn, always named, and always last
 * on the axis (D-070, D-073).
 *
 * Exported because the chart layer has to give it the off-ramp neutral: an
 * absence must not be placeable on the scale beside the levels.
 */
export const ABSENCE_DIMENSIONS = new Set<Dimension>([
  'severity',
  'ssvcExpl',
  'ssvcAuto',
  'ssvcImpact',
])

/** The three SSVC axes, which share an encoding, an ordering and a NULL band. */
export const SSVC_DIMENSIONS = new Set<Dimension>(['ssvcExpl', 'ssvcAuto', 'ssvcImpact'])

/** Which label map a code dimension's buckets are named from. */
export const CODE_LABELS: Partial<Record<Dimension, Record<number, string>>> = {
  severity: SEVERITY_LABELS,
  cvssVersion: CVSS_VERSION_LABELS,
  state: STATE_LABELS,
  ssvcExpl: SSVC_EXPL_LABELS,
  ssvcAuto: SSVC_AUTO_LABELS,
  ssvcImpact: SSVC_IMPACT_LABELS,
  kev: KEV_LABELS,
  kevRansomware: KEV_RANSOMWARE_LABELS,
}

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
/**
 * A week is labelled by its Monday, as a `YYYY-MM-DD` day: `'weekday 0'` moves
 * a date forward to the next Sunday (or leaves a Sunday alone), and six days
 * back from that Sunday is the Monday that opened the week. Weeks are
 * Monday-to-Sunday rather than `%W`, whose week 00 is a stub that changes size
 * every year and whose labels are not dates a reader can place.
 */
const WEEK_EXPR = "date(c.published, 'unixepoch', 'weekday 0', '-6 days')"

/** Storage codes are identifiers: 4 (v4.0) belongs after 31 (v3.1). */
const CVSS_VERSION_ORDER =
  'CASE WHEN c.cvss_ver = 2 THEN 0 WHEN c.cvss_ver = 30 THEN 1 ' +
  'WHEN c.cvss_ver = 31 THEN 2 WHEN c.cvss_ver = 4 THEN 3 ' +
  'WHEN c.cvss_ver IS NULL THEN 5 ELSE 4 END'

/**
 * An SSVC axis in code order with the unassessed records **last**.
 *
 * SQLite sorts NULL first ascending, which would open every exploitation
 * breakdown on the band that is an absence rather than a level, and put it at
 * the baseline of a stack where its size distorts the trend above it — the
 * position D-073 reserved for the series a reader can actually compare. The
 * codes are this file's own; nothing caller-supplied reaches here.
 */
function absentLast(column: string): string {
  return `CASE WHEN ${column} IS NULL THEN 99 ELSE ${column} END`
}

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
type JoinGroup = 'prod' | 'cwe' | 'ref' | 'cna' | 'kev'

/**
 * **`CROSS JOIN` is load-bearing, not a synonym.** In SQLite it is an inner
 * join whose *order the optimizer may not change* — the documented way to pin a
 * driving table — and it is what makes these aggregates usable at full scale.
 *
 * Every one of these chains must be walked the same way: start from the `cve`
 * rows the `WHERE` clause already narrowed, then expand through the link table
 * by `cve_id`. That is precisely the access path `schema.sql` was built for —
 * link tables are WITHOUT ROWID with `cve_id` leading the primary key — and it
 * is a seek per record rather than a scan.
 *
 * Left free, the planner inverts it once statistics exist (D-067 ships them,
 * and the client derives them when an artifact predates that). Measured at full
 * scale, 372,322 records: driving from `cwe`'s 797 rows instead makes
 * `CWE × Severity` **24.1 s** and `Vendor × CWE` **24.4 s**, against **239 ms**
 * and **383 ms** pinned — 101× and 64×. The same statistics leave every other
 * shape unchanged, so this is not an argument against `ANALYZE`; it is the
 * planner making a locally reasonable choice that is catastrophic here, because
 * it turns one covering-index scan into ~190,000 random lookups into the
 * corpus table.
 *
 * It cannot change an answer — `CROSS JOIN` and `JOIN` are semantically
 * identical in SQLite — and `tests/unit/filters.test.ts` executes these against
 * the real schema, so the correctness claim is checked rather than asserted.
 */
const JOIN_SQL: Record<JoinGroup, string> = {
  prod:
    'CROSS JOIN cve_prod cp ON cp.cve_id = c.id JOIN product p ON p.id = cp.product_id ' +
    'JOIN vendor v ON v.id = p.vendor_id',
  cwe: 'CROSS JOIN cve_cwe x ON x.cve_id = c.id JOIN cwe w ON w.id = x.cwe_id',
  ref:
    'CROSS JOIN cve_ref r ON r.cve_id = c.id JOIN url u ON u.id = r.url_id ' +
    'JOIN host h ON h.id = u.host_id',
  // Not pinned, and not a link table: a scalar foreign key reached by a LEFT
  // JOIN, where there is no join order to get wrong.
  cna: 'LEFT JOIN cna n ON n.id = c.cna_id',
  // Nor is this one — see `JOIN_SQL_KEV` above, which the export path shares.
  kev: JOIN_SQL_KEV,
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
  week: { key: WEEK_EXPR, label: WEEK_EXPR, group: WEEK_EXPR },
  severity: { key: 'c.cvss_sev', label: 'c.cvss_sev', group: 'c.cvss_sev' },
  cvssVersion: {
    key: 'c.cvss_ver',
    label: 'c.cvss_ver',
    group: 'c.cvss_ver',
    order: CVSS_VERSION_ORDER,
  },
  ssvcExpl: {
    key: 'c.ssvc_expl',
    label: 'c.ssvc_expl',
    group: 'c.ssvc_expl',
    order: absentLast('c.ssvc_expl'),
  },
  ssvcAuto: {
    key: 'c.ssvc_auto',
    label: 'c.ssvc_auto',
    group: 'c.ssvc_auto',
    order: absentLast('c.ssvc_auto'),
  },
  ssvcImpact: {
    key: 'c.ssvc_impact',
    label: 'c.ssvc_impact',
    group: 'c.ssvc_impact',
    order: absentLast('c.ssvc_impact'),
  },
  kev: {
    key: KEV_MEMBER,
    label: KEV_MEMBER,
    group: KEV_MEMBER,
    order: KEV_MEMBER_ORDER,
    join: 'kev',
  },
  kevRansomware: {
    key: KEV_RANSOMWARE,
    label: KEV_RANSOMWARE,
    group: KEV_RANSOMWARE,
    order: KEV_RANSOMWARE_ORDER,
    join: 'kev',
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
 * 24,436 and nothing renders that. Raised from 250 for the weekly grain: five
 * years of weeks is 261 buckets, and the workspace opens on exactly that. */
export const GROUP_LIMIT = 400

/**
 * Counts by one dimension, under the same filters as the list.
 *
 * Ordered by count for the dimensions where "the top ones" is the question, and
 * by the key itself for the time-like ones, where a chart wants the axis in
 * order — cut, when over the cap, at the *old* end, the same end `crossSql`
 * cuts (aligned 2026-08-16; it used to keep the oldest buckets, so a
 * one-dimension "CVEs by month" answered about 1999 where the two-dimension
 * one answered about now).
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
  const select =
    `SELECT ${shape.key} AS bucket, ${shape.label} AS label, ${countFor([shape])} AS cves ` +
    `FROM cve c ${joinsFor([shape])} WHERE ${where} GROUP BY ${shape.group}`

  if (TIME_DIMENSIONS.has(dimension)) {
    // A time axis over its cap keeps the *recent* end, as `crossSql`'s
    // narrowing does — with 336 months in the corpus, `ORDER BY month ASC
    // LIMIT 12` would silently answer about 1999 — and still reads oldest
    // first. The two cannot be one ORDER BY, and the sentinel row (`bounded +
    // 1`, which the Worker turns into a truncation flag by *stopping on it*)
    // has to come out last: narrowed newest-first and re-sorted ascending, the
    // extra row would be the oldest and come out first, and the Worker would
    // keep it and drop the newest. So the narrowing takes `bounded + 1`
    // newest-first, `extra` names the one row past the cap if there is one,
    // and the final order puts that row after the rest. `IS` rather than `=`
    // because a bucket can be NULL — a record with no publication date — and
    // the EXISTS guard keeps a NULL bucket from matching an empty `extra`.
    return {
      sql:
        `WITH recent AS (${select} ORDER BY ${shape.key} DESC LIMIT ?), ` +
        `extra AS (SELECT bucket FROM recent ORDER BY bucket DESC LIMIT 1 OFFSET ?) ` +
        `SELECT bucket, label, cves FROM recent ` +
        `ORDER BY (EXISTS (SELECT 1 FROM extra) AND bucket IS (SELECT bucket FROM extra)), ` +
        `bucket ASC LIMIT ?`,
      params: [...params, bounded + 1, bounded, bounded + 1],
      limit: bounded,
    }
  }

  // Scales read in their own order; identities read biggest-first, because
  // "which are the top ones" is the question being asked of them. `state` is
  // the exception among the codes: PUBLISHED before REJECTED is the reading
  // order, and its stored codes run the other way.
  const ordered = FIXED_ORDER_DIMENSIONS.has(dimension)
    ? `${axisOrder(shape)} ASC`
    : dimension === 'state'
      ? `${shape.key} DESC`
      : 'cves DESC'
  return {
    sql: `${select} ORDER BY ${ordered} LIMIT ?`,
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
export const CROSS_ROW_LIMIT = 400
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
