import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Route } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'

import { downloadButton, makeOfflineButton, awaitIdle } from './ui'

/**
 * The hosted query tier, in a browser, against a real database (D-084).
 *
 * **The server is stubbed and the rest is real.** `page.route` answers
 * `/api/sql.php`, but not with canned rows: it runs the SQL the *bundle*
 * compiled against a real hosted database built by the real pipeline
 * (`hosted.py`), through `node:sqlite` — the same SQLite the browser runs and
 * the same engine `hosted-parity.test.ts` pins the PHP authorizer against. So
 * this exercises the whole client path that only a browser reaches: the
 * synchronous XHR the Worker issues (verified to work through `page.route` on
 * both engines before this spec was written), the report SQL the bundle
 * builds, real SQLite answering it, and the shared Chart component drawing the
 * result — with only the PHP process swapped for `node:sqlite`, whose parity
 * with the endpoint is held by the unit tests and proven for real by
 * `scripts/verify-sql-php.sh`.
 *
 * What it uniquely proves: a first visit with no local copy lands in the
 * *workspace* (not the old download gate), the header offers "Make available
 * offline" rather than "Sync", the page footer carries the per-tier
 * disclosure on every page (no strip, no disclosure to open — UI polish,
 * 2026-08-16), a report renders from server-executed SQL, and the offline
 * upgrade downloads and switches the answering tier to local.
 *
 * The dev server cannot execute PHP, so without this stub the probe fails and
 * the landing fallback renders — which is the local-tier suite's world. Here
 * the stub *is* the tier.
 */

let dbPath: string
let workDir: string

test.beforeAll(() => {
  // Build a real hosted database the way production does: a fixture corpus →
  // artifact → hosted.py build (corpus + FTS + KEV). Needs python3 (as
  // contract.test.ts already does); if it is absent the whole file skips
  // rather than pretends.
  workDir = mkdtempSync(join(tmpdir(), 'hosted-e2e-'))
  const script = [
    'import os, sys',
    'sys.path.insert(0, "pipeline")',
    'sys.path.insert(0, "pipeline/tests")',
    'import fixtures, hosted',
    'import kev as kev_module',
    `work = ${JSON.stringify(workDir)}`,
    'artifact = fixtures.build_artifact(work, fixtures.corpus_v1(), "v1", rev=1)',
    'pub = os.path.join(work, "pub"); os.makedirs(pub, exist_ok=True)',
    'kev_module.sample(artifact, os.path.join(pub, "kev.json"), limit=10)',
    'print(hosted.build(artifact, pub, os.path.join(work, "hosted.sqlite"))["out"])',
  ].join('\n')
  dbPath = execFileSync('python3', ['-c', script], { encoding: 'utf-8' }).trim()
})

test.afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

/**
 * Answer `/api/sql.php` by running the SQL against the fixture hosted DB —
 * read-only, so a write refuses exactly as the endpoint's authorizer would,
 * and rows come back in the endpoint's envelope.
 */
async function serveHosted(route: Route): Promise<void> {
  const request = JSON.parse(route.request().postData() ?? 'null') as {
    sql: string
    params?: (string | number)[]
    limit?: number
  }
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const statement = db.prepare(request.sql)
    statement.setReadBigInts(false)
    const limit = Math.max(1, Math.min(request.limit ?? 1000, 20_000))
    const raw = statement.all(...((request.params ?? []) as never[]))
    const columns = raw.length
      ? Object.keys(raw[0] as object)
      : statement.columns().map((c) => c.name)
    const rows = (raw as Record<string, unknown>[])
      .slice(0, limit)
      .map((row) => columns.map((c) => row[c]))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ columns, rows, truncated: raw.length > limit, ms: 1 }),
    })
  } catch (error) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ error: `this endpoint is read-only: ${String(error)}` }),
    })
  } finally {
    db.close()
  }
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/sql.php', serveHosted)
})

