import { readFileSync } from 'node:fs'
import { DatabaseSync, constants } from 'node:sqlite'

import { describe, expect, it } from 'vitest'

import { ACTION, authorize, AUTH_DENY, AUTH_OK, CONSOLE_ROW_LIMIT } from '../../lib/authorizer'

/**
 * The console's read-only guarantee, checked against SQLite rather than against
 * our own idea of it (M3, D-044).
 *
 * The claim being tested is structural: not "we reject these strings" but "the
 * database refuses these actions". So every case here is real SQL run through
 * the real authorizer callback, and the assertion is on what the *database*
 * ends up holding as much as on the error raised — a refusal that still wrote
 * something would pass a message-only test.
 *
 * `node:sqlite` is the same SQLite the browser runs (3.53.0, matching
 * `@sqlite.org/sqlite-wasm`) and exposes the same authorizer, with the action
 * code and operands in a different argument order. That difference is why
 * `authorize` takes them apart rather than being written against one driver.
 */

/** A database with the published schema and one record in it. */
function guarded(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync('pipeline/schema.sql', 'utf-8'))
  db.exec(`
    INSERT INTO cve(id, cve_id, year, state, cvss_score) VALUES (1, 'CVE-2021-44228', 2021, 1, 10);
    INSERT INTO cve_text(cve_id, descr) VALUES (1, 'remote code execution');
    INSERT INTO meta(k, v) VALUES ('schema', 1), ('rev', 2);
  `)
  // The client builds these after import (D-035), so a console over a real
  // local copy can see them — and can try to write to them.
  db.exec("CREATE VIRTUAL TABLE fts USING fts5(descr, content='cve_text', content_rowid='cve_id')")
  db.exec("INSERT INTO fts(fts) VALUES('rebuild')")
  return db
}

function arm(db: DatabaseSync): { denials: string[] } {
  const denials: string[] = []
  db.setAuthorizer((code: number, arg1: string | null, arg2: string | null) => {
    const verdict = authorize(code, arg1, arg2)
    if (verdict.ok) return AUTH_OK
    denials.push(verdict.reason ?? '')
    return AUTH_DENY
  })
  return { denials }
}

describe('the action codes', () => {
  it('are SQLite’s own, not ours', () => {
    // Named here so the policy is driver-independent (lib/authorizer.ts), which
    // is only safe while the numbers agree. `node:sqlite` publishes a handful
    // of them; a drift in any one would silently change what is allowed.
    expect(ACTION.SELECT).toBe(constants.SQLITE_SELECT)
    expect(ACTION.READ).toBe(constants.SQLITE_READ)
    expect(ACTION.FUNCTION).toBe(constants.SQLITE_FUNCTION)
    expect(ACTION.PRAGMA).toBe(constants.SQLITE_PRAGMA)
    expect(ACTION.INSERT).toBe(constants.SQLITE_INSERT)
    expect(AUTH_DENY).toBe(constants.SQLITE_DENY)
  })
})

describe('what the console can do', () => {
  it('reads, joins, aggregates and searches', () => {
    const db = guarded()
    arm(db)
    expect(Number(db.prepare('SELECT count(*) AS n FROM cve').get()?.n)).toBe(1)
    expect(
      db
        .prepare(
          `SELECT c.cve_id, t.descr FROM cve c JOIN cve_text t ON t.cve_id = c.id
           WHERE c.state = 1 ORDER BY c.cvss_score DESC`
        )
        .all()
    ).toHaveLength(1)
    // Aggregates and scalar functions are `SQLITE_FUNCTION`, which is allowed —
    // fts5's bm25/snippet/highlight arrive the same way.
    expect(
      db.prepare('SELECT max(cvss_score) AS m, upper(cve_id) AS u FROM cve').get()
    ).toBeTruthy()
    // Recursive CTEs are allowed on purpose: read-only, useful, and the classic
    // way to write a query that runs forever — which is why cancellation ships
    // in the same milestone.
    expect(
      db
        .prepare(
          'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 5) ' +
            'SELECT count(*) AS c FROM n'
        )
        .get()?.c
    ).toBe(5)
  })

  it('reads the schema, which is how a person finds their way around', () => {
    const db = guarded()
    arm(db)
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().length
    ).toBeGreaterThan(5)
  })
})

