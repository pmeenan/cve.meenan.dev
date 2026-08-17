import { expect, test } from '@playwright/test'

import { requireLocalStorage } from './support'
import { agentCall, awaitIdle, calendarDay, importCorpus, openCalendar } from './ui'

import { yearsBack } from '../../lib/dates'
import { defaultReport } from '../../lib/report'

/**
 * The date range control, in a browser (M9).
 *
 * The arithmetic is tested away from the browser (`tests/unit/dates.test.ts`).
 * What only a browser has is everything this control exists for, and each of
 * these was a real defect in the two `<input type="date">` boxes it replaced:
 *
 * - **Typing a date works.** The native control committed the year `0002` on
 *   the first keystroke of `2025`, because a controlled date input fires a
 *   change per segment.
 * - **The range is the data's.** The boxes show the copy's own extent instead
 *   of nothing, the calendar refuses days outside it, and a typed date beyond
 *   it is clamped rather than accepted.
 * - **A month is a click away**, from the shortcut rail or the month and year
 *   selects, and the whole thing is reachable from the keyboard.
 * - **The usual windows are one click**, from the quick ranges over the chart
 *   (`[data-quick-range]`: all time, 10 / 5 / 2 / 1 years, year to date) —
 *   a lower edge relative to today, the current one shown pressed.
 *
 * Since the filter drawer went (UI polish, 2026-08-16) the canvas strip's
 * published window is the one instance of the control, and it is the
 * disclosure of the filter as well as its editor: on the report canvas there
 * is no `published` chip, so "is a window applied?" is read from the boxes —
 * a committed edge is a value, an unset one shows the copy's extent in muted
 * text (`data-soft`) — and from what the report counted.
 *
 * Every assertion is written against the *bounds this copy reports* rather
 * than a literal date: the development slice covers one year and the published
 * corpus covers twenty-seven, and a spec pinned to either one is a spec that
 * fails on the other.
 */

