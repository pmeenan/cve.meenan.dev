import { expect, test, type Page } from '@playwright/test'

import { skipWithoutLocalStorage } from './support'

import { SCHEMA_VERSION } from '../../lib/protocol'

/**
 * M3's exit criteria in a browser: every confirmed filter axis answering, a
 * long query reporting and cancellable, hostile SQL refused by the database
 * itself, and a schema bump announced.
 *
 * One import, then everything else — an import is the expensive part and OPFS
 * is scoped to the browser context, so a test per criterion would mean a
 * download per criterion. The schema-bump case reloads with `?schema=`, which
 * is what makes the announcement reachable without shipping a second build of
 * the app (`ImportOptions.schema`).
 */

/**
 * SQLite prints its own diagnostics through `sqlite3.config.error` when a
 * statement is refused or interrupted, and both are *expected* here — this spec
 * exists to cause them. They are left on the console rather than silenced,
 * because silencing them would also hide the failures nobody expected (D-009
 * leaves the console as the only diagnostic channel there is).
 */
const EXPECTED = /sqlite3_(step|prepare|exec)|SQLITE_(AUTH|INTERRUPT)|not authorized|interrupted/i

function watchConsole(page: Page): string[] {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error' && !EXPECTED.test(message.text())) failures.push(message.text())
  })
  return failures
}

/**
 * Open one of M4's tabs.
 *
 * The app is a tabbed workspace on one route (M4), so a surface is only in the
 * accessibility tree — and only reachable by a role query — once its tab is
 * selected. Everything else about these tests is unchanged.
 */
async function openTab(page: Page, name: string): Promise<void> {
  await page.getByRole('tab', { name, exact: true }).click()
  await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  )
}

/** Download the development slice and wait for the local copy to be queryable. */
async function importCorpus(page: Page): Promise<void> {
  await page.goto('/')
  await skipWithoutLocalStorage(page)
  await page.getByRole('button', { name: /Download data/ }).click()
  await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible({ timeout: 300_000 })
  await openTab(page, 'Explore')
  await expect(page.getByRole('heading', { name: 'Explore' })).toBeVisible()
}

/**
 * Explore's filter form, as a scope for every field lookup.
 *
 * Scoped twice over. Page-wide, the console's textarea would answer to
 * `getByLabel('Group by')`, because an accessible name includes the value of
 * the control a label wraps and the example query contains a `GROUP BY`. And
 * since M4 there are *two* copies of this form — Explore's and the report
 * builder's — so the panel has to be named as well: `getByRole` skips the four
 * hidden panels because they are out of the accessibility tree, but `getByLabel`
 * is a DOM query and sees both.
 */
function filterForm(page: Page) {
  return page.locator('#panel-explore form.filters')
}

/**
 * Run the filter form and wait for *this* run's result.
 *
 * Waiting on the progress bar is not enough and was actively misleading: a
 * query that finishes in milliseconds may never render one, so the assertion
 * then reads the previous result and a filter that never applied looks correct.
 * The page stamps each answer with a counter for exactly this (`data-run`).
 */
async function runFilters(page: Page): Promise<void> {
  const before = await answered(page, '[data-matches]')
  await filterForm(page).getByRole('button', { name: 'Run', exact: true }).click()
  await waitForAnswer(page, '[data-matches]', before)
}

/** The answer counter currently on screen for a surface, or null if it is empty. */
async function answered(page: Page, selector: string): Promise<string | null> {
  const element = page.locator(selector).first()
  if ((await element.count()) === 0) return null
  return element.getAttribute('data-run')
}

async function waitForAnswer(page: Page, selector: string, before: string | null): Promise<void> {
  // Starting a new run deliberately removes the previous result. That empty
  // interval is not an answer: require a new, non-null counter or a fast test
  // can continue against an empty table before the Worker replies.
  await expect
    .poll(
      async () => {
        const after = await answered(page, selector)
        return after !== null && after !== before
      },
      { timeout: 120_000 }
    )
    .toBe(true)
}

/** The grouped table's rows as [label, count]. */
async function groups(page: Page): Promise<[string, number][]> {
  const rows = page.locator('table.groups tbody tr')
  const out: [string, number][] = []
  for (let at = 0; at < (await rows.count()); at += 1) {
    const cells = rows.nth(at).locator('td')
    out.push([
      (await cells.nth(0).innerText()).trim(),
      Number((await cells.nth(1).innerText()).replace(/[^\d]/g, '')),
    ])
  }
  return out
}

