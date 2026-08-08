import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it } from 'vitest'

import {
  cwesSql,
  DETAIL_LIMITS,
  isCveId,
  productsSql,
  recordSql,
  referencesSql,
  versionsSql,
  VERSION_STATUS,
  type DetailQuery,
} from '../../lib/detail'

/**
 * The per-CVE detail view's queries (M4), executed against real SQLite and the
 * published schema.
 *
 * This is the first surface that reaches the two sections D-033 argued into the
 * schema and nothing has rendered since — version ranges and references — so
 * these tests are the first check that those tables are queryable at all.
 *
 * The corpus below is shaped like the real one where it matters: a record with
 * no English description (4.46%, D-023), a record affecting several products,
 * a REJECTED record, and identifiers and product names that are themselves SQL
 * injection attempts (rule 4).
 */

const HOSTILE_PRODUCT = "'); DROP TABLE cve; --"
const HOSTILE_URL = 'javascript:alert(1)'

function corpus(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync('pipeline/schema.sql', 'utf-8'))
  db.exec(`
    INSERT INTO cna(id, name) VALUES (1, 'Apache'), (2, 'MITRE');
    INSERT INTO vendor(id, name) VALUES (1, 'Apache Software Foundation'), (2, 'Cisco');
    INSERT INTO product(id, vendor_id, name) VALUES (1, 1, 'Log4j'), (2, 2, 'IOS XE');
    INSERT INTO cwe(id, cwe, descr) VALUES (1, 'CWE-502', 'Deserialization'), (2, 'CWE-20', 'Input validation');
    INSERT INTO host(id, name) VALUES (1, 'github.com'), (2, 'nvd.nist.gov');
    INSERT INTO url(id, url, host_id) VALUES
      (1, 'https://github.com/apache/logging-log4j2', 1),
      (2, 'https://nvd.nist.gov/vuln/detail/CVE-2021-44228', 2),
      (3, '${HOSTILE_URL}', 1);
    INSERT INTO vtype(id, name) VALUES (1, 'semver'), (2, 'custom');

    INSERT INTO cve(id, cve_id, year, state, cna_id, published, updated,
                    cvss_ver, cvss_score, cvss_sev, cvss_vec,
                    reserved, ssvc_expl, ssvc_auto, ssvc_impact)
      VALUES (1, 'CVE-2021-44228', 2021, 1, 1, 1639094400, 1641340800, 31, 10, 4, 'AV:N/AC:L',
              1638000000, 2, 1, 1),
             -- No SSVC assessment and no description: the sparse record.
             (2, 'CVE-2022-0002', 2022, 1, 2, 1646092800, 1646179200, NULL, NULL, NULL, NULL,
              1645000000, NULL, NULL, NULL),
             (3, 'CVE-2022-0003', 2022, 2, 2, 1646092800, 1646179200, NULL, NULL, NULL, NULL,
              1645000000, NULL, NULL, NULL);

    INSERT INTO cve_text(cve_id, descr, title) VALUES
      (1, 'Remote code execution in Log4j.', 'Log4j JNDI remote code execution');
    -- A REJECTED record: its only English text is the rejection reason, which is
    -- what stops it rendering blank (D-070).
    INSERT INTO cve_text(cve_id, reason) VALUES (3, 'Withdrawn by its CNA as a duplicate.');

    INSERT INTO cve_cwe(cve_id, cwe_id) VALUES (1, 1), (1, 2);
    INSERT INTO cve_prod(cve_id, product_id, default_status) VALUES (1, 1, 1), (1, 2, NULL);
    INSERT INTO cve_ref(cve_id, url_id) VALUES (1, 1), (1, 2), (1, 3);
    INSERT INTO cve_ver(cve_id, product_id, status, version, lt, lte, vtype)
      VALUES (1, 1, 1, '2.0', '2.15.0', NULL, 1),
             (1, 1, 2, '2.17.0', NULL, NULL, 1),
             (1, 2, 3, NULL, NULL, '17.9.1', 2);
  `)
  db.exec(
    `INSERT INTO product(id, vendor_id, name) VALUES (3, 2, ?)`.replace(
      '?',
      `'${HOSTILE_PRODUCT.replace(/'/g, "''")}'`
    )
  )
  db.exec('INSERT INTO cve_prod(cve_id, product_id, default_status) VALUES (2, 3, 2)')
  return db
}

function run(db: DatabaseSync, query: DetailQuery): unknown[][] {
  return db
    .prepare(query.sql)
    .all(...(query.params as (string | number)[]))
    .map((row) => Object.values(row as Record<string, unknown>))
}

describe('recordSql', () => {
  it('finds a record however the identifier is cased', () => {
    // A permalink and a chat tool call both carry whatever the user typed, and
    // "no such record" for a lower-case id would be a lie.
    const db = corpus()
    for (const id of ['CVE-2021-44228', 'cve-2021-44228', ' CVE-2021-44228 ']) {
      expect(run(db, recordSql(id))[0]?.[0], id).toBe('CVE-2021-44228')
    }
  })

  it('returns nothing for an id no record carries', () => {
    expect(run(corpus(), recordSql('CVE-1999-0001'))).toHaveLength(0)
  })

  it('returns a record with no English description rather than dropping it (D-023)', () => {
    // A LEFT JOIN, not an inner one: 4.46% of the corpus has no row in
    // `cve_text`, and an inner join would report those records as nonexistent.
    const row = run(corpus(), recordSql('CVE-2022-0002'))[0]
    expect(row).toBeTruthy()
    expect(row![0]).toBe('CVE-2022-0002')
    expect(row![10]).toBeNull()
  })

  it('returns a REJECTED record — the detail view is where you learn that (D-022)', () => {
    const row = run(corpus(), recordSql('CVE-2022-0003'))[0]
    expect(row![1]).toBe(2)
  })
})

