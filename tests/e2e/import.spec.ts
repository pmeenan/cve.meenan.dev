import { expect, test } from '@playwright/test'

/**
 * M1's exit criterion, as a test: the deployed export fetches the published
 * chunks, decompresses them itself, writes them into OPFS, builds its indexes,
 * answers a real query, and still has the database after a reload — carrying
 * MITRE's notice throughout (D-008).
 *
 * It also records Q-003's numbers. They are printed rather than asserted:
 * budgets come *from* this measurement, so asserting one here would be
 * circular. The only timing bound is the test timeout, which catches a
 * regression into pathology.
 *
 * Everything lives in one test because OPFS is scoped to the browser context
 * and Playwright gives each test a fresh one — persistence across a *reload*
 * is the real property, and it has to be checked in the context that imported.
 */
test('imports, queries, and survives a reload', async ({ page }) => {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text())
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'cve.meenan.dev' })).toBeVisible()

  await test.step('import', async () => {
    await page.getByRole('button', { name: /Download data/ }).click()
    await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible({ timeout: 180_000 })

    const timings = await page.locator('.timings').innerText()
    test.info().annotations.push({ type: 'Q-003', description: timings.replace(/\n/g, ' ') })
  })

  await test.step('query', async () => {
    await page.getByRole('button', { name: 'Run query' }).click()
    await expect(page.getByRole('heading', { name: 'Most-reported vendors' })).toBeVisible()

    const rows = page.locator('tbody tr')
    await expect(rows).toHaveCount(15)

    // A real aggregate over real records, not a fixture: three columns, and a
    // leading count that is a plausible number rather than zero.
    const cells = page.locator('tbody tr').first().locator('td')
    await expect(cells).toHaveCount(3)
    expect(Number(await cells.nth(1).innerText())).toBeGreaterThan(0)
  })

  await test.step('the notice travels with the copy (D-008)', async () => {
    // The terms require reproducing MITRE's copyright designation and the
    // license clause — assert the required components, not just the name
    // (D-047). The canonical string lives in pipeline/build.py.
    const notice = page.locator('.notice')
    await expect(notice).toContainText('Copyright © 1999-')
    await expect(notice).toContainText('The MITRE Corporation')
    await expect(notice).toContainText('irrevocable copyright license')
    await expect(notice).toContainText("reproduce MITRE's copyright designation and this license")
    await expect(notice).toContainText('cve.org/legal/termsofuse')
  })

  await test.step('persistence', async () => {
    await page.reload()
    // No download this time: the button reports an existing local copy, and the
    // query runs against what OPFS kept.
    await expect(page.getByRole('button', { name: 'Re-download data' })).toBeEnabled({
      timeout: 30_000,
    })
    await page.getByRole('button', { name: 'Run query' }).click()
    await expect(page.locator('tbody tr')).toHaveCount(15)
  })

  expect(failures, `console/page errors:\n${failures.join('\n')}`).toEqual([])
})
