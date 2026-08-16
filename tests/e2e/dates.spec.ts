import { expect, test } from '@playwright/test'

import { requireLocalStorage } from './support'
import { awaitIdle, calendarDay, importCorpus, openCalendar, openPanel } from './ui'

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
 *
 * Every assertion is written against the *bounds this copy reports* rather
 * than a literal date: the development slice covers one year and the published
 * corpus covers twenty-seven, and a spec pinned to either one is a spec that
 * fails on the other.
 */

test.describe('the date range control', () => {
  test('types, bounds, picks and pages — on the canvas and in the drawer', async ({ page }) => {
    test.setTimeout(600_000)
    const failures: string[] = []
    page.on('pageerror', (error) => failures.push(String(error)))

    await page.goto('/?remote=0')
    await requireLocalStorage(page)
    await importCorpus(page, 300_000)

    const from = page.locator('#canvas-pub-from')
    const to = page.locator('#canvas-pub-to')

    /** The extent the copy reported, read out of the control itself. */
    let extent = { min: '', max: '' }

    await test.step('an unfiltered report shows the data’s own range, not empty boxes', async () => {
      // The seeded display is the point: a reader adjusting the window edits a
      // date rather than inventing one, and the boxes say what the chart on
      // screen is actually covering.
      await expect(from).toHaveAttribute('data-soft', '1', { timeout: 30_000 })
      await expect(to).toHaveAttribute('data-soft', '1')
      extent = { min: await from.inputValue(), max: await to.inputValue() }
      expect(extent.min).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(extent.max).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(extent.min < extent.max).toBe(true)
      // Shown, but not filtering: no `published` chip, because nothing was
      // committed to the definition (and a permalink stays free of it).
      await expect(page.locator('[data-chip="published"]')).toHaveCount(0)
    })

    await test.step('a whole year can be typed into the box', async () => {
      const year = Number(extent.max.slice(0, 4))
      await from.click()
      await from.press('Control+a')
      await from.type(String(year), { delay: 20 })
      // Nothing is committed while the keys are still arriving: the old
      // control rewrote the box mid-word, and committing here would re-run the
      // report and disable the box under the reader's fingers.
      await expect(page.locator('[data-chip="published"]')).toHaveCount(0)
      await from.press('Enter')
      await awaitIdle(page)
      // A bare year means the whole year — the start of it on this edge —
      // clamped into the data, which for a slice that begins mid-year is the
      // first day it holds.
      const expected = `${year}-01-01` < extent.min ? extent.min : `${year}-01-01`
      await expect(from).toHaveValue(expected)
      await expect(page.locator('[data-chip="published"]')).toContainText(expected)
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
      const runs = page.locator('[data-report-matches]')
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
      await expect(page.locator('[data-chip="published"]')).toContainText(`${start} to ${end}`)
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
      await expect(page.locator('[data-chip="published"]')).toBeVisible()
      // Clamped: a shortcut never sets an edge the calendar could not then
      // show, which for a copy whose head is a week old means "today" lands on
      // the last day it holds.
      expect((await from.inputValue()) >= extent.min).toBe(true)
      expect((await to.inputValue()) <= extent.max).toBe(true)

      await openCalendar(page, 'canvas-published')
      await page.locator('[data-preset="all"]').click()
      await awaitIdle(page)
      await expect(page.locator('[data-chip="published"]')).toHaveCount(0)
      await expect(from).toHaveAttribute('data-soft', '1')
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

    await test.step('the drawer’s pickers escape the panel that scrolls', async () => {
      // The filter drawer is `overflow-y: auto`; a popover positioned inside it
      // would be clipped by the panel it lives in, which is the one place this
      // control has to work.
      await openPanel(page, 'filters')
      const popover = await openCalendar(page, 'published')
      const box = (await popover.boundingBox())!
      const panel = (await page.locator('#filters-panel').boundingBox())!
      expect(box.width).toBeGreaterThan(0)
      // Wider than the drawer, and therefore not inside its clip.
      expect(box.x + box.width).toBeGreaterThan(panel.x + panel.width)
      await page.keyboard.press('Escape')

      // Every axis carries its own extent — the KEV dates are CISA's timeline,
      // not the corpus's, and its due dates run into the future.
      const kevAdded = page.locator('#report-kev-added-from')
      if ((await kevAdded.getAttribute('data-soft')) === '1') {
        expect(await kevAdded.inputValue()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      }
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
