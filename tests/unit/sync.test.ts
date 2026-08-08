import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

import { describe, expect, it } from 'vitest'

import { LOOKUP_ARITY } from '../../lib/delta'
import {
  FORMAT_VERSION,
  LOOKUP_ORDER,
  SCHEMA_VERSION,
  type Delta,
  type DeltaLookups,
} from '../../lib/protocol'
import { indexSql, SEARCH_INDEXES } from '../../lib/search'
import { applyDelta, LOOKUP_COLUMNS, type SyncDb } from '../../lib/sync'

/**
 * Delta apply (M2's Sync), tested away from the browser.
 *
 * Two classes of failure live here and they fail very differently. The first is
 * loud: a delta that does not belong to this copy — wrong watermark, drifted ID
 * space, a reference to a lookup row the client has never seen — must be
 * refused with the database untouched. Those are asserted directly.
 *
 * The second is silent, and it is why this file exists rather than a couple of
 * round-trip assertions. The client builds its own full-text indexes (D-035)
 * over *external content* tables, so fts5 keeps no copy of the text and cannot
 * work out what to un-index by itself. Replace a description without the
 * explicit `'delete'` protocol and everything looks right — the tables are
 * there, the row counts are right, the promotion gate passes — while searches
 * match records on words their text no longer contains. The only check that
 * disagrees is `integrity-check` at `rank = 1`, and the obvious invocation is
 * the useless one (RE-005). So every case below runs that check, and the last
 * test in the file proves the check itself is load-bearing by breaking the
 * index and watching it fail.
 *
 * `node:sqlite` is the same SQLite the browser runs (3.53.0, matching
 * `@sqlite.org/sqlite-wasm`), so the fts5 behaviour asserted here is the fts5
 * that ships.
 */

/** The `SyncDb` the Worker builds over SQLite/WASM, over `node:sqlite` instead. */
function adapt(db: DatabaseSync): SyncDb {
  const args = (params?: readonly unknown[]) => (params ?? []) as SQLInputValue[]
  return {
    run(sql, params) {
      db.prepare(sql).run(...args(params))
    },
    row(sql, params) {
      const found = db.prepare(sql).get(...args(params))
      // `get` builds the row object in column order, so this is the same
      // positional array the Worker's `rowMode: 'array'` produces.
      return found === undefined ? null : Object.values(found)
    },
    column(sql, params) {
      return db
        .prepare(sql)
        .all(...args(params))
        .map((found) => Object.values(found)[0])
    },
  }
}

const NOTICE = 'CVE® is a trademark of The MITRE Corporation.'

function emptyLookups(): DeltaLookups {
  return { cna: [], cwe: [], vendor: [], product: [], host: [], url: [], vtype: [] }
}

/** One delta, with everything not under test left empty. */
function delta(from: number, to: number, parts: Partial<Delta> = {}): Delta {
  return {
    format: FORMAT_VERSION,
    schema: SCHEMA_VERSION,
    from,
    to,
    generated: 2_000,
    notice: NOTICE,
    lookups: emptyLookups(),
    upsert: [],
    delete: [],
    ...parts,
  }
}

/**
 * A small database in exactly the shape a downloaded one is in: the published
 * schema, executed rather than paraphrased (D-043), plus the three full-text
 * indexes the client builds for itself after a download.
 *
 * Two records, two vendors, and one of everything else — enough that a
 * replacement has dependent rows to drop and the indexes have something to lose
 * track of.
 */