/** How many records the current filters match, from the summary line. */
async function matches(page: Page): Promise<number> {
  return Number(await page.locator('[data-matches]').first().getAttribute('data-matches'))
}

async function setFilter(page: Page, label: string, value: string): Promise<void> {
  await filterForm(page).getByLabel(label, { exact: true }).fill(value)
}

async function groupBy(page: Page, label: string): Promise<void> {
  await filterForm(page).getByLabel('Group by').selectOption({ label })
}

test('filters, the console, cancellation and a schema bump', async ({ page }) => {
  test.setTimeout(600_000)
  const failures = watchConsole(page)
  await importCorpus(page)

  /**
   * Each lookup axis is checked against itself: group by the dimension, take
   * the top value, then filter on that value and require the two counts to
   * agree. That is a stronger assertion than any fixed expectation — it holds
   * against the development slice and the full corpus alike, and it catches the
   * failure that matters, a filter and an aggregate disagreeing about what a
   * record is (one CVE with eight products is not eight CVEs).
   */
  for (const [dimension, field] of [
    ['Vendor', 'Vendor'],
    ['CNA', 'CNA'],
    ['CWE', 'CWE'],
    ['Reference host', 'Reference host'],
  ] as const) {
    await test.step(`filter by ${dimension} agrees with grouping by it`, async () => {
      await page.getByRole('button', { name: 'Reset filters' }).click()
      await groupBy(page, dimension)
      await runFilters(page)
      const rows = await groups(page)
      expect(rows.length, `no ${dimension} buckets`).toBeGreaterThan(0)
      const [label, count] = rows[0]!
      // The CWE bucket is labelled `CWE-79 — Cross-site Scripting`; the filter
      // takes the identifier.
      const value = dimension === 'CWE' ? label.split(' ')[0]! : label

      await page.getByRole('button', { name: 'Reset filters' }).click()
      await setFilter(page, field, value)
      await runFilters(page)
      expect(await matches(page), `${dimension} ${value}`).toBe(count)
      await expect(page.locator('[data-unmatched]')).toHaveCount(0)
    })
  }

  await test.step('a name that matches nothing says so, rather than showing zero results', async () => {
    await page.getByRole('button', { name: 'Reset filters' }).click()
    await setFilter(page, 'Vendor', 'zzz-no-such-vendor')
    await runFilters(page)
    await expect(page.locator('[data-unmatched="vendor"]')).toContainText('zzz-no-such-vendor')
    expect(await matches(page)).toBe(0)
  })

  await test.step('severity, score, dates and years', async () => {
    await page.getByRole('button', { name: 'Reset filters' }).click()
    await groupBy(page, 'Severity')
    await runFilters(page)
    const bySeverity = new Map(await groups(page))
    expect(bySeverity.size).toBeGreaterThan(1)

    await page.getByRole('button', { name: 'Reset filters' }).click()
    await filterForm(page).getByLabel('CRITICAL').check()
    await runFilters(page)
    expect(await matches(page)).toBe(bySeverity.get('CRITICAL'))

    // A score floor is a subset of the severity band above it: CRITICAL starts
    // at 9.0, so everything at 9.5 or more is CRITICAL and there are fewer.
    await setFilter(page, 'CVSS score from', '9.5')
    await runFilters(page)
    const high = await matches(page)
    expect(high).toBeGreaterThan(0)
    expect(high).toBeLessThanOrEqual(bySeverity.get('CRITICAL')!)

    await page.getByRole('button', { name: 'Reset filters' }).click()
    await setFilter(page, 'Published from', '2099-01-01')
    await runFilters(page)
    expect(await matches(page)).toBe(0)
  })

  await test.step('REJECTED records are excluded by default and never quietly (D-022)', async () => {
    await page.getByRole('button', { name: 'Reset filters' }).click()
    await runFilters(page)
    const published = await matches(page)
    await expect(page.locator('[data-state-warning]')).toHaveCount(0)

    await filterForm(page).getByLabel('All records').check()
    // Editing the next request must not relabel the answer already on screen.
    await expect(page.locator('[data-state-warning]')).toHaveCount(0)
    await runFilters(page)
    const all = await matches(page)
    expect(all).toBeGreaterThan(published)
    // Including them changes the denominator of everything on screen, so it has
    // to be visible rather than implied by a radio button.
    await expect(page.locator('[data-state-warning="all"]')).toContainText('REJECTED')

    await filterForm(page).getByLabel('REJECTED only').check()
    await runFilters(page)
    expect(await matches(page)).toBe(all - published)

    // State and severity both use numeric codes 1 and 2. The renderer must use
    // the dimension to choose labels, or these appear as LOW and MEDIUM.
    await page.getByRole('button', { name: 'Reset filters' }).click()
    await filterForm(page).getByLabel('All records').check()
    await groupBy(page, 'State')
    await runFilters(page)
    const states = new Map(await groups(page))
    expect(states.get('PUBLISHED')).toBe(published)
    expect(states.get('REJECTED')).toBe(all - published)
  })

  await test.step('full-text search, and the SQL behind every number', async () => {
    await page.getByRole('button', { name: 'Reset filters' }).click()
    await setFilter(page, 'Search descriptions', 'buffer overflow')
    await runFilters(page)
    expect(await matches(page)).toBeGreaterThan(0)
    // The query is inspectable and carries no interpolated value — the values
    // are bound (rule 4, and the property D-044 will need from the chat layer).
    // `textContent`, not `innerText`: the disclosure is closed, and innerText
    // reports what is *rendered*.
    const sql = (await page.locator('details.sql pre').textContent()) ?? ''
    expect(sql).toContain('fts MATCH ?')
    expect(sql).not.toContain('buffer')

    await setFilter(page, 'Search descriptions', 'zzqqxx-not-a-word')
    await runFilters(page)
    expect(await matches(page)).toBe(0)
  })

  await test.step('the console reads', async () => {
    await openTab(page, 'SQL')
    await page.getByRole('button', { name: 'What the schema looks like' }).click()
    await page.getByRole('button', { name: 'Run SQL' }).click()
    await expect(page.locator('[data-console-rows]')).toBeVisible({ timeout: 120_000 })
    expect(
      Number(await page.locator('[data-console-rows]').getAttribute('data-console-rows'))
    ).toBeGreaterThan(5)
  })

  /**
   * The read-only guarantee, from the outside. Each of these is refused by
   * SQLite's authorizer rather than by anything inspecting the text — the
   * pragma pair and the table-valued pragma are the cases a denylist of words
   * would let through (lib/authorizer.ts).
   */
  for (const sql of [
    'DELETE FROM cve',
    "INSERT INTO cve(id, cve_id) VALUES (999999, 'CVE-9999-9999')",
    'UPDATE cve SET cvss_score = 0',
    'DROP TABLE cve_text',
    'PRAGMA query_only = OFF',
    'SELECT * FROM pragma_query_only',
    "INSERT INTO fts(fts) VALUES('rebuild')",
    'SELECT 1; DELETE FROM cve',
    "ATTACH DATABASE 'evil.db' AS evil",
  ]) {
    await test.step(`the console refuses: ${sql}`, async () => {
      await page.locator('textarea.sql-input').fill(sql)
      await page.getByRole('button', { name: 'Run SQL' }).click()
      await expect(page.locator('[data-console-error]')).toBeVisible({ timeout: 120_000 })
      await expect(page.locator('[data-console-error]')).toContainText(/read-only|not authorized/i)
    })
  }

  await test.step('and the corpus is untouched by all of that', async () => {
    await page.locator('textarea.sql-input').fill('SELECT count(*) AS records FROM cve')
    await page.getByRole('button', { name: 'Run SQL' }).click()
    await expect(page.locator('table.console tbody tr')).toHaveCount(1, { timeout: 120_000 })
    const records = Number(
      (await page.locator('table.console tbody td').first().innerText()).replace(/[^\d]/g, '')
    )
    expect(records).toBeGreaterThan(1000)
  })

  await test.step('a refusal does not disarm the app’s own writes', async () => {
    // The authorizer is installed for the duration of one console query and
    // removed afterwards, on the connection that also applies deltas. If
    // removal failed, this is where it would show: sync would be refused by the
    // guard the console left behind.
    await openTab(page, 'Data')
    await page.getByRole('button', { name: 'Sync' }).click()
    await expect(page.locator('.progress')).toBeHidden({ timeout: 300_000 })
    await expect(page.locator('[data-error]')).toHaveCount(0)
    await openTab(page, 'SQL')
  })

  await test.step('the row cap is applied and reported', async () => {
    await page.locator('textarea.sql-input').fill('SELECT cve_id, year FROM cve')
    await page.getByRole('button', { name: 'Run SQL' }).click()
    await expect(page.locator('[data-console-rows]')).toContainText('capped', { timeout: 120_000 })
  })

  /**
   * D-052 §3 and its M3 consequence, in one step: a query that will not finish
   * on its own has to say it is running, leave the tab usable, and stop when
   * asked. The recursive CTE is the honest way to write one — it is read-only,
   * so the authorizer allows it, which is exactly why cancellation is the thing
   * that bounds it rather than a rule against it.
   */
  await test.step('a long query reports, stays responsive, and can be cancelled', async () => {
    await page
      .locator('textarea.sql-input')
      .fill(
        'WITH RECURSIVE forever(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM forever WHERE x < 100000000) SELECT count(*) FROM forever'
      )
    await page.getByRole('button', { name: 'Run SQL' }).click()

    // It says it is running, with elapsed time that advances — which is only
    // possible because the progress handler is posting from inside SQLite.
    const progress = page.locator('.progress')
    await expect(progress).toContainText(/running — [\d.]+ s/, { timeout: 30_000 })
    const first = await progress.innerText()
    await expect(async () => {
      expect(await progress.innerText()).not.toBe(first)
    }).toPass({ timeout: 30_000 })

    // The tab is not frozen: the main thread renders and accepts input while
    // the Worker is inside SQLite.
    await expect(page.getByRole('button', { name: 'Cancel query' })).toBeEnabled()
    expect(await page.evaluate(() => document.title)).toBeTruthy()

    await page.getByRole('button', { name: 'Cancel query' }).click()
    await expect(page.locator('[data-console-cancelled]')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('.progress')).toBeHidden()
  })

  await test.step('and the database still answers afterwards', async () => {
    await page.locator('textarea.sql-input').fill('SELECT count(*) AS records FROM cve')
    await page.getByRole('button', { name: 'Run SQL' }).click()
    await expect(page.locator('table.console tbody tr')).toHaveCount(1, { timeout: 120_000 })
    await expect(page.locator('[data-console-error]')).toHaveCount(0)
  })

  /**
   * A schema bump, rehearsed (M3). `?schema=N+1` is this build claiming to read
   * a version the local copy is not — which is precisely the position the next
   * build will be in on the day the schema changes, with every existing user's
   * copy at the old version.
   *
   * Version-relative, because the day arrived: schema 2 shipped in M5 (D-070),
   * and a hard-coded `?schema=2` quietly stopped being a mismatch. The *real*
   * bump — two data planes, one on each side — is exercised in `bump.spec.ts`;
   * this remains the cheap rehearsal that needs neither.
   */
  await test.step('a schema bump is announced, not silent', async () => {
    const ahead = SCHEMA_VERSION + 1
    await page.goto(`/?schema=${ahead}`)
    const announcement = page.locator('[data-obsolete]')
    await expect(announcement).toBeVisible({ timeout: 120_000 })
    await expect(announcement).toContainText(`schema ${SCHEMA_VERSION}`)
    await expect(announcement).toContainText(`schema ${ahead}`)
    await expect(announcement).toContainText('Download the corpus again')
    // Not offered as a query surface: a copy this build cannot read must not be
    // queried, so the tabs that need one are disabled rather than opening onto
    // an empty panel.
    await expect(page.getByRole('tab', { name: 'Explore' })).toBeDisabled()
    await expect(page.getByRole('tab', { name: 'SQL' })).toBeDisabled()
    await expect(page.getByRole('heading', { name: 'Explore' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Download data', exact: true })).toBeVisible()
  })

  await test.step('and the origin is refused too, naming the fix', async () => {
    // The data plane is still at the version this build's copy came from, so
    // downloading again cannot help —
    // and the app says the thing that can (reload for the matching build),
    // rather than sending the user round a loop.
    await page.getByRole('button', { name: 'Download data', exact: true }).click()
    await expect(page.locator('[data-error]')).toContainText(/reload the page/, {
      timeout: 120_000,
    })
    // And the announcement is still there: the two say different things and
    // both are true at once.
    await expect(page.locator('[data-obsolete]')).toBeVisible()
  })

  await test.step('the copy the bump refused is still there', async () => {
    // D-013 licenses *replacing* the local database, not deleting it out from
    // under someone who has been told to download again. Without the override
    // the same copy is live and queryable.
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Re-download data' })).toBeEnabled({
      timeout: 120_000,
    })
    await page.getByRole('button', { name: 'Run query' }).click()
    await expect(page.locator('.results tbody tr').first()).toBeVisible({ timeout: 120_000 })
  })

  expect(failures, `console/page errors:\n${failures.join('\n')}`).toEqual([])
})
