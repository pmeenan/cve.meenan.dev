import { expect, test, type Page } from '@playwright/test'

import { requireLocalStorage } from './support'
import {
  agentCall,
  awaitIdle,
  closePanel,
  downloadButton,
  importCorpus,
  openPanel,
  pick,
  pickerClear,
} from './ui'

import { SCHEMA_VERSION } from '../../lib/protocol'

/**
 * M3's exit criteria in a browser: every confirmed filter axis answering, a
 * long query reporting and cancellable, hostile SQL refused by the database
 * itself, and a schema bump announced.
 *
 * The filter drawer is gone (UI polish, 2026-08-16), so a filter is expressed
 * the way an agent expresses one: `agentCall(page, 'search_records', {...})`
 * and `agentCall(page, 'aggregate', {...})` are the same five tools the chat
 * layer and `window.cveExplorer` run (D-086), through the same Worker path,
 * and each result lands on the canvas exactly as a chat call's would — so a
 * spec can assert on the JSON the model would read *and* on the canvas hooks.
 * The property under test is the query layer's, not a widget's, and it holds
 * or fails the same way through either.
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

/** The canvas's two answer surfaces: the chart's container and the record list's summary line. */
const REPORT = '[data-report-matches]'
const RECORDS = '[data-matches]'

/** The answer counter currently on screen for a surface, or null if it is empty. */
async function answered(page: Page, selector: string): Promise<string | null> {
  const element = page.locator(selector).first()
  if ((await element.count()) === 0) return null
  return element.getAttribute('data-run')
}

/**
 * Do something that runs a query, and wait for *this* run's answer to land on
 * the canvas.
 *
 * Waiting on the progress bar is not enough and was actively misleading: a
 * query that finishes in milliseconds may never render one, so the assertion
 * then reads the previous result and a filter that never applied looks correct.
 * The page stamps each answer with a counter for exactly this (`data-run`).
 * An `agentCall` resolves when the Worker has answered, but the render that
 * shows the answer is a tick behind it — so the counter is waited on even then.
 */
async function ran<T>(page: Page, selector: string, action: () => Promise<T>): Promise<T> {
  const before = await answered(page, selector)
  const out = await action()
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
  return out
}

/**
 * An `aggregate` result's cells as [label, count] — the one-axis shape. The
 * label is what the chart shows: a name for the lookup axes, the band's name
 * for the coded ones (severity's CRITICAL is `"CRITICAL"`), and a bracketed
 * absence — `(none recorded)`, `(not scored)` — for the bucket of records that
 * carry no value.
 */
function cells(result: Record<string, unknown>): [string, number][] {
  return result.cells as [string, number][]
}

/** The cells that name a value: the absence band cannot be filtered on by name. */
function named(result: Record<string, unknown>): [string, number][] {
  return cells(result).filter((cell) => cell[0] !== null && !cell[0].startsWith('('))
}

/** How many records the current filters match, from the canvas. */
async function matches(page: Page, selector: string): Promise<number> {
  const attribute = selector === REPORT ? 'data-report-matches' : 'data-matches'
  return Number(await page.locator(selector).first().getAttribute(attribute))
}

/**
 * The chart's own table as label → count, for a one-axis report. The rendered
 * labels rather than the tool's cells, which carry the stored codes: this is
 * where a renderer that chose labels by position rather than by dimension
 * would show.
 */
async function bucketTable(page: Page): Promise<Map<string, number>> {
  const rows = page.locator('table.chart-data tbody tr')
  const out = new Map<string, number>()
  for (let at = 0; at < (await rows.count()); at += 1) {
    const row = rows.nth(at)
    out.set(
      (await row.locator('th').innerText()).trim(),
      Number((await row.locator('td').first().innerText()).replace(/[^\d]/g, ''))
    )
  }
  return out
}

