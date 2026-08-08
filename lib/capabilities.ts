/**
 * The browser-support gate (D-016, M5).
 *
 * Everything below the D-016 floor has to be told *before* a download, in a
 * message that stands on its own. There is no telemetry (D-009), so a gate that
 * fires is a gate nobody will ever hear about: whatever it says on screen is the
 * whole support channel, and "something went wrong" would end the story there.
 *
 * **The naive interface check is the trap this exists to avoid.** Safari
 * 15.2–16.3 ships `FileSystemFileHandle.createSyncAccessHandle`, so every
 * `'createSyncAccessHandle' in …` probe passes — and then the handle's `read`,
 * `write`, `getSize`, `truncate` and `flush` return **Promises** rather than
 * values, because those methods were only made synchronous in Safari 16.4
 * (which is exactly why D-016's floor is 16.4 and not 16). SQLite/WASM's `opfs`
 * VFS calls them synchronously, so the failure lands deep inside the import as
 * an unintelligible WASM error, tens of seconds and hundreds of megabytes in.
 * The only probe that separates the two is *calling* one and looking at what
 * comes back, which is what `probeSyncAccess` does — on a scratch file, in the
 * Worker, before anything is fetched.
 *
 * The checks are split into two kinds and the split is load-bearing:
 *
 *   - **`required`** — the import path cannot run at all. The gate blocks.
 *   - **`degraded`** — something specific stops working and the app says so
 *     rather than pretending. Query cancellation is the only one today
 *     (`lib/cancel.ts` needs shared memory), and it already has its own message.
 */

/** One thing the app needs, and whether this browser has it. */
export interface Capability {
  /** Stable key, so a diagnostics report and a test can name one. */
  id: string
  /** What it is called in a sentence a user reads. */
  label: string
  ok: boolean
  /** Why it matters, shown when it is missing. */
  why: string
  /** A missing `required` capability blocks the import; `degraded` narrows it. */
  level: 'required' | 'degraded'
}

export interface CapabilityReport {
  capabilities: Capability[]
  /** Everything `required` is present, so the import path can run. */
  supported: boolean
  /** Present but narrowed — reported, never silently absent. */
  degraded: string[]
}

/**
 * The floor, as prose (D-016).
 *
 * Named versions rather than "a modern browser", because a user who is below
 * the floor needs to know what to do, and every one of these is the version
 * that shipped the synchronous access handle or the isolation it needs.
 */
export const SUPPORT_FLOOR = 'Chrome or Edge 108+, Firefox 111+, or Safari 16.4+'

/**
 * The synchronous-method probe, as a value rather than a boolean.
 *
 * `unknown` is its own answer: the probe could not be run (no OPFS at all, or
 * the scratch file could not be created), which is different from "it ran and
 * the methods were async". Conflating them would make an unrelated storage
 * failure read as an unsupported browser.
 */
export type SyncAccessProbe = 'sync' | 'async' | 'unavailable' | 'unknown'

/**
 * The scratch entries the probe writes, by prefix.
 *
 * **The name must be unique per Worker**, and that is not tidiness. A sync
 * access handle is an exclusive lock whose release outlives the synchronous
 * `close()` (RE-007), so two tabs probing *the same* file name is two tabs
 * where one hangs — with no error, no timeout, and a page that sits at
 * "pending" forever. Reproduced: opening a second tab while the first was still
 * starting up wedged it for the full 300-second test timeout.
 *
 * `isOurEntry` in `lib/staging.ts` matches this prefix, so a scratch file left
 * behind by a tab that was closed mid-probe is reclaimed by the ordinary sweep
 * rather than accumulating forever.
 */
export const PROBE_PREFIX = 'capability-probe-'

/** One probe file name, unique to this call. */
function probeName(): string {
  const random = new Uint8Array(8)
  crypto.getRandomValues(random)
  return (
    PROBE_PREFIX +
    Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('') +
    '.tmp'
  )
}

/**
 * Call one synchronous method and see whether it answered or promised.
 *
 * Must run where sync access handles are available, which is a dedicated Worker
 * (the File System standard restricts `createSyncAccessHandle` to workers).
 * Non-destructive: its own scratch entry, removed on the way out even when the
 * probe throws — a leftover file would be a permanent 0-byte oddity in the
 * user's storage that nothing else ever cleans up.
 */
