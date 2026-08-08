import { expect, test, type Page } from '@playwright/test'

import { requireLocalStorage } from './support'

/**
 * The CISA KEV overlay, in a browser (M6, D-010, D-076).
 *
 * The validator, the compiled predicates and the export columns are all tested
 * away from the browser — `tests/unit/kev.test.ts`, `tests/unit/filters.test.ts`
 * and `pipeline/tests/test_kev.py`. What only a browser has is the part this
 * covers: fetch → validate → one transaction into the OPFS copy, the freshness
 * line that reads back out of it, and the two failure shapes that matter —
 * **a KEV failure must not fail the corpus operation**, and **a copy with no
 * catalog must refuse a KEV question rather than answer it wrongly**.
 *
 * It needs a `kev.json` on the data plane it is pointed at. Locally that is
 * `pipeline/kev.py sample` + `run --from-file` (pipeline/README.md); the spec
 * skips itself when the file is absent, because a plane without one is a
 * legitimate state and not a failure of this build.
 */

/** Whether the plane under test serves a catalog at all. */
async function catalogPresent(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    try {
      const response = await fetch('/data/kev.json', { cache: 'no-store' })
      return response.ok
    } catch {
      return false
    }
  })
}

test.describe('CISA KEV overlay', () => {
  test('a download ends with a catalog, and the copy can be queried by it', async ({ page }) => {
    test.setTimeout(600_000)
    const failures: string[] = []
    page.on('pageerror', (error) => failures.push(String(error)))
    page.on('console', (message) => {
      if (message.type() === 'error') failures.push(message.text())
    })

    await page.goto('/')
    await requireLocalStorage(page)
    test.skip(!(await catalogPresent(page)), 'this data plane serves no kev.json')

    await test.step('the corpus downloads and the catalog rides along', async () => {
      await page.getByRole('button', { name: /Download data/ }).click()
      await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible({ timeout: 300_000 })
      // The line is its own, beside but distinct from the corpus's: two datasets
      // on two cadences, so one number for both would be wrong about whichever
      // moved last.
      const line = page.locator('[data-kev]')
      await expect(line).toBeVisible({ timeout: 300_000 })
      await expect(line).not.toHaveAttribute('data-kev', 'none')
      // Provenance wherever KEV is asserted, and never as an endorsement.
      await expect(line).toContainText('CISA KEV catalog')
      await expect(line).toContainText('entries')

      // **And the app is usable again.** The page derives *busy* from the
      // Worker's progress phase, so a KEV refresh that ends without saying so
      // leaves every button disabled — which is exactly what happened, and it
      // presented as this spec waiting ten minutes for a Run button that was
      // never going to enable. Asserted here, with a short timeout, so that
      // failure is thirty seconds and a sentence rather than a test timeout
      // with no obvious cause.
      await expect(page.getByRole('button', { name: 'Sync', exact: true })).toBeEnabled({
        timeout: 30_000,
      })
    })

    await test.step('membership is filterable and the counts agree (M3’s pattern)', async () => {
      await page.getByRole('tab', { name: 'Explore' }).click()
      // Grouped count first, then the filter, then the two have to agree — the
      // check that would catch a filter and an aggregate disagreeing about what
      // "in KEV" means.
      await page.locator('#explore-group').selectOption('kev')
      await page.getByRole('button', { name: 'Run', exact: true }).click()
      const rows = page.locator('.results tbody tr')
      await expect(rows.first()).toBeVisible({ timeout: 180_000 })
      const grouped = await rows.first().innerText()
      // The listed band is first on the axis: it is the small one, and a stack's
      // baseline is the only position a reader can compare across buckets.
      expect(grouped).toContain('In KEV')
      const listedCount = Number(grouped.replace(/[^\d]/g, ''))
      expect(listedCount).toBeGreaterThan(0)

      // `exact`, because "In KEV (per CISA)" is a substring of "Not in KEV
      // (per CISA)" — which is inherent to the clearest possible pair of
      // labels, so the test accommodates it rather than the labels getting
      // worse.
      await page
        .getByRole('group', { name: 'CISA KEV', exact: true })
        .getByLabel('In KEV (per CISA)', { exact: true })
        .check()
      await page.locator('#explore-group').selectOption('')
      await page.getByRole('button', { name: 'Run', exact: true }).click()
      await expect(page.locator('[data-matches]')).toHaveAttribute(
        'data-matches',
        String(listedCount),
        { timeout: 180_000 }
      )
    })

    await test.step('a KEV × severity report renders reconciled with its table', async () => {
      await page.getByRole('tab', { name: 'Report' }).click()
      await page.locator('#report-rows').selectOption('kev')
      await page.locator('#report-series').selectOption('severity')
      await page.getByRole('button', { name: /Run report/ }).click()
      const chart = page.locator('[data-chart]')
      await expect(chart).toBeVisible({ timeout: 180_000 })
      // Both membership bands on the chart. A KEV chart showing only the listed
      // band is a chart with no denominator.
      const table = page.locator('.chart-data tbody tr')
      const labels = await table.locator('th').allInnerTexts()
      expect(labels.some((label) => label.includes('In KEV'))).toBe(true)
      expect(labels.some((label) => label.includes('Not in KEV'))).toBe(true)
    })

    await test.step('the detail view renders the KEV block under the reference hardening', async () => {
      // The listed record is found through the KEV filter rather than named, so
      // this works against either data plane.
      await page.getByRole('tab', { name: 'Explore' }).click()
      await page.getByRole('button', { name: 'Run', exact: true }).click()
      const first = page.locator('.results.records tbody button').first()
      await expect(first).toBeVisible({ timeout: 180_000 })
      await first.click()
      const block = page.locator('[data-kev-entry]')
      await expect(block).toBeVisible({ timeout: 60_000 })
      await expect(block).toContainText('Added to the catalog')

      // Every note link is held to the same allowlist the references are, and a
      // refused one renders as text with the reason rather than disappearing
      // (rule 4). The sample catalog carries a `javascript:` token for exactly
      // this assertion.
      //
      // **The counts are asserted first, and that is the point.** Iterating a
      // locator that matches nothing passes every per-element assertion below
      // it — the RE-024 shape, and this spec had it: the loops ran over zero
      // links and reported the hardening verified.
      const notes = page.locator('[data-kev-notes] li')
      await expect(notes.first()).toBeVisible({ timeout: 60_000 })
      const links = page.locator('[data-kev-notes] a')
      expect(await links.count(), 'no note link was rendered, so nothing below was checked').toBe(1)
      // And the refused one is *shown*, with its reason, rather than dropped:
      // an omitted reference is a fact about the record the reader should have.
      const refused = page.locator('[data-kev-notes] [data-ref-refused="1"]')
      expect(await refused.count()).toBe(1)
      await expect(refused).toContainText('not linked')
      for (const href of await links.evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLAnchorElement).href)
      )) {
        expect(href).toMatch(/^https?:/)
      }
      for (const rel of await links.evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLAnchorElement).rel)
      )) {
        expect(rel).toContain('noreferrer')
      }
    })

    await test.step('a second tab agrees about the catalog', async () => {
      // Multi-tab is full support (M5), and the KEV line is part of what has to
      // agree: two tabs reporting different catalog versions is the confusion
      // that support exists to remove. Read from the shared copy rather than
      // from either page's session, which is what makes it true without a
      // handshake.
      const second = await page.context().newPage()
      await second.goto('/')
      const secondLine = second.locator('[data-kev]')
      await expect(secondLine).toBeVisible({ timeout: 180_000 })
      const [a, b] = await Promise.all([
        page.locator('[data-kev]').getAttribute('data-kev'),
        secondLine.getAttribute('data-kev'),
      ])
      expect(b).toBe(a)
      await second.close()
    })

    await test.step('the catalog survives a reopen with no network', async () => {
      // `status` makes no network request, so the freshness line is read out of
      // the copy — which is what makes it honest offline (D-048). The reopen is
      // the real claim, and it needs the shell's worker *controlling*, which
      // takes a second load by design — the trap offline.spec.ts documents.
      await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, {
        timeout: 60_000,
      })
      await page.context().setOffline(true)
      const reopened = await page.context().newPage()
      await reopened.goto('/')
      const line = reopened.locator('[data-kev]')
      await expect(line).toBeVisible({ timeout: 180_000 })
      await expect(line).not.toHaveAttribute('data-kev', 'none')
      // And it is the *stored* values with their age, not a claim about the
      // origin — which is what "honest offline" means.
      await expect(line).toContainText('CISA KEV catalog')
      await reopened.close()
      await page.context().setOffline(false)
    })

    expect(failures, 'the page logged errors').toEqual([])
  })

  test('a failed KEV fetch leaves the corpus and the previous catalog alone', async ({ page }) => {
    test.setTimeout(600_000)
    await page.goto('/')
    await requireLocalStorage(page)
    test.skip(!(await catalogPresent(page)), 'this data plane serves no kev.json')

    await page.getByRole('button', { name: /Download data/ }).click()
    await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible({ timeout: 300_000 })
    const line = page.locator('[data-kev]')
    await expect(line).toBeVisible({ timeout: 300_000 })
    const before = await line.getAttribute('data-kev')
    expect(before).not.toBe('none')

    await test.step('the origin starts refusing the catalog', async () => {
      // `page.route` sees the Worker's requests, which is what M2's failure
      // tests are built on.
      await page.route('**/data/kev.json', (route) => route.fulfill({ status: 503, body: 'no' }))
      await page.getByRole('button', { name: 'Refresh KEV' }).click()
      // The failure is *reported* — silence would be the dishonest outcome —
      // and the catalog that is still there is still the catalog.
      await expect(line).toContainText('Last refresh failed', { timeout: 120_000 })
      await expect(line).toHaveAttribute('data-kev', String(before))
    })

    await test.step('and a sync still succeeds with the corpus untouched', async () => {
      // The property this milestone hangs on: a KEV failure is not a failure of
      // the corpus operation that triggered it.
      await page.getByRole('button', { name: 'Sync', exact: true }).click()
      await expect(page.locator('[data-revision]')).toBeVisible({ timeout: 180_000 })
      await expect(page.locator('[data-revision]')).toContainText('Local copy at revision')
      await page.getByRole('button', { name: 'Run query' }).click()
      await expect(page.locator('.results tbody tr').first()).toBeVisible({ timeout: 180_000 })
    })

    await test.step('a malformed catalog is refused whole, not partly applied', async () => {
      await page.unroute('**/data/kev.json')
      await page.route('**/data/kev.json', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          // Parses, and is not a catalog. Half a known-exploited list read as a
          // whole one is worse than yesterday's.
          body: JSON.stringify({ catalogVersion: '2099.01.01', vulnerabilities: 'lots' }),
        })
      )
      await page.getByRole('button', { name: 'Refresh KEV' }).click()
      await expect(line).toContainText('Last refresh failed', { timeout: 120_000 })
      await expect(line).toHaveAttribute('data-kev', String(before))
      await page.unroute('**/data/kev.json')
    })
  })

  test('a copy with no catalog refuses a KEV question by name', async ({ page }) => {
    test.setTimeout(600_000)
    await page.goto('/')
    await requireLocalStorage(page)

    // Downloaded with the catalog unreachable, so the copy is complete and the
    // overlay is absent — the state a user is in before the first refresh, and
    // the one where answering "nothing is known to be exploited" would be a
    // finding rather than a missing feature.
    await page.route('**/data/kev.json', (route) => route.abort())
    await page.getByRole('button', { name: /Download data/ }).click()
    await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible({ timeout: 300_000 })

    await page.getByRole('tab', { name: 'Explore' }).click()
    await page.locator('#explore-group').selectOption('kev')
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    // By name, and actionable: the message says what to do and that nothing
    // else about the copy is affected.
    await expect(page.locator('[data-error="1"]')).toContainText('no CISA KEV catalog', {
      timeout: 120_000,
    })
    await expect(page.locator('[data-error="1"]')).toContainText('Refresh KEV')

    await test.step('and every other KEV surface refuses the same way', async () => {
      // The Explore path is not the only gate. A report, an export and the
      // detail view each reach the table by a different route, and the detail
      // view is the sharpest: without its own check *every* record on a
      // catalog-less copy would die with `no such table` — which is the
      // "makes the overlay's absence look like a broken record" failure its
      // own comment names.
      await page.getByRole('tab', { name: 'Report' }).click()
      await page.locator('#report-rows').selectOption('kev')
      await page.getByRole('button', { name: /Run report/ }).click()
      await expect(page.locator('[data-error="1"]')).toContainText('no CISA KEV catalog', {
        timeout: 120_000,
      })

      await page.getByRole('tab', { name: 'Explore' }).click()
      await page.locator('#explore-group').selectOption('')
      await page.getByRole('button', { name: 'Run', exact: true }).click()
      const first = page.locator('.results.records tbody button').first()
      await expect(first).toBeVisible({ timeout: 180_000 })
      await first.click()
      // Opens, renders, and simply has no KEV block.
      await expect(page.locator('[data-detail]')).toBeVisible({ timeout: 60_000 })
      await expect(page.locator('[data-kev-entry]')).toHaveCount(0)
    })

    await test.step('while every other query still works', async () => {
      await page.locator('#explore-group').selectOption('severity')
      await page.getByRole('button', { name: 'Run', exact: true }).click()
      await expect(page.locator('.results tbody tr').first()).toBeVisible({
        timeout: 180_000,
      })
    })
    await page.unroute('**/data/kev.json')
  })
})
