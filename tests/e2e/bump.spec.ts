import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { SCHEMA_VERSION } from '../../lib/protocol'

import { skipWithoutLocalStorage } from './support'

/**
 * The half of a schema bump that needs **two real data planes** — the claim M3
 * and M4 deliberately could not make (D-068), because there was only one schema
 * to have. There are two now: `pipeline/pub` is schema 2 (D-070, D-075) and
 * `pipeline/pub-schema1` is the generation that preceded it.
 *
 * What this proves that nothing else can: a client that speaks the *old* schema
 * meets the *new* data plane and refuses before a byte of it is fetched, saying
 * the thing that helps — reload the page, because the app is what is behind and
 * re-downloading would fetch the same bytes and fail the same way. That is the
 * position every deployed browser is in during the deploy window, artifact
 * first (pipeline/README.md).
 *
 * **The mirror half — a new client meeting an old local copy — is exercised in
 * `query.spec.ts` with `?schema=`, and that is not a shortcut.** A build can
 * claim to read another schema version; it cannot *be* another build. Its
 * full-text index definition is compiled in (`lib/search.ts` covers
 * `cve_text.descr` **and** `cve_text.title`), so this build downloading the
 * schema-1 artifact would fail on `no such column: title` — not because the
 * announcement is broken but because the two halves of a bump ship together.
 * The announcement path compares two numbers and never branches on them, which
 * is what makes the version knob a faithful rehearsal of it.
 */

const OLD_PLANE = 'pipeline/pub-schema1'

function oldSchema(): number {
  const manifest = JSON.parse(readFileSync(join(OLD_PLANE, 'manifest.json'), 'utf-8')) as {
    schema: number
  }
  return manifest.schema
}

test('an old client refuses the new data plane, before a byte of it', async ({ page }) => {
  test.setTimeout(600_000)
  test.skip(
    !existsSync(join(OLD_PLANE, 'manifest.json')),
    `no pre-bump data plane at ${OLD_PLANE} — nothing to compare against`
  )

  const previous = oldSchema()
  expect(previous, 'the two planes are at the same schema, so this proves nothing').not.toBe(
    SCHEMA_VERSION
  )

  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(String(error)))

  const chunks: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith('/data/') && !path.endsWith('manifest.json')) chunks.push(path)
  })

  await test.step('the refusal names both versions and the action', async () => {
    // `?schema=` makes this build claim the old version, which is precisely the
    // position a deployed app is in the moment the new artifact lands.
    await page.goto(`/?schema=${previous}`)
    await skipWithoutLocalStorage(page)
    await page.getByRole('button', { name: /Download data/ }).click()

    const error = page.locator('[data-error]')
    await expect(error).toBeVisible({ timeout: 120_000 })
    await expect(error).toContainText(`schema ${SCHEMA_VERSION}`)
    await expect(error).toContainText(`schema ${previous}`)
    // "Re-download" would send the user round a loop; "reload" is what fixes it.
    await expect(error).toContainText('reload the page')
    await expect(error).toContainText('local copy is untouched')
  })

  await test.step('and nothing was fetched', async () => {
    // The manifest is read — it is what carries the version — and refused. No
    // chunk follows it, which is the claim the message makes about itself.
    expect(chunks).toEqual([])
    // Nor was anything written: an origin that was empty stays empty.
    const stored = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory()
      const names: string[] = []
      for await (const entry of root.values()) names.push(entry.name)
      return names.filter((name) => name.endsWith('.sqlite'))
    })
    expect(stored).toEqual([])
  })

  await test.step('the same browser, at the schema the plane speaks, downloads it', async () => {
    // The control: the refusal above is about the version, not about anything
    // else being wrong. And the new columns arrive, which is the point of the
    // bump (D-070) — asserted through the SQL console, so the assertion is
    // against the database rather than against a rendering of it.
    await page.goto('/')
    await page.getByRole('button', { name: /Download data/ }).click()
    await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible({ timeout: 300_000 })
    expect(chunks.length).toBeGreaterThan(0)

    await page.getByRole('tab', { name: 'SQL' }).click()
    await page
      .locator('textarea.sql-input')
      .fill(
        'SELECT count(reserved) AS reserved, count(ssvc_expl) AS assessed, ' +
          'count(*) - count(ssvc_expl) AS not_assessed FROM cve'
      )
    await page.getByRole('button', { name: 'Run SQL' }).click()
    await expect(page.locator('table.console tbody tr')).toHaveCount(1, { timeout: 120_000 })
    await expect(page.locator('[data-console-error]')).toHaveCount(0)

    const cells = page.locator('table.console tbody tr').first().locator('td')
    // `dateReserved` is 100% of the corpus, so this is a real check that the
    // column was populated rather than merely added.
    expect(Number(await cells.nth(0).innerText())).toBeGreaterThan(0)
    // And both SSVC states exist: assessed records *and* unassessed ones. If
    // the second were zero the projection would be inventing findings, which is
    // the failure D-070 is most concerned with.
    expect(Number(await cells.nth(1).innerText())).toBeGreaterThan(0)
    expect(Number(await cells.nth(2).innerText())).toBeGreaterThan(0)
  })

  await test.step('and a title is searchable, which is what put it in the index', async () => {
    await page.getByRole('tab', { name: 'Explore' }).click()
    await page.locator('#panel-explore').getByLabel('Search descriptions').fill('traversal')
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    await expect(page.locator('[data-matches]')).toBeVisible({ timeout: 120_000 })
    // Not an assertion about *which* records match — the slice is whatever the
    // corpus holds — only that the two-column index answers at all.
    expect(
      Number(await page.locator('[data-matches]').getAttribute('data-matches'))
    ).toBeGreaterThan(0)
  })

  expect(failures, `page errors:\n${failures.join('\n')}`).toEqual([])
})
