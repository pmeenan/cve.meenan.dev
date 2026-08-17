import { expect, test, type Page } from '@playwright/test'

import { requireLocalStorage } from './support'

import { awaitIdle, downloadButton, openPanel } from './ui'

import { AUTO_SYNC_AFTER_MS } from '../../lib/freshness'
import { DATA_ROOT } from '../../lib/protocol'

/**
 * Sync (M2), in a browser: a local copy walked forward by the delta files the
 * origin publishes, rather than re-downloaded.
 *
 * The applier itself is tested exhaustively away from the browser
 * (`tests/unit/sync.test.ts`, and `tests/unit/contract.test.ts` reconstructs the
 * pipeline's own next generation from the published snapshot and delta) —
 * because the checks that matter most are the full-text ones, and
 * `integrity-check` at `rank = 1` is far too expensive to run against 122 MB of
 * description text here (RE-005). What this covers is the part only a browser
 * has: manifest → plan → fetch → verify → apply on the OPFS copy, and the
 * revision the page then reports.
 *
 * It adapts to the data plane it is pointed at, because the two that exist are
 * different shapes. The development slice has no deltas, so the honest thing to
 * assert against it is that a current copy is *reported* as current and nothing
 * is fetched. Pointed at the real one — the full corpus and the deltas the
 * daily cron has published since (D-058) — the same test walks a snapshot up
 * through real days of upstream change. Both are asserted; which one ran is in
 * the annotations, along with what the catch-up cost.
 *
 * `BASE_URL=https://cve.meenan.dev pnpm e2e sync` points it at the deployed
 * app, which is only useful once this build is deployed. To run the *local*
 * build against the *live* data, mirror the plane and serve it — which is how
 * the numbers in D-063 were taken:
 *
 *     curl -O https://cve.meenan.dev/data/manifest.json      # then its chunks
 *     SERVE_DATA_ROOT=<mirror> pnpm e2e sync                 # and its deltas
 */
