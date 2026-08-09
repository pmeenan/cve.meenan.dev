/**
 * One record, in full (M4).
 *
 * This is the first surface that reaches the two sections D-033 argued into the
 * schema and nothing has rendered since: **affected version ranges** (95.0%
 * prevalence, +14.4 MB compressed) and **references** (95.1%, +23.0 MB). Until
 * now they were bytes every user downloaded and no query touched. From M7 it is
 * also what D-044's "CVE detail" chat tool renders through, which is why the
 * queries live here rather than inside the Worker's message handler.
 *
 * Five small queries rather than one join. A record affecting 40 products with
 * 200 version rows and 30 references would come back as a 240,000-row cross
 * product from a single statement, and the Worker would hold every copy of the
 * description in it. Each query below is bounded on its own terms and reports
 * when its bound was hit.
 *
 * Every value here is attacker-influenced text (rule 4). It reaches SQL as a
 * bound parameter and the DOM as a text node; the reference URLs additionally
 * go through `lib/sanitize.ts` before anything makes one a link.
 */

import type { SqlParam } from './filters'

/** `cve_ver.status`, as stored. */
export const VERSION_STATUS: Record<number, string> = {
  1: 'affected',
  2: 'unaffected',
  3: 'unknown',
}

/**
 * Per-section caps.
 *
 * Generous against the real corpus — the widest record has far fewer rows than
 * any of these — and present so that one pathological record cannot make the
 * detail view the most expensive thing in the app. Each is reported when it
 * bites, because a truncated list of affected versions is a security-relevant
 * omission rather than a display detail.
 */
export const DETAIL_LIMITS = {
  cwes: 64,
  products: 400,
  versions: 800,
  references: 400,
} as const

export interface DetailQuery {
  sql: string
  params: SqlParam[]
  limit: number
}

/**
 * Look records up by the canonical id, case-insensitively.
 *
 * `cve.cve_id` carries a UNIQUE index, which is the one index the schema keeps
 * specifically because the client looks records up by ID — but `lower()` on the
 * column defeats it, so each of these is a scan of 372,322 short strings. That
 * measures in single-digit milliseconds and is worth it: a permalink or a chat
 * tool call carrying `cve-2021-44228` must find the record rather than report
 * that it does not exist.
 */
const BY_ID = 'lower(c.cve_id) = ?'

function key(cveId: string): string {
  return cveId.trim().toLowerCase()
}

/**
 * The record itself. `cve_text` is a LEFT JOIN: 4.46% have no English
 * description (D-023).
 *
 * `reason` is why the REJECTED half of that number stops rendering blank —
 * every one of the 17,842 REJECTED records has its only English text there
 * (D-070). `title` and the three SSVC codes come from the same row set, so the
 * detail view costs the same one query it did at schema 1.
 */
export function recordSql(cveId: string): DetailQuery {
  return {
    sql:
      `SELECT c.cve_id, c.state, c.year, c.published, c.updated, c.cvss_ver, c.cvss_score, ` +
      `c.cvss_sev, c.cvss_vec, n.name AS cna, t.descr, t.title, t.reason, c.reserved, ` +
      `c.ssvc_expl, c.ssvc_auto, c.ssvc_impact ` +
      `FROM cve c LEFT JOIN cna n ON n.id = c.cna_id LEFT JOIN cve_text t ON t.cve_id = c.id ` +
      `WHERE ${BY_ID} LIMIT 1`,
    params: [key(cveId)],
    limit: 1,
  }
}

export function cwesSql(cveId: string): DetailQuery {
  return {
    sql:
      `SELECT w.cwe, w.descr FROM cve c JOIN cve_cwe x ON x.cve_id = c.id ` +
      `JOIN cwe w ON w.id = x.cwe_id WHERE ${BY_ID} ORDER BY w.cwe LIMIT ?`,
    params: [key(cveId), DETAIL_LIMITS.cwes + 1],
    limit: DETAIL_LIMITS.cwes,
  }
}

/**
 * The affected products, from the link table.
 *
 * Separate from the version ranges because they answer different questions and
 * because 5.0% of records have products with no version rows at all — folding
 * them together would make those records look like they affect nothing.
 */
export function productsSql(cveId: string): DetailQuery {
  return {
    sql:
      `SELECT v.name AS vendor, p.name AS product, cp.default_status FROM cve c ` +
      `JOIN cve_prod cp ON cp.cve_id = c.id JOIN product p ON p.id = cp.product_id ` +
      `LEFT JOIN vendor v ON v.id = p.vendor_id WHERE ${BY_ID} ` +
      `ORDER BY v.name, p.name LIMIT ?`,
    params: [key(cveId), DETAIL_LIMITS.products + 1],
    limit: DETAIL_LIMITS.products,
  }
}