test('filters, the console, cancellation and a schema bump', async ({ page }) => {
  test.setTimeout(600_000)
  const failures = watchConsole(page)
  await page.goto('/')
  await requireLocalStorage(page)
  await importCorpus(page, 300_000)

  /**
   * Each lookup axis is checked against itself: group by the dimension, take
   * the top value, then filter on that value and require the two counts to
   * agree. That is a stronger assertion than any fixed expectation — it holds
   * against the development slice and the full corpus alike, and it catches the
   * failure that matters, a filter and an aggregate disagreeing about what a
   * record is (one CVE with eight products is not eight CVEs).
   */
  for (const dimension of ['vendor', 'cna', 'cwe', 'host'] as const) {
    await test.step(`filter by ${dimension} agrees with grouping by it`, async () => {
      const grouped = await ran(page, REPORT, () =>
        agentCall(page, 'aggregate', { rows: dimension })
      )
      const buckets = named(grouped)
      expect(buckets.length, `no ${dimension} buckets`).toBeGreaterThan(0)
      const [label, count] = buckets[0]!
      // The CWE bucket is labelled `CWE-79 — Cross-site Scripting`; the filter
      // takes the identifier.
      const value = dimension === 'cwe' ? label.split(' ')[0]! : label

      if (dimension === 'vendor') {
        // The vendor picker on the canvas strip is the one direct control the
        // lookup axes kept. Picking the top vendor commits the same
        // `filters.vendor` a tool call sets and re-runs the chart, so its
        // match count is the bucket's; clearing it is the unfiltered report
        // again.
        const total = grouped.recordsMatched as number
        await ran(page, REPORT, () => pick(page, 'vendor', value))
        expect(await matches(page, REPORT), `picked ${value}`).toBe(count)
        await ran(page, REPORT, () => pickerClear(page, 'vendor'))
        expect(await matches(page, REPORT)).toBe(total)
      }

      const found = await ran(page, RECORDS, () =>
        agentCall(page, 'search_records', { [dimension]: [value] })
      )
      expect(found.recordsMatched, `${dimension} ${value}`).toBe(count)
      expect(await matches(page, RECORDS)).toBe(count)
      expect(found.unmatchedFilterValues).toEqual([])
      await expect(page.locator('[data-unmatched]')).toHaveCount(0)
    })
  }

  await test.step('a name that matches nothing says so, rather than showing zero results', async () => {
    const found = await ran(page, RECORDS, () =>
      agentCall(page, 'search_records', { vendor: ['zzz-no-such-vendor'] })
    )
    expect(found.recordsMatched).toBe(0)
    // Said to the model and shown to the reader, in the same words: a typo is
    // not an empty result.
    expect(found.unmatchedFilterValues).toEqual([
      { axis: 'vendor', values: ['zzz-no-such-vendor'] },
    ])
    await expect(page.locator('[data-unmatched="vendor"]')).toContainText('zzz-no-such-vendor')
  })

  await test.step('severity, score and dates', async () => {
    const grouped = await ran(page, REPORT, () =>
      agentCall(page, 'aggregate', { rows: 'severity' })
    )
    // The tool's cells carry the band's *name*, as the chart does — a model
    // told `["4", 120]` says "severity 4" — and the never-scored band is
    // labelled too.
    const bySeverity = new Map(cells(grouped))
    expect(bySeverity.size).toBeGreaterThan(1)
    const critical = bySeverity.get('CRITICAL')!
    expect(critical).toBeGreaterThan(0)

    const found = await ran(page, RECORDS, () =>
      agentCall(page, 'search_records', { severity: ['CRITICAL'] })
    )
    expect(found.recordsMatched).toBe(critical)

    // A score floor is a subset of the severity band above it: CRITICAL starts
    // at 9.0, so everything at 9.5 or more is CRITICAL and there are fewer.
    const high = await ran(page, RECORDS, () =>
      agentCall(page, 'search_records', { severity: ['CRITICAL'], scoreMin: 9.5 })
    )
    expect(high.recordsMatched as number).toBeGreaterThan(0)
    expect(high.recordsMatched as number).toBeLessThanOrEqual(critical)

    // The published-date window is the canvas strip's own control, shown with
    // the chart. An unbounded report first, so the boxes display the copy's
    // extent rather than a filter.
    const unbounded = await ran(page, REPORT, () =>
      agentCall(page, 'aggregate', { rows: 'month', series: 'severity' })
    )
    const all = unbounded.recordsMatched as number
    // The date control is bounded by the copy (M9): a boundary outside the
    // data is **clamped into it** rather than accepted, so this no longer
    // produces the empty report it used to — it produces the last day the copy
    // holds. Both halves are asserted, because the clamp is the behaviour and
    // the count is the proof that the predicate still applies.
    const from = page.locator('#canvas-pub-from')
    const latest = await page.locator('#canvas-pub-to').inputValue()
    await ran(page, REPORT, async () => {
      await from.fill('2099-01-01')
      await from.press('Enter')
    })
    await expect(from).toHaveValue(latest)
    const lastDay = await matches(page, REPORT)
    expect(lastDay).toBeGreaterThan(0)
    expect(lastDay).toBeLessThan(all)
  })

  await test.step('REJECTED records are excluded by default and never quietly (D-022)', async () => {
    const defaulted = await ran(page, RECORDS, () => agentCall(page, 'search_records', {}))
    const published = defaulted.recordsMatched as number
    await expect(page.locator('[data-state-warning]')).toHaveCount(0)

    const widened = await ran(page, RECORDS, () =>
      agentCall(page, 'search_records', { state: 'all' })
    )
    const all = widened.recordsMatched as number
    expect(all).toBeGreaterThan(published)
    // Including them changes the denominator of everything on screen, so it has
    // to be visible rather than implied by an argument.
    await expect(page.locator('[data-state-warning="all"]')).toContainText('REJECTED')

    const rejected = await ran(page, RECORDS, () =>
      agentCall(page, 'search_records', { state: 'rejected' })
    )
    expect(rejected.recordsMatched).toBe(all - published)

    // State and severity both use numeric codes 1 and 2. The renderer must use
    // the dimension to choose labels, or these appear as LOW and MEDIUM.
    await ran(page, REPORT, () => agentCall(page, 'aggregate', { rows: 'state', state: 'all' }))
    const states = await bucketTable(page)
    expect(states.get('PUBLISHED')).toBe(published)
    expect(states.get('REJECTED')).toBe(all - published)
  })

  await test.step('full-text search, and the SQL behind every number', async () => {
    const found = await ran(page, RECORDS, () =>
      agentCall(page, 'search_records', { text: 'buffer overflow' })
    )
    expect(found.recordsMatched as number).toBeGreaterThan(0)
    // The query is inspectable: the SQL panel is filled with whatever last ran
    // on the canvas — while it is closed, so an edit underway is never
    // replaced. What it shows is the statement made runnable for a reader,
    // which means the search terms are there as one quoted fts5 literal (the
    // parse `ftsQuery` did, `lib/inline-sql.ts`) and nowhere else: the query
    // layer bound them (rule 4), and the display quoted them. Whether the
    // panel's copy really reproduces the number is then a matter of running
    // it.
    await openPanel(page, 'sql')
    const sql = await page.locator('textarea.sql-input').inputValue()
    expect(sql).toContain('fts MATCH')
    expect(sql).toContain(`'"buffer" AND "overflow"'`)
    expect(sql).not.toMatch(/MATCH \?/)
    await page.getByRole('button', { name: 'Run SQL' }).click()
    await expect(page.locator('[data-console-rows]')).toBeVisible({ timeout: 120_000 })
    expect(
      Number(await page.locator('[data-console-rows]').getAttribute('data-console-rows'))
    ).toBeGreaterThan(0)
    await closePanel(page, 'sql')

    const none = await ran(page, RECORDS, () =>
      agentCall(page, 'search_records', { text: 'zzqqxx-not-a-word' })
    )
    expect(none.recordsMatched).toBe(0)
  })

  await test.step('the console reads', async () => {
    await openPanel(page, 'sql')
    await page.getByRole('button', { name: 'Schema' }).click()
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
    // guard the console left behind. Sync is a header button — no panel
    // needed, and the SQL panel stays open underneath.
    await page.getByRole('button', { name: 'Sync', exact: true }).click()
    await expect(page.locator('.progress')).toBeHidden({ timeout: 300_000 })
    await expect(page.locator('[data-error]')).toHaveCount(0)
    // The progress bar hiding is not the end of the sequence: a KEV refresh and
    // the workspace's own follow-up questions come after it, each a short busy
    // window. The next step clicks a button, and a click dispatched into one of
    // those windows is silently swallowed (RE-034) — this is the idle-first
    // half of that workaround.
    await awaitIdle(page, 120_000)
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
    // queried, so the app shows the landing view rather than the workspace —
    // the canvas and the SQL console are not in the DOM to reach.
    await expect(page.locator('[data-landing]')).toBeVisible()
    await expect(page.locator('[data-toggle="sql"]')).toHaveCount(0)
    await expect(page.locator('#sql-panel')).toHaveCount(0)
    await expect(page.locator('section.canvas')).toHaveCount(0)
    await expect(downloadButton(page)).toHaveText('Re-download CVE dataset')
  })

  await test.step('and the origin is refused too, naming the fix', async () => {
    // The data plane is still at the version this build's copy came from, so
    // downloading again cannot help —
    // and the app says the thing that can (reload for the matching build),
    // rather than sending the user round a loop.
    await downloadButton(page).click()
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
    // the same copy is live and queryable — the workspace opens on it, and the
    // footer's Data & diagnostics disclosure offers a replacement rather than a
    // first download.
    await page.goto('/')
    // A reopened copy that is more than twelve hours behind — the dev fixture
    // always is — syncs itself once after its first report answers, and its
    // outcome lands in the revision line. Waited for before anything is
    // clicked, because `awaitIdle` alone can return in the gap before that
    // sync's first progress message (RE-034's window, one layer up).
    await expect(page.locator('[data-revision]')).toContainText(/already current|applied/, {
      timeout: 120_000,
    })
    await awaitIdle(page, 120_000)
    await openPanel(page, 'data')
    await expect(page.getByRole('button', { name: 'Re-download data' })).toBeEnabled({
      timeout: 120_000,
    })
    await page.getByRole('button', { name: 'Run query' }).click()
    // Scoped to the panel: the canvas's chart table is `results` too, and it
    // is visually hidden under a chart.
    await expect(page.locator('#data-panel table.results tbody tr').first()).toBeVisible({
      timeout: 120_000,
    })
  })

  expect(failures, `console/page errors:\n${failures.join('\n')}`).toEqual([])
})
