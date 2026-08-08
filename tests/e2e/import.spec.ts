import { expect, test } from '@playwright/test'

import { requireLocalStorage } from './support'

import { SEARCH_INDEXES } from '../../lib/search'

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
  // The per-step waits below are minutes long because this spec is also run
  // against the full corpus (see the deploy verification in plan.md), and the
  // config's 120 s default would cap them — a progressing import would fail on
  // elapsed time alone, which is the ceiling D-052 rules out. This bound is a
  // stall detector: nothing here should take ten minutes, and if it does the
  // run is stuck rather than slow.
  test.setTimeout(600_000)

  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text())
  })

  await page.goto('/')
  await requireLocalStorage(page)
  await expect(page.getByRole('heading', { name: 'cve.meenan.dev' })).toBeVisible()

  await test.step('import', async () => {
    await page.getByRole('button', { name: /Download data/ }).click()

    // Building the indexes is 90% of an import — 9 s on the development slice,
    // 65 s on the full corpus — so D-052 puts it above the line where silence
    // is indistinguishable from a hang. Asserted here rather than sampled after
    // the fact because it is a property of the *wait*: it has to be countable
    // while the user is looking at it. Not a race at either scale — the phase
    // lasts seconds and reports about 96 times inside it.
    const progress = page.locator('.progress')
    // The label comes from `SEARCH_INDEXES` rather than being spelled out: the
    // description index covers titles too since schema 2 (D-070), and the
    // property under test is that the count is *countable*, not what the rows
    // are called.
    await expect(progress).toContainText(
      new RegExp(`[\\d,]+ ${SEARCH_INDEXES[0]!.label} indexed`),
      { timeout: 300_000 }
    )
    // And a determinate bar while it does: a fraction, not the full-width
    // placeholder an unmeasurable phase renders.
    await expect(page.locator('.progress .fill')).toHaveAttribute('data-indeterminate', 'false')

    await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible({ timeout: 300_000 })

    const timings = await page.locator('.timings').innerText()
    test.info().annotations.push({ type: 'Q-003', description: timings.replace(/\n/g, ' ') })
  })

  await test.step('query', async () => {
    await page.getByRole('button', { name: 'Run query' }).click()
    // D-052: no latency ceiling, so this timeout is a stall detector and not a
    // budget. It has to be generous — against the full corpus the first query
    // after an import costs ~9 s of page-cache warming, and Playwright's 5 s
    // default was quietly asserting a ceiling this project does not have.
    await expect(page.getByRole('heading', { name: 'Most-reported vendors' })).toBeVisible({
      timeout: 120_000,
    })

    const rows = page.locator('.results tbody tr')
    await expect(rows).toHaveCount(15, { timeout: 120_000 })

    // A real aggregate over real records, not a fixture: three columns, and a
    // leading count that is a plausible number rather than zero.
    const cells = page.locator('.results tbody tr').first().locator('td')
    await expect(cells).toHaveCount(3)
    expect(Number(await cells.nth(1).innerText())).toBeGreaterThan(0)
  })

  await test.step('the client-built indexes are searchable (D-035)', async () => {
    // The indexes are built here rather than shipped, a rowid range at a time,
    // which puts this app in charge of covering the id space. A range dropped
    // by that walk shows up nowhere else: the fts5 tables exist either way, the
    // promotion gate counts tables and not rows, and the only symptom is
    // records that can never be found. tests/unit/search.test.ts holds the
    // arithmetic to the same standard against SQLite directly; this is the one
    // place the WASM build's own fts5 answers a search over the real corpus.
    await page.getByRole('button', { name: 'Measure query latency' }).click()
    await expect(page.getByRole('heading', { name: 'Query latency' })).toBeVisible({
      timeout: 300_000,
    })

    const json = await page.locator('table.bench').getAttribute('data-json')
    const results = (JSON.parse(json ?? '{}').results ?? []) as { name: string; rows: number }[]
    const rows = (name: string) => results.find((entry) => entry.name === name)?.rows
    // Descriptions and vendor names — two of the three indexes, through two
    // different code paths (a join back to `cve`, and a bare lookup).
    expect(rows('fts-ranked'), 'no CVE matched a description search').toBeGreaterThan(0)
    expect(rows('fts-vendor'), 'no vendor matched a name search').toBeGreaterThan(0)
  })

  await test.step('the copy says how old its data is (M2 freshness)', async () => {
    // Sync is manual after the first one (D-025), so the thing that keeps a
    // month-old corpus from producing confident-looking counts is the app
    // saying how old it is. The stamp has to come from the data itself — the
    // `generated` the pipeline writes and every delta carries (D-058 §4a) —
    // and not from when this browser happened to download it, which is why it
    // is checked against the manifest rather than against the clock.
    const generated = await page.evaluate(async () => {
      const manifest = await (await fetch('/data/manifest.json', { cache: 'no-cache' })).json()
      return manifest.generated as number
    })
    const freshness = page.locator('[data-freshness]')
    await expect(freshness).toContainText('Data as of', { timeout: 60_000 })
    await expect(freshness).toContainText(/old\b/)
    await expect(freshness.locator('time')).toHaveAttribute(
      'datetime',
      new Date(generated * 1000).toISOString()
    )
    // Which verdict it renders depends on how old the served generation is, so
    // the assertion is on the pair being consistent rather than on either one.
    const age = Number(await freshness.getAttribute('data-age-ms'))
    const stale = (await freshness.getAttribute('data-freshness')) === 'stale'
    expect(age).toBeGreaterThanOrEqual(0)
    expect(stale).toBe(age > 2 * 24 * 3_600_000)
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

  await test.step('persistence, notice included (D-008)', async () => {
    await page.reload()
    // No download this time: the button reports an existing local copy, and the
    // query runs against what OPFS kept.
    await expect(page.getByRole('button', { name: 'Re-download data' })).toBeEnabled({
      timeout: 30_000,
    })
    await page.getByRole('button', { name: 'Run query' }).click()
    await expect(page.locator('.results tbody tr')).toHaveCount(15, { timeout: 120_000 })

    // The notice has to survive the reload, not just the import. A returning
    // visitor's page never receives an `imported` message, so if the notice
    // rides only on that, every session after the first serves CVE data with
    // no attribution — which is the one condition D-008's grant carries.
    const reloaded = page.locator('.notice')
    await expect(reloaded).toContainText('The MITRE Corporation')
    await expect(reloaded).toContainText("reproduce MITRE's copyright designation and this license")
  })

  await test.step('clearing removes the copy and everything derived from it', async () => {
    await page.getByRole('button', { name: 'Clear local copy' }).click()
    await expect(page.getByRole('button', { name: 'Download data', exact: true })).toBeVisible({
      timeout: 60_000,
    })
    // Stale panels next to a "Download data" button are the UI asserting
    // something false about what is on disk.
    await expect(page.locator('.timings')).toHaveCount(0)
    await expect(page.locator('.results')).toHaveCount(0)
    await expect(page.locator('.notice')).toHaveCount(0)
  })

  expect(failures, `console/page errors:\n${failures.join('\n')}`).toEqual([])
})
