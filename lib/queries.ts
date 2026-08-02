/**
 * The query-latency benchmark (Q-003).
 *
 * This is a **baseline, not a budget**: D-049 sets no latency ceiling, on the
 * grounds that a complicated question over 372k records is allowed to take a
 * while. What these are for is spotting a regression and pointing at what is
 * worth indexing, which only works if the query stays identical run to run —
 * hence literal SQL in the tree rather than something typed into a console.
 *
 * They are deliberately unparameterized — nothing here interpolates record
 * content or user input (rule 5) — every one is a single `SELECT`, and none
 * depends on the wall clock; `tests/unit/queries.test.ts` asserts all three.
 *
 * Coverage is by *shape*, not by feature checklist: a point lookup (the floor),
 * indexed range aggregates, wide joins through the link tables, a full scan of
 * the largest table, and FTS. M3 tunes indexing against these.
 */
export interface BenchQuery {
  name: string
  /** What this shape stands in for, so a slow row is diagnosable. */
  what: string
  sql: string
}

export const BENCH_QUERIES: BenchQuery[] = [
  {
    name: 'point-lookup',
    what: 'one record by CVE ID — the floor',
    sql: `SELECT cve_id, year, cvss_score, cvss_vec FROM cve WHERE cve_id = 'CVE-2021-44228'`,
  },
  {
    name: 'severity-by-year',
    what: 'D-046 #1: stacked severity counts over time, whole corpus',
    sql: `SELECT year, cvss_sev, count(*) AS cves
          FROM cve
          WHERE state = 1 AND cvss_sev IS NOT NULL
          GROUP BY year, cvss_sev
          ORDER BY year DESC, cvss_sev DESC`,
  },
  {
    name: 'cna-year-cvss',
    what: 'vision criterion 3: group by CNA and year under a CVSS predicate',
    sql: `SELECT n.name AS cna, c.year, count(*) AS cves
          FROM cve c JOIN cna n ON n.id = c.cna_id
          WHERE c.state = 1 AND c.cvss_score >= 7.0
          GROUP BY c.cna_id, c.year
          ORDER BY cves DESC
          LIMIT 50`,
  },
  {
    name: 'vendor-severity-2y',
    what: "D-046 #2: the owner's question — vendor x product x severity, 2 years",
    // The cutoff is a literal epoch (2024-08-01) rather than
    // strftime('%s','now','-2 years'): a benchmark whose result set changes
    // with the wall clock cannot be compared against a number recorded last
    // month, which is the entire job of this file.
    sql: `SELECT v.name AS vendor, p.name AS product, c.cvss_sev, count(*) AS cves
          FROM cve c
          JOIN cve_prod cp ON cp.cve_id = c.id
          JOIN product p ON p.id = cp.product_id
          JOIN vendor v ON v.id = p.vendor_id
          WHERE c.state = 1 AND c.published >= 1722470400
          GROUP BY v.id, p.id, c.cvss_sev
          ORDER BY cves DESC
          LIMIT 100`,
  },
  {
    name: 'product-drilldown',
    what: 'narrow filter through the widest link table',
    sql: `SELECT p.name AS product, count(*) AS cves
          FROM cve_prod cp
          JOIN product p ON p.id = cp.product_id
          JOIN cve c ON c.id = cp.cve_id
          WHERE c.state = 1
            AND p.vendor_id = (SELECT p2.vendor_id
                               FROM cve_prod cp2 JOIN product p2 ON p2.id = cp2.product_id
                               GROUP BY p2.vendor_id ORDER BY count(*) DESC LIMIT 1)
          GROUP BY p.id
          ORDER BY cves DESC
          LIMIT 25`,
  },
  {
    name: 'cwe-top',
    what: 'aggregate over a WITHOUT ROWID link table',
    sql: `SELECT w.cwe, w.descr, count(*) AS cves
          FROM cve_cwe x
          JOIN cwe w ON w.id = x.cwe_id
          JOIN cve c ON c.id = x.cve_id
          WHERE c.state = 1
          GROUP BY w.id
          ORDER BY cves DESC
          LIMIT 25`,
  },
  {
    name: 'reference-hosts',
    what: 'D-033 host interning: full scan of the reference tables',
    sql: `SELECT h.name AS host, count(DISTINCT r.cve_id) AS cves
          FROM cve_ref r
          JOIN url u ON u.id = r.url_id
          JOIN host h ON h.id = u.host_id
          GROUP BY h.id
          ORDER BY cves DESC
          LIMIT 25`,
  },
  {
    name: 'fts-count',
    what: 'client-built description index (D-035): how many match at all',
    sql: `SELECT count(*) AS hits FROM fts WHERE fts MATCH 'buffer AND overflow'`,
  },
  {
    name: 'fts-ranked',
    what: 'search joined back to the records and ordered by severity',
    sql: `SELECT c.cve_id, c.cvss_score
          FROM fts
          JOIN cve c ON c.id = fts.rowid
          WHERE fts MATCH 'sql AND injection'
          ORDER BY c.cvss_score DESC
          LIMIT 25`,
  },
  {
    name: 'fts-vendor',
    what: 'vendor index — the type-ahead path a filter UI will use',
    sql: `SELECT name FROM fts_vendor WHERE fts_vendor MATCH 'cisco' LIMIT 25`,
  },
]
