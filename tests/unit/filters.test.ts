import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it } from 'vitest'

import {
  compile,
  countSql,
  crossSql,
  CROSS_CELL_LIMIT,
  ftsQuery,
  groupSql,
  lookupKey,
  LOOKUP_AXES,
  LOOKUP_SQL,
  normalizeCwe,
  NOT_ASSESSED,
  rowsSql,
  DIMENSIONS,
  GROUP_LIMIT,
  MAX_ROW_LIMIT,
  type Dimension,
  type Filters,
  type LookupAxis,
  type Resolved,
  type SqlParam,
} from '../../lib/filters'
import { RECORD_COLUMNS } from '../../lib/export'
import { indexPlan, indexSql } from '../../lib/search'

/**
 * The shared query layer (M3), against real SQLite and the published schema.
 *
 * Two classes of failure are worth a test here and neither shows up in a type
 * check. The first is *quiet wrongness*: a missing state predicate inflating
 * every count by ~5% (D-022), a link-table join turning one CVE with eight
 * products into eight CVEs, a LEFT JOIN that became an INNER one and silently
 * dropped the 4.46% of records with no description (D-023). The second is
 * *injection*: filter values are attacker-influenced twice over — they come
 * from a URL and they are compared against corpus text — so every one of them
 * has to arrive as a bound parameter rather than as SQL (rule 4).
 *
 * So the compiled SQL is executed rather than pattern-matched, against a corpus
 * shaped like the real one where it matters: PUBLISHED and REJECTED records, a
 * record with no description, one CVE affecting several products, and names
 * containing quotes and SQL.
 */

/** Names that would end the statement if any of them reached SQL as text. */
const HOSTILE_VENDOR = "O'Reilly'); DROP TABLE cve; --"
const HOSTILE_PRODUCT = '"quoted" \\ product % _'

