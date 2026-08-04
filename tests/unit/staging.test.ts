import { describe, expect, it } from 'vitest'

import type { Manifest } from '../../lib/protocol'
import {
  assertLocallyUsable,
  assertPromotable,
  classifyCandidate,
  REQUIRED_TABLES,
  type CandidateReader,
  bindsTo,
  chooseStagingFile,
  completed,
  isOurEntry,
  newRecord,
  parseStagingRecord,
  pendingChunks,
  stagingPlan,
  LEGACY_DB_FILE,
  SLOT_FILES,
  STAGING_RECORD_FILE,
  STAGING_RECORD_VERSION,
  type StagedMeta,
  type StagingPlan,
  type StagingRecord,
} from '../../lib/staging'

/**
 * Staged replacement's decision logic (D-061), tested away from the browser.
 *
 * The failures these guard against all have the same shape: a download that
 * *looks* complete promoting a database that is not, or a resume mixing bytes
 * from two generations. Neither shows up as an error — both show up as wrong
 * query results weeks later.
 */

const hash = (seed: string) => seed.repeat(64).slice(0, 64)

function manifest(overrides: Partial<Manifest['snapshot']> = {}): Manifest {
  return {
    format: 1,
    schema: 1,
    rev: 3,
    generated: 1785586104,
    notice: 'CVE record content: Copyright © 1999-2026, The MITRE Corporation.',
    snapshot: {
      path: 'snapshot-2',
      rev: 2,
      raw_bytes: 90,
      chunk_bytes: 50,
      chunks: [
        { name: '000.br', offset: 0, raw_bytes: 50, bytes: 10, sha256: hash('a') },
        { name: '001.br', offset: 50, raw_bytes: 40, bytes: 8, sha256: hash('b') },
      ],
      ...overrides,
    },
    deltas: [],
  }
}

describe('stagingPlan', () => {
  it('reads a well-formed snapshot in file order', () => {
    const plan = stagingPlan(manifest())
    expect(plan.path).toBe('snapshot-2')
    expect(plan.rev).toBe(2)
    expect(plan.rawBytes).toBe(90)
    expect(plan.chunks.map((c) => c.name)).toEqual(['000.br', '001.br'])
  })

  it('sorts by offset, so a shuffled manifest still describes the same file', () => {
    const shuffled = manifest()
    shuffled.snapshot.chunks.reverse()
    expect(stagingPlan(shuffled).chunks.map((c) => c.offset)).toEqual([0, 50])
  })

  it('accepts a manifest that predates snapshot.rev (D-055)', () => {
    const old = manifest()
    delete old.snapshot.rev
    // The database's own meta.rev is the watermark; the manifest's copy is a
    // cross-check when it exists and nothing when it does not.
    expect(stagingPlan(old).rev).toBeNull()
  })

  it('refuses chunks that leave a hole', () => {
    // The failure that motivates the whole check: every chunk matches its
    // published SHA-256, the file is the right length, and bytes 50..69 are
    // zeros no hash in the manifest ever covered.
    const holed = manifest()
    holed.snapshot.chunks[1]!.offset = 70
    holed.snapshot.chunks[1]!.raw_bytes = 20
    expect(() => stagingPlan(holed)).toThrow(/do not cover/)
  })

  it('refuses chunks that overlap', () => {
    const overlapping = manifest()
    overlapping.snapshot.chunks[1]!.offset = 40
    expect(() => stagingPlan(overlapping)).toThrow(/do not cover/)
  })

  it('refuses chunks that do not add up to the declared length', () => {
    const short = manifest()
    short.snapshot.raw_bytes = 100
    expect(() => stagingPlan(short)).toThrow(/cover 90 bytes of a 100-byte snapshot/)
  })

  it('refuses a chunk name that is not one publish.py writes', () => {
    const hostile = manifest()
    hostile.snapshot.chunks[0]!.name = '../../etc/passwd'
    expect(() => stagingPlan(hostile)).toThrow(/will not fetch/)
  })

  it('refuses a snapshot directory that is not one publish.py writes', () => {
    const hostile = manifest({ path: '../secrets' })
    expect(() => stagingPlan(hostile)).toThrow(/will not fetch/)
  })

  it('refuses a chunk with a malformed hash', () => {
    const hostile = manifest()
    hostile.snapshot.chunks[0]!.sha256 = 'nope'
    expect(() => stagingPlan(hostile)).toThrow(/64 hex characters/)
  })

  it('refuses a zero-length snapshot', () => {
    // Chunks kept, so the only reason to reject is the length — the earlier
    // version passed `chunks: []` too and would have passed with the length
    // check deleted.
    expect(() => stagingPlan(manifest({ raw_bytes: 0 }))).toThrow(/unusable snapshot/)
  })

  it('refuses the same chunk name twice, even when the offsets tile perfectly', () => {
    // The hole this closes is invisible to the tiling walk: everything
    // downstream is keyed by name, so two entries sharing one collapse into a
    // single fetch and the loser's byte range is never written — while the
    // offsets add up to exactly `raw_bytes`.
    const cloned = manifest()
    cloned.snapshot.chunks[1]!.name = '000.br'
    expect(() => stagingPlan(cloned)).toThrow(/same chunk name twice/)
  })

  it.each([
    ['a negative offset', { offset: -1 }],
    ['a fractional offset', { offset: 0.5 }],
    ['a fractional length', { raw_bytes: 1.5 }],
    ['a zero-length chunk', { raw_bytes: 0 }],
  ])('refuses %s', (_label, fields) => {
    const broken = manifest()
    Object.assign(broken.snapshot.chunks[0]!, fields)
    expect(() => stagingPlan(broken)).toThrow(/unusable offset or length/)
  })
})

