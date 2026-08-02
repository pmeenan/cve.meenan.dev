import { describe, expect, it, vi } from 'vitest'

import { isNotFound, writeFully } from '../../lib/opfs'

/**
 * Regression tests for two OPFS behaviours that fail silently when got wrong:
 * a short write leaves a plausible-looking but corrupt database, and a
 * swallowed delete error reports a clear that did not happen.
 */
describe('writeFully', () => {
  /** A handle that writes at most `limit` bytes per call, like the spec allows. */
  const handle = (limit: number, log: { at: number; len: number }[] = []) => ({
    log,
    write(buffer: ArrayBufferView, options?: { at?: number }) {
      const n = Math.min(limit, buffer.byteLength)
      log.push({ at: options?.at ?? 0, len: n })
      return n
    },
  })

  it('writes everything when the handle takes it all at once', () => {
    const h = handle(1024)
    writeFully(h, new Uint8Array(1000), 4096)
    expect(h.log).toEqual([{ at: 4096, len: 1000 }])
  })

  it('keeps going until the whole buffer has landed', () => {
    // The failure this guards: one call, 300 of 1000 bytes written, 700 bytes
    // of the database quietly never stored.
    const h = handle(300)
    writeFully(h, new Uint8Array(1000), 0)
    expect(h.log.reduce((sum, w) => sum + w.len, 0)).toBe(1000)
  })

  it('advances the offset by what was actually written, not by the buffer size', () => {
    const h = handle(300)
    writeFully(h, new Uint8Array(1000), 4096)
    expect(h.log.map((w) => w.at)).toEqual([4096, 4396, 4696, 4996])
  })

  it('throws rather than spinning when the handle stops making progress', () => {
    // Retrying forever would present as a hung import, which D-052 requires to
    // be distinguishable from a slow one.
    const stalled = { write: vi.fn(() => 0) }
    expect(() => writeFully(stalled, new Uint8Array(10), 0)).toThrow(/stalled/)
    expect(stalled.write).toHaveBeenCalledTimes(1)
  })
})

describe('isNotFound', () => {
  it('treats a missing entry as success', () => {
    expect(isNotFound(Object.assign(new Error('gone'), { name: 'NotFoundError' }))).toBe(true)
  })

  it('does NOT swallow a file another tab holds open', () => {
    // The bug this exists to prevent: "Clear local copy" reporting success
    // while 441 MB of corpus survives, which the next reload then prefers.
    const locked = Object.assign(new Error('locked'), { name: 'NoModificationAllowedError' })
    expect(isNotFound(locked)).toBe(false)
  })

  it.each([null, undefined, 'NotFoundError', 42])('is not fooled by %p', (value) => {
    expect(isNotFound(value)).toBe(false)
  })
})
