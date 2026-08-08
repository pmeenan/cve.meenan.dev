import { readFileSync } from 'node:fs'

import { expect, test, type Browser, type Page } from '@playwright/test'

import { requireLocalStorage } from './support'

import { RECORD_COLUMNS } from '../../lib/export'

/**
 * M4's exit criteria in a browser: the owner's motivating question answered
 * entirely through the UI, charted and exportable, with REJECTED excluded by
 * default — plus each of the surfaces that question drags in.
 *
 * One import, then everything else. An import is the expensive part and OPFS is
 * scoped to the browser context, so a test per criterion would mean a download
 * per criterion. The one place that deliberately pays for a second download is
 * the permalink step, because a permalink is only proved by a browser that has
 * never seen this one's storage.
 */

const FORMULA_LEAD = /^[=+\-@\t\r]/

async function openTab(page: Page, name: string): Promise<void> {
  // Enabled *first*. The tabs that need a corpus are disabled until the Worker
  // reports one, and clicking across that transition landed a click the
  // component had not wired up yet — reliably on Firefox, where the window is
  // wider, and invisibly on Chromium.
  //
  // Waiting for enabled is necessary but not sufficient, and the retry below is
  // not superstition: `ready` can go true, then briefly false again while the
  // Worker settles a fresh profile's copy, and a click delivered inside that
  // second window is dropped by a genuinely-disabled button. Observed on
  // Firefox in "a permalink reproduces its report on a fresh browser profile",
  // where the assertion saw `title="Download the corpus first"` return for five
  // polls *after* the click. Retrying the click is right rather than merely
  // convenient: a person who clicked and saw nothing happen would click again.
  const tab = page.getByRole('tab', { name, exact: true })
  await expect(tab).toBeEnabled({ timeout: 120_000 })
  await expect(async () => {
    await tab.click()
    await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 2_000 })
  }).toPass({ timeout: 120_000 })
}

async function importCorpus(page: Page): Promise<void> {
  await page.goto('/')
  await requireLocalStorage(page)
  await page.getByRole('button', { name: /Download data/ }).click()
  await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible({ timeout: 300_000 })
}

/** The answer counter currently on screen for a surface, or null if it is empty. */
async function answered(page: Page, selector: string): Promise<string | null> {
  const element = page.locator(selector).first()
  if ((await element.count()) === 0) return null
  return element.getAttribute('data-run')
}

/**
 * Run the report and wait for *this* run's answer.
 *
 * The same reasoning as M3's `runFilters`: a report that finishes in
 * milliseconds may never render a progress bar, so waiting on one reads the
 * previous result and a dimension that never applied looks correct.
 */
async function runReport(page: Page): Promise<void> {
  const before = await answered(page, '[data-report-matches]')
  await page.getByRole('button', { name: 'Run report' }).click()
  await expect
    .poll(
      async () => {
        const after = await answered(page, '[data-report-matches]')
        return after !== null && after !== before
      },
      { timeout: 120_000 }
    )
    .toBe(true)
}

/** The chart's own table, as [rowLabel, ...cells]. The audit channel, read as one. */
async function chartRows(page: Page): Promise<string[][]> {
  const rows = page.locator('table.chart-data tbody tr')
  const out: string[][] = []
  for (let at = 0; at < (await rows.count()); at += 1) {
    const cells = rows.nth(at).locator('th, td')
    const values: string[] = []
    for (let cell = 0; cell < (await cells.count()); cell += 1) {
      values.push((await cells.nth(cell).innerText()).trim())
    }
    out.push(values)
  }
  return out
}

async function seriesLabels(page: Page): Promise<string[]> {
  const headers = page.locator('table.chart-data thead th')
  const out: string[] = []
  // The first column header is the rows dimension, not a series.
  for (let at = 1; at < (await headers.count()); at += 1) {
    out.push((await headers.nth(at).innerText()).trim())
  }
  return out
}

async function setReport(
  page: Page,
  fields: { title?: string; rows?: string; series?: string; chart?: string }
): Promise<void> {
  if (fields.title !== undefined) await page.locator('#report-title').fill(fields.title)
  if (fields.rows) await page.locator('#report-rows').selectOption({ label: fields.rows })
  if (fields.series !== undefined) {
    await page
      .locator('#report-series')
      .selectOption(fields.series === '' ? { value: '' } : { label: fields.series })
  }
  if (fields.chart) await page.locator('#report-chart').selectOption({ label: fields.chart })
}

