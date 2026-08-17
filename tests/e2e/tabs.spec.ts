import { expect, test, type Page } from '@playwright/test'

import { requireLocalStorage } from './support'

import { awaitIdle, downloadButton, openPanel } from './ui'

/**
 * Multi-tab, as full support rather than honest degradation (M5, owner
 * decision 2026-08-08).
 *
 * Two properties, and they fail very differently. Exclusion is loud: two tabs
 * writing at once corrupt the copy, and the Web Lock is what stops it. The
 * other one is silent, and is the reason this test exists at all — a tab that
 * did not perform a replacement goes on answering, *correctly*, from a
 * generation that is no longer the live database, with a freshness line that
 * disagrees with the tab next to it and no error anywhere.
 *
 * Both tabs share one browser context on purpose: OPFS, Web Locks and
 * `BroadcastChannel` are all scoped to the origin within a context, and two
 * contexts would be two machines rather than two tabs.
 */

/** Wait for the Worker to have spoken about storage, whatever it says. */
async function settled(page: Page): Promise<void> {
  await expect(page.locator('main')).not.toHaveAttribute('data-status', 'pending', {
    timeout: 120_000,
  })
}

/**
 * The first download starts from the landing view's CTA; every later one is
 * the "Re-download data" button inside the footer's Data & diagnostics
 * disclosure — two different surfaces since the UI revamp, so two helpers
 * rather than one label regex.
 */
async function download(page: Page): Promise<void> {
  await downloadButton(page).click()
  await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible({ timeout: 300_000 })
  // Quiet before returning: the catch-up and auto-run report follow an
  // import, and their busy flickers can swallow a click on a disabled button.
  await awaitIdle(page, 60_000)
}

/**
 * A re-download from a ready workspace. The Import heading is already on
 * screen from the previous import, so completion is waited on as a *change*
 * to the recorded timings — capture, click, wait for a different payload —
 * rather than on a heading that would match instantly.
 */
async function redownload(page: Page): Promise<void> {
  await openPanel(page, 'data')
  const before = await page.locator('.timings').getAttribute('data-json')
  await page.getByRole('button', { name: 'Re-download data' }).click()
  await expect(page.locator('.timings')).not.toHaveAttribute('data-json', before ?? '', {
    timeout: 300_000,
  })
  await awaitIdle(page, 60_000)
}

/** Wait for a tab to finish whatever it is doing, so the next step is not a race. */
async function idle(page: Page): Promise<void> {
  await awaitIdle(page, 300_000)
}

/** The demo aggregate, which is the cheapest proof a tab can still answer. */
async function query(page: Page): Promise<void> {
  await openPanel(page, 'data')
  await page.getByRole('button', { name: 'Run query' }).click()
  await expect(page.locator('#data-panel table.results tbody tr').first()).toBeVisible({
    timeout: 300_000,
  })
}

