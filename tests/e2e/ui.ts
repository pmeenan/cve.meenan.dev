import { expect, type Locator, type Page } from '@playwright/test'

/**
 * The suite's one map of the workspace (UI revamp).
 *
 * Before this file every spec built its own locators inline, which made the
 * 15-file blast radius of renaming one button the most expensive part of any
 * UI change. Selector knowledge that more than one spec needs lives here;
 * anything a single spec asserts (its own `data-*` payloads, copy strings)
 * stays with that spec, where the intent is.
 *
 * The workspace has two top-level states:
 *
 * - **Landing** — no usable local copy. One CTA (`Download CVE dataset`,
 *   `[data-download]`), the diagnostics disclosure, and the page-level
 *   banners. The download progress bar renders here while an import runs.
 * - **Workspace** — a usable copy. Header toggles open the panels: Filters
 *   (`#filters-panel`), SQL (`#sql-panel`), Data (`#data-panel`), Saved
 *   (`#saved-panel`), and the chat column. The Data panel opens itself after
 *   an import, which is why `importCorpus` can await the `Import` heading.
 *   The canvas auto-runs a default report the first time a copy is ready —
 *   `data-run` is never assumed to be zero.
 */

/** The landing view's download CTA — also `Re-download CVE dataset` at a bump. */
export const DOWNLOAD = /download CVE dataset/i

export function downloadButton(page: Page): Locator {
  return page.locator('[data-download]')
}

/** The workspace panels a header toggle controls. */
export type PanelName = 'filters' | 'sql' | 'data' | 'saved'

export function panelToggle(page: Page, panel: PanelName): Locator {
  return page.locator(`[data-toggle="${panel}"]`)
}

/** Open a workspace panel if it is not already open. */
export async function openPanel(page: Page, panel: PanelName): Promise<void> {
  const toggle = panelToggle(page, panel)
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(page.locator(`#${panel === 'data' ? 'data-panel' : `${panel}-panel`}`)).toBeVisible()
}

/** Close a workspace panel if it is open. */
export async function closePanel(page: Page, panel: PanelName): Promise<void> {
  const toggle = panelToggle(page, panel)
  if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click()
}

/**
 * Make sure the chat column is on screen.
 *
 * It opens by itself on a viewport at least 68rem wide (the Playwright
 * default is), so most of the time this is a no-op — but it is state, not a
 * given, and a spec that resized or closed it should not have to know why.
 */
export async function openChat(page: Page): Promise<void> {
  const toggle = page.locator('[data-chat-toggle]')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(page.locator('aside.chat')).toBeVisible()
}

/** The canvas's collapsed share/export row, opened. */
export async function openShare(page: Page): Promise<void> {
  const share = page.locator('details.share')
  if (!(await share.evaluate((node) => (node as HTMLDetailsElement).open))) {
    await share.locator('summary').click()
  }
}

/**
 * Download the corpus from the landing view and wait for the workspace.
 *
 * The `Import` heading is inside the Data panel, which opens itself on the
 * import that filled it — so awaiting it asserts both the import and the
 * panel behaviour. The default report that auto-runs afterwards is left to
 * finish on its own; specs that need quiet use `awaitIdle`.
 */
export async function importCorpus(page: Page, timeout = 90_000): Promise<void> {
  await page.goto('/')
  await expect(page.locator('main')).not.toHaveAttribute('data-status', 'pending', {
    timeout: 15_000,
  })
  await downloadButton(page).click()
  await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible({ timeout })
  // An import is followed by the catch-up, the KEV refresh and the canvas's
  // auto-run report — several short busy windows in which every workspace
  // button flickers disabled. A click dispatched into one of those flickers
  // passes Playwright's actionability check and then lands on a disabled
  // button, which swallows it. Returning only once the Worker is quiet makes
  // "import finished" mean what callers assume it means.
  await awaitIdle(page, 60_000)
}

/**
 * Wait until nothing is running: the header Sync button doubles as the idle
 * signal, because it is disabled for exactly as long as the Worker is busy.
 *
 * Idle has to *hold*, not merely be sampled: the post-import sequence is
 * several distinct busy windows (catch-up, KEV refresh, the canvas auto-run)
 * with effect-tick gaps between them, and one enabled sample can land in a
 * gap with more work still queued — which is how a click that follows lands
 * on a re-disabled button and is swallowed (RE-034). Two samples 300 ms
 * apart, both enabled, is beyond any gap those windows leave.
 */
export async function awaitIdle(page: Page, timeout = 60_000): Promise<void> {
  const sync = page.getByRole('button', { name: 'Sync', exact: true })
  const deadline = Date.now() + timeout
  for (;;) {
    await expect(sync).toBeEnabled({ timeout: Math.max(1000, deadline - Date.now()) })
    await page.waitForTimeout(300)
    if (await sync.isEnabled()) return
    if (Date.now() > deadline) {
      throw new Error(`awaitIdle: the Worker kept starting new work for ${timeout} ms`)
    }
  }
}