function corpus(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync('pipeline/schema.sql', 'utf-8'))
  db.exec(`
    INSERT INTO meta(k, v) VALUES ('rev', 1), ('schema', ${SCHEMA_VERSION}), ('generated', 1000),
                                  ('notice', '${NOTICE}');
    INSERT INTO cna(id, name) VALUES (1, 'acme-cna');
    INSERT INTO cwe(id, cwe, descr) VALUES (1, 'CWE-79', 'Cross-site Scripting');
    INSERT INTO vendor(id, name) VALUES (1, 'acme'), (2, 'globex');
    INSERT INTO product(id, vendor_id, name) VALUES (1, 1, 'widget'), (2, 2, 'sprocket');
    INSERT INTO host(id, name) VALUES (1, 'example.org');
    INSERT INTO url(id, url, host_id) VALUES (1, 'https://example.org/a', 1);
    INSERT INTO vtype(id, name) VALUES (1, 'semver');

    INSERT INTO cve VALUES (1, 'CVE-2026-0001', 2026, 1, 1, 100, 100, 31, 7.5, 3, 'CVSS:3.1/AV:N',
                            50, 1, 0, 1);
    -- No SSVC assessment at all, which is the state half the corpus is in and
    -- the one a replacement must be able to leave alone (D-070).
    INSERT INTO cve VALUES (2, 'CVE-2026-0002', 2026, 1, 1, 200, 200, NULL, NULL, NULL, NULL,
                            NULL, NULL, NULL, NULL);
    INSERT INTO cve_text VALUES (1, 'alpha buffer overflow in the parser',
                                 'Widget parser overflow', NULL);
    INSERT INTO cve_text VALUES (2, 'beta injection in the handler', NULL, NULL);
    INSERT INTO cve_cwe VALUES (1, 1);
    INSERT INTO cve_prod VALUES (1, 1, 2);
    INSERT INTO cve_ref VALUES (1, 1);
    INSERT INTO cve_ver VALUES (1, 1, 1, '1.0', NULL, '1.4', 1);
  `)
  for (const index of SEARCH_INDEXES) {
    const sql = indexSql(index)
    db.exec(sql.drop)
    db.exec(sql.create)
    db.exec(`INSERT INTO ${index.fts}(${index.fts}) VALUES('rebuild')`)
  }
  return db
}

/**
 * The one form of the check that compares the index against its content table.
 * Throws "database disk image is malformed" when they have drifted (RE-005).
 */
function assertIndexesAgree(db: DatabaseSync): void {
  for (const index of SEARCH_INDEXES) {
    db.exec(`INSERT INTO ${index.fts}(${index.fts}, rank) VALUES('integrity-check', 1)`)
  }
}

function matches(db: DatabaseSync, fts: string, term: string): number[] {
  return db
    .prepare(`SELECT rowid FROM ${fts} WHERE ${fts} MATCH ? ORDER BY rowid`)
    .all(term)
    .map((row) => Number((row as { rowid: number }).rowid))
}

function value(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): unknown {
  const row = db.prepare(sql).get(...params)
  return row === undefined ? null : Object.values(row)[0]
}

function watermark(db: DatabaseSync): unknown {
  return value(db, "SELECT v FROM meta WHERE k = 'rev'")
}

describe('the column lists apply binds into', () => {
  it('are the published schema’s, in the published schema’s order', () => {
    const db = corpus()
    for (const table of LOOKUP_ORDER) {
      const columns = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => (row as { name: string }).name)
      // Not "contains": apply names every column and binds the wire tuple
      // positionally against that list, so an added column or a reorder here
      // would put values in the wrong places rather than fail.
      expect(columns, `${table} drifted from lib/sync.ts`).toEqual([...LOOKUP_COLUMNS[table]])
      expect(LOOKUP_COLUMNS[table].length).toBe(LOOKUP_ARITY[table])
    }
    db.close()
  })
})

