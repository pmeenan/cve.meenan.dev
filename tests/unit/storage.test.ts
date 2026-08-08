import { describe, expect, it } from 'vitest'

import {
  bytes,
  limitFreeSpace,
  persistenceMessage,
  planSpace,
  readStorage,
  requestPersistence,
  spaceMessage,
  STORAGE_HEADROOM_FLOOR,
  type StorageReport,
} from '../../lib/storage'

/**
 * Quota, persistence and the preflight (M5).
 *
 * The arithmetic that matters is the *two generations*: a re-download stages
 * into the other slot and does not touch the live database until the staged one
 * has passed its gate (D-061), so both exist at once. A preflight that budgeted
 * for one would wave through exactly the download that runs out of room at 90%
 * — which is the failure it exists to prevent.
 */

const MB = 1024 * 1024
const ARTIFACT = 441 * MB

function report(free: number | null): StorageReport {
  if (free === null) return { usage: null, quota: null, persisted: null, available: true }
  return { usage: 0, quota: free, persisted: true, available: true }
}

describe('planSpace', () => {
  it('budgets the imported footprint, not the artifact', () => {
    // The artifact is not what ends up on disk: the client builds three fts5
    // indexes into the same file afterwards (D-035), which is why 376.7 MB of
    // artifact becomes 441.1 MB of database. Budgeting the artifact alone
    // passes a browser that then runs out *during the index build*, after the
    // whole transfer — the failure this check exists to move earlier.
    const plan = planSpace(ARTIFACT, report(null))
    expect(plan.needed).toBeGreaterThan(ARTIFACT * 1.17)
  })

  it('asks for one generation, not two, because the old one is already in `usage`', () => {
    // Staged replacement does hold two at once (D-061), but the existing copy
    // is inside the `usage` that `free` was computed by subtracting. Counting
    // it twice refused downloads that would have succeeded — and pointed the
    // user at "Clear local copy", which destroys a working corpus to satisfy a
    // constraint that was never binding.
    const withCopy = planSpace(ARTIFACT, {
      usage: 400 * MB,
      quota: 1000 * MB,
      persisted: true,
      available: true,
    })
    expect(withCopy.fits).toBe(true)
  })

  it('does not charge a resumed download for its preallocated staging file twice', () => {
    // The staged raw file is already included in usage. A retry only has to
    // fund the index growth and headroom; asking for the raw bytes again can
    // permanently refuse a download that has all of those bytes ready to use.
    const withoutReuse = planSpace(ARTIFACT, report(200 * MB))
    const resumed = planSpace(ARTIFACT, report(200 * MB), ARTIFACT)
    expect(withoutReuse.fits).toBe(false)
    expect(resumed.fits).toBe(true)
    expect(resumed.needed).toBeLessThan(withoutReuse.needed)
  })

  it('refuses a download that demonstrably cannot fit', () => {
    const plan = planSpace(ARTIFACT, report(200 * MB))
    expect(plan.fits).toBe(false)
    // Both numbers, because "not enough space" alone tells nobody how much to
    // free.
    expect(spaceMessage(plan)).toContain(bytes(plan.needed))
    expect(spaceMessage(plan)).toContain('200.0 MiB')
    expect(spaceMessage(plan)).toContain('untouched')
  })

  it('refuses when there is not room for the finished database', () => {
    // 400 MiB free against a 441 MB corpus: enough for the artifact, not for
    // the indexes built into it.
    expect(planSpace(ARTIFACT, report(400 * MB)).fits).toBe(false)
    expect(planSpace(ARTIFACT, report(700 * MB)).fits).toBe(true)
  })

  it('proceeds when the browser will not estimate', () => {
    // An unknown quota is not evidence of a small one. Refusing on "I don't
    // know" would block every browser that reports nothing, which is the
    // opposite of degrading honestly — the download then fails the way it
    // always could, with the live copy intact.
    const plan = planSpace(ARTIFACT, report(null))
    expect(plan.free).toBeNull()
    expect(plan.fits).toBe(true)
  })

  it('keeps a floor of headroom for small artifacts', () => {
    // 10% of a development slice is a few megabytes, and SQLite's journal is
    // not proportional to the corpus.
    const plan = planSpace(1 * MB, report(null))
    expect(plan.needed).toBeGreaterThanOrEqual(STORAGE_HEADROOM_FLOOR)
  })
})

describe('limitFreeSpace', () => {
  it('can reduce a known estimate but cannot increase it', () => {
    const original: StorageReport = {
      usage: 300 * MB,
      quota: 500 * MB,
      persisted: true,
      available: true,
    }
    expect(limitFreeSpace(original, 80 * MB).quota).toBe(380 * MB)
    expect(limitFreeSpace(original, 1_000 * MB).quota).toBe(500 * MB)
  })

  it('supplies a bounded estimate when the browser does not provide one', () => {
    expect(limitFreeSpace(report(null), 8 * MB)).toMatchObject({ usage: 0, quota: 8 * MB })
  })
})

describe('readStorage', () => {
  it('tolerates a storage manager that rejects', async () => {
    const result = await readStorage({
      estimate: async () => {
        throw new Error('no')
      },
      persisted: async () => {
        throw new Error('no')
      },
    } as unknown as StorageManager)
    // Available, but with nothing to say — distinct from no StorageManager at
    // all, which is what a browser below the floor looks like.
    expect(result).toEqual({ usage: null, quota: null, persisted: null, available: true })
  })

  it('reports absence rather than throwing', async () => {
    expect((await readStorage(undefined)).available).toBe(false)
  })

  it('passes through what the browser says', async () => {
    const result = await readStorage({
      estimate: async () => ({ usage: 100, quota: 900 }),
      persisted: async () => false,
    } as unknown as StorageManager)
    expect(result).toEqual({ usage: 100, quota: 900, persisted: false, available: true })
  })
})

describe('requestPersistence', () => {
  it('reports what was granted, not that the call succeeded', async () => {
    // Chrome refuses silently on a site with no engagement, and the refusal is
    // indistinguishable from a grant unless the return value is read.
    const refused = await requestPersistence({
      persisted: async () => false,
      persist: async () => false,
    } as unknown as StorageManager)
    expect(refused).toBe(false)
  })

  it('does not re-ask when it is already granted', async () => {
    let asked = 0
    const granted = await requestPersistence({
      persisted: async () => true,
      persist: async () => {
        asked += 1
        return true
      },
    } as unknown as StorageManager)
    expect(granted).toBe(true)
    expect(asked).toBe(0)
  })

  it('is null where the API is absent', async () => {
    expect(await requestPersistence(undefined)).toBeNull()
    expect(await requestPersistence({} as StorageManager)).toBeNull()
  })
})

describe('the sentences a person reads', () => {
  it('keeps the three persistence states distinct', () => {
    expect(persistenceMessage(true)).toContain('will not evict')
    expect(persistenceMessage(false)).toContain('may evict')
    // "This browser does not say" is not the same as "it may evict", and
    // guessing either way would be inventing a fact about the user's storage.
    expect(persistenceMessage(null)).toContain('does not say')
  })

  it('formats bytes in the units the OS storage panel uses', () => {
    expect(bytes(0)).toBe('0 B')
    expect(bytes(1024)).toBe('1.0 KiB')
    expect(bytes(441 * MB)).toBe('441.0 MiB')
    expect(bytes(null)).toBe('an unknown amount')
  })
})