/** Trigger an export and read the file the browser actually wrote. */
async function exportFile(page: Page, button: string): Promise<{ name: string; text: string }> {
  const downloaded = page.waitForEvent('download', { timeout: 120_000 })
  await page.getByRole('button', { name: button }).click()
  const download = await downloaded
  const path = await download.path()
  return { name: download.suggestedFilename(), text: readFileSync(path, 'utf-8') }
}

/**
 * Split a CSV into records and fields, respecting the quoting.
 *
 * Hand-rolled rather than pulled in: the point of the assertion below is that
 * *our* quoting is correct, and a parser lenient enough to be convenient would
 * paper over exactly the defect being looked for.
 */
function parseCsv(text: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!
    if (quoted) {
      if (char === '"') {
        if (text[at + 1] === '"') {
          field += '"'
          at += 1
        } else quoted = false
      } else field += char
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      record.push(field)
      field = ''
    } else if (char === '\r' && text[at + 1] === '\n') {
      record.push(field)
      records.push(record)
      record = []
      field = ''
      at += 1
    } else {
      field += char
    }
  }
  if (field || record.length) {
    record.push(field)
    records.push(record)
  }
  return records
}

test('reports, charts, permalinks, saved reports, exports and the detail view', async ({
  page,
  browser,
}) => {
  test.setTimeout(1_200_000)
  await importCorpus(page)
  await openTab(page, 'Report')

  /**
   * The founding question, in the shape D-046 benchmark item #1 asks it: CVE
   * counts by severity over time, stacked. This is the report the whole
   * milestone is for.
   */
  await test.step('severity over time, stacked, with the unscored band shown', async () => {
    await setReport(page, {
      title: 'Severity over time',
      rows: 'Month',
      series: 'Severity',
      chart: 'Stacked bars',
    })
    await runReport(page)

    await expect(page.locator('figure.chart svg')).toBeVisible()
    await expect(page.locator('figure.chart rect.bar').first()).toBeVisible()

    const labels = await seriesLabels(page)
    // CRITICAL sits at the stack's baseline, so it is the first series — the
    // bottom band is the only one a reader can compare across buckets, and the
    // founding question is about CRITICAL (M4 shape decision).
    expect(labels[0]).toBe('CRITICAL')
    // About half the corpus has never been scored. That band is always shown,
    // never excluded by default, and it lands at the top where it cannot
    // distort the trend beneath it.
    expect(labels).toContain('(not scored)')
    expect(labels[labels.length - 2]).toBe('(not scored)')
    expect(labels[labels.length - 1]).toBe('Total')

    const rows = await chartRows(page)
    expect(rows.length).toBeGreaterThan(1)
    // Every row has a cell per series: an absent cell is a zero, not a gap.
    for (const row of rows) expect(row).toHaveLength(labels.length + 1)
  })

  await test.step('the chart and its table are the same numbers', async () => {
    // The table is both the accessibility channel and the audit one, so it has
    // to be reconcilable with what is drawn: each row's Total is the sum of its
    // own cells.
    for (const row of await chartRows(page)) {
      const cells = row.slice(1, -1).map((value) => Number(value.replace(/[^\d]/g, '')))
      const total = Number(row[row.length - 1]!.replace(/[^\d]/g, ''))
      expect(cells.reduce((sum, value) => sum + value, 0)).toBe(total)
    }
  })

  await test.step('the PUBLISHED-only default is shown, not implied (D-022)', async () => {
    // The one filter that changes every number on screen. It is a chip in the
    // same row as everything the user chose, and it is not removable.
    const chip = page.locator('[data-chip="state"]')
    await expect(chip).toContainText('PUBLISHED records only')
    await expect(chip.locator('button')).toHaveCount(0)
  })

  await test.step('changing rows cannot leave the same dimension selected as the split', async () => {
    await page.locator('#report-rows').selectOption({ label: 'Severity' })
    await expect(page.locator('#report-series')).toHaveValue('')
    await runReport(page)
    await expect(page.locator('[data-error]')).toHaveCount(0)

    // Restore the founding shape for the remaining checks.
    await setReport(page, { rows: 'Month', series: 'Severity' })
    await runReport(page)
  })

  /**
   * D-046 benchmark item #2, which is the milestone's own exit criterion:
   * counts by vendor, product and severity over the last two years. Each axis
   * is checked against the same corpus, so a cross-tab that double-counts a
   * record affecting eight products would show up as a total larger than the
   * match count.
   */
  await test.step('vendor and product by severity, over the last two years', async () => {
    const from = new Date()
    from.setUTCFullYear(from.getUTCFullYear() - 2)
    await page.locator('details.filter-disclosure summary').click()
    await page.locator('#report-pub-from').fill(from.toISOString().slice(0, 10))

    for (const dimension of ['Vendor', 'Product']) {
      await setReport(page, { title: `${dimension} by severity`, rows: dimension })
      await runReport(page)
      const rows = await chartRows(page)
      expect(rows.length, dimension).toBeGreaterThan(0)

      const matches = Number(
        await page.locator('[data-report-matches]').getAttribute('data-report-matches')
      )
      expect(matches, dimension).toBeGreaterThan(0)
      // A record affecting eight products is one record, not eight (D-069's
      // shared-join-chain rule). The top bucket therefore cannot exceed the
      // match count.
      const top = Number(rows[0]![rows[0]!.length - 1]!.replace(/[^\d]/g, ''))
      expect(top, dimension).toBeLessThanOrEqual(matches)
      // The date filter is still applied — the chip says so, which is what a
      // reader checks.
      await expect(page.locator('[data-chip="published"]')).toBeVisible()
    }
  })

  await test.step('a line chart and a table-only report render the same data', async () => {
    await setReport(page, { rows: 'Month', chart: 'Lines over time' })
    await runReport(page)
    await expect(page.locator('figure.chart polyline.series-line').first()).toBeVisible()
    const asLines = await chartRows(page)

    await setReport(page, { chart: 'Table only' })
    await runReport(page)
    await expect(page.locator('figure.chart')).toHaveCount(0)
    // The table is still there — it is not the chart's fallback, it is the
    // report's numbers.
    expect((await chartRows(page)).length).toBeGreaterThanOrEqual(asLines.length)
  })

  // --- Exports ----------------------------------------------------------

  await test.step('a CSV export carries the notice and is quoted throughout', async () => {
    await setReport(page, { title: 'Severity by month', rows: 'Month', chart: 'Stacked bars' })
    await runReport(page)
    const file = await exportFile(page, 'Export these numbers')
    expect(file.name).toBe('severity-by-month.csv')

    // D-008: an export is a copy of CVE data, and every copy carries MITRE's
    // notice. This is a functional requirement of the feature (D-047).
    expect(file.text).toContain('The MITRE Corporation')
    expect(file.text).toContain('irrevocable copyright license')
    expect(file.text).toContain('cve.org/legal/termsofuse')

    const records = parseCsv(
      file.text
        .split('\r\n')
        .filter((line) => !line.startsWith('# '))
        .join('\r\n')
    )
    expect(records.length).toBeGreaterThan(1)
    expect(records[0]).toEqual(['rows', 'series', 'cves'])
    // Rule 4 over real corpus text rather than over an invented payload: no
    // cell in a file built from this corpus may begin with something a
    // spreadsheet executes, and no cell may carry a control character that
    // would split the record. `tests/unit/export.test.ts` supplies the hostile
    // records; this checks that the guard is actually in the path.
    for (const record of records) {
      for (const cell of record) {
        expect(FORMULA_LEAD.test(cell), `unguarded cell: ${cell.slice(0, 40)}`).toBe(false)
        expect(
          /[\u0000-\u001F\u007F-\u009F]/.test(cell),
          `control char: ${cell.slice(0, 40)}`
        ).toBe(false)
      }
    }
  })

  await test.step('a JSON export parses, and carries the notice too', async () => {
    // Leave the previous Month result on screen while editing the builder to a
    // different, unrun definition. "Export these numbers" must stay attached
    // to the Worker-echoed report that produced the visible table.
    await page.locator('#report-rows').selectOption({ label: 'Year' })
    await page.locator('#export-format').selectOption('json')
    const file = await exportFile(page, 'Export these numbers')
    expect(file.name).toBe('severity-by-month.json')
    const parsed = JSON.parse(file.text) as {
      notice: string
      rows: { rows: string; series: string; cves: number }[]
      sql: string
      revision: number | null
    }
    expect(parsed.notice).toContain('The MITRE Corporation')
    expect(parsed.rows.length).toBeGreaterThan(0)
    // The backing query travels with the numbers: a figure in a file can be
    // traced to the statement that produced it, the same property the chat
    // layer will have to carry (D-044).
    expect(parsed.sql).toContain('SELECT')
    expect(parsed.sql).toContain("strftime('%Y-%m'")
  })

  await test.step('a record export is the whole match set, not the page', async () => {
    await openTab(page, 'Explore')
    // A filter that is certain to match in any generation of the corpus and
    // certain to be narrower than the on-screen cap of 100 — which is the
    // difference this step exists to demonstrate.
    //
    // Scoped to the panel, not the page: `getByRole` skips the four hidden
    // panels because they are out of the accessibility tree, but `getByLabel`
    // is a DOM query and matches Explore's and Report's copies of the shared
    // filter form alike.
    await page.locator('#panel-explore').getByLabel('CRITICAL').check()
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    await expect(page.locator('[data-matches]')).toBeVisible({ timeout: 120_000 })
    const matches = Number(await page.locator('[data-matches]').getAttribute('data-matches'))
    expect(matches).toBeGreaterThan(100)

    const file = await exportFile(page, 'Export records')
    const records = parseCsv(
      file.text
        .split('\r\n')
        .filter((line) => !line.startsWith('# '))
        .join('\r\n')
    )
    // Named from the module the writer names them from, so a schema addition
    // cannot leave the file's header and its rows describing different columns.
    expect(records[0]).toEqual([...RECORD_COLUMNS])
    // The six D-070 columns are in the *copy* even though they are not on
    // screen — an export that dropped `rejection_reason` would hand back every
    // REJECTED record with no text in it at all (D-071).
    expect(records[0]).toContain('rejection_reason')
    expect(records[0]).toContain('ssvc_exploitation')
    // The list on screen is capped at 100; the export is not. This is the
    // difference the feature exists for.
    expect(records.length - 1).toBe(matches)
    expect(file.text).toContain('The MITRE Corporation')
  })

  // --- The per-CVE detail view -------------------------------------------

  await test.step('a record opens in full, with its references held to an allowlist', async () => {
    await page.getByRole('button', { name: 'Reset filters' }).click()
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    await expect(page.locator('[data-matches]')).toBeVisible({ timeout: 120_000 })

    const first = page.locator('table.records tbody tr').first().locator('button.link')
    const cve = (await first.innerText()).trim()
    await first.click()

    const detail = page.locator('[data-detail]')
    await expect(detail).toBeVisible({ timeout: 120_000 })
    await expect(detail.locator('[data-detail-loaded]')).toBeVisible({ timeout: 120_000 })
    await expect(detail.getByRole('heading', { name: cve })).toBeVisible()
    // Focus moves to the panel that just opened, or a keyboard user has no way
    // to know anything happened.
    await expect(page.locator('#detail-heading')).toBeFocused()

    // Every rendered reference link is http(s), carries no referrer, and opens
    // in a new tab without a handle back to this one (rule 4, D-011).
    const links = detail.locator('ul.refs a')
    for (let at = 0; at < (await links.count()); at += 1) {
      const link = links.nth(at)
      expect(await link.getAttribute('href')).toMatch(/^https?:\/\//)
      expect(await link.getAttribute('rel')).toContain('noreferrer')
      expect(await link.getAttribute('rel')).toContain('noopener')
      expect(await link.getAttribute('referrerpolicy')).toBe('no-referrer')
    }

    await detail.getByRole('button', { name: 'Close record' }).click()
    await expect(page.locator('[data-detail]')).toHaveCount(0)
  })

  await test.step('an identifier no record carries is answered, not failed', async () => {
    // "No record has that id" is an answer. Reporting it as an error sends the
    // reader looking for a broken app instead of a typo.
    await page.locator('#explore-cve').fill('CVE-1999-0001')
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    await expect(page.locator('[data-matches]')).toBeVisible({ timeout: 120_000 })
    await expect(page.locator('[data-error]')).toHaveCount(0)
  })

  // --- Saved reports, history, and permalinks -----------------------------

  await test.step('a saved report and the history survive a reload', async () => {
    await openTab(page, 'Report')
    await setReport(page, { title: 'CWE spread', rows: 'CWE', series: 'Severity' })
    await runReport(page)
    await page.locator('#report-save-name').fill('CWE spread')
    await page.getByRole('button', { name: 'Save report' }).click()

    await page.reload()
    await openTab(page, 'Saved')
    // Not in the SQLite copy, which a re-download or a schema bump destroys
    // (D-013, D-068) — that is the whole reason these live in localStorage.
    await expect(page.locator('[data-saved]')).toBeVisible({ timeout: 120_000 })
    await expect(page.getByRole('button', { name: 'Open saved report: CWE spread' })).toBeVisible()
    await expect(page.locator('[data-recent]')).toBeVisible()
  })

  await test.step('opening a saved report runs it', async () => {
    await page.getByRole('button', { name: 'Open saved report: CWE spread' }).click()
    await expect(page.getByRole('tab', { name: 'Report' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('[data-report-matches]')).toBeVisible({ timeout: 120_000 })
    await expect(page.locator('[data-report-title]')).toContainText('CWE spread')
  })

  await test.step('deleting a saved report removes it, and it stays gone', async () => {
    await openTab(page, 'Saved')
    await page.getByRole('button', { name: 'Delete saved report: CWE spread' }).click()
    await expect(page.getByRole('button', { name: 'Open saved report: CWE spread' })).toHaveCount(0)
    await page.reload()
    await openTab(page, 'Saved')
    await expect(page.getByRole('button', { name: 'Open saved report: CWE spread' })).toHaveCount(0)
  })

  /**
   * The permalink, on a browser that has never seen this one's storage.
   *
   * This is the only test that proves a link carries the *report* rather than a
   * pointer into this browser's state — a fresh context has its own OPFS and
   * its own `localStorage`, so nothing but the URL crosses.
   */
  await test.step('a permalink reproduces its report on a fresh browser profile', async () => {
    await openTab(page, 'Report')
    await setReport(page, {
      title: 'Shared: CNA by severity',
      rows: 'CNA',
      series: 'Severity',
      chart: 'Grouped bars',
    })
    await runReport(page)
    await page.getByRole('button', { name: 'Copy link' }).click()
    const link = await page.locator('input.permalink').inputValue()

    // The predicates are in the fragment and nowhere else: a query string
    // reaches nginx's request line and its access log, which is the one thing
    // the data-plane design exists to prevent (D-014, D-032, D-069).
    expect(link).toContain('#')
    expect(new URL(link).search).toBe('')
    expect(new URL(link).hash.length).toBeGreaterThan(1)

    const expected = await chartRows(page)
    await inFreshProfile(browser, link, async (fresh) => {
      // A fresh profile has no corpus, so the link cannot run yet — and the
      // page says so rather than appearing to ignore it.
      await expect(fresh.locator('[data-link-pending]')).toBeVisible({ timeout: 120_000 })
      await expect(fresh.locator('[data-link-error]')).toHaveCount(0)

      await fresh.getByRole('button', { name: /Download data/ }).click()

      // And then it runs itself, and takes the reader to it — which is what
      // they asked for by following the link. Waiting on the Import panel would
      // be waiting on something the app correctly hides at that moment.
      await expect(fresh.locator('[data-report-matches]')).toBeVisible({ timeout: 300_000 })
      await expect(fresh.getByRole('tab', { name: 'Report' })).toHaveAttribute(
        'aria-selected',
        'true'
      )
      await expect(fresh.locator('[data-revision]')).toBeVisible()
      await expect(fresh.locator('#report-title')).toHaveValue('Shared: CNA by severity')
      await expect(fresh.locator('#report-rows')).toHaveValue('cna')
      await expect(fresh.locator('[data-link-pending]')).toHaveCount(0)
      // The same numbers, from a browser that shares nothing with this one but
      // the URL.
      expect(await chartRows(fresh)).toEqual(expected)
    })
  })

  await test.step('a hostile fragment is refused by name, not rendered', async () => {
    // A fragment is a stranger's input and goes through the same validation as
    // everything else (D-069).
    for (const [fragment, expected] of [
      ['#not-base64!!', /could not be opened/],
      [
        `#${btoa(JSON.stringify({ v: 1, rows: 'sqlite_master', chart: 'table' })).replace(/=+$/, '')}`,
        /dimension/,
      ],
      [
        `#${btoa(JSON.stringify({ v: 99, rows: 'year', chart: 'table' })).replace(/=+$/, '')}`,
        /newer version/,
      ],
    ] as const) {
      // Through `about:blank` first: `goto` to a URL that differs only in its
      // fragment is a same-document navigation, so the page would never
      // remount and the assertion would read the previous fragment's answer.
      await page.goto('about:blank')
      await page.goto(`/${fragment}`)
      await expect(page.locator('[data-link-error]')).toContainText(expected, { timeout: 120_000 })
    }
  })
})

/** Run a step in a browser context that shares nothing with this test's. */
async function inFreshProfile(
  browser: Browser,
  url: string,
  body: (page: Page) => Promise<void>
): Promise<void> {
  const context = await browser.newContext()
  try {
    const fresh = await context.newPage()
    await fresh.goto(url)
    await body(fresh)
  } finally {
    await context.close()
  }
}