describe('what it cannot do, whatever it types', () => {
  const writes: [string, string][] = [
    ['INSERT', "INSERT INTO cve(id, cve_id) VALUES (99, 'CVE-9999-9999')"],
    ['UPDATE', 'UPDATE cve SET cvss_score = 0'],
    ['DELETE', 'DELETE FROM cve'],
    ['INSERT from a SELECT', 'INSERT INTO cve(id, cve_id) SELECT 98, cve_id FROM cve'],
    ['DROP', 'DROP TABLE cve'],
    ['ALTER', 'ALTER TABLE cve ADD COLUMN sneaky TEXT'],
    ['CREATE TABLE', 'CREATE TABLE evil(a)'],
    ['CREATE TEMP TABLE', 'CREATE TEMP TABLE evil(a)'],
    ['CREATE TRIGGER', 'CREATE TRIGGER t AFTER INSERT ON cve BEGIN DELETE FROM cve; END'],
    ['CREATE VIEW', 'CREATE VIEW v AS SELECT * FROM cve'],
    ['CREATE INDEX', 'CREATE INDEX i ON cve(cvss_vec)'],
    ['REINDEX', 'REINDEX'],
    ['ANALYZE', 'ANALYZE'],
    // The one that matters most: the pragma the older defence rested on cannot
    // be flipped back, because PRAGMA itself is refused.
    ['PRAGMA write flip', 'PRAGMA query_only = OFF'],
    ['PRAGMA journal', 'PRAGMA journal_mode = OFF'],
    ['ATTACH', "ATTACH DATABASE 'other.db' AS other"],
    ['DETACH', 'DETACH DATABASE main'],
    ['SAVEPOINT', 'SAVEPOINT s'],
    ['VACUUM', 'VACUUM'],
    ['PRAGMA optimize', 'PRAGMA optimize'],
    // A pragma wearing a SELECT's clothes. The statement begins with SELECT and
    // names no forbidden word, which is exactly why inspecting the text is not
    // the mechanism: SQLite reports it as a PRAGMA action because that is what
    // it is.
    ['table-valued pragma', 'SELECT * FROM pragma_query_only'],
    // fts5 commands are writes to the index, spelled as an INSERT into a
    // virtual table — including the one that would rebuild the indexes the
    // client spent a minute building (D-035).
    ['fts5 rebuild', "INSERT INTO fts(fts) VALUES('rebuild')"],
  ]

  it.each(writes)('refuses %s', (unused, sql) => {
    const db = guarded()
    arm(db)
    expect(() => db.exec(sql)).toThrow()
    // The database is unchanged: a refusal that still wrote would satisfy a
    // message-only assertion.
    expect(Number(db.prepare('SELECT count(*) AS n FROM cve').get()?.n)).toBe(1)
    expect(Number(db.prepare('SELECT cvss_score AS s FROM cve').get()?.s)).toBe(10)
  })

  it('refuses the write in a multi-statement string, having run the read', () => {
    const db = guarded()
    arm(db)
    // SQLite prepares one statement at a time, so the SELECT runs and the
    // DELETE is refused when it is reached. What matters is that the write
    // never happens — a semicolon is not a way past the authorizer.
    expect(() => db.exec('SELECT 1; DELETE FROM cve')).toThrow()
    expect(Number(db.prepare('SELECT count(*) AS n FROM cve').get()?.n)).toBe(1)
  })

  it('says what was refused, in words a person can act on', () => {
    const db = guarded()
    const { denials } = arm(db)
    expect(() => db.exec('DELETE FROM cve')).toThrow(/not authorized/i)
    expect(denials.join(' ')).toMatch(/read-only/)
    expect(denials.join(' ')).toMatch(/DELETE/)
  })

  it('refuses a function by name even where functions are allowed', () => {
    expect(authorize(ACTION.FUNCTION, null, 'load_extension').ok).toBe(false)
    expect(authorize(ACTION.FUNCTION, null, 'LOAD_EXTENSION').ok).toBe(false)
    expect(authorize(ACTION.FUNCTION, null, 'count').ok).toBe(true)
  })

  it('denies every action that is not on the list, including future ones', () => {
    for (const [name, code] of Object.entries(ACTION)) {
      const allowed = ['SELECT', 'READ', 'FUNCTION', 'RECURSIVE'].includes(name)
      expect(authorize(code, 'cve', 'x').ok, name).toBe(allowed)
    }
    // An action code this build has never heard of — a future SQLite — is
    // denied rather than allowed by omission.
    expect(authorize(9999, null, null).ok).toBe(false)
  })
})

describe('the guard is per-query, not per-connection', () => {
  it('lets the app write again once it is removed', () => {
    // The Worker installs the authorizer for the duration of a console query
    // and takes it off afterwards, because the same connection is what syncs
    // deltas and builds indexes. If removal did not work, the first console
    // query would break sync until the page was reloaded.
    const db = guarded()
    arm(db)
    expect(() => db.exec('DELETE FROM cve')).toThrow()
    db.setAuthorizer(null)
    db.exec("INSERT INTO cve(id, cve_id, state) VALUES (2, 'CVE-2022-0002', 1)")
    expect(Number(db.prepare('SELECT count(*) AS n FROM cve').get()?.n)).toBe(2)
  })
})

describe('the row cap', () => {
  it('is a bound on what the Worker holds, not a display preference', () => {
    // 1,000 rows of description text is already megabytes, and every row is
    // structured-cloned to the page. The number itself is a judgement call; that
    // it is *finite* is not.
    expect(CONSOLE_ROW_LIMIT).toBeGreaterThan(100)
    expect(CONSOLE_ROW_LIMIT).toBeLessThanOrEqual(10_000)
  })
})