export async function probeSyncAccess(
  root: FileSystemDirectoryHandle | null
): Promise<SyncAccessProbe> {
  if (!root) return 'unknown'
  const name = probeName()
  let handle: FileSystemFileHandle
  try {
    handle = await root.getFileHandle(name, { create: true })
  } catch {
    return 'unknown'
  }
  try {
    if (
      typeof (handle as { createSyncAccessHandle?: unknown }).createSyncAccessHandle !== 'function'
    )
      return 'unavailable'
    const access = await handle.createSyncAccessHandle()
    try {
      // `getSize` because it takes no arguments and changes nothing. On a
      // browser at the floor it returns a number; below it, a Promise.
      const size: unknown = access.getSize()
      return isThenable(size) ? 'async' : 'sync'
    } finally {
      // Awaited for RE-007's reason: the exclusive lock outlives the
      // synchronous return, and the next open of the same file hangs.
      await access.close()
    }
  } catch {
    return 'unavailable'
  } finally {
    await root.removeEntry(name).catch(() => undefined)
  }
}

function isThenable(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/** What `assess` needs to know about the environment, so it can be tested. */
export interface Environment {
  crossOriginIsolated: boolean
  hasWasm: boolean
  hasSharedArrayBuffer: boolean
  hasOpfs: boolean
  hasStreams: boolean
  syncAccess: SyncAccessProbe
}

/**
 * Judge one environment.
 *
 * Pure, and separate from the probing, because the interesting cases are the
 * ones no CI browser can produce: Safari 16.3's async handles, a page served
 * without COOP/COEP. Both are values here, and `tests/unit/capabilities.test.ts`
 * asserts what the gate says about them.
 */
export function assess(env: Environment): CapabilityReport {
  const capabilities: Capability[] = [
    {
      id: 'wasm',
      label: 'WebAssembly',
      ok: env.hasWasm,
      why: 'SQLite and the brotli decompressor are both WebAssembly; without it there is nothing to run the corpus in.',
      level: 'required',
    },
    {
      id: 'opfs',
      label: 'Origin Private File System',
      ok: env.hasOpfs,
      why: 'The corpus is a 441 MB SQLite database stored in the browser’s private file system. Without it there is nowhere to put it.',
      level: 'required',
    },
    {
      id: 'sync-access',
      label: 'Synchronous file access handles',
      ok: env.syncAccess === 'sync',
      why:
        env.syncAccess === 'async'
          ? 'This browser has file access handles, but its read and write methods are asynchronous. SQLite needs the synchronous form, which Safari added in 16.4.'
          : 'SQLite reads and writes the local database through synchronous file access handles.',
      level: 'required',
    },
    {
      id: 'isolation',
      label: 'Cross-origin isolation',
      ok: env.crossOriginIsolated,
      why: 'The storage layer needs shared memory, which browsers only grant to cross-origin-isolated pages. If you see this on cve.meenan.dev, the COOP/COEP headers did not arrive — a proxy or an extension may have stripped them.',
      level: 'required',
    },
    {
      id: 'shared-memory',
      label: 'SharedArrayBuffer',
      ok: env.hasSharedArrayBuffer,
      why: 'The database worker and the page coordinate through shared memory.',
      level: 'required',
    },
    {
      id: 'streams',
      label: 'Streaming responses',
      ok: env.hasStreams,
      why: 'Chunks are read as streams so a transfer that dies mid-chunk is reported as stalled rather than looking alive (D-064).',
      level: 'degraded',
    },
  ]
  return {
    capabilities,
    supported: capabilities.every((entry) => entry.level !== 'required' || entry.ok),
    degraded: capabilities
      .filter((entry) => entry.level === 'degraded' && !entry.ok)
      .map((entry) => entry.label),
  }
}

/**
 * The sentence shown to a browser that cannot run the app.
 *
 * It names the specific thing that is missing *and* the floor, because those
 * answer different questions — "why does this not work" and "what do I do". A
 * gate that said only the second would be a wall for someone whose browser is
 * fine and whose proxy stripped a header, which is a real and fixable case.
 */
export function gateMessage(report: CapabilityReport): string {
  const missing = report.capabilities.filter((entry) => entry.level === 'required' && !entry.ok)
  if (!missing.length) return ''
  const first = missing[0]!
  return (
    `This browser cannot run cve.meenan.dev: ${first.why} ` +
    `The app needs ${SUPPORT_FLOOR}. ` +
    'Nothing has been downloaded, and nothing on this machine has been changed.'
  )
}
