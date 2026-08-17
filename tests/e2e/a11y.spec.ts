import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

import { requireLocalStorage } from './support'
import {
  agentCall,
  closePanel,
  downloadButton,
  importCorpus,
  openChat,
  openPanel,
  panelToggle,
  pick,
  setChartType,
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
 * page, because a collapsed panel is *removed from the DOM* in the new UI (or,
 * for the footer's Data & diagnostics disclosure, hidden inside a closed
 * `<details>`) — a single pass would report the app as clean while having
 * looked at none of the panels. The same goes for the popovers: the date
 * calendar and the vendor picker's listbox exist only while open.
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

const PANELS: PanelName[] = ['sql', 'data', 'saved']

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
  // (week × severity, stacked), so the workspace scans below see a real chart
  // without running anything. `data-run` is never assumed zero anywhere here.
  await expect(page.locator('[data-report-matches]')).toBeVisible({ timeout: 120_000 })

  // --- The half no rule engine checks, part one: the panel contract --------

  await test.step('panel toggles announce state, reference their panel, and unmount it', async () => {
    for (const panel of PANELS) {
      const toggle = panelToggle(page, panel)
      await closePanel(page, panel) // the Data disclosure auto-opens after an import
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      const controls = await toggle.getAttribute('aria-controls')
      expect(controls, panel).toBeTruthy()
      // Collapsed means *absent*: a header panel is removed from the DOM, not
      // hidden, so it cannot trap focus or leak into the accessibility tree.
      // The footer's Data & diagnostics is a native `<details>` — its section
      // stays in the DOM but a closed details renders nothing, which the
      // accessibility tree honours the same way.
      if (panel === 'data') await expect(page.locator(`#${controls}`)).toBeHidden()
      else await expect(page.locator(`#${controls}`)).toHaveCount(0)

      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      // aria-controls references an element that exists while open.
      await expect(page.locator(`#${controls}`)).toBeVisible()

      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      if (panel === 'data') await expect(page.locator(`#${controls}`)).toBeHidden()
      else await expect(page.locator(`#${controls}`)).toHaveCount(0)
    }
  })

  // --- axe, one workspace state at a time ----------------------------------

  await test.step('the footer disclosure, with an import report and a demo result on it', async () => {
    // The Data & diagnostics disclosure in the page footer (UI polish,
    // 2026-08-16): revision, freshness and KEV lines, the import timings, the
    // demo query's result table and the diagnostics — scanned open, because
    // closed it is a `<summary>` and nothing else.
    await openPanel(page, 'data')
    await page.getByRole('button', { name: 'Run query' }).click()
    await expect(page.getByRole('heading', { name: 'Most-reported vendors' })).toBeVisible({
      timeout: 120_000,
    })
    await scan(page, 'footer disclosure (Data & diagnostics)')
    await closePanel(page, 'data')
  })

  await test.step('the canvas, with the chart and its numbers on it', async () => {
    await expect(page.locator('figure.chart svg')).toBeVisible({ timeout: 120_000 })
    // The strip's controls are the filter form now: every one of them has to
    // be labelled, checked structurally rather than by sampling — a control
    // with no associated <label> is one a screen reader announces as nothing
    // but its role.
    const unlabelled = await page.locator('[data-canvas-range]').evaluate((strip) => {
      const bad: string[] = []
      for (const control of strip.querySelectorAll<HTMLInputElement>('input, select, textarea')) {
        if (!control.labels || control.labels.length === 0) {
          bad.push(control.id || control.outerHTML.slice(0, 60))
        }
      }
      return bad
    })
    expect(unlabelled).toEqual([])
    await scan(page, 'canvas (chart)')
  })

  await test.step('the vendor picker, with its listbox open', async () => {
    // A combobox over a listbox that exists only while open — the roles,
    // `aria-activedescendant` and the options' names are what a keyboard user
    // navigates by, and none of it is on the page when the list is closed.
    const box = page.locator('[data-picker="vendor"] input')
    await box.click()
    const list = page.locator('[data-picker="vendor"] [role="listbox"]')
    await expect(list).toBeVisible()
    await expect(box).toHaveAttribute('aria-expanded', 'true')
    await scan(page, 'vendor picker (listbox open)')
    await page.keyboard.press('Escape')
    await expect(list).toHaveCount(0)
  })

  await test.step('the date calendar, which is a dialog of tables and buttons', async () => {
    // Scanned open, because closed it is not in the DOM at all — and it is the
    // densest control in the app: a dialog holding two month grids, two
    // selects and forty-odd day buttons whose only names are their labels.
    await page.locator('[data-date-open="canvas-published"]').click()
    await expect(page.locator('[data-date-pop]')).toBeVisible()
    await scan(page, 'date range calendar')
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-date-pop]')).toHaveCount(0)
  })

  await test.step('the chart’s numbers are reachable, which is what makes it accessible', async () => {
    // The SVG says what it is and points at the table.
    const svg = page.locator('figure.chart svg')
    await expect(svg).toHaveAttribute('role', 'img')
    await expect(svg.locator('title').first()).toContainText('table below this chart')

    // Under a chart the table is visually hidden but in the DOM (M9) — still
    // the screen-reader channel, and a real table: a header per column, a
    // header per row.
    const table = page.locator('table.chart-data')
    await expect(table).toBeAttached()
    await expect(table.locator('thead th[scope="col"]').first()).toBeAttached()
    await expect(table.locator('tbody th[scope="row"]').first()).toBeAttached()
    expect(await table.locator('tbody tr').count()).toBeGreaterThan(0)

    // The Table view is where the numbers are *shown* — the same table, now a
    // visible, sortable spreadsheet.
    await setChartType(page, 'Table')
    await expect(table).toBeVisible()
    await expect(table.locator('thead th[scope="col"]').first()).toBeVisible()
    await scan(page, 'canvas (table view)')
    await setChartType(page, 'Stacked bars')
    await expect(svg).toBeVisible()
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
    // A record list is asked for through the agent surface (D-086) — the same
    // call chat would make, landing on the same canvas — since there is no
    // "List records" button any more.
    await agentCall(page, 'search_records', {})
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
    // Chips render on the records view (the report canvas shows the vendor in
    // its own picker instead — next step). A vendor filter through the agent
    // surface puts one on screen.
    await agentCall(page, 'search_records', { vendor: ['cisco'] })
    await expect(page.locator('[data-matches]')).toBeVisible({ timeout: 120_000 })
    const chip = page.locator('[data-chip="vendor"]')
    await expect(chip).toBeVisible()
    // The accessible name carries the filter, not just the word "Remove".
    const clear = chip.getByRole('button')
    await expect(clear).toHaveAttribute('aria-label', /Remove filter: Vendor: cisco/)
    await clear.focus()
    await page.keyboard.press('Enter')
    // Removing a chip re-runs the query immediately; the chip disappearing is
    // the part this check owns.
    await expect(page.locator('[data-chip="vendor"]')).toHaveCount(0)
  })

  await test.step('the vendor picker shows the selection, and clears from the keyboard', async () => {
    // Back on the report canvas, the vendor is the strip's own control (UI
    // polish, 2026-08-16): the box carries the name and a clear button
    // beside it whose accessible name says which filter it clears — five
    // buttons all called "clear" would be a keyboard user hearing the same
    // word five times.
    await agentCall(page, 'aggregate', { rows: 'severity' })
    await expect(page.locator('[data-report-matches]')).toBeVisible({ timeout: 120_000 })
    await pick(page, 'vendor', 'cisco')
    const box = page.locator('[data-picker="vendor"] input')
    await expect(box).toHaveAttribute('data-picker-value', '1')
    await expect(box).toHaveValue(/cisco/i)
    const clear = page.locator('[data-picker-clear="vendor"]')
    await expect(clear).toBeVisible()
    await expect(clear).toHaveAttribute('aria-label', /^Vendor: any/)
    await scan(page, 'canvas (vendor selected)')
    await clear.focus()
    // Enter, not a click: a keyboard activates a button through `click`
    // (Enter and Space), never through a pointer event, so a button wired to
    // `pointerdown` alone is a button a keyboard user cannot press.
    await page.keyboard.press('Enter')
    // Clearing re-runs the report for every vendor; the box reading "All"
    // again — no value, no clear button — is the part this check owns.
    await expect(
      page.locator('[data-picker-clear="vendor"]'),
      'the picker clear button did not activate from the keyboard'
    ).toHaveCount(0)
    await expect(box).not.toHaveAttribute('data-picker-value', '1')
  })
})
