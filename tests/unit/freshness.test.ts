import { describe, expect, it } from 'vitest'

import { describeFreshness, STALE_AFTER_MS } from '../../lib/freshness'

/**
 * The staleness indicator's arithmetic (M2 freshness).
 *
 * What it must not do is claim precision it does not have or a verdict it
 * cannot support: the age comes from `meta.generated`, which is when the
 * pipeline built the revision — not when the user last synced, and not a
 * comparison against the origin's head, which would need a network request the
 * reopen path deliberately does not make (D-048).
 */
const HOUR = 3_600_000
const DAY = 24 * HOUR

/** `meta.generated` is unix *seconds*; the clock is milliseconds. */
const at = (nowMs: number, ageMs: number) => describeFreshness((nowMs - ageMs) / 1000, nowMs)

describe('describeFreshness', () => {
  const now = Date.UTC(2026, 7, 4, 12, 0, 0)

  it('describes an age in the units that carry the meaning', () => {
    expect(at(now, 5 * 60_000)?.age).toBe('less than an hour old')
    expect(at(now, HOUR)?.age).toBe('1 hour old')
    expect(at(now, 5 * HOUR)?.age).toBe('5 hours old')
    expect(at(now, DAY)?.age).toBe('1 day old')
    // Floored, not rounded: a copy that is 47 hours old is not two days old
    // yet, and "1 day" is the claim the data supports.
    expect(at(now, 47 * HOUR)?.age).toBe('1 day old')
    expect(at(now, 40 * DAY)?.age).toBe('40 days old')
  })

  it('flags a copy the daily pipeline has published past', () => {
    expect(at(now, 12 * HOUR)?.stale).toBe(false)
    expect(at(now, STALE_AFTER_MS)?.stale).toBe(false)
    expect(at(now, STALE_AFTER_MS + 1)?.stale).toBe(true)
    expect(at(now, 30 * DAY)?.stale).toBe(true)
  })

  it('carries a machine-readable stamp of the build time', () => {
    const fresh = at(now, 3 * HOUR)
    expect(fresh?.iso).toBe(new Date(now - 3 * HOUR).toISOString())
  })

  it('reports data from the future as new rather than as a negative age', () => {
    // A client clock behind the server's is ordinary and is not a problem to
    // warn about — the data is newer than this machine thinks now is.
    const ahead = describeFreshness((now + DAY) / 1000, now)
    expect(ahead?.ageMs).toBe(0)
    expect(ahead?.age).toBe('less than an hour old')
    expect(ahead?.stale).toBe(false)
  })

  it('describes nothing when there is no usable timestamp', () => {
    // Rendering "56 years old" for a missing stamp would be the indicator
    // inventing the very alarm it exists to make trustworthy.
    expect(describeFreshness(null, now)).toBeNull()
    expect(describeFreshness(undefined, now)).toBeNull()
    expect(describeFreshness(0, now)).toBeNull()
    expect(describeFreshness(-1, now)).toBeNull()
    expect(describeFreshness('1785586104', now)).toBeNull()
    expect(describeFreshness(Number.NaN, now)).toBeNull()
  })
})