test.describe('the date range control', () => {
  test('types, bounds, picks and pages on the canvas strip', async ({ page }) => {
    test.setTimeout(600_000)
    const failures: string[] = []
    page.on('pageerror', (error) => failures.push(String(error)))

    await page.goto('/?remote=0')
    await requireLocalStorage(page)
    await importCorpus(page, 300_000)

    const from = page.locator('#canvas-pub-from')
    const to = page.locator('#canvas-pub-to')
    const runs = page.locator('[data-report-matches]')

    /** The extent the copy reported, read out of the control itself. */
    let extent = { min: '', max: '' }

    await test.step('an unset edge shows the data’s own bound, not an empty box', async () => {
      // The opening report is windowed on its lower edge only — two years
      // back, a value in the box because it is a filter — while the upper edge
      // is unset and *displays* the copy's last day. The seeded display is the
      // point: a reader adjusting the window edits a date rather than
      // inventing one, and the boxes say what the chart on screen is covering.
      const opening = dayOf(defaultReport(Date.now()).filters.publishedFrom!)
      await expect(from).toHaveValue(opening, { timeout: 30_000 })
      await expect(from).not.toHaveAttribute('data-soft', '1')
      await expect(to).toHaveAttribute('data-soft', '1')

      // Clearing the lower edge is an edit, so it re-runs; then both boxes are
      // the extent, and neither filters.
      const before = Number(await runs.getAttribute('data-run'))
      await from.fill('')
      await from.press('Enter')
      await awaitIdle(page)
      expect(Number(await runs.getAttribute('data-run'))).toBe(before + 1)
      await expect(from).toHaveAttribute('data-soft', '1')
      extent = { min: await from.inputValue(), max: await to.inputValue() }
      expect(extent.min).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(extent.max).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(extent.min < extent.max).toBe(true)
      // Shown, but not filtering: the unwindowed report counts every PUBLISHED
      // record the copy holds. The `sql` tool fills the SQL panel and leaves
      // the canvas alone, which is why it can be the witness here.
      const counted = await agentCall(page, 'sql', {
        sql: 'SELECT count(*) FROM cve WHERE state = 1',
      })
      const every = (counted.rows as [number][])[0]![0]
      expect(Number(await runs.getAttribute('data-report-matches'))).toBe(every)
    })

    await test.step('a whole year can be typed into the box', async () => {
      const year = Number(extent.max.slice(0, 4))
      const before = Number(await runs.getAttribute('data-run'))
      await from.click()
      await from.press('Control+a')
      await from.type(String(year), { delay: 20 })
      // Nothing is committed while the keys are still arriving: the old
      // control rewrote the box mid-word, and committing here would re-run the
      // report and disable the box under the reader's fingers.
      expect(Number(await runs.getAttribute('data-run'))).toBe(before)
      await from.press('Enter')
      await awaitIdle(page)
      // A bare year means the whole year — the start of it on this edge —
      // clamped into the data, which for a slice that begins mid-year is the
      // first day it holds.
      const expected = `${year}-01-01` < extent.min ? extent.min : `${year}-01-01`
      await expect(from).toHaveValue(expected)
      await expect(from).not.toHaveAttribute('data-soft', '1')
      expect(Number(await runs.getAttribute('data-run'))).toBe(before + 1)
    })

    await test.step('a date outside the data is clamped into it', async () => {
      await from.click()
      await from.press('Control+a')
      await from.type('1970-01-01', { delay: 10 })
      await from.press('Enter')
      await awaitIdle(page)
      await expect(from).toHaveValue(extent.min)
    })

    await test.step('the calendar picks a range in two clicks and re-runs once', async () => {
      // One run for the pair, not one per edge: the picker holds the first
      // click and commits a *range*, which on the hosted tier is the difference
      // between one round trip and two — the second of them for a half-applied
      // window nobody asked about.
      const before = Number(await runs.getAttribute('data-run'))
      await openCalendar(page, 'canvas-published')
      // The calendar opens where the range is, so the first month on screen is
      // the one holding the current start.
      const start = addDaysIso(extent.min, 4)
      const end = addDaysIso(extent.min, 20)
      await calendarDay(page, start).click()
      await calendarDay(page, end).click()
      await awaitIdle(page)
      await expect(page.locator('[data-date-pop]')).toHaveCount(0)
      await expect(from).toHaveValue(start)
      await expect(to).toHaveValue(end)
      await expect(to).not.toHaveAttribute('data-soft', '1')
      expect(Number(await runs.getAttribute('data-run'))).toBe(before + 1)
    })

    await test.step('a day outside the data cannot be picked', async () => {
      await openCalendar(page, 'canvas-published')
      const outside = calendarDay(page, addDaysIso(extent.max, 1))
      // It may be off the visible months entirely; when it is on screen it is
      // disabled, which is the assertion that matters.
      if ((await outside.count()) > 0) await expect(outside).toBeDisabled()
      await page.keyboard.press('Escape')
      await expect(page.locator('[data-date-pop]')).toHaveCount(0)
    })

    await test.step('a shortcut sets the range in one click, and clears it in one', async () => {
      await openCalendar(page, 'canvas-published')
      await page.locator('[data-preset="90d"]').click()
      await awaitIdle(page)
      await expect(from).not.toHaveAttribute('data-soft', '1')
      // Clamped: a shortcut never sets an edge the calendar could not then
      // show, which for a copy whose head is a week old means "today" lands on
      // the last day it holds.
      expect((await from.inputValue()) >= extent.min).toBe(true)
      expect((await to.inputValue()) <= extent.max).toBe(true)

      await openCalendar(page, 'canvas-published')
      await page.locator('[data-preset="all"]').click()
      await awaitIdle(page)
      await expect(from).toHaveAttribute('data-soft', '1')
      await expect(to).toHaveAttribute('data-soft', '1')
      await expect(from).toHaveValue(extent.min)
    })

    await test.step('the calendar is usable from the keyboard alone', async () => {
      await openCalendar(page, 'canvas-published')
      // Focus lands *in the grid*, not on the dialog: the reader arrived here
      // to choose a day.
      const focused = () => page.evaluate(() => document.activeElement?.getAttribute('data-day'))
      const landed = await focused()
      expect(landed).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      await page.keyboard.press('ArrowLeft')
      expect(await focused()).toBe(addDaysIso(landed!, -1))
      await page.keyboard.press('ArrowUp')
      expect(await focused()).toBe(addDaysIso(landed!, -8))
      await page.keyboard.press('PageUp')
      const start = (await focused())!
      await page.keyboard.press('Enter')
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('Enter')
      await awaitIdle(page)
      await expect(from).toHaveValue(start)
      await expect(to).toHaveValue(addDaysIso(start, 1))
    })

    await test.step('month and year are selects, so any month is two clicks away', async () => {
      await openCalendar(page, 'canvas-published')
      const years = await page
        .locator('[data-cal-year] option')
        .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))
      // Bounded by the copy: the year list is the years it holds, never the
      // calendar's idea of a century.
      expect(years[0]).toBe(extent.min.slice(0, 4))
      expect(years[years.length - 1]).toBe(extent.max.slice(0, 4))
      await page.locator('[data-cal-month]').selectOption(String(Number(extent.min.slice(5, 7))))
      const months = await page
        .locator('[data-month]')
        .evaluateAll((tables) => tables.map((table) => (table as HTMLElement).dataset.month))
      expect(months[0]).toBe(extent.min.slice(0, 7))
      expect(months).toHaveLength(2)
      await page.keyboard.press('Escape')
    })

    await test.step('a quick range is one click, relative to today, and reads pressed', async () => {
      // The rail sets a lower edge only: the upper edge stays unset (soft) so
      // "the last year" is a question about the data's head and a permalink
      // for it does not carry today. The edge is not clamped into the copy —
      // it is relative to the day, not the data — so it is checked against
      // the same arithmetic the button used, and the pressed state follows
      // the boxes, not the click.
      const rail = page.locator('[data-quick-range]')
      await expect(rail).toHaveCount(6)
      let before = Number(await runs.getAttribute('data-run'))
      await page.locator('[data-quick-range="1y"]').click()
      await awaitIdle(page)
      expect(Number(await runs.getAttribute('data-run'))).toBe(before + 1)
      const today = new Date().toISOString().slice(0, 10)
      await expect(from).toHaveValue(yearsBack(today, 1))
      await expect(from).not.toHaveAttribute('data-soft', '1')
      await expect(to).toHaveAttribute('data-soft', '1')
      await expect(page.locator('[data-quick-range="1y"]')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('[data-quick-range][aria-pressed="true"]')).toHaveCount(1)

      // "All time" is the way back to no window at all, and it is what a
      // hand-cleared pair of boxes already equals — so it reads pressed there
      // too. A typed edge that matches no button leaves nothing pressed.
      before = Number(await runs.getAttribute('data-run'))
      await page.locator('[data-quick-range="all"]').click()
      await awaitIdle(page)
      expect(Number(await runs.getAttribute('data-run'))).toBe(before + 1)
      await expect(from).toHaveAttribute('data-soft', '1')
      await expect(to).toHaveAttribute('data-soft', '1')
      await expect(page.locator('[data-quick-range="all"]')).toHaveAttribute('aria-pressed', 'true')
      await from.click()
      await from.press('Control+a')
      await from.type(addDaysIso(extent.min, 3), { delay: 10 })
      await from.press('Enter')
      await awaitIdle(page)
      await expect(page.locator('[data-quick-range][aria-pressed="true"]')).toHaveCount(0)
    })

    await test.step('Reset puts the opening window back', async () => {
      // The strip's Reset restores the whole opening report, and the window
      // with it: the lower edge is a value again and the upper edge is unset.
      const before = Number(await runs.getAttribute('data-run'))
      await page.locator('[data-reset]').click()
      await awaitIdle(page)
      expect(Number(await runs.getAttribute('data-run'))).toBe(before + 1)
      await expect(from).toHaveValue(dayOf(defaultReport(Date.now()).filters.publishedFrom!))
      await expect(from).not.toHaveAttribute('data-soft', '1')
      await expect(to).toHaveAttribute('data-soft', '1')
      // …which is the "2 yr" quick range, built by the same arithmetic.
      await expect(page.locator('[data-quick-range="2y"]')).toHaveAttribute('aria-pressed', 'true')
    })

    expect(failures, failures.join('\n')).toEqual([])
  })
})

/** Day arithmetic for the assertions themselves — UTC, like everything else. */
function addDaysIso(day: string, count: number): string {
  const at = new Date(`${day}T00:00:00Z`)
  at.setUTCDate(at.getUTCDate() + count)
  return at.toISOString().slice(0, 10)
}

/** Unix seconds as the `YYYY-MM-DD` day the boxes show. */
function dayOf(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10)
}
