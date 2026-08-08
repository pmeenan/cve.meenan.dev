import { expect, test } from '@playwright/test'

import { SUPPORT_FLOOR } from '../../lib/capabilities'

/**
 * The gate, the quota preflight and the diagnostics panel (M5).
 *
 * All three exist for conditions the machine running this suite is not in, so
 * two of them are *forced* rather than waited for — the capability verdict
 * through `?probe=` (which reaches the Worker, where the real probe runs) and
 * the quota through a page-level override of `navigator.storage.estimate`.
 * That is the only way to see what a browser below the D-016 floor or a
 * nearly-full disk actually gets told.
 *
 * That is worth doing because there is no telemetry (D-009): whatever these
 * paths say on screen is the entire support channel, and a message nobody has
 * ever read is a message nobody can act on.
 */

test('a browser below the floor is stopped at the gate, not mid-download', async ({ page }) => {
  test.setTimeout(300_000)

  // Safari 16.3, stood in for: `createSyncAccessHandle` exists and the handle's
  // methods return Promises. Every interface check passes and the import dies
  // inside WASM — which is the failure the gate exists to prevent, and the
  // reason the probe *calls* a method instead of looking for one.
  //
  // Through the URL rather than by patching the page, because the probe runs in
  // the *Worker*, which `addInitScript` cannot reach. `?probe=` can only make
  // the verdict worse, never better (`ImportOptions.probe`).
  await page.goto('/?probe=async')
  const gate = page.locator('[data-gate="unsupported"]')
  await expect(gate).toBeVisible({ timeout: 120_000 })

  // Which sentence it leads with depends on the browser, and that is the point
  // rather than a wrinkle: the gate names the *first* required capability that
  // is missing. On an engine with no OPFS at all the honest answer is "there is
  // nowhere to put it", not a story about asynchronous handles, and the forced
  // probe must not talk over it. So the Safari-16.3 wording is asserted only
  // where the browser would otherwise pass, which is exactly where that message
  // is the one a user would get.
  //
  // Both configured engines have OPFS since WebKit left the project list
  // (2026-08-08, RE-022), so today this always takes the first branch — it stays
  // a *measurement* rather than a constant so that adding an engine without
  // OPFS changes the assertion instead of breaking it. What is genuinely lost
  // with WebKit is that no engine in the suite now fails for real: this test
  // covers the gate only on browsers told to pretend.
  const hasOpfs = await page.evaluate(() => typeof navigator.storage?.getDirectory === 'function')
  await expect(gate).toContainText(hasOpfs ? 'asynchronous' : 'nowhere to put it')
  await expect(gate).toContainText(SUPPORT_FLOOR)
  // The reassurance a dead end owes: nothing was fetched and nothing was
  // changed. Both are true because the gate runs before the manifest.
  await expect(gate).toContainText('nothing on this machine has been changed')
  // And the button is not merely useless — it is disabled, so the message is
  // the end of the interaction rather than the start of a failed download.
  await expect(page.getByRole('button', { name: /Download data/ })).toBeDisabled()
})

test('a download that cannot fit is refused before a byte of it is fetched', async ({ page }) => {
  test.setTimeout(300_000)

  // A quota smaller than the artifact, through the URL for RE-020's reason: the
  // preflight reads `navigator.storage` inside the Worker, and a page-level
  // override of `estimate` never reaches it. `?free=` can only make the check
  // refuse, never pass.
  const dataRequests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/data/') && !url.pathname.endsWith('manifest.json')) {
      dataRequests.push(url.pathname)
    }
  })

  await page.goto('/?free=8388608')
  await expect(page.locator('main')).not.toHaveAttribute('data-status', 'pending', {
    timeout: 120_000,
  })
  await page.getByRole('button', { name: /Download data/ }).click()

  const error = page.locator('[data-error]')
  await expect(error).toBeVisible({ timeout: 120_000 })
  await expect(error).toContainText('Not enough storage')
  // Both numbers, so the user knows how much to free rather than only that it
  // is not enough.
  await expect(error).toContainText(/needs about/)
  await expect(error).toContainText(/is offering/)
  // The claim the message makes about itself: nothing was fetched. The manifest
  // is read first — it is what says how big the artifact is — but not one chunk.
  expect(dataRequests).toEqual([])
})

test('the diagnostics panel reports what a bug report needs', async ({ page }) => {
  test.setTimeout(300_000)

  await page.goto('/')
  await expect(page.locator('main')).not.toHaveAttribute('data-status', 'pending', {
    timeout: 120_000,
  })
  await page.getByRole('button', { name: /Download data/ }).click()
  await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible({ timeout: 300_000 })

  const panel = page.locator('[data-diagnostics]')
  // Closed by default: it is for the day something is wrong.
  await expect(panel).not.toHaveAttribute('open', '')
  await panel.getByText('Diagnostics').click()
  await expect(panel.locator('[data-diagnostics-body]')).toBeVisible()

  // D-009 names what a bug report needs, and this is the only place it can come
  // from. Each of these is asserted to say *something*, not to say a
  // particular thing — the values are the user's machine, not ours.
  await expect(panel.locator('[data-diag="storage"]')).toContainText('ready')
  await expect(panel.locator('[data-diag="schema"]')).toContainText('this app reads')
  await expect(panel.locator('[data-diag="records"]')).not.toBeEmpty()
  await expect(panel.locator('[data-diag="generated"]')).toContainText(/\d{4}-\d{2}-\d{2}/)
  await expect(panel.locator('[data-diag="usage"]')).toContainText(/iB|B$/)
  await expect(panel.locator('[data-diag="persisted"]')).not.toBeEmpty()
  await expect(panel.locator('[data-diag="shell"]')).toContainText(/registered|not supported/)
  await expect(panel.locator('[data-diag="capabilities"]')).toContainText('WebAssembly: yes')
  await expect(panel.locator('[data-diag="floor"]')).toContainText(SUPPORT_FLOOR)

  // And it promises what the rest of the app promises: nothing leaves.
  await expect(panel).toContainText('there is no telemetry')
})