test('catches a fresh download up to the head the origin advertises', async ({ page }) => {
  // Minutes, because this spec is also pointed at the full corpus. A stall
  // detector, not a budget (D-052).
  test.setTimeout(600_000)

  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text())
  })

  await page.goto('/')
  await requireLocalStorage(page)

  // What the origin is offering, read from the browser rather than from Node:
  // this is the same request, same origin and same cache policy the Worker makes.
  const plane = await page.evaluate(async (root) => {
    const manifest = await (await fetch(`${root}/manifest.json`, { cache: 'no-cache' })).json()
    return {
      head: manifest.rev as number,
      snapshot: (manifest.snapshot.rev ?? null) as number | null,
      deltas: (manifest.deltas ?? []).length as number,
      generated: manifest.generated as number,
    }
  }, DATA_ROOT)
  test.info().annotations.push({
    type: 'data plane',
    description: `snapshot rev ${plane.snapshot}, head ${plane.head}, ${plane.deltas} delta(s)`,
  })

  // The revision line lives in the footer's Data & diagnostics disclosure
  // since the UI polish; its attribute and text are readable whether or not
  // the disclosure is open, so nothing below has to open it to assert on it.
  const revision = page.locator('[data-revision]')

  await test.step('download, which ends by catching up', async () => {
    // The landing view's CTA; the Import heading is inside the footer's Data
    // & diagnostics disclosure, which opens itself on the import that filled it.
    await expect(page.locator('main')).not.toHaveAttribute('data-status', 'pending', {
      timeout: 60_000,
    })
    await downloadButton(page).click()
    await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible({ timeout: 300_000 })
    // Quiet before anything is clicked: the catch-up and the canvas auto-run
    // follow an import, and their busy flickers can swallow a click.
    await awaitIdle(page)

    // The property: a download lands at `snapshot.rev`, and the head has moved
    // on daily since that generation was cut (D-058). Stopping there would
    // leave a copy that is stale on arrival, so the import continues into a
    // catch-up and the copy ends at head either way.
    await expect(revision).toHaveAttribute('data-revision', String(plane.head), {
      timeout: 300_000,
    })
  })

  await test.step('and the catch-up did the work the manifest implied', async () => {
    const summary = await revision.innerText()
    // Recorded rather than asserted, in the same spirit as import.spec.ts's
    // Q-003 line: what a real chain costs is a measurement, and a budget here
    // would be a latency ceiling D-052 rules out.
    test.info().annotations.push({ type: 'sync', description: summary.replace(/\n/g, ' ') })
    if (plane.snapshot !== null && plane.head > plane.snapshot) {
      // A plane with deltas above its snapshot: the client must have fetched
      // and applied them rather than reported itself current.
      expect(summary).toMatch(/update(s)? applied/)
      // The "N new CVEs since your last sync" number (M2 freshness), counted
      // apart from revisions of records this copy already held.
      expect(summary).toMatch(/[\d,]+ new CVEs?/)
      expect(summary).toMatch(/[\d,]+ records revised/)
    } else {
      // A plane whose head *is* its snapshot — the development slice, and the
      // state the origin is in for the hours after a monthly rotation (D-060).
      expect(summary).toContain('already current')
    }
  })

  await test.step('a second sync has nothing left to do', async () => {
    // Idempotence as the user meets it: the chain is empty because the
    // watermark is already at head, so no delta is fetched and none is applied.
    // (Re-applying one is refused by the watermark guard — asserted in
    // tests/unit/sync.test.ts, where it can be forced.)
    await page.getByRole('button', { name: 'Sync', exact: true }).click()
    await expect(revision).toContainText('already current', { timeout: 120_000 })
    await expect(revision).toHaveAttribute('data-revision', String(plane.head))
    await expect(page.locator('[data-error]')).toHaveCount(0)
  })

  await test.step('and the synced copy still answers a query', async () => {
    await openPanel(page, 'data')
    await page.getByRole('button', { name: 'Run query' }).click()
    await expect(page.locator('#data-panel table.results tbody tr')).toHaveCount(15, {
      timeout: 180_000,
    })
    await expect(page.locator('.notice')).toContainText('The MITRE Corporation')
  })

  await test.step('and survives a reload at the revision it synced to', async () => {
    await page.reload()
    await expect(revision).toHaveAttribute('data-revision', String(plane.head), {
      timeout: 120_000,
    })
    await assertSearchable(page)
  })

  await test.step('a reopened copy that is behind catches itself up', async () => {
    // The automatic catch-up (UI polish, 2026-08-16): a page that opens on a
    // local copy more than twelve hours behind posts one `sync` by itself,
    // once the first report has answered. Whether it *should* have fired here
    // depends on the plane: the development slice is dated days ago, so it
    // does; the live origin's copy is hours old at most, so it does not. The
    // proof is the summary on the revision line — a fresh page starts with no
    // sync outcome, so one being there after a reload nobody clicked on is the
    // automatic sync and nothing else. `assertSearchable` above already waited
    // for the Worker to go quiet, which is what makes the negative half safe.
    const age = Date.now() - plane.generated * 1000
    const behind = age > AUTO_SYNC_AFTER_MS
    test.info().annotations.push({
      type: 'auto-sync',
      description: `copy ${(age / 3_600_000).toFixed(1)} h old — ${behind ? 'expected' : 'not expected'} to fire`,
    })
    if (behind) {
      await expect(revision).toContainText(/already current|update(s)? applied/, {
        timeout: 120_000,
      })
      await expect(revision).toHaveAttribute('data-revision', String(plane.head))
      await expect(page.locator('[data-error]')).toHaveCount(0)
    } else {
      await expect(revision).not.toContainText(/already current|update(s)? applied/)
    }
  })

  expect(failures, 'the page logged errors').toEqual([])
})

/**
 * The full-text indexes still answer after a sync maintained them.
 *
 * Not an integrity check — that is `rank = 1` and costs a rebuild (RE-005) —
 * but it is the one place in this suite where the browser's own fts5 is asked
 * about a corpus a delta has touched.
 */
async function assertSearchable(page: Page): Promise<void> {
  // After a reload the footer's Data & diagnostics disclosure is closed; the
  // demo query lives inside it. Idle first — a reload re-fires the canvas
  // auto-run and, on a copy that is behind, the automatic catch-up after it,
  // and either busy window would otherwise swallow the click below.
  await awaitIdle(page)
  await openPanel(page, 'data')
  await page.getByRole('button', { name: 'Run query' }).click()
  await expect(page.locator('#data-panel table.results tbody tr').first()).toBeVisible({
    timeout: 180_000,
  })
}
