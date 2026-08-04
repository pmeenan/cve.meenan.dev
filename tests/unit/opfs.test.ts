import { describe, expect, it, vi } from 'vitest'

import {
  isNotFound,
  readTextEntry,
  removeIfPresent,
  writeFully,
  writeTextEntry,
} from '../../lib/opfs'

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

/**
 * The small-file helpers staged replacement writes its resume record through
 * (D-061). A fake OPFS root, because the behaviours worth pinning are all about
 * error handling and truncation rather than about the file system.
 */
function fakeRoot(
  files: Map<string, Uint8Array>,
  options: { calls?: string[]; writeLimit?: number; readError?: Error } = {}
) {
  const notFound = () => Object.assign(new Error('missing'), { name: 'NotFoundError' })
  const calls = options.calls ?? []
  const root = {
    files,
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      if (options.readError) throw options.readError
      if (!files.has(name)) {
        if (!opts?.create) throw notFound()
        files.set(name, new Uint8Array(0))
      }
      return {
        async getFile() {
          return { text: async () => new TextDecoder().decode(files.get(name)!) }
        },
        async createSyncAccessHandle() {
          let closed = false
          return {
            truncate(size: number) {
              calls.push(`truncate:${size}`)
              const current = files.get(name)!
              const next = new Uint8Array(size)
              next.set(current.subarray(0, Math.min(size, current.length)))
              files.set(name, next)
            },
            write(buffer: ArrayBufferView, opts?: { at?: number }) {
              const at = opts?.at ?? 0
              // Short writes are legal (RE-014); the real handle does this and
              // an always-complete fake cannot tell whether the caller loops.
              const take = Math.min(options.writeLimit ?? buffer.byteLength, buffer.byteLength)
              calls.push(`write:${at}:${take}`)
              const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, take)
              const current = files.get(name)!
              const next = new Uint8Array(Math.max(current.length, at + take))
              next.set(current)
              next.set(bytes, at)
              files.set(name, next)
              return take
            },
            flush() {
              calls.push('flush')
            },
            async close() {
              closed = true
              calls.push('close')
            },
            get isClosed() {
              return closed
            },
          }
        },
      }
    },
    async removeEntry(name: string) {
      if (!files.delete(name)) throw notFound()
    },
  }
  return root as unknown as FileSystemDirectoryHandle
}

describe('readTextEntry / writeTextEntry', () => {
  it('round-trips a record', async () => {
    const files = new Map<string, Uint8Array>()
    const root = fakeRoot(files)
    await writeTextEntry(root, 'staging.json', '{"v":1}')
    expect(await readTextEntry(root, 'staging.json')).toBe('{"v":1}')
  })

  it('truncates first, so a shorter record does not inherit the old tail', async () => {
    // Without the truncate, `{"done":[true,true]}` overwritten by `{"done":[]}`
    // leaves trailing bytes that parse as neither record — and the resume path
    // would then treat a perfectly good staged download as unreadable.
    const files = new Map<string, Uint8Array>()
    const root = fakeRoot(files)
    await writeTextEntry(root, 'staging.json', '{"long":"aaaaaaaaaaaaaaaaaaaa"}')
    await writeTextEntry(root, 'staging.json', '{"n":1}')
    expect(await readTextEntry(root, 'staging.json')).toBe('{"n":1}')
  })

  it('reports a missing entry as null rather than throwing', async () => {
    expect(await readTextEntry(fakeRoot(new Map()), 'staging.json')).toBeNull()
  })

  it('does NOT report a locked entry as missing', async () => {
    // "I could not read it" is not "it is not there". The caller treats the
    // second as "start a fresh download", which is merely wasteful — but the
    // same conflation on the discovery path is what deletes a live database.
    const locked = Object.assign(new Error('locked'), { name: 'NoModificationAllowedError' })
    await expect(
      readTextEntry(fakeRoot(new Map(), { readError: locked }), 'staging.json')
    ).rejects.toThrow(/locked/)
  })

  it('truncates, writes, flushes and only then closes', async () => {
    // The flush is the reason this helper exists: an unflushed resume record is
    // a resume record that lies after exactly the crash it was written for.
    // Without asserting the call itself, deleting `flush()` breaks no test.
    const calls: string[] = []
    await writeTextEntry(fakeRoot(new Map(), { calls }), 'staging.json', '{"n":1}')
    expect(calls).toEqual(['truncate:0', 'write:0:7', 'flush', 'close'])
  })

  it('loops until the whole record has landed when the handle writes short', async () => {
    const files = new Map<string, Uint8Array>()
    const calls: string[] = []
    await writeTextEntry(fakeRoot(files, { calls, writeLimit: 3 }), 'staging.json', '{"n":1}')
    expect(new TextDecoder().decode(files.get('staging.json')!)).toBe('{"n":1}')
    expect(calls.filter((call) => call.startsWith('write:'))).toEqual([
      'write:0:3',
      'write:3:3',
      'write:6:1',
    ])
  })
})

describe('removeIfPresent', () => {
  it('removes what is there', async () => {
    const files = new Map([['cve-a.sqlite', new Uint8Array(1)]])
    await removeIfPresent(fakeRoot(files), 'cve-a.sqlite')
    expect(files.size).toBe(0)
  })

  it('is a no-op when the entry is already gone', async () => {
    await expect(removeIfPresent(fakeRoot(new Map()), 'cve-a.sqlite')).resolves.toBeUndefined()
  })

  it('propagates a file another tab holds open', async () => {
    // Same rule as `isNotFound` above: reporting a removal that did not happen
    // is the failure this must not have.
    const locked = {
      async removeEntry() {
        throw Object.assign(new Error('locked'), { name: 'NoModificationAllowedError' })
      },
    } as unknown as FileSystemDirectoryHandle
    await expect(removeIfPresent(locked, 'cve-a.sqlite')).rejects.toThrow(/locked/)
  })
})
