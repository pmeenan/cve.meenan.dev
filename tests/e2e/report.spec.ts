import { readFileSync } from 'node:fs'

import { expect, test, type Browser, type Page } from '@playwright/test'

import { requireLocalStorage } from './support'
import {
  agentCall,
  awaitIdle,
  downloadButton,
  importCorpus,
  openPanel,
  openShare,
  setChartType,
} from './ui'

import { KEV_COLUMNS, RECORD_COLUMNS } from '../../lib/export'
import { defaultReport } from '../../lib/report'

/**
 * M4's exit criteria in a browser: the owner's motivating question answered
 * entirely through the UI, charted and exportable, with REJECTED excluded by
 * default — plus each of the surfaces that question drags in. Migrated to the
 * single-pane workspace, and then to the workspace without a filter drawer
 * (UI polish, 2026-08-16): a report's axes and predicates are set the way an
 * agent sets them — `agentCall(page, 'aggregate', {...})`, the same tool the
 * chat layer runs, whose result lands on the canvas exactly as a chat call's
 * would (D-086) — while the canvas keeps its own direct controls: the title,
 * the chart type, the published window, the time grain, the pickers, Reset,
 * and the share row.
 *
 * One import, then everything else. An import is the expensive part and OPFS is
 * scoped to the browser context, so a test per criterion would mean a download
 * per criterion. The one place that deliberately pays for a second download is
 * the permalink step, because a permalink is only proved by a browser that has
 * never seen this one's storage.
 */

const FORMULA_LEAD = /^[=+\-@\t\r]/

/** The chart's container, which carries the run counter and the match count. */
const REPORT = '[data-report-matches]'
/** The record list's summary line. */
const RECORDS = '[data-matches]'

/** The answer counter currently on screen for a surface, or null if it is empty. */
async function answered(page: Page, selector: string): Promise<string | null> {
  const element = page.locator(selector).first()
  if ((await element.count()) === 0) return null
  return element.getAttribute('data-run')
}

/**
 * Do something that runs a query, and wait for *this* run's answer.
 *
 * The same reasoning as M3's `runFilters`: a report that finishes in
 * milliseconds may never render a progress bar, so waiting on one reads the
 * previous result and a dimension that never applied looks correct. `data-run`
 * is captured and waited on rather than assumed zero, because the canvas
 * auto-runs a report of its own the first time a copy is ready — and an
 * `agentCall` resolves a render tick before the canvas shows its answer.
 */
async function ran<T>(page: Page, selector: string, action: () => Promise<T>): Promise<T> {
  const before = await answered(page, selector)
  const out = await action()
  await expect
    .poll(
      async () => {
        const after = await answered(page, selector)
        return after !== null && after !== before
      },
      { timeout: 120_000 }
    )
    .toBe(true)
  return out
}

/**
 * Wait out everything a reload of a local copy sets off before touching it.
 *
 * The header renders once the Worker has reopened the copy; the canvas then
 * auto-runs the most recent report; and a copy more than twelve hours behind
 * — the dev fixture always is — then **syncs itself once** (UI polish,
 * 2026-08-16), followed by a KEV refetch. `awaitIdle` alone can return in the
 * gap between the report answering and the sync's first progress message,
 * and a click dispatched into the sync that follows lands on a busy Worker
 * (RE-034 in a new coat). The sync's outcome is written into the revision
 * line, so that is what is waited for, and *then* idle.
 */
async function settleAfterReload(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Sync', exact: true })).toBeVisible({
    timeout: 120_000,
  })
  await expect(page.locator('[data-revision]')).toContainText(/already current|applied/, {
    timeout: 120_000,
  })
  await awaitIdle(page, 120_000)
}

/** Run a report definition through the agent surface and wait for the chart. */
async function runReport(page: Page, args: Record<string, unknown>): Promise<void> {
  const result = await ran(page, REPORT, () => agentCall(page, 'aggregate', args))
  expect(result.refused, String(result.reason)).toBeUndefined()
}