describe('applying a delta', () => {
  it('advances the watermark with the rows it carries', () => {
    const db = corpus()
    const counts = applyDelta(
      adapt(db),
      delta(1, 2, {
        upsert: [{ id: 3, cve: 'CVE-2026-0003', y: 2026, st: 1, descr: 'gamma use after free' }],
      })
    )

    expect(counts).toEqual({ from: 1, to: 2, upserts: 1, inserts: 1, deletes: 0 })
    expect(watermark(db)).toBe(2)
    // `generated` moves with it: it dates the same content, and the staleness
    // indicator reads it.
    expect(value(db, "SELECT v FROM meta WHERE k = 'generated'")).toBe(2_000)
    expect(value(db, 'SELECT count(*) FROM cve')).toBe(3)
    expect(matches(db, 'fts', 'gamma')).toEqual([3])
    assertIndexesAgree(db)
    db.close()
  })

  it('counts new CVEs apart from revisions of records this copy holds', () => {
    // The number behind "N new CVEs since your last sync". It has to be counted
    // *before* the rows are written, because afterwards every upsert looks
    // identical — which is why it comes out of the pairing preflight rather
    // than from a second pass.
    const db = corpus()
    const counts = applyDelta(
      adapt(db),
      delta(1, 2, {
        upsert: [
          // One record this copy already holds, revised…
          { id: 1, cve: 'CVE-2026-0001', y: 2026, st: 1, descr: 'alpha, now with a fix' },
          // …and one it has never seen.
          { id: 3, cve: 'CVE-2026-0003', y: 2026, st: 1, descr: 'gamma use after free' },
        ],
      })
    )

    expect(counts.upserts).toBe(2)
    expect(counts.inserts).toBe(1)

    // And re-applying the same records at the next revision adds nothing new:
    // both are now held, so the honest answer is zero rather than two.
    const again = applyDelta(
      adapt(db),
      delta(2, 3, {
        upsert: [
          { id: 1, cve: 'CVE-2026-0001', y: 2026, st: 1, descr: 'alpha, fixed again' },
          { id: 3, cve: 'CVE-2026-0003', y: 2026, st: 1, descr: 'gamma, unchanged' },
        ],
      })
    )
    expect(again.upserts).toBe(2)
    expect(again.inserts).toBe(0)

    // A record a tombstone removed and a later delta re-publishes is new again,
    // which is what the user's copy actually experiences.
    applyDelta(adapt(db), delta(3, 4, { delete: ['CVE-2026-0003'] }))
    const revived = applyDelta(
      adapt(db),
      delta(4, 5, {
        upsert: [{ id: 3, cve: 'CVE-2026-0003', y: 2026, st: 1, descr: 'gamma, back' }],
      })
    )
    expect(revived.inserts).toBe(1)
    assertIndexesAgree(db)
    db.close()
  })

  it('replaces a record whole — absent means absent (D-031)', () => {
    const db = corpus()
    applyDelta(
      adapt(db),
      delta(1, 2, {
        upsert: [
          {
            // Record 1 had a CWE, a product, a reference, a version row, a CVSS
            // score and a description. It keeps only the description, changed.
            id: 1,
            cve: 'CVE-2026-0001',
            y: 2026,
            st: 2,
            descr: 'delta heap corruption in the decoder',
          },
        ],
      })
    )

    expect(value(db, 'SELECT state FROM cve WHERE id = 1')).toBe(2)
    expect(value(db, 'SELECT cvss_ver FROM cve WHERE id = 1')).toBe(null)
    for (const table of ['cve_cwe', 'cve_prod', 'cve_ref', 'cve_ver']) {
      expect(value(db, `SELECT count(*) FROM ${table} WHERE cve_id = 1`), table).toBe(0)
    }
    // The old text is gone from the index, not merely overwritten in the
    // content table. Without the `'delete'` protocol this is the assertion that
    // fails — and nothing else would.
    expect(matches(db, 'fts', 'alpha')).toEqual([])
    expect(matches(db, 'fts', 'heap')).toEqual([1])
    assertIndexesAgree(db)
    db.close()
  })

  it('un-indexes a record that loses its description entirely', () => {
    const db = corpus()
    // A record with no English description has no `cve_text` row at all
    // (D-023), which the wire expresses by omitting the key.
    applyDelta(
      adapt(db),
      delta(1, 2, { upsert: [{ id: 1, cve: 'CVE-2026-0001', y: 2026, st: 1 }] })
    )

    expect(value(db, 'SELECT count(*) FROM cve_text WHERE cve_id = 1')).toBe(0)
    expect(matches(db, 'fts', 'alpha')).toEqual([])
    expect(matches(db, 'fts', 'beta')).toEqual([2])
    assertIndexesAgree(db)
    db.close()
  })

  it('removes a tombstoned record and everything hanging off it', () => {
    const db = corpus()
    const counts = applyDelta(adapt(db), delta(1, 2, { delete: ['CVE-2026-0001'] }))

    expect(counts.deletes).toBe(1)
    expect(value(db, 'SELECT count(*) FROM cve')).toBe(1)
    expect(value(db, 'SELECT count(*) FROM cve_ver WHERE cve_id = 1')).toBe(0)
    expect(matches(db, 'fts', 'alpha')).toEqual([])
    assertIndexesAgree(db)
    db.close()
  })

  it('ignores a tombstone for a record this copy never held', () => {
    // The ordinary case for a client that downloaded a snapshot published after
    // the record was withdrawn: the delta still names it.
    const db = corpus()
    expect(() => applyDelta(adapt(db), delta(1, 2, { delete: ['CVE-1999-9999'] }))).not.toThrow()
    expect(watermark(db)).toBe(2)
    expect(value(db, 'SELECT count(*) FROM cve')).toBe(2)
    db.close()
  })

  it('interns new lookup rows and indexes the vendor and product names', () => {
    const db = corpus()
    applyDelta(
      adapt(db),
      delta(1, 2, {
        lookups: {
          ...emptyLookups(),
          vendor: [[3, 'initech']],
          product: [[3, 3, 'stapler']],
          host: [[2, 'newhost.example.org']],
          url: [[2, 'https://newhost.example.org/x', 2]],
        },
        upsert: [
          {
            id: 3,
            cve: 'CVE-2026-0003',
            y: 2026,
            st: 1,
            prod: [[3, 1]],
            ref: [2],
            descr: 'epsilon',
          },
        ],
      })
    )

    expect(value(db, 'SELECT name FROM vendor WHERE id = 3')).toBe('initech')
    expect(matches(db, 'fts_vendor', 'initech')).toEqual([3])
    expect(matches(db, 'fts_product', 'stapler')).toEqual([3])
    assertIndexesAgree(db)
    db.close()
  })

  it('re-indexes a lookup row whose content changed under an id already held', () => {
    // `extra` in pipeline/delta.py: a row can be re-shipped because its content
    // changed, not only because it is new. The name in the index has to change
    // with it, which needs the old value — the one thing a delta does not carry.
    const db = corpus()
    applyDelta(
      adapt(db),
      delta(1, 2, { lookups: { ...emptyLookups(), vendor: [[1, 'acme industries']] } })
    )

    expect(value(db, 'SELECT name FROM vendor WHERE id = 1')).toBe('acme industries')
    expect(matches(db, 'fts_vendor', 'acme')).toEqual([1])
    expect(matches(db, 'fts_vendor', 'industries')).toEqual([1])
    assertIndexesAgree(db)
    db.close()
  })

  it('leaves the index alone when a lookup row arrives unchanged', () => {
    const db = corpus()
    const before = value(db, 'SELECT count(*) FROM fts_vendor_data')
    applyDelta(adapt(db), delta(1, 2, { lookups: { ...emptyLookups(), vendor: [[1, 'acme']] } }))

    expect(matches(db, 'fts_vendor', 'acme')).toEqual([1])
    // A delete/insert pair for an identical value would churn the index's own
    // segments for nothing; this is what says it did not happen.
    expect(value(db, 'SELECT count(*) FROM fts_vendor_data')).toBe(before)
    assertIndexesAgree(db)
    db.close()
  })

  it('applies a chain one file at a time, each starting where the last ended', () => {
    const db = corpus()
    const target = adapt(db)
    applyDelta(
      target,
      delta(1, 2, { upsert: [{ id: 3, cve: 'C-3', y: 2026, st: 1, descr: 'z1' }] })
    )
    applyDelta(
      target,
      delta(2, 4, { upsert: [{ id: 4, cve: 'C-4', y: 2026, st: 1, descr: 'z2' }] })
    )

    expect(watermark(db)).toBe(4)
    expect(value(db, 'SELECT count(*) FROM cve')).toBe(4)
    assertIndexesAgree(db)
    db.close()
  })
})

