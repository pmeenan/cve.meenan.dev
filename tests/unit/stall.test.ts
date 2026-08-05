import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_STALL_MS,
  MAX_STALL_MS,
  MIN_STALL_MS,
  stallError,
  stallTimeout,
  watchForStalls,
} from '../../lib/stall'

/**
 * Stall detection (D-052), tested away from the browser.
 *
 * The property is the distinction, not the timer: a transfer that keeps
 * receiving bytes must never be reported, however long it takes, and one that
 * stops must be reported once. Both halves are asserted, because a watch that
 * fires on slowness is worse than none — it turns a working download on a bad
 * link into an error the user cannot get past.
 *
 * The clock is injected rather than faked so the *policy* is what is under
 * test: how much time has passed since the last beat, not how the platform
 * schedules a callback. Timers are faked only to make the ticks happen.
 */
afterEach(() => {
  vi.useRealTimers()
})

/** A watch driven by an explicit clock, with the ticks under test control. */
function harness(timeoutMs: number) {
  vi.useFakeTimers()
  let clock = 1_000
  const stalls: number[] = []
  const watch = watchForStalls({
    timeoutMs,
    onStall: (idleMs) => stalls.push(idleMs),
    now: () => clock,
  })
  return {
    watch,
    stalls,
    /** Advance the injected clock *and* the timers, so ticks actually run. */
    advance(ms: number) {
      clock += ms
      vi.advanceTimersByTime(ms)
    },
  }
}

describe('watchForStalls', () => {
  it('never fires while beats keep arriving, however long the transfer runs', () => {
    const { watch, stalls, advance } = harness(60_000)
    // Ten minutes of a transfer that is slow but alive: a byte every 30 s.
    for (let minute = 0; minute < 20; minute++) {
      advance(30_000)
      watch.beat()
    }
    expect(stalls).toEqual([])
    watch.stop()
  })

  it('fires once when nothing arrives for the timeout', () => {
    const { watch, stalls, advance } = harness(60_000)
    advance(30_000)
    watch.beat()
    expect(stalls).toEqual([])

    advance(61_000)
    expect(stalls).toHaveLength(1)
    expect(stalls[0]).toBeGreaterThanOrEqual(60_000)

    // And not again: the caller's response is to abort the transfer, and a
    // second report would race the error already on its way out.
    advance(600_000)
    expect(stalls).toHaveLength(1)
    watch.stop()
  })

  it('measures the gap when a tick runs, not the number of ticks missed', () => {
    // A throttled Worker timer in a background tab fires late; a suspended
    // laptop fires very late. Both must cost detection latency rather than
    // produce a stall that never happened — so the tick asks the clock.
    const { watch, stalls, advance } = harness(60_000)
    // One tick, arriving 10 minutes late, with a beat 1 ms of clock earlier.
    watch.beat()
    advance(600_000)
    expect(stalls).toHaveLength(1)
    expect(stalls[0]).toBeGreaterThanOrEqual(600_000)
  })

  it('stops reporting once stopped', () => {
    const { watch, stalls, advance } = harness(1_000)
    watch.stop()
    advance(60_000)
    expect(stalls).toEqual([])
    // Idempotent, because the import path stops it in two places on purpose.
    expect(() => {
      watch.stop()
      watch.beat()
    }).not.toThrow()
  })
})

describe('stallTimeout', () => {
  it('defaults anything unusable', () => {
    expect(stallTimeout(undefined)).toBe(DEFAULT_STALL_MS)
    expect(stallTimeout(Number.NaN)).toBe(DEFAULT_STALL_MS)
    expect(stallTimeout(0)).toBe(DEFAULT_STALL_MS)
    expect(stallTimeout(-5)).toBe(DEFAULT_STALL_MS)
  })

  it('clamps a caller-supplied value into a range that can still succeed', () => {
    // A crafted `?stall=1` must not make every download fail instantly, and
    // `?stall=99999999` must not disable detection.
    expect(stallTimeout(1)).toBe(MIN_STALL_MS)
    expect(stallTimeout(2_000)).toBe(2_000)
    expect(stallTimeout(99_999_999)).toBe(MAX_STALL_MS)
  })
})

describe('stallError', () => {
  it('says it is a stall rather than slowness, and what survives', () => {
    const error = stallError('The download', 61_432, 'Your local copy is untouched.')
    expect(error.message).toContain('stalled')
    expect(error.message).toContain('61 s')
    expect(error.message).toContain('rather than a slow one')
    expect(error.message).toContain('Your local copy is untouched.')
  })
})
