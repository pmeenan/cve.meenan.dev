/**
 * Storage quota, persistence and eviction (M5).
 *
 * The corpus is 441 MB in OPFS and a *replacement* holds two generations at
 * once (D-061), so this app is one of the few web pages that can genuinely run
 * a browser out of storage. Three separate things follow, and they are separate
 * on purpose:
 *
 *   - **Persistence is asked for and its answer is reported, never assumed.**
 *     `navigator.storage.persist()` may grant, refuse, or not exist. Without a
 *     grant the copy is evictable under storage pressure — the browser may
 *     simply delete it — and a user who paid for a 63 MB download deserves to
 *     know which of those they got. D-013 makes the copy a rebuildable cache, so
 *     eviction is survivable; it is not something to be silent about.
 *   - **A doomed download is refused before it starts.** The manifest says how
 *     many bytes the artifact expands to, and `navigator.storage.estimate()`
 *     says what is left. Dying at 90% costs the user the whole transfer and
 *     tells them nothing; refusing up front costs nothing and names the number.
 *   - **An eviction discovered at reopen is an empty origin, not an error.**
 *     That path needs no code here — it is what discovery already reports — but
 *     it is why the preflight is a *check* rather than a reservation.
 */

/** What the browser will say about storage, or nulls where it will not say. */
export interface StorageReport {
  /** Bytes this origin is using, as the browser estimates it. */
  usage: number | null
  /** Bytes this origin may use. */
  quota: number | null
  /** True when the origin's data is exempt from eviction under pressure. */
  persisted: boolean | null
  /** False when `navigator.storage` is missing entirely (no estimate, no grant). */
  available: boolean
}

/**
 * What one generation costs *on disk*, as a multiple of the published
 * artifact's expanded length.
 *
 * The artifact is not what ends up in OPFS. The client builds three fts5
 * indexes into the same file after the chunks land (D-035), which is why a
 * 376.7 MB artifact becomes a **441.1 MB** database — the number D-049
 * measured and architecture.md says this work plans against. Budgeting the
 * artifact alone passes a browser with 445 MB free and then dies partway
 * through a 58-second index build, after the whole transfer: the exact failure
 * this module exists to prevent, just moved later.
 */
export const IMPORT_FOOTPRINT = 441.1 / 376.7

/**
 * Headroom on top of that, for the rollback journal SQLite writes across the
 * index transaction and for the estimate being documented as approximate.
 *
 * 10% with a 64 MiB floor is deliberately loose: this check exists to catch
 * "you have 200 MB free and need 500", not to arbitrate the last megabyte.
 */
export const STORAGE_HEADROOM = 0.1
export const STORAGE_HEADROOM_FLOOR = 64 * 1024 * 1024

export interface SpacePlan {
  /** Bytes the download needs at its peak, headroom included. */
  needed: number
  /** Bytes the browser says are left, or null when it will not say. */
  free: number | null
  /** False only when the browser gave a number and that number is too small. */
  fits: boolean
}

/**
 * What a download needs *in addition to what is already stored*, and whether
 * that fits. `reusableBytes` is storage already occupied by the staging slot
 * this run will continue writing into.
 *
 * **One generation, whether or not a copy is already here.** Staged replacement
 * does hold two at once (D-061), but the existing one is already inside the
 * `usage` that `free` is computed by subtracting — counting it again refused
 * downloads that would have succeeded comfortably. A user with the corpus
 * imported and 572 MiB free was told they needed 790 MiB, and pointed at
 * "Clear local copy", which would have destroyed a working 441 MB copy to
 * satisfy a constraint that was never binding. Found by M5's data-plane review,
 * along with the mirror-image error in the other direction: budgeting the
 * artifact rather than the imported footprint, which passed a browser that then
 * ran out during the index build. No single headroom constant covers both, so
 * both are named above.
 *
 * A retry is the other place double-counting matters. The staging file is
 * preallocated to the artifact's expanded length before its first chunk lands,
 * and that allocation is already inside `usage`. Requiring a whole new
 * generation on retry can strand a perfectly resumable download on an origin
 * that has enough room for only the remaining index growth and headroom.
 * Reusable bytes are therefore subtracted from the imported footprint, capped
 * at that footprint so corrupt metadata can never create space on paper.
 *
 * `fits` is true when the browser declines to estimate. An unknown quota is not
 * evidence of a small one, and refusing on "I don't know" would block every
 * browser that reports nothing — the opposite of the honest degradation this is
 * for. The download then fails the way it always could, with the live copy
 * intact.
 */
