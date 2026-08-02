import { describe, expect, it } from 'vitest'

import { BENCH_QUERIES } from '../../lib/queries'

/**
 * The benchmark set is the thing the criterion-3 latency budget is measured
 * against, so it gets the same guarantee as everything else that reaches the
 * database: read-only, one statement, no interpolation (rule 5, D-044).
 */
describe('BENCH_QUERIES', () => {
  it('names every query uniquely', () => {
    const names = BENCH_QUERIES.map((query) => query.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it.each(BENCH_QUERIES)('$name is a single read-only statement', (query) => {
    expect(query.sql.trimStart().slice(0, 6).toUpperCase()).toBe('SELECT')
    // No statement separator: `db.exec` would happily run a second one, and the
    // `query_only` pragma is a flag a second statement could flip back.
    expect(query.sql).not.toContain(';')
    expect(query.sql).not.toMatch(
      /\bPRAGMA\b|\bATTACH\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bDROP\b/i
    )
  })

  it.each(BENCH_QUERIES)('$name gives the same answer on any day', (query) => {
    // A benchmark whose result set moves with the wall clock cannot be compared
    // against a number recorded last month, which is this file's whole job.
    // `vendor-severity-2y` used strftime('%s','now',…) and had to be pinned to a
    // literal epoch for exactly this reason.
    expect(query.sql).not.toMatch(/\bstrftime\b|'now'|\bdate\s*\(|\bdatetime\s*\(|\bjulianday\b/i)
    // Not a template: an interpolation site here is a place for record content
    // to end up, and it would also make two runs incomparable.
    expect(query.sql).not.toContain('${')
    expect(query.what.length).toBeGreaterThan(0)
  })
})
