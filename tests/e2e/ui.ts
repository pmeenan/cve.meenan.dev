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
 * The workspace has two top-level states — and a brief third before either:
 * while `main[data-status]` is `pending` (and, with the hosted tier reachable,
 * while the hosted probe is in flight) the page renders neither view, so
 * nothing flashes before the Worker has said which one applies (M9, D-084).
 * `importCorpus` already waits that state out.
 *
 * - **Landing** — neither tier can answer: no local copy, and the hosted tier
 *   is off (`?remote=0`) or unreachable. One CTA (`Download CVE dataset`,
 *   `[data-download]`), the diagnostics disclosure, and the page-level
 *   banners. The download progress bar renders here while an import runs.
 * - **Workspace** — a tier can answer. On the **local** tier (a downloaded
 *   copy) the header carries a `Sync` button; on the **hosted** tier (server
 *   answering, no local copy) it carries `Make available offline` instead,
 *   which is the same `[data-download]` action. `main[data-tier]` is `local`
 *   or `hosted`. Header toggles open the panels: Filters (`#filters-panel`),
 *   SQL (`#sql-panel`), Data (`#data-panel`), Saved (`#saved-panel`), and the
 *   chat column. The canvas auto-runs a default report the first time a tier
 *   is ready — `data-run` is never assumed to be zero.
 *
 * **The dev server cannot execute `sql.php`** (it serves PHP as bytes), so
 * the hosted probe fails against it and the landing fallback renders — which
 * is why the local-tier specs still see the landing CTA on a first visit.
 * `importCorpus` pins that with `?remote=0` so it does not even depend on the
 * probe failing; a spec that wants the *hosted* tier stubs `/api/sql.php`
 * with `page.route` (see `hosted.spec.ts`).
 */

/** The landing view's download CTA — also `Re-download CVE dataset` at a bump. */
export const DOWNLOAD = /download CVE dataset/i

export function downloadButton(page: Page): Locator {
  return page.locator('[data-download]')
}

/**
 * The hosted tier's upgrade action — the workspace header's `Make available
 * offline` (`data-download` too, so `downloadButton` finds either). Distinct
 * helper because a spec asserting the *hosted* header wants the label, not
 * just the hook.
 */
export function makeOfflineButton(page: Page): Locator {
  return page.getByRole('button', { name: /make available offline/i })
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

/**
 * Pick a chart type from the canvas's icon toggle group (M9) — the buttons'
 * accessible names are the old dropdown's labels: `Stacked bars`,
 * `Grouped bars`, `Lines over time`, `Stacked area`, `Table`.
 */
export async function setChartType(page: Page, label: string): Promise<void> {
  await page
    .locator('[data-chart-picker]')
    .getByRole('button', { name: label, exact: true })
    .click()
}

/**
 * The date range control (M9), by the `data-date-range` name its instances
 * carry: `canvas-published` on the canvas strip, and `published`, `updated`,
 * `kev-added`, `kev-due` in the filter drawer.
 *
 * Its two text boxes keep the ids the native inputs had — `#canvas-pub-from`,
 * `#report-pub-from` and so on — so a spec that only wants to set a date can
 * still `fill()` one. The value is committed on **Enter or blur**, never
 * mid-typing (a commit re-runs the canvas report, and a running query disables
 * the box under the reader's fingers), so a `fill()` must be followed by
 * something that blurs it.
 *
 * The calendar is a fixed-position dialog outside the panel's scroll box, so
 * `openCalendar` returns it rather than searching the panel.
 */
export async function openCalendar(page: Page, name: string): Promise<Locator> {
  await page.locator(`[data-date-open="${name}"]`).click()
  const popover = page.locator(`[data-date-pop="${name}"]`)
  await expect(popover).toBeVisible()
  return popover
}

/** One day cell in an open calendar, by the day it is. */
export function calendarDay(page: Page, day: string): Locator {
  return page.locator(`[data-day="${day}"]`)
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
  // `?remote=0` turns the hosted tier off (D-084), so a first visit lands on
  // the download CTA deterministically — the local-tier flow every caller of
  // this helper is a precondition for. Without it the flow still works (the
  // dev server cannot answer the probe), but this does not lean on that.
  await page.goto('/?remote=0')
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
 *
 * **Local tier only.** The idle signal is the `Sync` button, which the header
 * carries only on the local tier; on the hosted tier it is "Make available
 * offline" instead and this would never settle (RE-032). Call it after a copy
 * is local (as `importCorpus` does), never while on the hosted tier.
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
