import { expect, test } from '@playwright/test'

import { requireLocalStorage } from './support'

import { awaitIdle, downloadButton, openPanel } from './ui'

/**
 * The offline app shell (D-048, D-054), and the boundary it must never cross.
 *
 * Vision criterion 5 says the app works offline, *fully*. OPFS already
 * preserves the data — an already-open tab keeps querying with the network
 * gone, and did before M5 — but nothing preserved the app: reopening it with no
 * network got a browser error page and a 441 MB database nobody could reach.
 * So the test that matters is a **reopen**, not a disconnect.
 *
 * The other half is the scope boundary. `/data/` must pass through the worker
 * untouched: the manifest is the freshness signal (D-042), and a stale one
 * served from a cache would break the staleness indicator — the one guard
 * vision criterion 7 has against confident-but-old counts.
 */

test('the app reopens with no network, and never serves /data/ from its cache', async ({
  context,
  page,
}) => {
  test.setTimeout(600_000)

  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(String(error)))

  await test.step('the shell registers and takes over', async () => {
    await page.goto('/')
    await requireLocalStorage(page)
    // The worker takes over on the *next* load by design, so this is two loads.
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, {
      timeout: 60_000,
    })
    await expect(page.locator('main')).not.toHaveAttribute('data-status', 'pending', {
      timeout: 120_000,
    })
  })

  await test.step('with a local copy', async () => {
    // The landing view's CTA; the Import heading is inside the Data panel,
    // which opens itself on the import that filled it.
    await downloadButton(page).click()
    await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible({ timeout: 300_000 })
    // Quiet before the next step: the post-import catch-up and auto-run
    // report otherwise flicker every button disabled under a later click.
    await awaitIdle(page)
  })

  await test.step('the data plane is not in the shell cache', async () => {
    // Asserted against the cache's own contents rather than by observing a
    // request, because the failure mode is a `/data/` entry that is only
    // *served* later — when the network is gone and the manifest is stale.
    const cached = await page.evaluate(async () => {
      const names = await caches.keys()
      const urls: string[] = []
      for (const name of names) {
        const cache = await caches.open(name)
        for (const request of await cache.keys()) urls.push(new URL(request.url).pathname)
      }
      return urls
    })
    expect(cached.length).toBeGreaterThan(0)
    expect(cached.filter((path) => path.startsWith('/data'))).toEqual([])
    // And the things that *must* be there, or an offline reopen cannot boot.
    expect(cached).toContain('/sqlite/sqlite3.wasm')
    expect(cached).toContain('/sqlite/index.mjs')
  })

  await test.step('reopened cold with the network killed, the corpus is still queryable', async () => {
    await context.setOffline(true)
    // A *new* page, not a reload of a running one: the claim is that the app
    // opens, not that an open tab survives.
    const reopened = await context.newPage()
    const offlineFailures: string[] = []
    const noise: string[] = []
    reopened.on('pageerror', (error) => offlineFailures.push(String(error)))
    // Kept and reported on failure. An offline reopen that does not come up is
    // the one failure with nowhere to look afterwards — the network panel is
    // empty by construction and D-009 means nothing was collected — so the test
    // has to carry its own diagnostics or the next person starts from nothing.
    reopened.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') noise.push(message.text())
    })
    await reopened.goto('/')

    try {
      await expect(reopened.locator('main')).toHaveAttribute('data-status', 'ready', {
        timeout: 180_000,
      })
    } catch (error) {
      throw new Error(
        `the app did not come up offline.\nconsole:\n${noise.join('\n')}\n` +
          `page errors:\n${offlineFailures.join('\n')}\n${String(error)}`
      )
    }
    // A reopened page starts with the Data panel closed; the demo query is in
    // it, and opening it must work offline like everything else.
    await openPanel(reopened, 'data')
    await reopened.getByRole('button', { name: 'Run query' }).click()
    await expect(reopened.locator('#data-panel table.results tbody tr').first()).toBeVisible({
      timeout: 300_000,
    })
    // The notice travels with the copy, offline included (D-008).
    await expect(reopened.locator('.notice')).toContainText('The MITRE Corporation')
    expect(offlineFailures.join('\n')).not.toMatch(/Failed to fetch|NetworkError/)
  })

  await test.step('and a sync offline fails as a network error rather than silently', async () => {
    const reopened = context.pages().at(-1)!
    await reopened.getByRole('button', { name: 'Sync' }).click()
    // `/data/` passes through the worker, so with no network this is a real
    // failure — which is the correct answer. A cached manifest here would make
    // the app report "already current" while being days behind.
    await expect(reopened.locator('[data-error]')).toBeVisible({ timeout: 120_000 })
    await context.setOffline(false)
  })

  expect(failures, `page errors:\n${failures.join('\n')}`).toEqual([])
})
