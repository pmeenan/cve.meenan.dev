import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

import { requireLocalStorage } from './support'

/**
 * Accessibility as an acceptance criterion, not a polish pass (M4).
 *
 * Two halves, because one of them cannot check the other.
 *
 * **axe-core, on every tab.** Labels, roles, contrast and the structural rules
 * a rule engine is good at. Run per tab rather than once on the page, because
 * four of the five panels are `hidden` at any moment and a hidden panel is not
 * in the accessibility tree — a single pass would report the app as clean while
 * having looked at one fifth of it.
 *
 * **Hand-written keyboard tests.** Nothing axe checks says whether arrow keys
 * move between tabs, whether Tab escapes the tablist in one stop, or whether the
 * chart's numbers are reachable at all. Those are the things that actually
 * decide whether this app can be used without a mouse, and they are asserted
 * here by pressing keys.
 *
 * The chart is the case worth being explicit about. An SVG of sixty `<rect>`s
 * is not made accessible by labelling it; what makes it accessible is that the
 * same numbers are in a real table with real headers, always rendered. That is
 * asserted below by reading the table, not by trusting the label.
 */

/** Rules whose violations would be real defects here. Not a subset for convenience. */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']

async function openTab(page: Page, name: string): Promise<void> {
  await page.getByRole('tab', { name, exact: true }).click()
  await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  )
}

async function scan(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze()
  const summary = results.violations
    .map(
      (violation) =>
        `${violation.id} (${violation.impact}): ${violation.help}\n` +
        violation.nodes.map((node) => `    ${node.target.join(' ')}`).join('\n')
    )
    .join('\n')
  expect(results.violations, `${label}:\n${summary}`).toEqual([])
}

async function importCorpus(page: Page): Promise<void> {
  await page.goto('/')
  await requireLocalStorage(page)
  await page.getByRole('button', { name: /Download data/ }).click()
  await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible({ timeout: 300_000 })
}

test('every tab passes an automated accessibility scan, and works from the keyboard', async ({
  page,
}) => {
  test.setTimeout(600_000)

  await test.step('the first-visit page, before any corpus exists', async () => {
    // The state every visitor meets first, and the one most easily forgotten:
    // three of the five tabs are disabled here.
    await page.goto('/')
    await expect(page.getByRole('tablist')).toBeVisible({ timeout: 120_000 })
    await scan(page, 'first visit')
  })

  await importCorpus(page)

  await test.step('the Data tab, with an import report and a benchmark on it', async () => {
    await page.getByRole('button', { name: 'Run query' }).click()
    await expect(page.getByRole('heading', { name: 'Most-reported vendors' })).toBeVisible({
      timeout: 120_000,
    })
    await scan(page, 'Data')
  })

  await test.step('the Explore tab, with results and a record open', async () => {
    await openTab(page, 'Explore')
    await scan(page, 'Explore (form only)')
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    await expect(page.locator('[data-matches]')).toBeVisible({ timeout: 120_000 })
    await scan(page, 'Explore (results)')

    await page.locator('table.records tbody tr').first().locator('button.link').click()
    await expect(page.locator('[data-detail]')).toBeVisible({ timeout: 120_000 })
    await expect(page.locator('[data-detail-loaded]')).toBeVisible({ timeout: 120_000 })
    // The detail view is where the corpus's own text and URLs are rendered, so
    // it is the panel most likely to fail a contrast or link-name rule.
    await scan(page, 'Explore (record detail)')
    await page.getByRole('button', { name: 'Close record' }).click()
  })

  await test.step('the Report tab, with a chart on it', async () => {
    await openTab(page, 'Report')
    await scan(page, 'Report (builder)')
    await page.getByRole('button', { name: 'Run report' }).click()
    await expect(page.locator('[data-report-matches]')).toBeVisible({ timeout: 120_000 })
    await expect(page.locator('figure.chart svg')).toBeVisible()
    await scan(page, 'Report (chart)')
  })

  await test.step('the Saved tab', async () => {
    await openTab(page, 'Saved')
    await scan(page, 'Saved')
  })

  await test.step('the SQL tab', async () => {
    await openTab(page, 'SQL')
    await scan(page, 'SQL')
  })

  // --- The half no rule engine checks ------------------------------------

  await test.step('arrow keys move between tabs, and Home/End reach the ends', async () => {
    await openTab(page, 'Data')
    await page.getByRole('tab', { name: 'Data' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('tab', { name: 'Explore' })).toBeFocused()
    await expect(page.getByRole('tab', { name: 'Explore' })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    await page.keyboard.press('ArrowLeft')
    await expect(page.getByRole('tab', { name: 'Data' })).toBeFocused()

    // Wrapping, which is what the authoring practices ask for and what makes a
    // tablist navigable without counting.
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByRole('tab', { name: 'SQL' })).toBeFocused()

    await page.keyboard.press('Home')
    await expect(page.getByRole('tab', { name: 'Data' })).toBeFocused()
    await page.keyboard.press('End')
    await expect(page.getByRole('tab', { name: 'SQL' })).toBeFocused()
  })

  await test.step('the tablist is one tab stop, not five', async () => {
    // Roving tabindex: Tab moves past the whole list. Without it a keyboard
    // user pays five keystrokes to reach the page every time.
    const selected = page.locator('[role="tab"][aria-selected="true"]')
    await expect(selected).toHaveAttribute('tabindex', '0')
    const others = page.locator('[role="tab"][aria-selected="false"]')
    for (let at = 0; at < (await others.count()); at += 1) {
      await expect(others.nth(at)).toHaveAttribute('tabindex', '-1')
    }
  })

  await test.step('a panel is labelled by its tab, and hidden panels are out of the tree', async () => {
    await openTab(page, 'Report')
    const panel = page.locator('[data-panel="report"]')
    await expect(panel).toHaveAttribute('aria-labelledby', 'tab-report')
    await expect(panel).toHaveAttribute('role', 'tabpanel')
    // Hidden rather than unmounted: a half-built report survives a trip to
    // another tab, and `hidden` keeps it out of the accessibility tree and out
    // of the tab order while it waits.
    await expect(page.locator('[data-panel="explore"]')).toBeHidden()
  })

  await test.step('the chart’s numbers are reachable, which is what makes it accessible', async () => {
    await openTab(page, 'Report')
    await page.getByRole('button', { name: 'Run report' }).click()
    await expect(page.locator('[data-report-matches]')).toBeVisible({ timeout: 120_000 })

    // The SVG says what it is and points at the table.
    const svg = page.locator('figure.chart svg')
    await expect(svg).toHaveAttribute('role', 'img')
    await expect(svg.locator('title').first()).toContainText('table below this chart')

    // And the table is a real table: a header per column, a header per row.
    const table = page.locator('table.chart-data')
    await expect(table).toBeVisible()
    await expect(table.locator('thead th[scope="col"]').first()).toBeVisible()
    await expect(table.locator('tbody th[scope="row"]').first()).toBeVisible()
    expect(await table.locator('tbody tr').count()).toBeGreaterThan(0)
  })

  await test.step('a filter chip can be removed from the keyboard, and says which one', async () => {
    await openTab(page, 'Report')
    await page.locator('details.filter-disclosure summary').click()
    await page.locator('#report-vendor').fill('cisco')
    const chip = page.locator('[data-chip="vendor"]')
    await expect(chip).toBeVisible()
    // The accessible name carries the filter, not just the word "Remove".
    const clear = chip.getByRole('button')
    await expect(clear).toHaveAttribute('aria-label', /Remove filter: Vendor: cisco/)
    await clear.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-chip="vendor"]')).toHaveCount(0)
  })
})