export function planSpace(
  artifactBytes: number,
  report: StorageReport,
  reusableBytes = 0
): SpacePlan {
  const generation = Math.max(0, artifactBytes) * IMPORT_FOOTPRINT
  const reusable = Math.min(generation, Math.max(0, reusableBytes))
  const needed =
    generation - reusable + Math.max(generation * STORAGE_HEADROOM, STORAGE_HEADROOM_FLOOR)
  const free =
    report.usage !== null && report.quota !== null ? Math.max(0, report.quota - report.usage) : null
  return { needed, free, fits: free === null || free >= needed }
}

/**
 * Cap an estimate's free bytes for the `?free=` failure affordance.
 *
 * This must never increase what the browser reported. The knob is reachable in
 * a URL, and its safety argument is that it can only force a refusal; replacing
 * a real 100 MiB estimate with a caller-supplied 1 TiB estimate would instead
 * bypass the production preflight. When the browser gives no estimate, the cap
 * supplies one so the failure path remains testable.
 */
export function limitFreeSpace(report: StorageReport, maximum: number): StorageReport {
  const limit = Math.max(0, maximum)
  if (report.usage === null || report.quota === null) {
    return { ...report, usage: 0, quota: limit }
  }
  const free = Math.max(0, report.quota - report.usage)
  return { ...report, quota: report.usage + Math.min(free, limit) }
}

/** The refusal, naming both numbers — a bare "not enough space" is unactionable. */
export function spaceMessage(plan: SpacePlan): string {
  return (
    `Not enough storage: this download needs about ${bytes(plan.needed)} of free space and ` +
    `this browser is offering ${bytes(plan.free ?? 0)}. Nothing has been fetched and your ` +
    'existing copy, if any, is untouched. Freeing space elsewhere is the repair; "Clear local ' +
    'copy" also works, but it trades the copy you have for the room to fetch a new one, so it ' +
    'is the last resort rather than the first.'
  )
}

/**
 * Bytes for a person. Binary units, because that is what browsers report and
 * what the OS storage panel a user will go and look at says.
 */
export function bytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'an unknown amount'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let at = 0
  let scaled = Math.max(0, value)
  while (scaled >= 1024 && at < units.length - 1) {
    scaled /= 1024
    at += 1
  }
  return `${scaled.toFixed(at === 0 ? 0 : 1)} ${units[at]}`
}

/**
 * Ask the browser what it knows, tolerating every way it can decline.
 *
 * Never throws: this feeds a diagnostics panel and a preflight, and a storage
 * API that rejects must not be able to take the app down with it.
 */
export async function readStorage(storage: StorageManager | undefined): Promise<StorageReport> {
  if (!storage) return { usage: null, quota: null, persisted: null, available: false }
  let usage: number | null = null
  let quota: number | null = null
  let persisted: boolean | null = null
  try {
    const estimate = await storage.estimate()
    usage = typeof estimate.usage === 'number' ? estimate.usage : null
    quota = typeof estimate.quota === 'number' ? estimate.quota : null
  } catch {
    /* left null */
  }
  try {
    persisted = typeof storage.persisted === 'function' ? await storage.persisted() : null
  } catch {
    persisted = null
  }
  return { usage, quota, persisted, available: true }
}

/**
 * Ask for persistence, and report what was actually granted.
 *
 * Called from a user gesture (the Download button), because Firefox prompts and
 * a prompt outside a gesture is a prompt that is dismissed. The return value is
 * the *browser's* answer, not the request's success: Chrome grants silently on
 * a site with engagement and refuses silently otherwise, and both look the same
 * from the call site unless the result is read.
 */
export async function requestPersistence(
  storage: StorageManager | undefined
): Promise<boolean | null> {
  if (!storage || typeof storage.persist !== 'function') return null
  try {
    if (typeof storage.persisted === 'function' && (await storage.persisted())) return true
    return await storage.persist()
  } catch {
    return null
  }
}

/** How the persistence answer reads on screen. Three states, three sentences. */
export function persistenceMessage(persisted: boolean | null): string {
  if (persisted === true) {
    return 'Storage is persistent: this browser will not evict your local copy to reclaim space.'
  }
  if (persisted === false) {
    return (
      'Storage is not persistent: this browser may evict the local copy if it needs space. ' +
      'The copy is a cache and can always be downloaded again — but a re-download is 63 MB.'
    )
  }
  return 'This browser does not say whether the local copy is exempt from eviction.'
}