describe('chooseStagingFile', () => {
  it('stages into the slot that is not live', () => {
    expect(chooseStagingFile(SLOT_FILES[0])).toBe(SLOT_FILES[1])
    expect(chooseStagingFile(SLOT_FILES[1])).toBe(SLOT_FILES[0])
  })

  it('stages into the first slot when there is no local copy', () => {
    expect(chooseStagingFile(null)).toBe(SLOT_FILES[0])
  })

  it('leaves M1 copies alone: the legacy name occupies neither slot', () => {
    // Staging over the live legacy file would be the exact failure staged
    // replacement exists to prevent.
    expect(chooseStagingFile(LEGACY_DB_FILE)).toBe(SLOT_FILES[0])
  })
})

describe('bindsTo', () => {
  const plan = stagingPlan(manifest())
  const record = newRecord(plan, SLOT_FILES[0])

  it('binds a record to the download it was written for', () => {
    expect(bindsTo(record, plan, SLOT_FILES[0])).toBe(true)
  })

  it('does not bind a record written for the other slot', () => {
    expect(bindsTo(record, plan, SLOT_FILES[1])).toBe(false)
  })

  /**
   * One mutated field per case, everything else identical.
   *
   * Changing two at once is how a test passes while the comparison it names
   * does nothing: an earlier version of this suite rotated `path` and `rev`
   * together, so deleting the `path` comparison from `bindsTo` left the whole
   * unit suite green.
   */
  it.each([
    ['a different generation', (p: StagingPlan) => ({ ...p, path: 'snapshot-9' })],
    ['a different declared revision', (p: StagingPlan) => ({ ...p, rev: 9 })],
    ['a revision the origin has stopped declaring', (p: StagingPlan) => ({ ...p, rev: null })],
    ['a different total length', (p: StagingPlan) => ({ ...p, rawBytes: p.rawBytes + 1 })],
    ['a chunk that moved', (p: StagingPlan) => patch(p, 1, { offset: 60 })],
    ['a chunk that resized', (p: StagingPlan) => patch(p, 1, { rawBytes: 30 })],
    [
      'a chunk republished under the same name',
      (p: StagingPlan) => patch(p, 1, { sha256: hash('c') }),
    ],
    ['a chunk renamed', (p: StagingPlan) => patch(p, 1, { name: '002.br' })],
    ['a different chunk count', (p: StagingPlan) => ({ ...p, chunks: p.chunks.slice(0, 1) })],
  ])('does not bind to %s', (_label, mutate) => {
    expect(bindsTo(record, mutate(stagingPlan(manifest())), SLOT_FILES[0])).toBe(false)
  })

  it('does not bind a record written by a different build of this file', () => {
    expect(bindsTo({ ...record, v: record.v + 1 }, plan, SLOT_FILES[0])).toBe(false)
  })

  it('does not bind when the bitmap is a different length from the chunk list', () => {
    // Reachable only through a hand-edited or truncated record, but the whole
    // point of the bitmap is that `done[i]` describes `chunks[i]`.
    expect(bindsTo({ ...record, done: [true] }, plan, SLOT_FILES[0])).toBe(false)
  })

  function patch(plan: StagingPlan, at: number, fields: Partial<StagingPlan['chunks'][number]>) {
    return {
      ...plan,
      chunks: plan.chunks.map((chunk, index) => (index === at ? { ...chunk, ...fields } : chunk)),
    }
  }

  it('still binds when only the head revision moved on', () => {
    // A delta published while a download was interrupted advances the head
    // without changing one snapshot byte. Discarding staged chunks over that
    // would make resume useless on exactly the days it matters.
    const later = manifest()
    later.rev = 11
    expect(bindsTo(record, stagingPlan(later), SLOT_FILES[0])).toBe(true)
  })
})