/** Run a record search through the agent surface and wait for the list. */
async function runRecords(page: Page, args: Record<string, unknown> = {}): Promise<number> {
  const result = await ran(page, RECORDS, () => agentCall(page, 'search_records', args))
  expect(result.refused, String(result.reason)).toBeUndefined()
  return result.recordsMatched as number
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

/** The rows dimension of the chart on screen, as its table's first header. */
async function rowsAxis(page: Page): Promise<string> {
  return (await page.locator('table.chart-data thead th').first().innerText()).trim()
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

/** Unix seconds as the `YYYY-MM-DD` day the date boxes show. */
function dayOf(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10)
}

test('reports, charts, permalinks, saved reports, exports and the detail view', async ({
  page,
  browser,
}) => {
  test.setTimeout(1_200_000)
  await page.goto('/')
  await requireLocalStorage(page)
  await importCorpus(page, 300_000)

  // The canvas auto-runs a default report the first time a copy is ready, and
  // the import is followed by a catch-up (M2). Wait both out, so the run
  // counters below always compare against a settled workspace.
  await expect(page.locator(REPORT)).toBeVisible({ timeout: 120_000 })
  await awaitIdle(page, 120_000)

  /**
   * The report a fresh workspace opens on: severity by week over the last two
   * years (`defaultReport`), with the time grain and the window as strip
   * controls rather than drawer fields. Quarterly is gone from the strip and
   * Weekly is new; a definition may still carry `quarter`, but the canvas
   * offers three grains.
   */
  await test.step('the opening report is severity by week, and Reset returns to it', async () => {
    const grain = page.locator('fieldset.granularity')
    await expect(grain).toHaveAttribute('data-granularity', 'week')
    const offered = await grain
      .locator('input[type="radio"]')
      .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))
    expect(offered).toEqual(['week', 'month', 'year'])
    await expect(grain.getByLabel('Weekly')).toBeChecked()
    await expect(grain.getByLabel('Quarterly')).toHaveCount(0)
    expect(await rowsAxis(page)).toBe('Week')
    // The lower edge is the Monday of the week two years back — a value in
    // the box, because it *is* a filter; the upper edge is unset and shows the
    // copy's own extent in muted text (`data-soft`), because seeding it would
    // write today's boundary into every permalink.
    const opening = dayOf(defaultReport(Date.now()).filters.publishedFrom!)
    await expect(page.locator('#canvas-pub-from')).toHaveValue(opening)
    await expect(page.locator('#canvas-pub-to')).toHaveAttribute('data-soft', '1')

    // A grain is one click and re-runs at once.
    await ran(page, REPORT, () => grain.getByLabel('Monthly').click())
    await expect(grain).toHaveAttribute('data-granularity', 'month')
    expect(await rowsAxis(page)).toBe('Month')

    // Reset is the way back to the opening report, whatever was done to it.
    await ran(page, REPORT, () => page.locator('[data-reset]').click())
    await expect(grain).toHaveAttribute('data-granularity', 'week')
    await expect(page.locator('#canvas-pub-from')).toHaveValue(opening)
  })

  /**
   * The founding question, in the shape D-046 benchmark item #1 asks it: CVE
   * counts by severity over time, stacked. This is the report the whole
   * milestone is for.
   */
  await test.step('severity over time, stacked, with the unscored band shown', async () => {
    await runReport(page, {
      title: 'Severity over time',
      rows: 'month',
      series: 'severity',
      chart: 'stackedBar',
    })
    await expect(page.locator('#canvas-title')).toHaveValue('Severity over time')

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

  await test.step('the PUBLISHED-only default is the quiet one; widening it is not (D-022)', async () => {
    // The one filter that changes every number on screen. The default is no
    // longer restated as a standing chip — it read as noise — so its absence
    // is the assertion; a widening is a removable chip *and* a warning over
    // the chart, and dismissing the chip restores the default.
    await expect(page.locator('[data-chip="state"]')).toHaveCount(0)
    await expect(page.locator('[data-state-warning]')).toHaveCount(0)

    await runReport(page, { rows: 'month', series: 'severity', state: 'all' })
    await expect(page.locator('[data-state-warning="all"]')).toContainText('REJECTED')
    const chip = page.locator('[data-chip="state"]')
    await expect(chip).toContainText('REJECTED included')
    await expect(chip.locator('button')).toHaveCount(1)

    await ran(page, REPORT, () => chip.locator('button').click())
    await expect(page.locator('[data-chip="state"]')).toHaveCount(0)
    await expect(page.locator('[data-state-warning]')).toHaveCount(0)
  })

  await test.step('the same dimension cannot be both axes', async () => {
    // A cross-tab of a dimension against itself puts every count on a diagonal
    // (D-069). It is refused by name at the definition, so no query runs and
    // the page shows no error — the refusal is the answer.
    const refused = await agentCall(page, 'aggregate', { rows: 'severity', series: 'severity' })
    expect(refused.refused).toBe(true)
    expect(String(refused.reason)).toMatch(/rows and series are both/)
    await expect(page.locator('[data-error]')).toHaveCount(0)
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
    const publishedFrom = from.toISOString().slice(0, 10)

    for (const dimension of ['vendor', 'product'] as const) {
      await runReport(page, {
        title: `${dimension} by severity`,
        rows: dimension,
        series: 'severity',
        publishedFrom,
      })
      const rows = await chartRows(page)
      expect(rows.length, dimension).toBeGreaterThan(0)

      const matches = Number(await page.locator(REPORT).getAttribute('data-report-matches'))
      expect(matches, dimension).toBeGreaterThan(0)
      // A record affecting eight products is one record, not eight (D-069's
      // shared-join-chain rule). The top bucket therefore cannot exceed the
      // match count.
      const top = Number(rows[0]![rows[0]!.length - 1]!.replace(/[^\d]/g, ''))
      expect(top, dimension).toBeLessThanOrEqual(matches)
      // The date filter is still applied — the strip's box carries it as a
      // value rather than the muted extent, which is what a reader checks.
      // (On the report canvas the published window has no chip: the box is
      // its control.)
      await expect(page.locator('#canvas-pub-from')).toHaveValue(publishedFrom)
      await expect(page.locator('#canvas-pub-from')).not.toHaveAttribute('data-soft', '1')
    }
  })

  await test.step('a line chart and a table-only report render the same data', async () => {
    // The chart type is a view of the result, not a re-run: the toggle redraws
    // the numbers already on the canvas.
    await runReport(page, { rows: 'month', series: 'severity' })
    await setChartType(page, 'Lines over time')
    await expect(page.locator('figure.chart polyline.series-line').first()).toBeVisible()
    const asLines = await chartRows(page)

    await setChartType(page, 'Table')
    await expect(page.locator('figure.chart')).toHaveCount(0)
    // The table is still there — it is not the chart's fallback, it is the
    // report's numbers.
    expect((await chartRows(page)).length).toBeGreaterThanOrEqual(asLines.length)
  })

  // --- Exports ----------------------------------------------------------

  await test.step('a CSV export carries the notice and is quoted throughout', async () => {
    await runReport(page, {
      title: 'Severity by month',
      rows: 'month',
      series: 'severity',
      chart: 'stackedBar',
    })
    await openShare(page)
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
    // Leave the Month result on screen while editing the live definition to
    // something unrun — the title is the one field the canvas edits without a
    // run. "Export these numbers" must stay attached to the Worker-echoed
    // report that produced the visible table, not to the edit.
    await page.locator('#canvas-title').fill('An edit nobody ran')
    await openShare(page)
    await page.locator('#export-format').selectOption('json')
    const file = await exportFile(page, 'Export these numbers')
    expect(file.name).toBe('severity-by-month.json')
    const parsed = JSON.parse(file.text) as {
      notice: string
      rows: { rows: string; series: string; cves: number }[]
      sql: string
      params: (string | number)[]
      revision: number | null
    }
    expect(parsed.notice).toContain('The MITRE Corporation')
    expect(parsed.rows.length).toBeGreaterThan(0)
    // The backing query travels with the numbers: a figure in a file can be
    // traced to the statement that produced it, the same property the chat
    // layer carries (D-044). Its values travel *beside* it as bound parameters
    // — the statement holds placeholders, never an interpolated value (rule 4).
    expect(parsed.sql).toContain('SELECT')
    expect(parsed.sql).toContain("strftime('%Y-%m'")
    expect(parsed.sql).toContain('?')
    expect(parsed.params.length).toBeGreaterThan(0)
  })

  await test.step('a record export is the whole match set, not the page', async () => {
    // A filter that is certain to match in any generation of the corpus, and
    // a list cap certain to be narrower than it — which is the difference this
    // step exists to demonstrate.
    const matches = await runRecords(page, { severity: ['CRITICAL'], limit: 10 })
    expect(matches).toBeGreaterThan(10)
    await expect(page.locator('table.records tbody tr')).toHaveCount(10)

    await openShare(page)
    // One format select serves every export now, and the previous step left
    // it on JSON — a CSV parse of a JSON export is what this guards against.
    await page.locator('#export-format').selectOption('csv')
    const file = await exportFile(page, 'Export matching records')
    const records = parseCsv(
      file.text
        .split('\r\n')
        .filter((line) => !line.startsWith('# '))
        .join('\r\n')
    )
    // Named from the module the writer names them from, so a schema addition
    // cannot leave the file's header and its rows describing different columns.
    // The record columns lead, in order. Since M6 an export made on a copy that
    // holds a KEV catalog *also* carries the six KEV columns — absent when it
    // does not, because empty ones would say every record is not
    // known-exploited (D-077 §1). So this asserts the prefix and then which of
    // the two shapes it is, rather than pinning one.
    expect(records[0]!.slice(0, RECORD_COLUMNS.length)).toEqual([...RECORD_COLUMNS])
    expect([RECORD_COLUMNS.length, RECORD_COLUMNS.length + KEV_COLUMNS.length]).toContain(
      records[0]!.length
    )
    if (records[0]!.length > RECORD_COLUMNS.length) {
      expect(records[0]!.slice(RECORD_COLUMNS.length)).toEqual([...KEV_COLUMNS])
    }
    // The six D-070 columns are in the *copy* even though they are not on
    // screen — an export that dropped `rejection_reason` would hand back every
    // REJECTED record with no text in it at all (D-071).
    expect(records[0]).toContain('rejection_reason')
    expect(records[0]).toContain('ssvc_exploitation')
    // The list on screen is capped; the export is not. This is the difference
    // the feature exists for.
    expect(records.length - 1).toBe(matches)
    expect(file.text).toContain('The MITRE Corporation')
  })

  // --- The per-CVE detail view -------------------------------------------

  await test.step('a record opens in full, with its references held to an allowlist', async () => {
    await runRecords(page)

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
    const matches = await runRecords(page, { cveId: 'CVE-1999-0001' })
    expect(matches).toBe(0)
    await expect(page.locator(RECORDS)).toBeVisible()
    await expect(page.locator('[data-error]')).toHaveCount(0)
  })

  // --- Saved reports, history, and permalinks -----------------------------

  await test.step('a saved report and the history survive a reload', async () => {
    // A fresh definition, so the saved one is the CWE spread and not the
    // leftover CVE-id search.
    await runReport(page, { title: 'CWE spread', rows: 'cwe', series: 'severity' })
    await openShare(page)
    await page.locator('#report-save-name').fill('CWE spread')
    await page.getByRole('button', { name: 'Save report' }).click()

    await page.reload()
    await settleAfterReload(page)
    await openPanel(page, 'saved')
    // Not in the SQLite copy, which a re-download or a schema bump destroys
    // (D-013, D-068) — that is the whole reason these live in localStorage.
    await expect(page.locator('[data-saved]')).toBeVisible({ timeout: 120_000 })
    await expect(page.getByRole('button', { name: 'Open saved report: CWE spread' })).toBeVisible()
    await expect(page.locator('[data-recent]')).toBeVisible()
  })

  await test.step('opening a saved report runs it on the canvas', async () => {
    await ran(page, REPORT, () =>
      page.getByRole('button', { name: 'Open saved report: CWE spread' }).click()
    )
    // The canvas title input carries the saved definition's title, and flags
    // it via data-report-title; the chart is grouped by what was saved — read
    // with a retrying assertion, because the run counter alone says a run
    // landed, not which.
    await expect(page.locator('#canvas-title')).toHaveValue('CWE spread')
    await expect(page.locator('#canvas-title')).toHaveAttribute('data-report-title', '1')
    await expect(page.locator('table.chart-data thead th').first()).toHaveText('CWE')
    await expect(page.locator('[data-error]')).toHaveCount(0)
  })

  await test.step('deleting a saved report removes it, and it stays gone', async () => {
    await openPanel(page, 'saved')
    await page.getByRole('button', { name: 'Delete saved report: CWE spread' }).click()
    await expect(page.getByRole('button', { name: 'Open saved report: CWE spread' })).toHaveCount(0)
    await page.reload()
    await settleAfterReload(page)
    await openPanel(page, 'saved')
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
    await runReport(page, {
      title: 'Shared: CNA by severity',
      rows: 'cna',
      series: 'severity',
      chart: 'groupedBar',
    })
    await openShare(page)
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

      // The landing CTA, once the Worker has spoken — clicking across the
      // pre-status render is the click ui.ts's importCorpus guards against.
      await expect(fresh.locator('main')).not.toHaveAttribute('data-status', 'pending', {
        timeout: 15_000,
      })
      await downloadButton(fresh).click()

      // And then it runs itself on the canvas, and the pending fragment wins
      // over the auto-run default report — which is what the reader asked for
      // by following the link. Waiting on the Import heading would be waiting
      // on a disclosure that opens beside the answer, not the answer.
      await expect(fresh.locator(REPORT)).toBeVisible({ timeout: 300_000 })
      await openPanel(fresh, 'data')
      await expect(fresh.locator('[data-revision]')).toBeVisible()
      await expect(fresh.locator('#canvas-title')).toHaveValue('Shared: CNA by severity')
      expect(await rowsAxis(fresh)).toBe('CNA')
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
