import { expect, type Page } from '@playwright/test'

/**
 * The precondition every data-path spec shares: this browser can actually hold
 * the corpus (M5, D-016).
 *
 * **This asserts rather than skips, and that is the point.** It began as
 * `skipWithoutLocalStorage`, written for Playwright's Linux WebKit, which ships
 * no OPFS at all (RE-022). Two things went wrong with that shape:
 *
 * 1. The check itself was written against
 *    `'createSyncAccessHandle' in FileSystemFileHandle.prototype` evaluated in
 *    `page.evaluate` — the **main thread**, where no engine exposes that method,
 *    Chromium included. So it reported "no OPFS" everywhere and skipped all nine
 *    data-path spec files on every engine (RE-024). `pnpm e2e` stayed green
 *    while testing nothing.
 * 2. Nothing said so. Skips are not failures, and a summary line reporting
 *    "N passed" does not say how many of the N ran.
 *
 * WebKit left the project list on 2026-08-08 for that reason, and with it went
 * the only engine a skip was ever correct for. Every remaining engine is
 * expected to support OPFS, so a browser that fails this probe is a regression —
 * in the browser, the harness, or the served isolation headers — and the suite
 * should say so loudly instead of quietly running less.
 *
 * The probe runs **inside a Worker**, which is where the app uses these APIs,
 * and it *calls* `getSize()` on a real handle rather than looking the method up:
 * Safari 16.3 exposes `createSyncAccessHandle` and throws, so presence proves
 * nothing and only a call separates the floor from the version below it (D-016).
 */
const PROBE = `
self.onmessage = async () => {
  const name = 'e2e-probe-' + Math.random().toString(36).slice(2) + '.bin'
  let dir = null, access = null, answer
  try {
    dir = await navigator.storage.getDirectory()
    access = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle()
    access.getSize()
    answer = { usable: true }
  } catch (error) {
    answer = { usable: false, why: String((error && error.message) || error) }
  } finally {
    // A per-probe filename and a release in \`finally\`: a fixed name plus an
    // exclusive handle is what deadlocked two tabs in RE-007, and a precondition
    // that hangs the suite is worse than one that lies.
    try { if (access) access.close() } catch {}
    try { if (dir) await dir.removeEntry(name) } catch {}
  }
  // Answered *after* the cleanup: the page terminates this worker on the
  // answer, and Firefox is quick enough about it that a probe file posted
  // first was left in OPFS — where a spec listing the directory counted it.
  postMessage(answer)
}
`

export async function requireLocalStorage(page: Page): Promise<void> {
  const result = await page.evaluate(async (source) => {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    const worker = new Worker(url)
    try {
      return await new Promise<{ usable: boolean; why?: string }>((resolve) => {
        // An engine with no OPFS may fail to construct the Worker at all, and
        // `onerror` is the only signal; the timeout covers a worker that neither
        // answers nor errors, which must not hang the run.
        const done = setTimeout(() => resolve({ usable: false, why: 'probe timed out' }), 15_000)
        worker.onmessage = (event) => {
          clearTimeout(done)
          resolve(event.data)
        }
        worker.onerror = (event) => {
          clearTimeout(done)
          resolve({ usable: false, why: `worker failed: ${event.message}` })
        }
        worker.postMessage(1)
      })
    } finally {
      worker.terminate()
      URL.revokeObjectURL(url)
    }
  }, PROBE)

  expect(
    result.usable,
    `this browser could not take a synchronous access handle in a Worker, so it cannot hold ` +
      `the corpus: ${result.why ?? 'unknown'}. Every configured engine is expected to support ` +
      `OPFS (WebKit was removed from the project list, RE-022), so this is a regression rather ` +
      `than a reason to skip — see RE-024 for what skipping here cost last time.`
  ).toBe(true)
}
