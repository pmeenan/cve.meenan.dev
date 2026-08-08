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
 *
 * The first version of this guard also tested
 * `'createSyncAccessHandle' in FileSystemFileHandle.prototype` **from
 * `page.evaluate`**, which runs on the main thread — where that method is not
 * exposed in *any* engine, Chromium included (RE-024). So it reported "no OPFS"
 * everywhere and skipped all nine data-path spec files on all three engines,
 * turning a green run into a green *empty* run. The probe below therefore runs
 * inside a Worker, which is the context the app uses it from.
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
/**
 * Ask a Worker to actually take a synchronous access handle, the way the app's
 * own gate does (D-016) — presence of the method proves nothing, because Safari
 * 16.3 exposes it and throws. The filename is per-probe and the handle is
 * released in `finally`: a fixed name plus an exclusive handle is what deadlocked
 * two tabs in RE-007, and a guard that hangs the suite is worse than one that
 * lies.
 */
const PROBE = `
self.onmessage = async () => {
  const name = 'e2e-probe-' + Math.random().toString(36).slice(2) + '.bin'
  let dir = null, access = null
  try {
    dir = await navigator.storage.getDirectory()
    access = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle()
    access.getSize()
    postMessage({ usable: true })
  } catch (error) {
    postMessage({ usable: false, why: String((error && error.message) || error) })
  } finally {
    try { if (access) access.close() } catch {}
    try { if (dir) await dir.removeEntry(name) } catch {}
  }
}
`

export async function skipWithoutLocalStorage(page: Page): Promise<void> {
  const usable = await page.evaluate(async (source) => {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    const worker = new Worker(url)
    try {
      return await new Promise<boolean>((resolve) => {
        // A worker that never answers must not hang the run: an engine with no
        // OPFS at all can fail to construct it, and `onerror` is the only signal.
        const done = setTimeout(() => resolve(false), 15_000)
        worker.onmessage = (event) => {
          clearTimeout(done)
          resolve(Boolean(event.data?.usable))
        }
        worker.onerror = () => {
          clearTimeout(done)
          resolve(false)
        }
        worker.postMessage(1)
      })
    } finally {
      worker.terminate()
      URL.revokeObjectURL(url)
    }
  }, PROBE)
  test.skip(
    !usable,
    'this browser has no OPFS, so it cannot hold the corpus — the capability ' +
      'gate covers it in resilience.spec.ts, which is the honest thing to assert here'
  )
}