describe('a delta this copy must not apply', () => {
  it('is refused when it does not start at the local watermark', () => {
    const db = corpus()
    expect(() => applyDelta(adapt(db), delta(7, 8))).toThrow(
      /starts at rev 7 but this copy is at 1/
    )
    expect(watermark(db)).toBe(1)
    db.close()
  })

  it('is refused a second time, which is what makes re-running safe', () => {
    const db = corpus()
    const once = delta(1, 2, {
      upsert: [{ id: 3, cve: 'CVE-2026-0003', y: 2026, st: 1, descr: 'gamma' }],
    })
    applyDelta(adapt(db), once)
    // Not applied twice and not silently ignored: a delta is a step from one
    // specific revision, and this copy has taken it.
    expect(() => applyDelta(adapt(db), once)).toThrow(/starts at rev 1 but this copy is at 2/)
    expect(value(db, 'SELECT count(*) FROM cve')).toBe(3)
    db.close()
  })

  it('is refused when a CVE has moved to a different row id', () => {
    const db = corpus()
    expect(() =>
      applyDelta(
        adapt(db),
        delta(1, 2, { upsert: [{ id: 9, cve: 'CVE-2026-0001', y: 2026, st: 1 }] })
      )
    ).toThrow(/ID space has drifted/)
    expect(watermark(db)).toBe(1)
    db.close()
  })

  it('is refused when a row id has been given to a different CVE', () => {
    // The direction that destroys data quietly: without this check the
    // replacement below drops record 1 with no error and no orphan to notice
    // it by — a silent undercount.
    const db = corpus()
    expect(() =>
      applyDelta(
        adapt(db),
        delta(1, 2, { upsert: [{ id: 1, cve: 'CVE-2026-4242', y: 2026, st: 1 }] })
      )
    ).toThrow(/row 1 is CVE-2026-0001 in this copy but CVE-2026-4242/)
    expect(value(db, 'SELECT cve_id FROM cve WHERE id = 1')).toBe('CVE-2026-0001')
    db.close()
  })

  it('does not let a tombstone hide reuse of its row id', () => {
    // Tombstones apply before upserts. If pairing validation happens only at
    // insert time, this delete erases the evidence that row 1 already belongs
    // to a different CVE and silently permits the server to reissue the id.
    const db = corpus()
    expect(() =>
      applyDelta(
        adapt(db),
        delta(1, 2, {
          delete: ['CVE-2026-0001'],
          upsert: [{ id: 1, cve: 'CVE-2026-4242', y: 2026, st: 1 }],
        })
      )
    ).toThrow(/row 1 is CVE-2026-0001 in this copy but CVE-2026-4242/)
    expect(value(db, 'SELECT cve_id FROM cve WHERE id = 1')).toBe('CVE-2026-0001')
    expect(watermark(db)).toBe(1)
    assertIndexesAgree(db)
    db.close()
  })

  it('is refused when a record references a lookup row this copy will not have', () => {
    const db = corpus()
    expect(() =>
      applyDelta(
        adapt(db),
        delta(1, 2, {
          upsert: [
            {
              id: 3,
              cve: 'CVE-2026-0003',
              y: 2026,
              st: 1,
              prod: [
                [1, null],
                [77, null],
              ],
            },
          ],
        })
      )
    ).toThrow(/references 1 product row\(s\) this copy does not have \(77\)/)
    expect(value(db, 'SELECT count(*) FROM cve')).toBe(2)
    db.close()
  })

  it('is refused when a shipped product names a vendor nobody has', () => {
    const db = corpus()
    expect(() =>
      applyDelta(
        adapt(db),
        delta(1, 2, { lookups: { ...emptyLookups(), product: [[9, 88, 'orphan']] } })
      )
    ).toThrow(/references 1 vendor row\(s\)/)
    expect(value(db, 'SELECT count(*) FROM product')).toBe(2)
    db.close()
  })

  it('is refused when it contradicts itself', () => {
    const db = corpus()
    const target = adapt(db)
    const record = { id: 3, cve: 'CVE-2026-0003', y: 2026, st: 1 }

    expect(() => applyDelta(target, delta(1, 2, { upsert: [record, record] }))).toThrow(
      /upserts row 3 twice/
    )
    expect(() =>
      applyDelta(target, delta(1, 2, { upsert: [record, { ...record, id: 4 }] }))
    ).toThrow(/upserts CVE-2026-0003 twice/)
    expect(() =>
      applyDelta(target, delta(1, 2, { upsert: [record], delete: ['CVE-2026-0003'] }))
    ).toThrow(/both upserts and deletes/)
    expect(() =>
      applyDelta(
        target,
        delta(1, 2, {
          lookups: {
            ...emptyLookups(),
            vendor: [
              [3, 'one'],
              [3, 'two'],
            ],
          },
        })
      )
    ).toThrow(/vendor row 3 twice/)
    expect(watermark(db)).toBe(1)
    db.close()
  })

  it('leaves the database exactly as it was when it fails part way through', () => {
    // The refusal is the *last* record in the file, so everything before it has
    // already been written when the transaction unwinds. This is the property
    // "an interrupted sync rolls back and re-running is safe" rests on.
    const db = corpus()
    const before = {
      records: value(db, 'SELECT count(*) FROM cve'),
      rev: watermark(db),
      generated: value(db, "SELECT v FROM meta WHERE k = 'generated'"),
      text: value(db, 'SELECT descr FROM cve_text WHERE cve_id = 1'),
      vendor: value(db, 'SELECT name FROM vendor WHERE id = 1'),
    }

    expect(() =>
      applyDelta(
        adapt(db),
        delta(1, 2, {
          lookups: { ...emptyLookups(), vendor: [[1, 'renamed under a doomed delta']] },
          delete: ['CVE-2026-0001'],
          upsert: [
            { id: 3, cve: 'CVE-2026-0003', y: 2026, st: 1, descr: 'inserted under a doomed delta' },
            // Row 2 is CVE-2026-0002 here and is not being deleted, so this is
            // the drift check firing after three writes have already landed.
            { id: 2, cve: 'CVE-2026-9999', y: 2026, st: 1 },
          ],
        })
      )
    ).toThrow(/ID space has drifted/)

    expect({
      records: value(db, 'SELECT count(*) FROM cve'),
      rev: watermark(db),
      generated: value(db, "SELECT v FROM meta WHERE k = 'generated'"),
      text: value(db, 'SELECT descr FROM cve_text WHERE cve_id = 1'),
      vendor: value(db, 'SELECT name FROM vendor WHERE id = 1'),
    }).toEqual(before)
    // And the indexes rolled back with the rows they describe.
    expect(matches(db, 'fts', 'alpha')).toEqual([1])
    expect(matches(db, 'fts_vendor', 'acme')).toEqual([1])
    assertIndexesAgree(db)

    // Re-running with a delta this copy *can* take then works, which is the
    // other half of "safe to re-run".
    applyDelta(adapt(db), delta(1, 2, { delete: ['CVE-2026-0001'] }))
    expect(watermark(db)).toBe(2)
    db.close()
  })
})

