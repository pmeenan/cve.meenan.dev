import { describe, expect, it } from 'vitest'

import {
  clearRecent,
  emptyStore,
  loadStore,
  RECENT_LIMIT,
  recordRecent,
  removeSaved,
  saveNamed,
  STORE_KEY,
  writeStore,
  type KeyValueStore,
} from '../../lib/saved'
import { emptyReport, REPORT_VERSION, type Report } from '../../lib/report'

/**
 * Saved reports and history (M4).
 *
 * These live in `localStorage`, which is a place this build does not control:
 * an entry there was written by some version of this app and is editable by
 * anyone with the console open. So the tests are mostly about what happens to
 * an entry that is malformed, hostile or from a newer build — and the required
 * answer is never "the app stops working", because a user with a corrupt entry
 * has no way to clear it if it does.
 *
 * The other property is the one this whole feature exists for: these survive
 * things the local database does not. A re-download or a schema bump destroys
 * the corpus copy (D-013, D-068), and it must not take a week of saved reports
 * with it — hence a separate store, tested separately.
 */

function store(initial?: string): KeyValueStore & { value: string | null } {
  return {
    value: initial ?? null,
    getItem(key: string) {
      return key === STORE_KEY ? this.value : null
    },
    setItem(key: string, value: string) {
      if (key === STORE_KEY) this.value = value
    },
  }
}

function report(over: Partial<Report> = {}): Report {
  return { ...emptyReport(), ...over }
}

describe('loadStore', () => {
  it('returns an empty store for a browser with no storage at all', () => {
    expect(loadStore(null)).toEqual(emptyStore())
  })

  it('survives every shape a corrupt entry can take', () => {
    for (const raw of [
      '',
      'not json',
      'null',
      '[]',
      '"a string"',
      '{"saved":"not a list"}',
      '{"saved":[null,42,"x"]}',
      '{"recent":[{"report":null}]}',
    ]) {
      expect(() => loadStore(store(raw))).not.toThrow()
      const loaded = loadStore(store(raw))
      expect(loaded.saved).toEqual([])
      expect(loaded.recent).toEqual([])
    }
  })

  it('throws nothing when reading storage itself throws', () => {
    // A browser with storage blocked for this origin throws on access, not on
    // write. Losing history there is fine; crashing the page is not.
    const hostile: KeyValueStore = {
      getItem() {
        throw new Error('blocked')
      },
      setItem() {
        throw new Error('blocked')
      },
    }
    expect(loadStore(hostile)).toEqual(emptyStore())
    expect(writeStore(hostile, emptyStore())).toBe(false)
  })

  it('drops the entries that no longer validate and keeps the ones that do', () => {
    // Entry by entry, not all or nothing: one report naming a dimension this
    // build dropped costs the user that report, not the other nineteen.
    const raw = JSON.stringify({
      saved: [
        { id: 'a', name: 'good', at: 1, report: report() },
        { id: 'b', name: 'bad axis', at: 2, report: { ...report(), rows: 'sqlite_master' } },
        { id: 'c', name: 'from the future', at: 3, report: { ...report(), v: REPORT_VERSION + 1 } },
      ],
      recent: [],
    })
    const loaded = loadStore(store(raw))
    expect(loaded.saved.map((entry) => entry.name)).toEqual(['good'])
  })

  it('re-applies the PUBLISHED default to a stored report that lost it (D-022)', () => {
    const raw = JSON.stringify({
      saved: [{ id: 'a', name: 'x', at: 1, report: { ...report(), filters: {} } }],
    })
    expect(loadStore(store(raw)).saved[0]!.report.filters.state).toBe('published')
  })

  it('bounds what it will read back', () => {
    const many = Array.from({ length: 500 }, (_, at) => ({
      id: `r${at}`,
      name: `n${at}`,
      at,
      report: report(),
    }))
    const loaded = loadStore(store(JSON.stringify({ saved: many, recent: many })))
    expect(loaded.recent.length).toBeLessThanOrEqual(RECENT_LIMIT)
    expect(loaded.saved.length).toBeLessThanOrEqual(100)
  })

  it('neutralizes timestamps outside the Date range before the UI renders them', () => {
    const raw = JSON.stringify({
      saved: [{ id: 'a', name: 'future', at: 1e308, report: report() }],
      recent: [{ id: 'b', name: 'past', at: -1e308, report: report({ rows: 'year' }) }],
    })
    const loaded = loadStore(store(raw))
    expect(loaded.saved[0]!.at).toBe(0)
    expect(loaded.recent[0]!.at).toBe(0)
    expect(() => new Date(loaded.saved[0]!.at).toISOString()).not.toThrow()
  })
})