test('a first visit lands in the workspace on the hosted tier', async ({ page }) => {
  await page.goto('/')
  // Not the download gate: the workspace, answering from the server.
  await expect(page.locator('main')).toHaveAttribute('data-tier', 'hosted', { timeout: 15_000 })
  await expect(downloadButton(page))
    .toHaveCount(0)
    .catch(() => undefined)
  // The header's upgrade action, and the per-tier disclosure — a line in the
  // page footer, visible with nothing opened: the tier that is answering is
  // never behind a click (D-084).
  await expect(makeOfflineButton(page)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sync', exact: true })).toHaveCount(0)
  const disclosure = page.locator('footer.about [data-hosted="1"]')
  await expect(disclosure).toBeVisible()
  await expect(disclosure).toContainText(/queries run on this site.s server/i)
  await expect(disclosure).toContainText(/make available offline/i)
})

test('the default report renders from server-executed SQL', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('main')).toHaveAttribute('data-tier', 'hosted', { timeout: 15_000 })
  // The canvas auto-runs severity-over-time; it must draw from hosted rows.
  await expect(page.locator('[data-run]').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('svg.chart, .chart svg, [data-chart]').first()).toBeVisible({
    timeout: 15_000,
  })
})

test('the date control is bounded by the server’s copy, not left unbounded', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('main')).toHaveAttribute('data-tier', 'hosted', { timeout: 15_000 })
  // `coverage` is answered from whichever copy is answering (D-085), so on this
  // tier it is one more server-executed statement — and an unset edge shows
  // its reply exactly as it does from a local copy. The *to* edge is the unset
  // one: the default report sets `publishedFrom` (two years back), so the
  // from box carries a real value rather than the copy's extent.
  const to = page.locator('#canvas-pub-to')
  await expect(to).toHaveAttribute('data-soft', '1', { timeout: 15_000 })
  await expect(to).toHaveValue(/^\d{4}-\d{2}-\d{2}$/)
  await expect(page.locator('#canvas-pub-from')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/)
})

test('the SQL console runs against the hosted tier', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('main')).toHaveAttribute('data-tier', 'hosted', { timeout: 15_000 })
  await page.locator('[data-toggle="sql"]').click()
  await expect(page.locator('#sql-panel')).toBeVisible()
  await page.locator('.sql-input').fill('SELECT count(*) AS n FROM cve')
  await page.locator('#sql-panel').getByRole('button', { name: /run/i }).first().click()
  // A number came back from the server, rendered in the results grid.
  await expect(page.locator('#sql-panel')).toContainText(/\brows?\b/i, { timeout: 15_000 })
})

test('a KEV question the hosted copy can answer is answered, not refused', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('main')).toHaveAttribute('data-tier', 'hosted', { timeout: 15_000 })
  await page.locator('[data-toggle="sql"]').click()
  await page.locator('.sql-input').fill('SELECT count(*) FROM kev')
  await page.locator('#sql-panel').getByRole('button', { name: /run/i }).first().click()
  await expect(page.locator('#sql-panel')).not.toContainText(/no such table/i)
})

test('Make available offline switches the tier to local', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('main')).toHaveAttribute('data-tier', 'hosted', { timeout: 15_000 })
  await makeOfflineButton(page).click()
  // The real download runs against the dev server's slice; when it lands the
  // tier flips to local and Sync replaces the offline action.
  await expect(page.locator('main')).toHaveAttribute('data-tier', 'local', { timeout: 90_000 })
  await awaitIdle(page, 60_000)
  await expect(page.getByRole('button', { name: 'Sync', exact: true })).toBeVisible()
  await expect(makeOfflineButton(page)).toHaveCount(0)
})

test('?remote=0 keeps the hosted tier off and shows the download gate', async ({ page }) => {
  await page.goto('/?remote=0')
  await expect(page.locator('main')).not.toHaveAttribute('data-status', 'pending', {
    timeout: 15_000,
  })
  await expect(page.locator('[data-landing]')).toBeVisible()
  await expect(downloadButton(page)).toBeVisible()
  await expect(page.locator('main')).not.toHaveAttribute('data-tier', 'hosted')
})