describe('pendingChunks', () => {
  const plan = stagingPlan(manifest())

  it('asks for everything when nothing has landed', () => {
    expect(pendingChunks(newRecord(plan, SLOT_FILES[0]), manifest())).toHaveLength(2)
  })

  it('asks only for what is missing', () => {
    const record = newRecord(plan, SLOT_FILES[0])
    record.done[0] = true
    expect(completed(record)).toBe(1)
    expect(pendingChunks(record, manifest()).map((c) => c.name)).toEqual(['001.br'])
  })

  it('asks for nothing once the bitmap is full', () => {
    const record = newRecord(plan, SLOT_FILES[0])
    record.done = [true, true]
    expect(pendingChunks(record, manifest())).toEqual([])
  })

  it('returns the manifest entry, not the record copy, so the fetch has a URL', () => {
    const entries = pendingChunks(newRecord(plan, SLOT_FILES[0]), manifest())
    expect(entries[0]).toMatchObject({ name: '000.br', bytes: 10, sha256: hash('a') })
  })

  it('refuses to silently skip a chunk the manifest no longer names', () => {
    // Skipping instead of throwing would leave that chunk's byte range
    // unwritten with nothing reporting it — the bitmap would still fill up.
    const renamed = manifest()
    renamed.snapshot.chunks[1]!.name = '009.br'
    expect(() => pendingChunks(newRecord(plan, SLOT_FILES[0]), renamed)).toThrow(
      /names a chunk the manifest does not/
    )
  })
})