describe('round trip', () => {
  it('survives a write and a read, which is what a reload is', () => {
    const held = store()
    const saved = saveNamed(
      emptyStore(),
      'Cisco criticals',
      report({ rows: 'vendor' }),
      1_700_000_000_000
    )
    expect(writeStore(held, saved)).toBe(true)
    const back = loadStore(held)
    expect(back.saved).toHaveLength(1)
    expect(back.saved[0]!.name).toBe('Cisco criticals')
    expect(back.saved[0]!.report.rows).toBe('vendor')
  })
})

describe('saveNamed', () => {
  it('replaces by name rather than accumulating near-duplicates', () => {
    let held = saveNamed(emptyStore(), 'Report', report({ rows: 'year' }), 1)
    held = saveNamed(held, 'Report', report({ rows: 'month' }), 2)
    expect(held.saved).toHaveLength(1)
    expect(held.saved[0]!.report.rows).toBe('month')
  })

  it('names an untitled save rather than storing a blank row', () => {
    expect(saveNamed(emptyStore(), '   ', report(), 1).saved[0]!.name).toBe('Untitled report')
  })

  it('puts the newest first', () => {
    let held = saveNamed(emptyStore(), 'first', report(), 1)
    held = saveNamed(held, 'second', report(), 2)
    expect(held.saved.map((entry) => entry.name)).toEqual(['second', 'first'])
  })
})

describe('removeSaved', () => {
  it('removes exactly one entry', () => {
    let held = saveNamed(emptyStore(), 'a', report(), 1)
    held = saveNamed(held, 'b', report({ rows: 'vendor' }), 2)
    const id = held.saved[1]!.id
    expect(removeSaved(held, id).saved.map((entry) => entry.name)).toEqual(['b'])
  })
})

describe('recordRecent', () => {
  it('deduplicates on the definition, keeping the latest run', () => {
    // Running the same report five times has to leave one entry, or a 20-entry
    // history covers the last minute instead of the session.
    let held = emptyStore()
    for (let at = 1; at <= 5; at += 1) held = recordRecent(held, report({ rows: 'year' }), at)
    expect(held.recent).toHaveLength(1)
    expect(held.recent[0]!.at).toBe(5)
  })

  it('treats a different definition as a different entry', () => {
    let held = recordRecent(emptyStore(), report({ rows: 'year' }), 1)
    held = recordRecent(held, report({ rows: 'month' }), 2)
    held = recordRecent(held, report({ rows: 'year', filters: { state: 'all' } }), 3)
    expect(held.recent).toHaveLength(3)
  })

  it('caps the history and keeps the newest end', () => {
    let held = emptyStore()
    for (let at = 0; at < RECENT_LIMIT + 10; at += 1) {
      held = recordRecent(held, report({ title: `report ${at}` }), at + 1)
    }
    expect(held.recent).toHaveLength(RECENT_LIMIT)
    expect(held.recent[0]!.report.title).toBe(`report ${RECENT_LIMIT + 9}`)
  })

  it('clears without touching the named list', () => {
    let held = saveNamed(emptyStore(), 'kept', report(), 1)
    held = recordRecent(held, report(), 2)
    const cleared = clearRecent(held)
    expect(cleared.recent).toEqual([])
    expect(cleared.saved).toHaveLength(1)
  })
})

describe('writeStore', () => {
  it('reports a quota failure rather than swallowing it', () => {
    // A report that appears to save and is gone on reload is worse than one
    // that says it could not be saved.
    const full: KeyValueStore = {
      getItem: () => null,
      setItem() {
        throw new Error('QuotaExceededError')
      },
    }
    expect(writeStore(full, saveNamed(emptyStore(), 'x', report(), 1))).toBe(false)
  })
})
