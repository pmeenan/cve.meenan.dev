import { describe, expect, it } from 'vitest'

import {
  assess,
  gateMessage,
  probeSyncAccess,
  PROBE_PREFIX,
  SUPPORT_FLOOR,
  type Environment,
} from '../../lib/capabilities'
import { isOurEntry } from '../../lib/staging'

/**
 * The support gate (D-016, M5).
 *
 * The interesting environments are exactly the ones no CI browser can produce:
 * Safari 16.3, whose `FileSystemSyncAccessHandle` methods return Promises where
 * SQLite calls them synchronously, and a page served without COOP/COEP. Both
 * are plain values here, which is the reason the judging is separated from the
 * probing at all — a gate that could only be tested by owning the browser it
 * exists for would never be tested.
 */

const SUPPORTED: Environment = {
  crossOriginIsolated: true,
  hasWasm: true,
  hasSharedArrayBuffer: true,
  hasOpfs: true,
  hasStreams: true,
  syncAccess: 'sync',
}

describe('assess', () => {
  it('passes a browser at the floor', () => {
    const report = assess(SUPPORTED)
    expect(report.supported).toBe(true)
    expect(report.degraded).toEqual([])
    expect(gateMessage(report)).toBe('')
  })

  it('fails Safari 16.3, whose handles are asynchronous', () => {
    // The failure this gate exists for. Every `'createSyncAccessHandle' in …`
    // check passes on that browser and the import then dies inside WASM, tens
    // of seconds and hundreds of megabytes in.
    const report = assess({ ...SUPPORTED, syncAccess: 'async' })
    expect(report.supported).toBe(false)
    expect(gateMessage(report)).toContain('asynchronous')
    expect(gateMessage(report)).toContain('16.4')
  })

  it('fails a page that is not cross-origin isolated, and says why that might be', () => {
    // Reachable with a perfectly good browser: a proxy or an extension that
    // strips COOP/COEP. Naming only the floor would send that user shopping for
    // a browser they already have.
    const report = assess({ ...SUPPORTED, crossOriginIsolated: false })
    expect(report.supported).toBe(false)
    expect(gateMessage(report)).toMatch(/proxy or an extension/)
  })

  it('fails a browser with no OPFS at all', () => {
    expect(assess({ ...SUPPORTED, hasOpfs: false, syncAccess: 'unavailable' }).supported).toBe(
      false
    )
  })

  it('names the floor and promises nothing was touched', () => {
    const message = gateMessage(assess({ ...SUPPORTED, hasWasm: false }))
    expect(message).toContain(SUPPORT_FLOOR)
    // The one reassurance a dead end owes: this is a gate, not a failed import.
    expect(message).toContain('nothing on this machine has been changed')
  })

  it('reports a narrowed capability without blocking', () => {
    const report = assess({ ...SUPPORTED, hasStreams: false })
    expect(report.supported).toBe(true)
    expect(report.degraded).toEqual(['Streaming responses'])
  })

  it('keeps "could not probe" out of the verdict’s reasoning', () => {
    // `unknown` is not `async`: an unrelated storage failure must not be
    // reported to the user as an unsupported browser. It still blocks — nothing
    // can run without a working handle — but the sentence is the generic one.
    const message = gateMessage(assess({ ...SUPPORTED, syncAccess: 'unknown' }))
    expect(message).not.toContain('asynchronous')
    expect(message).toContain('synchronous file access handles')
  })
})

describe('probeSyncAccess', () => {
  /** The handle shapes the probe has to tell apart, without a browser. */
  function root(get: () => unknown): FileSystemDirectoryHandle {
    const removed: string[] = []
    return {
      getFileHandle: async () => ({
        createSyncAccessHandle: async () => ({
          getSize: get,
          close: async () => undefined,
        }),
      }),
      removeEntry: async (name: string) => {
        removed.push(name)
      },
      // Exposed so the cleanup assertion can read it.
      removed,
    } as unknown as FileSystemDirectoryHandle
  }

  it('calls a method and reads what came back', async () => {
    expect(await probeSyncAccess(root(() => 0))).toBe('sync')
    expect(await probeSyncAccess(root(() => Promise.resolve(0)))).toBe('async')
  })

  it('is "unknown" with no OPFS rather than a verdict about the browser', async () => {
    expect(await probeSyncAccess(null)).toBe('unknown')
  })

  it('removes its scratch file, including when the probe throws', async () => {
    const handle = root(() => {
      throw new Error('nope')
    })
    expect(await probeSyncAccess(handle)).toBe('unavailable')
    // A leftover would be a permanent 0-byte oddity in the user's storage that
    // nothing else ever cleans up.
    const removed = (handle as unknown as { removed: string[] }).removed
    expect(removed).toHaveLength(1)
    expect(removed[0]).toMatch(new RegExp(`^${PROBE_PREFIX}[0-9a-f]{16}\\.tmp$`))
  })

  it('uses a different file every time, or two tabs deadlock', async () => {
    // Not tidiness. A sync access handle is an exclusive lock whose release
    // outlives `close()` (RE-007), so two tabs probing the same name is one tab
    // hanging with no error — reproduced as a page stuck at "pending" for the
    // full 300-second test timeout.
    const names = new Set<string>()
    for (let at = 0; at < 20; at += 1) {
      const handle = root(() => 0)
      await probeSyncAccess(handle)
      names.add((handle as unknown as { removed: string[] }).removed[0]!)
    }
    expect(names.size).toBe(20)
  })

  it('is swept if a tab dies mid-probe', () => {
    // The cost of unique names: a file nothing else knows about. `isOurEntry`
    // matches the prefix so the ordinary sweep reclaims it (D-061).
    expect(isOurEntry(`${PROBE_PREFIX}0123456789abcdef.tmp`)).toBe(true)
    expect(isOurEntry('cve-a.sqlite')).toBe(true)
    // And nothing else acquires a licence to be deleted by it.
    expect(isOurEntry('weights-gemma.bin')).toBe(false)
  })

  it('is "unavailable" when the handle has no synchronous accessor at all', async () => {
    const handle = {
      getFileHandle: async () => ({}),
      removeEntry: async () => undefined,
    } as unknown as FileSystemDirectoryHandle
    expect(await probeSyncAccess(handle)).toBe('unavailable')
  })
})