describe('the sections', () => {
  it('returns every CWE, ordered', () => {
    expect(run(corpus(), cwesSql('CVE-2021-44228')).map((row) => row[0])).toEqual([
      'CWE-20',
      'CWE-502',
    ])
  })

  it('returns affected products with their vendors', () => {
    const rows = run(corpus(), productsSql('CVE-2021-44228'))
    // The third column is `default_status`: 1 (affected) for Log4j, and NULL
    // for IOS XE, whose record states no default. Absent is not a value (D-070).
    expect(rows).toEqual([
      ['Apache Software Foundation', 'Log4j', 1],
      ['Cisco', 'IOS XE', null],
    ])
  })

  it('carries the container default beside every version row (D-070)', () => {
    // Without it the rows cannot be read: with `defaultStatus: affected`, the
    // `unaffected` row below is the *fixed* version, not an exemption.
    const rows = run(corpus(), versionsSql('CVE-2021-44228'))
    const log4j = rows.filter((row) => row[1] === 'Log4j')
    expect(log4j).toHaveLength(2)
    for (const row of log4j) expect(row[7]).toBe(1)
    expect(rows.find((row) => row[1] === 'IOS XE')![7]).toBeNull()
  })

  it('returns the rejection reason, which is a REJECTED record’s only text', () => {
    const row = run(corpus(), recordSql('CVE-2022-0003'))[0]!
    expect(row[10]).toBeNull() // no description at all
    expect(row[12]).toBe('Withdrawn by its CNA as a duplicate.')
  })

  it('keeps "not assessed" distinct from a code', () => {
    const scored = run(corpus(), recordSql('CVE-2021-44228'))[0]!
    expect([scored[14], scored[15], scored[16]]).toEqual([2, 1, 1])
    const unassessed = run(corpus(), recordSql('CVE-2022-0002'))[0]!
    expect([unassessed[14], unassessed[15], unassessed[16]]).toEqual([null, null, null])
  })

  it('reaches the version ranges nothing has rendered until now (D-033)', () => {
    const rows = run(corpus(), versionsSql('CVE-2021-44228'))
    expect(rows).toHaveLength(3)
    // All four columns come back rather than a pre-formatted sentence, so which
    // of the four shapes a row is stays visible: an exact version, a `<` bound,
    // a `<=` bound, or a bare status.
    const [vendor, product, status, version, lt, lte, vtype] = rows[0]!
    expect(vendor).toBe('Apache Software Foundation')
    expect(product).toBe('Log4j')
    expect(VERSION_STATUS[status as number]).toBe('affected')
    expect(version).toBe('2.0')
    expect(lt).toBe('2.15.0')
    expect(lte).toBeNull()
    expect(vtype).toBe('semver')
  })

  it('reaches the references, with the interned host beside each URL', () => {
    const rows = run(corpus(), referencesSql('CVE-2021-44228'))
    expect(rows).toHaveLength(3)
    // The host is what the UI shows next to the link. It comes from the
    // interned column rather than being re-parsed here.
    expect(new Set(rows.map((row) => row[1]))).toEqual(new Set(['github.com', 'nvd.nist.gov']))
    // A hostile URL is returned, not filtered in SQL: whether it may become a
    // link is a rendering decision (lib/sanitize.ts), and dropping it here
    // would hide a reference the record actually has.
    expect(rows.some((row) => row[0] === HOSTILE_URL)).toBe(true)
  })

  it('binds the identifier rather than pasting it, so a hostile id cannot run', () => {
    const db = corpus()
    for (const build of [recordSql, cwesSql, productsSql, versionsSql, referencesSql]) {
      const query = build("cve-2021-44228'); DROP TABLE cve; --")
      expect(query.sql).not.toContain('DROP')
      expect(() => run(db, query)).not.toThrow()
    }
    // And the corpus is still there.
    expect(db.prepare('SELECT count(*) AS n FROM cve').get()).toEqual({ n: 3 })
  })

  it('asks for one row past its cap, so truncation is detectable', () => {
    // The sentinel row is how the Worker tells a full section from a capped
    // one — the same convention `BoundedSql` uses (lib/filters.ts).
    expect(cwesSql('CVE-2021-44228').params[1]).toBe(DETAIL_LIMITS.cwes + 1)
    expect(versionsSql('CVE-2021-44228').params[1]).toBe(DETAIL_LIMITS.versions + 1)
    expect(referencesSql('CVE-2021-44228').params[1]).toBe(DETAIL_LIMITS.references + 1)
  })
})

describe('isCveId', () => {
  it('accepts the canonical form, either case', () => {
    expect(isCveId('CVE-2021-44228')).toBe(true)
    expect(isCveId('cve-1999-0001')).toBe(true)
    expect(isCveId(' CVE-2026-123456789 ')).toBe(true)
  })

  it('refuses everything that is not one', () => {
    for (const value of [
      '',
      'CVE',
      'CVE-21-44228',
      'CVE-2021-123',
      "CVE-2021-44228'; DROP TABLE cve",
      '../../etc/passwd',
      null,
      42,
      {},
    ]) {
      expect(isCveId(value), String(value)).toBe(false)
    }
  })
})