describe('the index check every case above relies on', () => {
  it('catches drift that nothing else does', () => {
    const db = corpus()
    // Exactly what apply would leave behind if it skipped the `'delete'`
    // protocol: the content table moves on, the index does not.
    db.exec("UPDATE cve_text SET descr = 'quenelle placeholder' WHERE cve_id = 1")

    expect(() => assertIndexesAgree(db)).toThrow(/malformed/)
    // And the invocation an agent would reach for first passes on the same
    // database, which is the trap RE-005 records.
    expect(() => db.exec("INSERT INTO fts(fts) VALUES('integrity-check')")).not.toThrow()
    // The damage is real, not theoretical: the row still matches a word its
    // text no longer contains.
    expect(matches(db, 'fts', 'alpha')).toEqual([1])
    db.close()
  })
})

describe('a cve_text row with nothing indexable in it', () => {
  /**
   * Every REJECTED record is this shape: a `cve_text` row whose `descr` and
   * `title` are both NULL, carrying only the rejection reason. 17,842 records
   * in the real corpus are like this (D-070), so it is the common case rather
   * than an edge one — and it is the one where fts5's `'delete'` protocol has
   * to be handed a pair of NULLs and accept them (RE-005).
   */
  function withRejected(): DatabaseSync {
    const db = corpus()
    applyDelta(
      adapt(db),
      delta(1, 2, {
        upsert: [{ id: 3, cve: 'CVE-2026-0009', y: 2026, st: 2, reason: 'Withdrawn: duplicate.' }],
      })
    )
    return db
  }

  it('is stored, and indexed as a row with no terms', () => {
    const db = withRejected()
    expect(value(db, 'SELECT count(*) FROM cve_text WHERE cve_id = 3')).toBe(1)
    expect(value(db, 'SELECT descr FROM cve_text WHERE cve_id = 3')).toBeNull()
    // The reason is deliberately *not* searchable: every rejection is the same
    // boilerplate, and indexing it would put that in the same term space as the
    // prose (the reasoning D-035 applied to reference URLs).
    expect(matches(db, 'fts', 'Withdrawn')).toEqual([])
    assertIndexesAgree(db)
    db.close()
  })

  it('round-trips through replacement without corrupting the index', () => {
    const db = withRejected()
    applyDelta(
      adapt(db),
      delta(2, 3, {
        upsert: [
          {
            id: 3,
            cve: 'CVE-2026-0009',
            y: 2026,
            st: 1,
            // Now described and no longer rejected — the transition that has to
            // un-index a pair of NULLs and index a description in their place.
            descr: 'restored and described',
          },
        ],
      })
    )
    expect(matches(db, 'fts', 'restored')).toEqual([3])
    expect(value(db, 'SELECT reason FROM cve_text WHERE cve_id = 3')).toBeNull()
    assertIndexesAgree(db)
    db.close()
  })

  it('survives being tombstoned', () => {
    const db = withRejected()
    applyDelta(adapt(db), delta(2, 3, { delete: ['CVE-2026-0009'] }))
    expect(value(db, 'SELECT count(*) FROM cve_text WHERE cve_id = 3')).toBe(0)
    assertIndexesAgree(db)
    db.close()
  })
})