describe('parseStagingRecord', () => {
  const valid = (): StagingRecord => newRecord(stagingPlan(manifest()), SLOT_FILES[0])
  const roundTrip = (record: unknown) => parseStagingRecord(JSON.parse(JSON.stringify(record)))

  it('round-trips a record it wrote', () => {
    const record = valid()
    record.done[0] = true
    expect(roundTrip(record)).toEqual(record)
  })

  // Fed to the parser directly. Wrapping these in `JSON.parse` inside the test
  // meant the *test's own* try/catch produced the null and `parseStagingRecord`
  // was never called — both cases passed with the function stubbed out to
  // return a bogus object. The real try/catch lives in the Worker.
  it.each([
    ['nothing at all', undefined],
    ['a JSON null', null],
    ['a top-level array', []],
    ['a bare string', 'staging'],
    ['a number', 7],
    ['an object with nothing in it', {}],
    ['the envelope alone', { v: 1, file: 'cve-a.sqlite' }],
  ])('reports %s as no record rather than throwing', (_label, value) => {
    // The record is an optimization. The correct response to a corrupt one is
    // to download again, never to fail a download the user asked for.
    let parsed: StagingRecord | null | undefined
    expect(() => {
      parsed = parseStagingRecord(value)
    }).not.toThrow()
    expect(parsed).toBeNull()
  })

  it.each([
    ['a bumped record version', (r: StagingRecord) => ({ ...r, v: STAGING_RECORD_VERSION + 1 })],
    ['a slot name we do not own', (r: StagingRecord) => ({ ...r, file: 'cve.sqlite' })],
    ['a slot name with a path in it', (r: StagingRecord) => ({ ...r, file: '../cve-a.sqlite' })],
    ['a bitmap of the wrong length', (r: StagingRecord) => ({ ...r, done: [true] })],
    ['a bitmap of non-booleans', (r: StagingRecord) => ({ ...r, done: [1, 0] })],
    ['a chunk name with a path in it', (r: StagingRecord) => mutate(r, 0, { name: '../000.br' })],
    ['a malformed chunk hash', (r: StagingRecord) => mutate(r, 0, { sha256: 'short' })],
    ['a negative offset', (r: StagingRecord) => mutate(r, 1, { offset: -1 })],
    ['a zero-length chunk', (r: StagingRecord) => mutate(r, 1, { rawBytes: 0 })],
    ['no chunks at all', (r: StagingRecord) => ({ ...r, chunks: [], done: [] })],
    ['a fractional length', (r: StagingRecord) => ({ ...r, rawBytes: 1.5 })],
    ['a revision that is not one', (r: StagingRecord) => ({ ...r, rev: 'two' })],
  ])('refuses %s', (_label, corrupt) => {
    expect(roundTrip(corrupt(valid()))).toBeNull()
  })

  function mutate(record: StagingRecord, at: number, patch: Record<string, unknown>) {
    const chunks = record.chunks.map((chunk, index) =>
      index === at ? { ...chunk, ...patch } : chunk
    )
    return { ...record, chunks }
  }
})

/**
 * The promotion gate — the one decision here that replaces a database the user
 * is relying on.
 *
 * Reaching it through the Worker costs a full import of a known-good artifact,
 * so before it moved into this module every one of its refusals was unreachable
 * from the test suite: the whole body could be deleted with everything green.
 */