/**
 * Version ranges (D-033).
 *
 * `status`, `version`, `lt` and `lte` together are what upstream said: a row
 * may be an exact version, a `< x` bound, a `<= x` bound, or a status with
 * neither. All four columns are returned rather than pre-formatted, because
 * collapsing them into a sentence in SQL would hide which of the four shapes a
 * row actually is.
 *
 * `default_status` comes along since schema 2, and it is what makes the rows
 * readable rather than merely present (D-070). It governs every version the
 * record does *not* list, so with `defaultStatus: affected` the listed
 * `unaffected` rows are the **fixed** versions and everything else is
 * vulnerable — the inverse of the natural reading of the rows alone. It is
 * joined from `cve_prod` rather than stored per version row, so a record whose
 * product has no `cve_prod` row (impossible today, but the join is a LEFT one
 * anyway) shows the rows without inventing a default.
 */
export function versionsSql(cveId: string): DetailQuery {
  return {
    sql:
      `SELECT v.name AS vendor, p.name AS product, cv.status, cv.version, cv.lt, cv.lte, ` +
      `t.name AS vtype, cp.default_status FROM cve c JOIN cve_ver cv ON cv.cve_id = c.id ` +
      `LEFT JOIN product p ON p.id = cv.product_id ` +
      `LEFT JOIN vendor v ON v.id = p.vendor_id LEFT JOIN vtype t ON t.id = cv.vtype ` +
      `LEFT JOIN cve_prod cp ON cp.cve_id = c.id AND cp.product_id = cv.product_id ` +
      `WHERE ${BY_ID} ORDER BY v.name, p.name, cv.status, cv.version LIMIT ?`,
    params: [key(cveId), DETAIL_LIMITS.versions + 1],
    limit: DETAIL_LIMITS.versions,
  }
}

/**
 * References (D-033).
 *
 * The URL and its interned host come back separately: the host is what the UI
 * shows beside the link, so the reader knows where a link goes before deciding
 * whether to follow it. Nothing here fetches anything — a URL in a CVE record
 * is attacker-supplied, and auto-fetching one is what rule 4 and D-011's
 * referrer concern exist to prevent.
 */
export function referencesSql(cveId: string): DetailQuery {
  return {
    sql:
      `SELECT u.url, h.name AS host FROM cve c JOIN cve_ref r ON r.cve_id = c.id ` +
      `JOIN url u ON u.id = r.url_id LEFT JOIN host h ON h.id = u.host_id ` +
      `WHERE ${BY_ID} ORDER BY h.name, u.url LIMIT ?`,
    params: [key(cveId), DETAIL_LIMITS.references + 1],
    limit: DETAIL_LIMITS.references,
  }
}

/**
 * Whether this copy holds the record at all (M7).
 *
 * Its own query rather than a field on another, because it answers a question
 * none of the others can: `kevSql` returning nothing means either "CISA does not
 * list it" or "this copy has never heard of it", and the chat layer's
 * `kev_lookup` must not report the second as the first — absence from CISA's
 * catalog is a finding, and a record the corpus lacks is not (D-077's rule,
 * one level down). Through `BY_ID` like every other lookup here, so a lowercase
 * identifier finds the record.
 */
export function existsSql(cveId: string): DetailQuery {
  return { sql: `SELECT 1 FROM cve c WHERE ${BY_ID} LIMIT 1`, params: [key(cveId)], limit: 1 }
}

/**
 * This record's KEV entry, if CISA lists it (M6, D-076).
 *
 * A sixth query rather than a join onto the record's own: the `kev` table only
 * exists once a catalog has been loaded, so folding it into `recordSql` would
 * make the whole detail view fail on a copy that has none — and this is a
 * lookup by primary key against 1,662 rows.
 *
 * Joined on `k.cve_id = c.id` rather than on the two id *strings*, so it is an
 * integer comparison against the primary key this table was indexed for
 * (`i_kev_cve`) instead of a text comparison whose result would depend on
 * collation. `cve.cve_id` is UNIQUE and the catalog holds one entry per CVE, so
 * at most one row comes back either way.
 */
export function kevSql(cveId: string): DetailQuery {
  return {
    sql:
      `SELECT k.added, k.due, k.name, k.descr, k.action, k.ransomware, k.notes, k.cwes, ` +
      `k.vendor, k.product FROM cve c JOIN kev k ON k.cve_id = c.id WHERE ${BY_ID} LIMIT 1`,
    params: [key(cveId)],
    limit: 1,
  }
}

/**
 * A CVE identifier the detail view will accept.
 *
 * Bounded and shaped before it becomes a query, because it arrives from a URL
 * fragment and from a chat tool call. Not a validation of whether the record
 * exists — that is the query's answer — just of whether this is the kind of
 * string that could name one.
 */
export function isCveId(value: unknown): value is string {
  return typeof value === 'string' && /^CVE-\d{4}-\d{4,12}$/i.test(value.trim())
}
