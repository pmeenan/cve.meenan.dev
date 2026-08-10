import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

import { requireLocalStorage } from './support'
import {
  closePanel,
  downloadButton,
  importCorpus,
  openChat,
  openPanel,
  panelToggle,
  type PanelName,
} from './ui'

/**
 * Accessibility as an acceptance criterion, not a polish pass (M4, re-based on
 * the single-pane workspace).
 *
 * Two halves, because one of them cannot check the other.
 *
 * **axe-core, per view.** Labels, roles, contrast and the structural rules a
 * rule engine is good at. Run with each panel open rather than once on the
 * page, because a collapsed panel is *removed from the DOM* in the new UI — a
 * single pass would report the app as clean while having looked at none of the
 * panels.
 *
 * **Hand-written checks.** Nothing axe checks says whether a panel toggle
 * announces its state, whether a legend entry conveys "hidden" by something
 * other than colour, or whether the chart's numbers are reachable at all.
 * Those are the things that actually decide whether this app can be used
 * without a mouse, and they are asserted here directly.
 *
 * The chart is the case worth being explicit about. An SVG of sixty `<rect>`s
 * is not made accessible by labelling it; what makes it accessible is that the
 * same numbers are in a real table with real headers, always rendered. That is
 * asserted below by reading the table, not by trusting the label.
 */

/** Rules whose violations would be real defects here. Not a subset for convenience. */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']

const PANELS: PanelName[] = ['filters', 'sql', 'data', 'saved']

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

test('every view passes an automated accessibility scan, and works from the keyboard', async ({
  page,
}) => {
  test.setTimeout(600_000)

  await test.step('the landing view, before any corpus exists', async () => {
    // The state every visitor meets first, and the one most easily forgotten:
    // one CTA and the diagnostics disclosure, no workspace at all.
    await page.goto('/')
    await requireLocalStorage(page)
    await expect(downloadButton(page)).toBeVisible({ timeout: 120_000 })
    await scan(page, 'landing')
  })

  await importCorpus(page, 300_000)
  // The canvas auto-runs the default report the first time a copy is ready
  // (year × severity, stacked), so the workspace scans below see a real chart
  // without running anything. `data-run` is never assumed zero anywhere here.
  await expect(page.locator('[data-report-matches]')).toBeVisible({ timeout: 120_000 })

  // --- The half no rule engine checks, part one: the panel contract --------

  await test.step('panel toggles announce state, reference their panel, and unmount it', async () => {
    for (const panel of PANELS) {
      const toggle = panelToggle(page, panel)
      await closePanel(page, panel) // the Data panel auto-opens after an import
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      const controls = await toggle.getAttribute('aria-controls')
      expect(controls, panel).toBeTruthy()
      // Collapsed means *absent*: the panel is removed from the DOM, not
      // hidden, so it cannot trap focus or leak into the accessibility tree.
      await expect(page.locator(`#${controls}`)).toHaveCount(0)

      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      // aria-controls references an element that exists while open.
      await expect(page.locator(`#${controls}`)).toBeVisible()

      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(page.locator(`#${controls}`)).toHaveCount(0)
    }
  })

  // --- axe, one workspace state at a time ----------------------------------

  await test.step('the Data panel, with an import report and a demo result on it', async () => {
    await openPanel(page, 'data')
    await page.getByRole('button', { name: 'Run query' }).click()
    await expect(page.getByRole('heading', { name: 'Most-reported vendors' })).toBeVisible({
      timeout: 120_000,
    })
    await scan(page, 'Data panel')
    await closePanel(page, 'data')
  })

  await test.step('the Filters panel, with every control labelled', async () => {
    await openPanel(page, 'filters')
    // The labelling contract, checked structurally rather than by sampling: a
    // control with no associated <label> is one a screen reader announces as
    // nothing but its role.
    const unlabelled = await page.locator('#filters-panel').evaluate((panel) => {
      const bad: string[] = []
      for (const control of panel.querySelectorAll<HTMLInputElement>('input, select, textarea')) {
        if (!control.labels || control.labels.length === 0) {
          bad.push(control.id || control.outerHTML.slice(0, 60))
        }
      }
      return bad
    })
    expect(unlabelled).toEqual([])
    await scan(page, 'Filters panel')
  })

  await test.step('the canvas, with the chart and its numbers on it', async () => {
    await expect(page.locator('figure.chart svg')).toBeVisible({ timeout: 120_000 })
    await scan(page, 'canvas (chart)')
  })

  await test.step('the chart’s numbers are reachable, which is what makes it accessible', async () => {
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

  await test.step('a legend entry toggles its series, and says so beyond colour', async () => {
    const entry = page.locator('ul.legend li').first()
    const toggle = entry.locator('button.legend-toggle')
    // The accessible name carries the series and the action, not just "toggle".
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(toggle).toHaveAttribute('aria-label', /^Hide series: /)

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(toggle).toHaveAttribute('aria-label', /^Show series: /)
    // The hidden state is conveyed structurally, not by a faded swatch alone.
    await expect(entry).toHaveAttribute('data-series-hidden', '1')

    // Restore: the table below always renders the complete model either way.
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(entry).not.toHaveAttribute('data-series-hidden', '1')
  })

  await test.step('the records view, with a record open and focus moved to it', async () => {
    await openPanel(page, 'filters')
    await page.locator('[data-list-records]').click()
    await expect(page.locator('[data-matches]')).toBeVisible({ timeout: 120_000 })
    await scan(page, 'records')

    await page.locator('table.records tbody tr').first().locator('button.link').click()
    await expect(page.locator('[data-detail]')).toBeVisible({ timeout: 120_000 })
    await expect(page.locator('[data-detail-loaded]')).toBeVisible({ timeout: 120_000 })
    // Focus moves to the panel that just opened, or a keyboard user has no way
    // to know anything happened.
    await expect(page.locator('#detail-heading')).toBeFocused()
    // The detail view is where the corpus's own text and URLs are rendered, so
    // it is the surface most likely to fail a contrast or link-name rule.
    await scan(page, 'record detail')
    await page.getByRole('button', { name: 'Close record' }).click()
    await expect(page.locator('[data-detail]')).toHaveCount(0)
  })

  await test.step('the SQL panel', async () => {
    await openPanel(page, 'sql')
    await scan(page, 'SQL panel')
    await closePanel(page, 'sql')
  })

  await test.step('the Saved panel', async () => {
    await openPanel(page, 'saved')
    await scan(page, 'Saved panel')
    await closePanel(page, 'saved')
  })

  await test.step('the chat column', async () => {
    await openChat(page)
    await scan(page, 'chat')
  })

  await test.step('a filter chip can be removed from the keyboard, and says which one', async () => {
    await openPanel(page, 'filters')
    await page.locator('#report-vendor').fill('cisco')
    const chip = page.locator('[data-chip="vendor"]')
    await expect(chip).toBeVisible()
    // The accessible name carries the filter, not just the word "Remove".
    const clear = chip.getByRole('button')
    await expect(clear).toHaveAttribute('aria-label', /Remove filter: Vendor: cisco/)
    await clear.focus()
    await page.keyboard.press('Enter')
    // Removing a chip re-runs the report immediately in the new UI; the chip
    // disappearing is the part this check owns.
    await expect(page.locator('[data-chip="vendor"]')).toHaveCount(0)
  })
})