describe('assertPromotable', () => {
  const plan = () => stagingPlan(manifest())
  const good: StagedMeta = {
    schema: 1,
    rev: 2,
    notice: 'CVE record content: Copyright © 1999-2026, The MITRE Corporation.',
    records: 372_322,
    promoted: 0,
  }
  // `Partial<StagedMeta>` rather than `Partial<typeof good>`: the point of the
  // gate is what it does with values the schema says cannot happen, so the
  // overrides have to be able to be null, undefined or the wrong type.
  const check = (meta: Partial<StagedMeta>, head: unknown = 3, p = plan()) =>
    assertPromotable({ ...good, ...meta }, head, p, 1)

  it('accepts a staged copy that matches the manifest', () => {
    expect(() => check({})).not.toThrow()
  })

  it('refuses a schema this build does not speak', () => {
    // D-013: the local database is a rebuildable cache, so the honest response
    // is a re-download — but never a silent promotion.
    expect(() => check({ schema: 2 })).toThrow(/schema 2, but this build speaks 1/)
  })

  it.each([
    ['a missing meta row', undefined],
    ['a null', null],
    ['a string', '2'],
    ['a negative revision', -1],
    ['a fractional revision', 2.5],
  ])('refuses %s where the watermark belongs', (_label, rev) => {
    expect(() => check({ rev })).toThrow(/no usable revision/)
  })

  it('refuses a copy whose revision contradicts the manifest', () => {
    // The publish was inconsistent; syncing from the wrong watermark would then
    // silently skip or replay a day of records.
    expect(() => check({ rev: 7 })).toThrow(/promised snapshot rev 2, the staged copy carries 7/)
  })

  it('refuses a copy above the head the origin advertises', () => {
    const noDeclaredRev = stagingPlan(manifest({ rev: undefined }))
    expect(() => check({ rev: 9 }, 3, noDeclaredRev)).toThrow(/above the manifest's head 3/)
  })

  it('accepts a manifest that predates snapshot.rev, trusting the database', () => {
    // D-055's older generation declares no snapshot rev; meta.rev is the
    // watermark either way, so this must not become a refusal.
    expect(() => check({ rev: 2 }, 3, stagingPlan(manifest({ rev: undefined })))).not.toThrow()
  })

  it.each([
    ['no notice at all', undefined],
    ['a null notice', null],
    ['an empty notice', ''],
    ['a whitespace notice', '   \n '],
    ['a non-string notice', 42],
  ])('refuses %s (D-008)', (_label, notice) => {
    // A copy of CVE data with no notice attached is one we are not licensed to
    // have made, so this refusal is a condition of the grant rather than a
    // quality check.
    expect(() => check({ notice })).toThrow(/no MITRE notice/)
  })

  it.each([
    ['zero records', 0],
    ['a missing count', undefined],
    ['a null count', null],
  ])('refuses %s', (_label, records) => {
    expect(() => check({ records })).toThrow(/holds no records/)
  })

  it.each([
    ['a counter the pipeline should never have set', 1],
    ['a missing pragma result', undefined],
    ['a null', null],
  ])('refuses a staged copy carrying %s', (_label, promoted) => {
    // Which slot is live is decided by this counter being non-zero. That is
    // only sound while published artifacts arrive at zero, and nothing upstream
    // enforces it — the day one starts setting it, a half-written staging file
    // would begin winning discovery.
    expect(() => check({ promoted })).toThrow(/must arrive at 0/)
  })
})

/**
 * The half of the gate discovery re-applies. It is the same code, so these are
 * about the *split* being real: a promotion counter alone must not make a file
 * live, and this is what stands between "something wrote a counter" and
 * "retire the other slot".
 */
describe('assertLocallyUsable', () => {
  const usable = {
    schema: 1,
    rev: 2,
    notice: 'CVE record content: Copyright © 1999-2026, The MITRE Corporation.',
    records: 372_322,
    promoted: 4,
  }

  it('accepts a promoted corpus', () => {
    expect(() => assertLocallyUsable(usable, 1)).not.toThrow()
  })

  it('does not care about the promotion counter', () => {
    // Discovery has already used it; the question here is what is behind it.
    expect(() => assertLocallyUsable({ ...usable, promoted: 99 }, 1)).not.toThrow()
    expect(() => assertLocallyUsable({ ...usable, promoted: 0 }, 1)).not.toThrow()
  })

  it.each([
    ['a database that is not our corpus at all', { schema: undefined, rev: undefined }],
    ['another schema version', { schema: 2 }],
    ['no watermark', { rev: null }],
    ['no notice', { notice: '' }],
    ['no records', { records: 0 }],
  ])('refuses %s', (_label, patch) => {
    expect(() => assertLocallyUsable({ ...usable, ...patch }, 1)).toThrow()
  })
})

/**
 * Discovery's classifier. The distinction it exists to preserve is between a
 * file we *read* and rejected, which is reclaimable, and one we could not read
 * at all, which is not — because the caller turns the second answer into
 * deletions over what may be the user's only copy.
 */
describe('classifyCandidate', () => {
  const meta: StagedMeta = {
    schema: 1,
    rev: 2,
    notice: 'CVE record content: Copyright © 1999-2026, The MITRE Corporation.',
    records: 1,
    promoted: 4,
  }
  const reader = (over: Partial<CandidateReader> = {}): CandidateReader => ({
    counter: () => 4,
    tablesPresent: () => REQUIRED_TABLES.length,
    meta: () => meta,
    ...over,
  })

  it('accepts a promoted, fully indexed corpus', () => {
    expect(classifyCandidate(reader(), 1)).toEqual({ kind: 'database', generation: 4 })
  })

  it.each([
    [
      'the counter read',
      {
        counter: () => {
          throw new Error('SQLITE_IOERR')
        },
      },
    ],
    [
      'the table listing',
      {
        tablesPresent: () => {
          throw new Error('SQLITE_BUSY')
        },
      },
    ],
    [
      'a meta read',
      {
        meta: () => {
          throw new Error('SQLITE_IOERR')
        },
      },
    ],
  ])('reports %s failing as unreadable, never as reclaimable', (_label, over) => {
    // The bug this pins: one catch around reads *and* validation turns a
    // transient disk error into "this file is disposable", which then
    // authorises a sweep.
    expect(classifyCandidate(reader(over as Partial<CandidateReader>), 1)).toEqual({
      kind: 'unreadable',
    })
  })

  it('reports an unreadable counter as unreadable', () => {
    expect(classifyCandidate(reader({ counter: () => null }), 1)).toEqual({ kind: 'unreadable' })
  })

  it('reports a corpus with no client-built indexes as unusable', () => {
    // Publisher drift: a published artifact that arrives carrying a counter.
    // It is a perfectly good corpus and still not a completed promotion, so it
    // must lose discovery rather than retire the real copy.
    expect(classifyCandidate(reader({ tablesPresent: () => 2 }), 1)).toEqual({ kind: 'unusable' })
  })

  it('never reads meta when the tables are not all there', () => {
    // Reading `meta` from a database that has no `meta` throws, and that
    // exception is indistinguishable from a disk error — so presence is
    // established first, through a table that always exists.
    let read = false
    const candidate = classifyCandidate(
      reader({
        tablesPresent: () => 0,
        meta: () => {
          read = true
          return meta
        },
      }),
      1
    )
    expect(candidate).toEqual({ kind: 'unusable' })
    expect(read).toBe(false)
  })

  it('reports a database this build would not serve as unusable', () => {
    expect(classifyCandidate(reader({ meta: () => ({ ...meta, schema: 2 }) }), 1)).toEqual({
      kind: 'unusable',
    })
  })

  it('carries the counter through, so the newer promotion can win', () => {
    expect(classifyCandidate(reader({ counter: () => 9 }), 1)).toEqual({
      kind: 'database',
      generation: 9,
    })
  })
})

describe('isOurEntry', () => {
  it.each([LEGACY_DB_FILE, ...SLOT_FILES, STAGING_RECORD_FILE])('claims %s', (name) => {
    expect(isOurEntry(name)).toBe(true)
  })

  it('claims the rollback journals SQLite writes beside them', () => {
    // Clearing the database and leaving its journal behind is how a "cleared"
    // origin still reports storage in use.
    expect(isOurEntry('cve-a.sqlite-journal')).toBe(true)
    expect(isOurEntry('cve.sqlite-journal')).toBe(true)
  })

  it('claims the other sidecars SQLite can write', () => {
    expect(isOurEntry('cve-a.sqlite-wal')).toBe(true)
    expect(isOurEntry('cve-a.sqlite-shm')).toBe(true)
    expect(isOurEntry('cve-b.sqlite-mj0a1b2c3d')).toBe(true)
  })

  it('does not claim anything else in the origin', () => {
    expect(isOurEntry('.opfs-sahpool')).toBe(false)
    expect(isOurEntry('weights.bin')).toBe(false)
    expect(isOurEntry('cve-c.sqlite')).toBe(false)
  })

  it('does not claim an unrelated file that merely sorts under one of our names', () => {
    // Both callers of this delete, and one runs on the read path — so the rule
    // is an allowlist of SQLite's sidecars rather than "anything with the right
    // prefix". M8 puts model weights in this same origin (plan.md).
    expect(isOurEntry('cve-a.sqlite-model-weights.bin')).toBe(false)
    expect(isOurEntry('cve.sqlite-backup')).toBe(false)
    expect(isOurEntry('cve.sqlite-')).toBe(false)
  })
})