test('a second tab queries while the first writes, and follows the replacement', async ({
  context,
}) => {
  test.setTimeout(600_000)

  const failures: string[] = []
  const watch = (page: Page, name: string) => {
    page.on('pageerror', (error) => failures.push(`${name}: ${error}`))
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      // sqlite3's OPFS async proxy logs its own console.error when an open
      // hits a file the other tab just replaced — the exact window the
      // promotion protocol exists to handle, and the reader tab recovers by
      // reopening (M5). Since the canvas auto-runs a report the moment a tab
      // is ready (D-081), the non-writing tab now queries *during* that
      // window routinely. The app-level assertions below are what verify the
      // recovery; the proxy's own logging of the transient is not a failure.
      if (/opfs.*(async error|async-proxy)/i.test(message.text())) return
      failures.push(`${name}: ${message.text()}`)
    })
  }

  const a = await context.newPage()
  watch(a, 'tab A')
  await a.goto('/')
  await requireLocalStorage(a)
  await settled(a)
  await download(a)

  const b = await context.newPage()
  watch(b, 'tab B')
  await b.goto('/')
  await settled(b)
  // Tab B opens on a copy that is days behind (the development slice is dated
  // at build time), so once its first report answers it posts one sync by
  // itself (UI polish, 2026-08-16) — a *write*, from the tab this test is about
  // to treat as the reader. Let it finish before the choreography below, so
  // every write from here on is one this test asked for; A's own import already
  // caught up, so A never fires one.
  await idle(b)

  await test.step('both tabs see the same copy — the point of the `opfs` VFS (D-051)', async () => {
    // `opfs-sahpool` froze the second tab entirely, which is what D-051 chose
    // against. This is the behaviour that choice bought. The revision line is
    // inside the footer's Data & diagnostics disclosure, closed on a fresh
    // page; `query` opens it.
    await query(b)
    await expect(b.locator('[data-revision]')).toBeVisible({ timeout: 120_000 })
    const [revA, revB] = await Promise.all([
      a.locator('[data-revision]').getAttribute('data-revision'),
      b.locator('[data-revision]').getAttribute('data-revision'),
    ])
    expect(revB).toBe(revA)
  })

  await test.step('two tabs both asked to write, and neither breaks', async () => {
    // A itself is idle here, so one of the two must succeed; the exclusion is
    // exercised by starting a write in A and *not awaiting it* before asking B.
    // `Sync` on the development slice finds nothing to fetch, so which one wins
    // is a race — the *specific* refusal is forced in the next step, where it
    // can be. What has to hold either way is that neither tab is left stuck.
    const writing = a.getByRole('button', { name: 'Sync' }).click()
    await b.getByRole('button', { name: 'Sync' }).click()
    await writing
    await idle(a)
    await idle(b)
    await expect(a.locator('main')).not.toHaveAttribute('data-status', 'pending')
    await expect(b.locator('main')).not.toHaveAttribute('data-status', 'pending')
  })

  await test.step('a tab that is refused the lock is told, in words', async () => {
    // Forced rather than raced: hold the writer lock from tab B's *page* —
    // the same origin-scoped lock the Worker takes — and then ask B to write.
    // Held from B rather than A so that releasing it is not on the critical
    // path of A's replacement in the next step, and released explicitly rather
    // than on a timer, because a timer is a race dressed as a delay.
    await b.evaluate(
      () =>
        new Promise<void>((granted) => {
          void navigator.locks.request(
            'cve-writer',
            () =>
              new Promise<void>((release) => {
                ;(window as unknown as { releaseWriter?: () => void }).releaseWriter = release
                granted()
              })
          )
        })
    )

    await b.getByRole('button', { name: 'Sync' }).click()
    const banner = b.locator('[data-error]')
    await expect(banner).toBeVisible({ timeout: 120_000 })
    await expect(banner).toContainText(/Another tab is/)
    // Full support, not degradation: the refused tab can still be used.
    await query(b)

    await b.evaluate(() => {
      const holder = window as unknown as { releaseWriter?: () => void }
      holder.releaseWriter?.()
      delete holder.releaseWriter
    })
    // And wait for it to actually be free, or the next step races the release.
    await b.waitForFunction(
      () =>
        navigator.locks
          .request('cve-writer', { ifAvailable: true }, (lock) => lock !== null)
          .then((got) => got === true),
      undefined,
      { timeout: 60_000 }
    )
  })

  await test.step('a replacement in one tab is followed by the other', async () => {
    // The silent failure. A re-download stages into the *other* slot and
    // promotes it (D-061), so after this the file tab B holds open is no longer
    // the live database. Without the announcement it would keep answering from
    // a generation nobody else can see.
    const before = await b.evaluate(async () => {
      const root = await navigator.storage.getDirectory()
      const names: string[] = []
      for await (const entry of root.values()) names.push(entry.name)
      return names.filter((name) => name.startsWith('cve-')).sort()
    })

    await redownload(a)

    // B re-reports without being touched: `data-run` is not enough here,
    // because the revision may be unchanged — what changed is which file it
    // came from. So assert the observable consequence: B can still query, and
    // its storage state stays `ready` rather than falling to `empty` when the
    // slot it was holding is swept.
    await expect(b.locator('main')).toHaveAttribute('data-status', 'ready', { timeout: 300_000 })
    await query(b)

    const after = await b.evaluate(async () => {
      const root = await navigator.storage.getDirectory()
      const names: string[] = []
      for await (const entry of root.values()) names.push(entry.name)
      return names.filter((name) => name.startsWith('cve-')).sort()
    })
    // The slots alternate, so the live file's *name* changed — which is exactly
    // what a tab holding the old one cannot notice on its own.
    test.info().annotations.push({
      type: 'slots',
      description: `before ${before.join(', ')} → after ${after.join(', ')}`,
    })
  })

  await test.step('and the two tabs agree about how fresh the copy is', async () => {
    // Freshness is read from the data's own build stamp (D-064), so two tabs
    // that disagree are two tabs looking at different generations.
    const freshness = async (page: Page) =>
      page.locator('[data-freshness]').getAttribute('data-freshness')
    // Both lines live in the footer disclosure; B's is open from `query`, but
    // say so rather than depend on it.
    await openPanel(b, 'data')
    await expect(b.locator('[data-freshness]')).toBeVisible({ timeout: 120_000 })
    expect(await freshness(b)).toBe(await freshness(a))
    const revs = await Promise.all([
      a.locator('[data-revision]').getAttribute('data-revision'),
      b.locator('[data-revision]').getAttribute('data-revision'),
    ])
    expect(revs[1]).toBe(revs[0])
  })

  expect(failures, `console/page errors:\n${failures.join('\n')}`).toEqual([])
})
