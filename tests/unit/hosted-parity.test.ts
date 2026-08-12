/**
 * The hosted tier must be the local tier, elsewhere (D-084).
 *
 * Three implementations share load-bearing constants they cannot import from
 * each other: `lib/search.ts`/`lib/kev.ts` (the client's tables),
 * `pipeline/hosted.py` (the same tables, built server-side), and
 * `public/api/sql.php` (the authorizer policy and the request bounds, in
 * PHP). This test holds them equal, in the spirit of the D-046 lesson that a
 * wrong schema is worse than none: a hosted `kev` table with different
 * columns, or a PHP authorizer that allows one action more, is two tiers
 * answering one question differently — quietly.
 *
 * Python is asked for its *values* (imported and printed as JSON, the
 * contract.test.ts pattern) rather than regex-scraped; PHP has no runtime in
 * this environment, so its constants are extracted textually from
 * declarations this test owns the shape of.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { RESULT_CHAR_BUDGET } from '../../lib/authorizer'
import { KEV_DDL, KEV_INSERT, KEV_META } from '../../lib/kev'
import { MAX_REMOTE_PARAMS, MAX_REMOTE_ROWS, MAX_REMOTE_SQL_CHARS } from '../../lib/remote'
import { SEARCH_INDEXES, indexSql } from '../../lib/search'

const ROOT = join(__dirname, '..', '..')

/** Whitespace-insensitive SQL equality: layout differs, statements must not. */
function squash(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

interface PythonSide {
  fts: { fts: string; content: string; rowid: string; statements: string[] }[]
  kev_ddl: string[]
  kev_insert: string
  kev_meta: Record<string, string>
}

let python: PythonSide

beforeAll(() => {
  const script = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(join(ROOT, 'pipeline'))})`,
    'import hosted',
    'print(json.dumps({',
    '  "fts": [',
    '    {"fts": f, "content": c, "rowid": r,',
    '     "statements": hosted._fts_statements(f, c, r, cols)}',
    '    for (f, c, r, cols) in hosted.FTS_INDEXES',
    '  ],',
    '  "kev_ddl": list(hosted.KEV_DDL),',
    '  "kev_insert": hosted.KEV_INSERT,',
    '  "kev_meta": hosted.KEV_META,',
    '}))',
  ].join('\n')
  python = JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf-8' }))
})

describe('pipeline/hosted.py mirrors the client-built tables', () => {
  it('builds the same fts5 indexes, column order included (RE-005)', () => {
    expect(python.fts.map((index) => index.fts)).toEqual(SEARCH_INDEXES.map((index) => index.fts))
    for (const [at, index] of SEARCH_INDEXES.entries()) {
      const server = python.fts[at]!
      expect(server.content).toBe(index.content)
      expect(server.rowid).toBe(index.rowid)
      const client = indexSql(index)
      // The CREATE is the contract; the fill differs only by the client's
      // rowid-range batching, so compare it up to the WHERE.
      expect(squash(server.statements[1]!)).toBe(squash(client.create))
      expect(squash(client.insert)).toContain(
        squash(server.statements[2]!.replace(/ WHERE.*$/, ''))
      )
    }
  })

  it('creates the same kev table, insert and meta keys', () => {
    expect(python.kev_ddl.map(squash)).toEqual(KEV_DDL.map(squash))
    expect(squash(python.kev_insert)).toBe(squash(KEV_INSERT))
    expect(python.kev_meta).toEqual(KEV_META)
  })
})

describe('public/api/sql.php mirrors the policy and the bounds', () => {
  const php = readFileSync(join(ROOT, 'public', 'api', 'sql.php'), 'utf-8')

  function phpConst(name: string): number {
    const match = php.match(new RegExp(`const ${name} = (\\d+);`))
    if (!match) throw new Error(`sql.php declares no const ${name}`)
    return Number(match[1])
  }

  it('allows exactly the four action codes lib/authorizer.ts allows', () => {
    const block = php.match(/const AUTH_ALLOWED = \[([^\]]+)\]/)?.[1] ?? ''
    const names = [...block.matchAll(/SQLite3::([A-Z_]+)/g)].map((hit) => hit[1])
    expect(names.sort()).toEqual(['FUNCTION', 'READ', 'RECURSIVE', 'SELECT'])
  })

  it('admits exactly the one pragma fts5 needs (RE-033)', () => {
    const block = php.match(/const AUTH_ALLOWED_PRAGMAS = \[([^\]]+)\]/)?.[1] ?? ''
    const names = [...block.matchAll(/'([a-z_]+)' =>/g)].map((hit) => hit[1])
    expect(names).toEqual(['data_version'])
  })

  it('denies the same function names lib/authorizer.ts denies', () => {
    const source = readFileSync(join(ROOT, 'lib', 'authorizer.ts'), 'utf-8')
    const tsBlock = source.match(/const DENIED_FUNCTIONS = new Set\(\[([^\]]+)\]\)/)?.[1] ?? ''
    const tsNames = [...tsBlock.matchAll(/'([a-z0-9_]+)'/g)].map((hit) => hit[1])
    const phpBlock = php.match(/const AUTH_DENIED_FUNCTIONS = \[([^\]]+)\]/)?.[1] ?? ''
    const phpNames = [...phpBlock.matchAll(/'([a-z0-9_]+)' =>/g)].map((hit) => hit[1])
    expect(tsNames.length).toBeGreaterThan(0)
    expect(phpNames.sort()).toEqual([...tsNames].sort())
  })

  it('holds the request bounds equal to lib/remote.ts', () => {
    expect(phpConst('MAX_SQL_CHARS')).toBe(MAX_REMOTE_SQL_CHARS)
    expect(phpConst('MAX_PARAMS')).toBe(MAX_REMOTE_PARAMS)
    expect(phpConst('MAX_ROWS')).toBe(MAX_REMOTE_ROWS)
  })

  it('holds the result budget equal to the guarded local tier (D-078)', () => {
    expect(phpConst('RESULT_BYTE_BUDGET')).toBe(RESULT_CHAR_BUDGET)
  })
})
