import { test, type Page } from '@playwright/test'

/**
 * Shared guards for the browser matrix (M5, D-016).
 *
 * Three engines run this suite since M5, and one of them cannot run the app at
 * all — not because of anything the app does, but because **Playwright's Linux
 * WebKit build ships no OPFS**. Measured 2026-08-08 against that build:
 *
 * | | value |
 * | --- | --- |
 * | `crossOriginIsolated` | true |
 * | `SharedArrayBuffer` | present |
 * | `navigator.locks` | present |
 * | `navigator.serviceWorker` | present |
 * | **`navigator.storage.getDirectory`** | **undefined** |
 * | **`FileSystemFileHandle.prototype.createSyncAccessHandle`** | **absent** |
 *
 * That is a fact about the *test* browser rather than about Safari: D-016's
 * floor is Safari 16.4, which has both. So the suite cannot exercise the data
 * path there, and pretending otherwise would leave `pnpm e2e` permanently red
 * with twenty failures that say nothing — the state in which a real regression
 * is indistinguishable from a known limitation.
 *
 * What that engine *does* verify, and it is not nothing: the capability gate
 * fires on a real browser below the floor, naming the right missing capability.
 * `resilience.spec.ts` deliberately does not use this guard.
 *
 * The check is a **measurement, not a browser name**. If a later Playwright
 * WebKit ships OPFS, these specs start running there by themselves.
 */
export async function skipWithoutLocalStorage(page: Page): Promise<void> {
  const usable = await page.evaluate(
    () =>
      typeof navigator.storage?.getDirectory === 'function' &&
      typeof FileSystemFileHandle !== 'undefined' &&
      'createSyncAccessHandle' in FileSystemFileHandle.prototype
  )
  test.skip(
    !usable,
    'this browser has no OPFS, so it cannot hold the corpus — the capability ' +
      'gate covers it in resilience.spec.ts, which is the honest thing to assert here'
  )
}