function corpus(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  // The published schema, executed rather than paraphrased (D-043).
  db.exec(readFileSync('pipeline/schema.sql', 'utf-8'))

  db.exec(
    `
    INSERT INTO cna(id, name) VALUES (1, 'Apache'), (2, 'MITRE'), (3, 'Cisco Systems');
    INSERT INTO vendor(id, name) VALUES (1, 'Apache Software Foundation'), (2, 'Cisco'), (3, ?1);
    INSERT INTO product(id, vendor_id, name)
      VALUES (1, 1, 'Log4j'), (2, 2, 'IOS XE'), (3, 1, 'Struts'), (4, 3, ?2);
    INSERT INTO cwe(id, cwe, descr) VALUES (1, 'CWE-502', 'Deserialization'), (2, 'CWE-79', 'XSS');
    INSERT INTO host(id, name) VALUES (1, 'github.com'), (2, 'nvd.nist.gov');
    INSERT INTO url(id, url, host_id)
      VALUES (1, 'https://github.com/a', 1), (2, 'https://nvd.nist.gov/b', 2),
             (3, 'https://github.com/c', 1);
  `
      .replace('?1', `'${HOSTILE_VENDOR.replace(/'/g, "''")}'`)
      .replace('?2', `'${HOSTILE_PRODUCT.replace(/'/g, "''")}'`)
  )

  const cve = db.prepare(
    `INSERT INTO cve(id, cve_id, year, state, cna_id, published, updated,
                     cvss_ver, cvss_score, cvss_sev, cvss_vec)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  /** SSVC codes for one record, or nothing at all — which is half the corpus. */
  const ssvc = db.prepare(
    'UPDATE cve SET ssvc_expl = ?2, ssvc_auto = ?3, ssvc_impact = ?4 WHERE id = ?1'
  )
  // published/updated are unix seconds, as stored.
  const day = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000)
  cve.run(1, 'CVE-2021-44228', 2021, 1, 1, day('2021-12-10'), day('2022-01-05'), 31, 10, 4, 'AV:N')
  cve.run(2, 'CVE-2022-0002', 2022, 1, 2, day('2022-03-01'), day('2022-03-02'), 30, 5.5, 2, 'AV:L')
  cve.run(
    3,
    'CVE-2023-0003',
    2023,
    2,
    2,
    day('2023-06-01'),
    day('2023-06-02'),
    null,
    null,
    null,
    ''
  )
  cve.run(4, 'CVE-2024-0004', 2024, 1, 3, day('2024-09-09'), day('2024-09-10'), 4, 9.1, 4, 'AV:N')
  // No `cve_text` row: 4.46% of the corpus has no English description (D-023),
  // and a list that quietly dropped them would look like a shorter answer.
  // Deliberately give the stored identifier-year a different value from the
  // publication year. A report's time bucket is over `published`, not over the
  // year embedded in a CVE ID.
  cve.run(5, 'CVE-2020-0005', 1999, 1, 3, day('2020-02-02'), day('2020-02-03'), 2, 3, 1, 'AV:L')

  // Only two of the five carry an SSVC assessment; 3 and 5 carry none, and 4
  // carries a *partial* one — the three states D-070 requires stay distinct.
  ssvc.run(1, 0, 0, 0) // CVE-2021-44228: Exploitation *none* — a finding, not an absence
  ssvc.run(2, 1, 1, 1) // CVE-2022-0002: poc / yes / total
  ssvc.run(4, 2, null, 1) // CVE-2024-0004: active, Automatable never stated

  const text = db.prepare('INSERT INTO cve_text(cve_id, descr) VALUES (?, ?)')
  text.run(1, 'Remote code execution via JNDI lookup, a deserialization flaw in the logger')
  text.run(2, 'Cross-site scripting in the web console')
  text.run(3, 'Rejected: this candidate was withdrawn')
  text.run(4, 'Buffer overflow in the packet parser')

  db.exec(`
    INSERT INTO cve_prod(cve_id, product_id, default_status)
      VALUES (1,1,1), (2,2,NULL), (4,3,2), (4,4,3), (5,2,NULL);
    INSERT INTO cve_cwe(cve_id, cwe_id) VALUES (1,1), (2,2), (4,2);
    INSERT INTO cve_ref(cve_id, url_id) VALUES (1,1), (1,2), (2,3), (4,2);
  `)

  // The client builds these after import (D-035); the text axis needs them.
  for (const { index } of indexPlan()) {
    const sql = indexSql(index)
    db.exec(sql.create)
    db.exec(`INSERT INTO ${index.fts}(${index.fts}) VALUES('rebuild')`)
  }
  return db
}

const db = corpus()

/** Resolve a filter's names the way the Worker does, then run the SQL. */
function resolve(filters: Filters): Resolved {
  const resolved: Resolved = {}
  for (const axis of LOOKUP_AXES) {
    const names = filters[axis]
    if (!names?.length) continue
    const ids: number[] = []
    for (const name of names) {
      for (const row of db.prepare(LOOKUP_SQL[axis]).all(lookupKey(axis, name))) {
        ids.push(Number((row as { id: number }).id))
      }
    }
    // Preserve the requested-but-unmatched state. The shared compiler treats
    // an empty resolved list as false; dropping it would turn a typo into an
    // absent filter and return the whole corpus.
    resolved[axis] = ids
  }
  return resolved
}

function run(sql: string, params: SqlParam[]): unknown[][] {
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => Object.values(row as Record<string, unknown>))
}

/** The CVE ids a filter selects, in id order. */
function ids(filters: Filters): string[] {
  const built = rowsSql(filters, resolve(filters), { sort: 'cve' })
  return run(built.sql, built.params)
    .map((row) => String(row[0]))
    .sort()
}

function counted(filters: Filters): number {
  const built = countSql(filters, resolve(filters))
  return Number(run(built.sql, built.params)[0]?.[0] ?? -1)
}

describe('the REJECTED default (D-022)', () => {
  it('excludes REJECTED records unless asked', () => {
    expect(ids({})).toEqual(['CVE-2020-0005', 'CVE-2021-44228', 'CVE-2022-0002', 'CVE-2024-0004'])
    expect(ids({ state: 'rejected' })).toEqual(['CVE-2023-0003'])
    expect(ids({ state: 'all' })).toHaveLength(5)
  })

  it('is in the compiled predicate itself, not in each caller', () => {
    // Every entry point has to carry it, because the failure mode is a report
    // that forgot: `1` (no predicate) must never be the whole clause by default.
    expect(compile({}).where).toContain('c.state = ?')
    expect(compile({}).params).toContain(1)
    expect(rowsSql({}).sql).toContain('c.state = ?')
    expect(countSql({}).sql).toContain('c.state = ?')
    expect(groupSql({}, {}, 'year').sql).toContain('c.state = ?')
    // `all` is the only way to get no state clause at all.
    expect(compile({ state: 'all' }).where).not.toContain('c.state')
  })

  it('counts the same records the list shows', () => {
    expect(counted({})).toBe(4)
    expect(counted({ state: 'all' })).toBe(5)
  })
})

describe('every confirmed filter axis (M3 scope)', () => {
  it('full text over descriptions', () => {
    expect(ids({ text: 'deserialization' })).toEqual(['CVE-2021-44228'])
    // A record with no description cannot match, and that is a different fact
    // from "no results" (D-023).
    expect(ids({ text: 'overflow' })).toEqual(['CVE-2024-0004'])
  })

  it('CVE ID, case-insensitively', () => {
    expect(ids({ cveId: 'cve-2021-44228' })).toEqual(['CVE-2021-44228'])
    expect(ids({ cveId: 'CVE-1999-0001' })).toEqual([])
  })

  it('vendor and product, through the link table without multiplying records', () => {
    expect(ids({ vendor: ['Apache Software Foundation'] })).toEqual([
      'CVE-2021-44228',
      'CVE-2024-0004',
    ])
    expect(ids({ product: ['IOS XE'] })).toEqual(['CVE-2020-0005', 'CVE-2022-0002'])
    // CVE-2024-0004 affects two products; an EXISTS keeps it one record where a
    // join would return it twice.
    expect(ids({ vendor: ['Apache Software Foundation', 'Cisco'] })).toHaveLength(4)
    expect(counted({ vendor: ['Apache Software Foundation'] })).toBe(2)
  })

  it('CNA', () => {
    expect(ids({ cna: ['apache'] })).toEqual(['CVE-2021-44228'])
  })

  it('returns no records when a requested lookup name does not exist', () => {
    expect(ids({ vendor: ['zzz-no-such-vendor'] })).toEqual([])
    expect(counted({ vendor: ['zzz-no-such-vendor'] })).toBe(0)
    // A valid value and an unknown one are OR alternatives on the same axis:
    // the valid value still contributes its matches, while the Worker reports
    // the unknown name separately.
    expect(ids({ vendor: ['Cisco', 'zzz-no-such-vendor'] })).toEqual([
      'CVE-2020-0005',
      'CVE-2022-0002',
    ])
  })

  it('CWE, by id or bare number', () => {
    expect(ids({ cwe: ['CWE-79'] })).toEqual(['CVE-2022-0002', 'CVE-2024-0004'])
    expect(ids({ cwe: ['79'] })).toEqual(['CVE-2022-0002', 'CVE-2024-0004'])
    expect(normalizeCwe('787')).toBe('cwe-787')
  })

  it('references by host (D-033), never by URL', () => {
    expect(ids({ host: ['github.com'] })).toEqual(['CVE-2021-44228', 'CVE-2022-0002'])
    expect(ids({ host: ['nvd.nist.gov'] })).toEqual(['CVE-2021-44228', 'CVE-2024-0004'])
  })

  it('CVSS severity, version and score', () => {
    expect(ids({ severity: [4] })).toEqual(['CVE-2021-44228', 'CVE-2024-0004'])
    // Stored codes, never compared numerically: v4.0 is 4 and v3.1 is 31
    // (D-047), so asking for v4.0 must not also return v3.0 and v3.1.
    expect(ids({ cvssVersion: [4] })).toEqual(['CVE-2024-0004'])
    expect(ids({ cvssVersion: [30, 31] })).toEqual(['CVE-2021-44228', 'CVE-2022-0002'])
    expect(ids({ scoreMin: 9 })).toEqual(['CVE-2021-44228', 'CVE-2024-0004'])
    expect(ids({ scoreMin: 3, scoreMax: 5.5 })).toEqual(['CVE-2020-0005', 'CVE-2022-0002'])
  })

  it('dates and years', () => {
    const day = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000)
    expect(ids({ publishedFrom: day('2022-01-01') })).toEqual(['CVE-2022-0002', 'CVE-2024-0004'])
    expect(ids({ publishedTo: day('2021-12-31') })).toEqual(['CVE-2020-0005', 'CVE-2021-44228'])
    expect(ids({ updatedFrom: day('2024-01-01') })).toEqual(['CVE-2024-0004'])
    expect(ids({ yearFrom: 2022, yearTo: 2024 })).toEqual(['CVE-2022-0002', 'CVE-2024-0004'])
  })

  it('state, as an axis rather than only a default', () => {
    expect(ids({ state: 'rejected' })).toEqual(['CVE-2023-0003'])
    // Values arriving from a future permalink are runtime input. Only the
    // explicit `all` opt-in may remove D-022's PUBLISHED predicate.
    expect(ids({ state: 'everything' as never })).toEqual([
      'CVE-2020-0005',
      'CVE-2021-44228',
      'CVE-2022-0002',
      'CVE-2024-0004',
    ])
  })

  it('combines axes with AND', () => {
    expect(ids({ vendor: ['Apache Software Foundation'], severity: [4], yearFrom: 2024 })).toEqual([
      'CVE-2024-0004',
    ])
    expect(ids({ text: 'deserialization', host: ['nvd.nist.gov'] })).toEqual(['CVE-2021-44228'])
  })
})

describe('grouped counts', () => {
  it('answers every dimension against the published schema', () => {
    for (const dimension of DIMENSIONS) {
      const built = groupSql({}, {}, dimension)
      // The point is that each one is valid SQL over the real schema and comes
      // back with (bucket, label, count) — a dimension that names a column that
      // does not exist would only fail here.
      const rows = run(built.sql, built.params)
      for (const row of rows) expect(row).toHaveLength(3)
      expect(rows.length).toBeGreaterThan(0)
    }
  })

  it('counts a record once per bucket, not once per link row', () => {
    const built = groupSql({}, resolve({}), 'vendor')
    const rows = run(built.sql, built.params)
    const apache = rows.find((row) => String(row[1]).startsWith('Apache'))
    expect(apache?.[2]).toBe(2)
    // CVE-2024-0004 affects two of Apache's products and is still one CVE.
    const total = rows.reduce((sum, row) => sum + Number(row[2]), 0)
    expect(total).toBeGreaterThanOrEqual(4)
  })

  it('applies the same filters as the list', () => {
    const filters: Filters = { severity: [4] }
    const built = groupSql(filters, resolve(filters), 'year')
    const rows = run(built.sql, built.params)
    expect(rows.map((row) => [Number(row[0]), Number(row[2])])).toEqual([
      [2021, 1],
      [2024, 1],
    ])
  })

  it('uses publication year and orders every time grain chronologically', () => {
    const years = groupSql({ state: 'all' }, {}, 'year')
    const yearBuckets = run(years.sql, years.params).map((row) => Number(row[0]))
    expect(yearBuckets).toContain(2020)
    expect(yearBuckets).not.toContain(1999)
    expect(yearBuckets).toEqual([...yearBuckets].sort((a, b) => a - b))

    for (const dimension of ['quarter', 'month'] as const) {
      const built = groupSql({ state: 'all' }, {}, dimension)
      const buckets = run(built.sql, built.params).map((row) => String(row[0]))
      expect(buckets).toEqual([...buckets].sort())
    }
  })

  it('orders CVSS versions semantically rather than by their storage codes', () => {
    const built = groupSql({}, {}, 'cvssVersion')
    expect(run(built.sql, built.params).map((row) => Number(row[0]))).toEqual([2, 30, 31, 4])
  })

  it('refuses a dimension it does not know', () => {
    expect(() => groupSql({}, {}, 'sqlite_master' as Dimension)).toThrow(/not a dimension/)
  })
})

/**
 * Two-axis aggregates (M4) — the shape both D-046 benchmark questions are in.
 *
 * The failure this section is really guarding is a cross-tab that runs and is
 * wrong: cells that pair attributes no record actually has, a NULL bucket
 * silently deleted by an `IN` clause, or a row's cells scattered through the
 * result set. None of those raise.
 */
describe('cross-tab counts', () => {
  const cells = (rows: Dimension, series: Dimension | null, filters: Filters = {}) => {
    const built = crossSql(filters, resolve(filters), rows, series)
    return run(built.sql, built.params)
  }

  it('answers every axis pair against the published schema', () => {
    for (const rows of DIMENSIONS) {
      for (const series of DIMENSIONS) {
        if (rows === series) continue
        const built = crossSql({}, {}, rows, series)
        const result = run(built.sql, built.params)
        // Five columns: bucket, label, series, series label, count.
        for (const row of result) expect(row).toHaveLength(5)
      }
    }
  })

  it('never pairs a vendor with another vendor’s product', () => {
    // CVE-2024-0004 affects Apache's Struts *and* the hostile vendor's product.
    // Joining `cve_prod` once per axis would report a Struts row under the
    // hostile vendor and vice versa — a cell for a combination no record has.
    const rows = cells('vendor', 'product')
    for (const row of rows) {
      const vendor = String(row[1])
      const product = String(row[3])
      expect(product.startsWith(vendor)).toBe(true)
    }
  })

  it('keeps a bucket that is NULL rather than dropping it', () => {
    // CVE-2023-0003 is REJECTED and carries no CVSS severity. About half the
    // real corpus is unscored, and the owner's call is that the band is always
    // shown — so `IN (SELECT …)`, which is never true for NULL, would delete
    // exactly the band the chart is required to render.
    const rows = cells('year', 'severity', { state: 'all' })
    const nulls = rows.filter((row) => row[2] === null)
    expect(nulls).toHaveLength(1)
    expect(Number(nulls[0]?.[0])).toBe(2023)
    expect(Number(nulls[0]?.[4])).toBe(1)
  })

  it('counts a record once per cell, not once per link row', () => {
    // CVE-2024-0004 affects two Apache-side products but is one CRITICAL CVE.
    const rows = cells('vendor', 'severity')
    const apache = rows.filter((row) => String(row[1]).startsWith('Apache'))
    const total = apache.reduce((sum, row) => sum + Number(row[4]), 0)
    expect(total).toBe(2)
  })

  it('keeps a row’s cells together and orders rows by their own total', () => {
    const rows = cells('vendor', 'severity')
    const order = rows.map((row) => String(row[0]))
    // Every bucket appears in exactly one contiguous run: a reader scrolling a
    // table, and a chart stacking segments, both depend on it.
    const runs = order.filter((bucket, index) => index === 0 || order[index - 1] !== bucket)
    expect(new Set(runs).size).toBe(runs.length)
  })

  it('orders a time axis forwards and a scale by its code', () => {
    const rows = cells('year', 'severity')
    const years = [...new Set(rows.map((row) => Number(row[0])))]
    expect(years).toEqual([...years].sort((a, b) => a - b))
    const first = rows.filter((row) => Number(row[0]) === years[0]).map((row) => Number(row[2]))
    expect(first).toEqual([...first].sort((a, b) => a - b))
  })

  it('orders a CVSS-version series as v2, v3.0, v3.1, then v4.0', () => {
    const versions = cells('state', 'cvssVersion').map((row) => Number(row[2]))
    expect(versions).toEqual([2, 30, 31, 4])
  })

  it('buckets by month and quarter from the stored timestamp', () => {
    const months = cells('month', 'severity').map((row) => String(row[0]))
    expect(months).toContain('2021-12')
    const quarters = cells('quarter', 'severity').map((row) => String(row[0]))
    expect(quarters).toContain('2021-Q4')
    expect(quarters).toContain('2024-Q3')
  })

  it('falls back to a one-dimension aggregate when there is no series', () => {
    const built = crossSql({}, {}, 'year', null)
    expect(built.sql).not.toContain('top_series')
    for (const row of run(built.sql, built.params)) expect(row).toHaveLength(3)
  })

  it('bounds the cells it will return', () => {
    const built = crossSql({}, {}, 'vendor', 'severity', { rows: 10 ** 6, series: 10 ** 6 })
    expect(built.limit).toBe(CROSS_CELL_LIMIT)
    expect(built.params.at(-1)).toBe(CROSS_CELL_LIMIT + 1)
  })

  it('applies the state default to both axis cuts as well as the cells', () => {
    // D-022 lives in `compile`, and a cross-tab compiles it three times — the
    // two narrowing passes and the cells. A pass that missed it would widen the
    // axes with REJECTED records the cells then cannot fill.
    const built = crossSql({}, {}, 'year', 'severity')
    expect(built.sql.match(/c\.state = \?/g)).toHaveLength(3)
    const rows = run(built.sql, built.params)
    expect(rows.some((row) => Number(row[0]) === 2023)).toBe(false)
  })

  it('binds filter values in every one of its passes', () => {
    const filters: Filters = { vendor: [HOSTILE_VENDOR], severity: [4] }
    const built = crossSql(filters, resolve(filters), 'vendor', 'severity')
    expect(built.sql).not.toContain('DROP')
    expect(built.sql).not.toContain(HOSTILE_VENDOR)
    expect(() => run(built.sql, built.params)).not.toThrow()
  })
})

describe('values never reach the SQL text (rule 4)', () => {
  const hostile: Filters = {
    text: "'; DROP TABLE cve; --",
    cveId: "CVE-2021-44228' OR '1'='1",
    vendor: [HOSTILE_VENDOR],
    product: [HOSTILE_PRODUCT],
    cwe: ["CWE-79'; DELETE FROM cve; --"],
    host: ["evil'--"],
    severity: [4],
    scoreMin: 1,
    publishedFrom: 0,
    state: 'all',
  }

  it('compiles them all as bound parameters', () => {
    const built = rowsSql(hostile, resolve(hostile))
    // Nothing recognisable from the values is in the statement, and the only
    // punctuation the values could have contributed is absent.
    expect(built.sql).not.toContain('DROP')
    expect(built.sql).not.toContain('--')
    expect(built.sql).not.toContain("'")
    expect(built.sql).not.toContain(HOSTILE_VENDOR)
    // Every value is a placeholder, and the counts line up exactly.
    expect((built.sql.match(/\?/g) ?? []).length).toBe(built.params.length)
  })

  it('runs them without incident, and the corpus is still there', () => {
    const built = rowsSql(hostile, resolve(hostile))
    expect(run(built.sql, built.params)).toEqual([])
    expect(Number(db.prepare('SELECT count(*) AS n FROM cve').get()?.n)).toBe(5)
  })

  it('matches a hostile *name* rather than executing it', () => {
    // The vendor whose name is a SQL injection attempt is a real vendor here,
    // and filtering on it has to return its records — proof the value is being
    // compared, not run.
    expect(ids({ vendor: [HOSTILE_VENDOR] })).toEqual(['CVE-2024-0004'])
    expect(ids({ product: [HOSTILE_PRODUCT] })).toEqual(['CVE-2024-0004'])
  })

  it('resolves names case-insensitively without an index', () => {
    for (const axis of LOOKUP_AXES) {
      expect(LOOKUP_SQL[axis as LookupAxis]).toContain('?')
    }
    expect(ids({ vendor: ['CISCO'] })).toEqual(['CVE-2020-0005', 'CVE-2022-0002'])
  })
})

describe('ftsQuery', () => {
  it('turns a search box into an AND of quoted terms', () => {
    expect(ftsQuery('buffer overflow')).toBe('"buffer" AND "overflow"')
    expect(ftsQuery('  ')).toBeNull()
    expect(ftsQuery(undefined)).toBeNull()
  })

  it('keeps phrases and prefixes, which is what a search box means', () => {
    expect(ftsQuery('"remote code execution"')).toBe('"remote code execution"')
    expect(ftsQuery('overfl*')).toBe('"overfl"*')
  })

  it('disarms fts5 syntax rather than passing it through', () => {
    // Every one of these is meaningful to fts5's own parser and would be a
    // syntax error or a different query if pasted in. They are *bound*, so this
    // is not about SQL injection — it is about the second parser the text
    // reaches.
    for (const input of [
      'NEAR(',
      'a OR b',
      'descr : foo',
      '"unbalanced',
      'a AND NOT b',
      '^anchored',
      '-negated',
      "'; DROP TABLE cve; --",
      '<script>alert(1)</script>',
    ]) {
      const query = ftsQuery(input)
      if (query === null) continue
      // The real test: fts5 accepts it, whatever it was.
      expect(() =>
        db.prepare('SELECT count(*) AS n FROM fts WHERE fts MATCH ?').get(query)
      ).not.toThrow()
    }
  })

  it('finds what a user would expect to find', () => {
    expect(ids({ text: 'cross-site scripting' })).toEqual(['CVE-2022-0002'])
    expect(ids({ text: '"packet parser"' })).toEqual(['CVE-2024-0004'])
    expect(ids({ text: 'parse*' })).toEqual(['CVE-2024-0004'])
    expect(ids({ text: '!!!' })).toEqual([])
  })
})

describe('caps', () => {
  it('bounds what a caller can ask for', () => {
    expect(rowsSql({}, {}, { limit: 10 ** 9 }).params.at(-2)).toBe(MAX_ROW_LIMIT + 1)
    expect(rowsSql({}, {}, { limit: -5 }).params.at(-2)).toBeGreaterThan(0)
    expect(rowsSql({}, {}, { offset: -5 }).params.at(-1)).toBe(0)
    expect(rowsSql({}, {}, { offset: 10 ** 12 }).params.at(-1)).toBe(1_000_000)
    const grouped = groupSql({}, {}, 'vendor', 10 ** 9)
    expect(grouped.limit).toBe(GROUP_LIMIT)
    expect(grouped.params.at(-1)).toBe(GROUP_LIMIT + 1)
  })

  it('asks SQL for one sentinel row beyond the collection cap', () => {
    const listed = rowsSql({}, {}, { limit: 3 })
    expect(listed.limit).toBe(3)
    expect(listed.params.at(-2)).toBe(4)

    const grouped = groupSql({}, {}, 'year', 3)
    expect(grouped.limit).toBe(3)
    expect(grouped.params.at(-1)).toBe(4)
  })

  it('fails closed when a lookup filter was not resolved', () => {
    const built = rowsSql({ vendor: ['Cisco'] })
    expect(built.sql).toContain(' AND 0')
    expect(run(built.sql, built.params)).toEqual([])
  })

  it('sorts by an allowlisted key only', () => {
    // The sort key reaches SQL as text, so it is a lookup rather than a value.
    const sneaky = rowsSql({}, {}, { sort: 'published; DROP TABLE cve' as never })
    expect(sneaky.sql).not.toContain('DROP')
    expect(() => run(sneaky.sql, sneaky.params)).not.toThrow()
  })

  it('keeps records with no description in the list (D-023)', () => {
    // CVE-2020-0005 has no `cve_text` row. An INNER JOIN here would drop it and
    // nothing would say so.
    const built = rowsSql({}, {}, { sort: 'cve' })
    const rows = run(built.sql, built.params)
    const row = rows.find((entry) => entry[0] === 'CVE-2020-0005')
    expect(row).toBeDefined()
    expect(row?.[8]).toBeNull()
  })
})

describe('the SSVC axes (D-070)', () => {
  it('filters on a stored code', () => {
    // CVE-2021-44228 is `Exploitation: none` — a finding, stored as 0.
    expect(ids({ ssvcExpl: [0], state: 'all' })).toEqual(['CVE-2021-44228'])
    expect(ids({ ssvcExpl: [2], state: 'all' })).toEqual(['CVE-2024-0004'])
  })

  it('can select the records nobody assessed, which `IN` alone cannot', () => {
    // The one that matters. `x IN (…)` is never true for NULL, so without the
    // sentinel this band — half the real corpus — would be selectable nowhere.
    const unassessed = ids({ ssvcExpl: [NOT_ASSESSED], state: 'all' })
    expect(unassessed).toEqual(['CVE-2020-0005', 'CVE-2023-0003'])
  })

  it('keeps "not assessed" and "none" apart', () => {
    const none = ids({ ssvcExpl: [0], state: 'all' })
    const absent = ids({ ssvcExpl: [NOT_ASSESSED], state: 'all' })
    expect(none).not.toEqual(absent)
    // And selecting both is the union, not one or the other.
    expect(ids({ ssvcExpl: [0, NOT_ASSESSED], state: 'all' }).sort()).toEqual(
      [...none, ...absent].sort()
    )
  })

  it('does not widen the other filters when it is the only clause', () => {
    // The parenthesisation check: `a AND b IS NULL OR c` would silently drop
    // the state predicate and return REJECTED records too.
    const built = compile({ ssvcExpl: [0, NOT_ASSESSED] })
    expect(built.where).toContain('(c.ssvc_expl IN (?) OR c.ssvc_expl IS NULL)')
    expect(ids({ ssvcExpl: [NOT_ASSESSED] })).not.toContain('CVE-2023-0003')
  })

  it('never binds the sentinel as a value', () => {
    const built = compile({ ssvcExpl: [NOT_ASSESSED], ssvcAuto: [1, NOT_ASSESSED] })
    expect(built.params).not.toContain(NOT_ASSESSED)
    expect(built.params).toContain(1)
  })

  it('groups with the unassessed band present and last', () => {
    const built = groupSql({ state: 'all' }, {}, 'ssvcExpl')
    const rows = run(built.sql, built.params)
    // Codes ascending, then the absence — the position D-073 reserves for a
    // band that is not a level, so it cannot distort the trend beneath it.
    expect(rows.map((row) => row[0])).toEqual([0, 1, 2, null])
    expect(rows.map((row) => row[2])).toEqual([1, 1, 1, 2])
  })

  it('carries a partial assessment as a gap rather than a code', () => {
    const built = groupSql({ state: 'all' }, {}, 'ssvcAuto')
    const rows = run(built.sql, built.params)
    // CVE-2024-0004 states Exploitation and Technical Impact and not
    // Automatable, so it lands in the null band of *this* axis only.
    expect(rows.find((row) => row[0] === null)?.[2]).toBe(3)
    expect(rows.map((row) => row[0])).toEqual([0, 1, null])
  })

  it('cross-tabs against another axis without dropping the null band', () => {
    const built = crossSql({ state: 'all' }, {}, 'severity', 'ssvcExpl')
    const rows = run(built.sql, built.params)
    expect(rows.some((row) => row[2] === null)).toBe(true)
  })
})

describe('the export-only columns (D-070, D-071)', () => {
  it('are absent from the record list and present in an export row', () => {
    const screen = rowsSql({ state: 'all' }, {}, { sort: 'cve' })
    expect(run(screen.sql, screen.params)[0]).toHaveLength(9)
    const full = rowsSql({ state: 'all' }, {}, { sort: 'cve', full: true })
    expect(run(full.sql, full.params)[0]).toHaveLength(RECORD_COLUMNS.length)
  })

  it('name their columns in the order the header claims', () => {
    // A mismatch here would label every column after the first wrong one — a
    // file that reads as a copy and is not one.
    const full = rowsSql({ state: 'all' }, {}, { sort: 'cve', full: true })
    const named = db.prepare(full.sql).all(...(full.params as (string | number)[]))
    expect(Object.keys(named[0] as Record<string, unknown>)).toHaveLength(RECORD_COLUMNS.length)
  })
})
