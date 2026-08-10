import { expect, test, type Page } from '@playwright/test'

import { requireLocalStorage } from './support'

import { awaitIdle, downloadButton, openPanel } from './ui'

import type { Manifest, Timings } from '../../lib/protocol'

/**
 * Staged replacement (D-061) and the download's failure-and-resume matrix (M2),
 * as tests.
 *
 * The property under test is not "download works" — `import.spec.ts` covers
 * that. It is that a download the user *starts and loses* costs them nothing:
 * the copy they already had stays queryable throughout, and the chunks that did
 * land are not fetched a second time.
 *
 * The interruption is deterministic (`?stop=1`) rather than raced, because a
 * 10 MB download over loopback finishes long before a test could kill it — see
 * `ImportOptions.stopAfterChunks`. The failures that need the *network* to
 * misbehave — a corrupted chunk, a rotated snapshot, a dead connection — are
 * produced with `page.route`, which sees the Worker's requests as well as the
 * page's (verified 2026-08-05 on Playwright 1.62 before these were written).
 */
test('an interrupted download resumes and never destroys the live copy', async ({ page }) => {
  // Generous because this spec is also worth pointing at the full corpus, where
  // one import is minutes. It is a stall detector, not a budget (D-052).
  test.setTimeout(600_000)

  const failures = watchForErrors(page)

  await page.goto('/')
  await requireLocalStorage(page)
  const first = await test.step('a first, complete download', async () => {
    await startDownload(page)
    const timings = await importedTimings(page)
    expect(timings.chunksFetched).toBe(timings.chunksTotal)
    expect(timings.chunksTotal).toBeGreaterThan(1)
    return timings
  })

  const rows = await test.step('and it answers a query', async () => {
    await page.getByRole('button', { name: 'Run query' }).click()
    await expect(page.locator('#data-panel table.results tbody tr')).toHaveCount(15, {
      timeout: 120_000,
    })
    return await page
      .locator('#data-panel table.results tbody tr')
      .first()
      .locator('td')
      .nth(1)
      .innerText()
  })

  await test.step('a download that dies partway leaves the live copy usable', async () => {
    // `?stop=1` aborts after one chunk has landed and been recorded — the same
    // state a closed laptop would leave behind.
    await page.goto('/?stop=1')
    await openDataControls(page)
    await page.getByRole('button', { name: 'Re-download data' }).click()
    await expect(page.locator('[data-error]')).toContainText('stopAfterChunks', {
      timeout: 180_000,
    })

    // The button still offers a *re*-download, which is the UI saying a local
    // copy is still there. M1's import would have truncated it by now.
    await expect(page.getByRole('button', { name: 'Re-download data' })).toBeEnabled({
      timeout: 60_000,
    })
    // The notice is a proxy for "the database is open and readable" — it is
    // read out of the copy's own `meta` table (D-008).
    await expect(page.locator('.notice')).toContainText('The MITRE Corporation')

    await page.getByRole('button', { name: 'Run query' }).click()
    await expect(page.locator('#data-panel table.results tbody tr')).toHaveCount(15, {
      timeout: 120_000,
    })
    // The same count as before the failed download. Only one generation is
    // reachable locally, so this cannot tell the old copy from a hypothetical
    // different correct one — it does catch a truncated or partial database.
    await expect(
      page.locator('#data-panel table.results tbody tr').first().locator('td').nth(1)
    ).toHaveText(rows)

    // The Import panel from the earlier successful run must not survive: its
    // "OPFS footprint" row omits the staged file this failure just left behind,
    // which at full scale understates the origin by ~440 MB.
    await expect(page.locator('.timings')).toHaveCount(0)

    // Three entries, which is what makes the resume below meaningful and what
    // the dedicated clear test operates on.
    await page.goto('/no-such-page')
    expect(await opfsEntries(page)).toEqual(['cve-a.sqlite', 'cve-b.sqlite', 'staging.json'])
  })

  await test.step('resuming refetches only the chunks that are missing', async () => {
    await page.goto('/')
    await openDataControls(page)
    await page.getByRole('button', { name: 'Re-download data' }).click()
    const resumed = await importedTimings(page)

    expect(resumed.chunksTotal).toBe(first.chunksTotal)
    // The one chunk the interrupted run staged is not fetched again.
    expect(resumed.chunksFetched).toBe(first.chunksTotal - 1)
    expect(resumed.records).toBe(first.records)

    // And the promotion swept both the copy it replaced and the resume record.
    // Asserted as an exact entry set rather than a byte ceiling: a ceiling says
    // only that some number stayed small, and the tightest leak it must catch —
    // one un-swept slot — clears it by under 10%.
    await awaitIdle(page, 300_000)
    await page.goto('/no-such-page')
    expect(await opfsEntries(page)).toEqual(['cve-b.sqlite'])
  })

  await test.step('the promoted copy is the one being queried', async () => {
    await page.goto('/')
    await openDataControls(page)
    // A fresh page, and therefore a fresh Worker, proves the promotion is on
    // disk rather than in the importing Worker's head: discovery has to find
    // the live slot by itself, from the file headers (D-061).
    await page.getByRole('button', { name: 'Run query' }).click()
    await expect(page.locator('#data-panel table.results tbody tr')).toHaveCount(15, {
      timeout: 120_000,
    })
    await expect(
      page.locator('#data-panel table.results tbody tr').first().locator('td').nth(1)
    ).toHaveText(rows)
  })

  expect(failures, `console/page errors:\n${failures.join('\n')}`).toEqual([])
})

/**
 * Clearing has to remove the *staged* copy, and the only moment that is a real
 * question is while a half-finished download is on disk. After a clean
 * promotion the sweep has already removed the staged slot and the record, so
 * clearing then proves nothing beyond "one live database can be deleted" —
 * which is what the earlier version of this assertion actually tested.
 */
test('clearing removes a half-finished download, not just the live copy', async ({ page }) => {
  test.setTimeout(600_000)
  const failures = watchForErrors(page)

  await page.goto('/')
  await startDownload(page)
  await importedTimings(page)
  // Before navigating away: the download continues into a catch-up and a KEV
  // refresh, and killing the Worker mid-transaction leaves a journal beside the
  // live file that the exact-set assertion below would count as an extra entry.
  await awaitIdle(page, 300_000)

  await page.goto('/?stop=1')
  await openDataControls(page)
  await page.getByRole('button', { name: 'Re-download data' }).click()
  await expect(page.locator('[data-error]')).toContainText('stopAfterChunks', { timeout: 180_000 })

  await page.goto('/no-such-page')
  expect(await opfsEntries(page)).toEqual(['cve-a.sqlite', 'cve-b.sqlite', 'staging.json'])

  await page.goto('/')
  // Wait for the page to *report* the local copy before clearing it. Clicking
  // straight after the navigation is a trap: navigating away too soon kills
  // the Worker mid-clear. `openDataControls` waits for the workspace to come
  // up idle — a status message arrived and a copy is live — before opening
  // the panel that holds the Clear button.
  await openDataControls(page)
  await page.getByRole('button', { name: 'Clear local copy' }).click()
  await expect(page.getByRole('button', { name: 'Download CVE dataset', exact: true })).toBeVisible(
    {
      timeout: 60_000,
    }
  )

  await page.goto('/no-such-page')
  // Nothing of ours survives — not the live slot, not the staged one, not the
  // resume record. `.opfs-sahpool` is only ever created by the measurement
  // sweep, and this run never asked for it.
  expect(await opfsEntries(page)).toEqual([])

  // And the record is gone in the sense that matters: the next download has
  // nothing to resume and fetches everything.
  await page.goto('/')
  await startDownload(page)
  const restarted = await importedTimings(page)
  expect(restarted.chunksFetched).toBe(restarted.chunksTotal)

  expect(failures, `console/page errors:\n${failures.join('\n')}`).toEqual([])
})

/**
 * The upgrade path every M1 visitor takes exactly once (D-061).
 *
 * It matters more than it looks: the entries this build does not recognise get
 * swept, so a copy under M1's name that is *not* adopted is not merely ignored
 * — it is deleted, and the visitor pays for a full re-download without ever
 * being told why.
 */
test('a copy under M1’s name is adopted, then retired by the first promotion', async ({ page }) => {
  test.setTimeout(600_000)
  const failures = watchForErrors(page)

  await page.goto('/')
  await startDownload(page)
  await importedTimings(page)
  await awaitIdle(page, 300_000)

  // Rewrite the local copy into what M1 left behind: the legacy file name and
  // no promotion counter. Done from a page with no Worker, because the live
  // slot cannot be removed while the database is open.
  await page.goto('/no-such-page')
  expect(await opfsEntries(page)).toEqual(['cve-a.sqlite'])
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const source = await (await root.getFileHandle('cve-a.sqlite')).getFile()
    const legacy = await root.getFileHandle('cve.sqlite', { create: true })
    const writable = await legacy.createWritable()
    await writable.write(source)
    await writable.close()
    // user_version lives at byte 60 of the header; zero is what the pipeline
    // publishes and what M1 never changed.
    const patch = await legacy.createWritable({ keepExistingData: true })
    await patch.write({ type: 'write', position: 60, data: new Uint8Array(4) })
    await patch.close()
    await root.removeEntry('cve-a.sqlite')
  })
  expect(await opfsEntries(page)).toEqual(['cve.sqlite'])

  await test.step('it is adopted rather than swept', async () => {
    await page.goto('/')
    await openDataControls(page)
    await page.getByRole('button', { name: 'Run query' }).click()
    await expect(page.locator('#data-panel table.results tbody tr')).toHaveCount(15, {
      timeout: 120_000,
    })
  })

  await test.step('and the first promotion retires it', async () => {
    await page.getByRole('button', { name: 'Re-download data' }).click()
    const timings = await importedTimings(page)
    // One generation on disk, not two: the legacy copy is gone and the slot it
    // was staged beside is the only database left.
    expect(timings.opfsBytes!).toBeLessThan(timings.rawBytes * 2)
    await awaitIdle(page, 300_000)
    await page.goto('/no-such-page')
    expect(await opfsEntries(page)).toEqual(['cve-a.sqlite'])
  })

  expect(failures, `console/page errors:\n${failures.join('\n')}`).toEqual([])
})

/**
 * Regression: a failed *read* must not license a delete.
 *
 * `tidy` removes everything not on its keep list, and the keep list is derived
 * from discovery. When discovery collapsed "I could not tell" into "there is
 * nothing here", one unreadable entry made a routine status poll delete the
 * live database — no error, no warning, just a Download button where 441 MB
 * used to be (D-061).
 */
test('a discovery failure leaves the local copy alone', async ({ page }) => {
  test.setTimeout(600_000)
  const failures = watchForErrors(page)

  await page.goto('/')
  await startDownload(page)
  await importedTimings(page)
  await awaitIdle(page, 300_000)

  await page.goto('/no-such-page')
  expect(await opfsEntries(page)).toEqual(['cve-a.sqlite'])
  // A *directory* where a database file would go. `getFileHandle` raises
  // TypeMismatchError on it — standing in for any non-NotFound failure the
  // header probe can hit (a locked file, an unreadable snapshot).
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    await root.getDirectoryHandle('cve-b.sqlite', { create: true })
  })

  await page.goto('/')
  // Wait for the Worker to have *answered*, not merely for a button to render.
  // `main[data-status]` leaves "pending" only once a status message lands, and
  // anything the discovery path does to storage happens before that message is
  // posted — so without this the assertion below races the very sweep it exists
  // to catch, and passes against the broken code.
  await expect(page.locator('main')).not.toHaveAttribute('data-status', 'pending', {
    timeout: 60_000,
  })
  // The live copy is still found and still usable — an entry we cannot examine
  // in the *other* slot is no reason to take the user's database away from
  // them. What it does cost is the sweep.
  await expect(page.locator('main')).toHaveAttribute('data-status', 'ready')
  await openPanel(page, 'data')
  await page.getByRole('button', { name: 'Run query' }).click()
  await expect(page.locator('#data-panel table.results tbody tr')).toHaveCount(15, {
    timeout: 120_000,
  })

  await page.goto('/no-such-page')
  expect(await opfsEntries(page)).toEqual(['cve-a.sqlite', 'cve-b.sqlite'])

  // And once the obstruction is gone the copy is simply there again — proving
  // the database survived intact rather than being rebuilt.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry('cve-b.sqlite')
  })
  await page.goto('/')
  await openDataControls(page)
  await page.getByRole('button', { name: 'Run query' }).click()
  await expect(page.locator('#data-panel table.results tbody tr')).toHaveCount(15, {
    timeout: 120_000,
  })

  expect(failures, `console/page errors:\n${failures.join('\n')}`).toEqual([])
})

/**
 * Regression: a resume record that outlives its file must not be believed.
 *
 * `bindsTo` proves the bitmap describes this *download*; only the file's length
 * proves it describes these *bytes*. Without that second check the run fetched
 * only the chunks the bitmap called pending into a freshly zero-filled file,
 * handed promotion a database with a hole in it, and — because the failed run
 * completed the bitmap — every retry then failed in seconds without fetching
 * anything, with no escape but destroying the good copy (D-061).
 */
test('a resume record that outlived its file is discarded, not believed', async ({ page }) => {
  test.setTimeout(600_000)
  const failures = watchForErrors(page)

  await page.goto('/')
  await startDownload(page)
  const first = await importedTimings(page)
  await page.getByRole('button', { name: 'Run query' }).click()
  await expect(page.locator('#data-panel table.results tbody tr')).toHaveCount(15, {
    timeout: 120_000,
  })
  const rows = await page
    .locator('#data-panel table.results tbody tr')
    .first()
    .locator('td')
    .nth(1)
    .innerText()

  // A record claiming every chunk but the first has already been staged into a
  // file that does not exist at all.
  await page.goto('/no-such-page')
  await page.evaluate(async () => {
    const manifest = await (await fetch('/data/manifest.json', { cache: 'no-cache' })).json()
    const snapshot = manifest.snapshot
    const chunks = [...snapshot.chunks]
      .sort((a: { offset: number }, b: { offset: number }) => a.offset - b.offset)
      .map((c: { name: string; offset: number; raw_bytes: number; sha256: string }) => ({
        name: c.name,
        offset: c.offset,
        rawBytes: c.raw_bytes,
        sha256: c.sha256,
      }))
    const record = {
      v: 1,
      file: 'cve-b.sqlite',
      path: snapshot.path,
      rev: typeof snapshot.rev === 'number' ? snapshot.rev : null,
      rawBytes: snapshot.raw_bytes,
      chunks,
      done: chunks.map((_: unknown, index: number) => index > 0),
    }
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle('staging.json', { create: true })
    const writable = await handle.createWritable()
    await writable.write(JSON.stringify(record))
    await writable.close()
  })

  await page.goto('/')
  await openDataControls(page)
  await page.getByRole('button', { name: 'Re-download data' }).click()
  const redone = await importedTimings(page)

  // Every chunk refetched, not just the one the record called pending.
  expect(redone.chunksFetched).toBe(redone.chunksTotal)
  expect(redone.records).toBe(first.records)
  await page.getByRole('button', { name: 'Run query' }).click()
  // Wait for the rows first: `toHaveText` carries Playwright's 5 s default, and
  // the first query after a full-corpus import spends ~9 s warming the page
  // cache — a ceiling D-052 says this project does not have.
  await expect(page.locator('#data-panel table.results tbody tr')).toHaveCount(15, {
    timeout: 120_000,
  })
  await expect(
    page.locator('#data-panel table.results tbody tr').first().locator('td').nth(1)
  ).toHaveText(rows)

  expect(failures, `console/page errors:\n${failures.join('\n')}`).toEqual([])
})

/**
 * Regression: sidecars are cleared before a slot's main file is reused.
 *
 * A crash during index building leaves a rollback journal describing the
 * generation that was in the slot. Overwriting only the main file pairs the new
 * bytes with the old journal, and SQLite replays it at open — the file we
 * verified byte-for-byte stops being that file, and the promotion gate then
 * inspects something else entirely. Reproduced outside the browser (D-061), and
 * documented by SQLite as a corruption path.
 *
 * The planted sidecar is a superjournal (`-mj…`) rather than a `-journal`: a
 * malformed `-journal` is deleted by SQLite's own recovery, so the slot ends up
 * clean whether or not this client did anything, and the test would pass
 * against the bug. Nothing in SQLite's open path touches a superjournal name it
 * did not create, so its survival is attributable.
 */
test('sidecars beside a staging slot are cleared before its bytes are reused', async ({ page }) => {
  test.setTimeout(600_000)
  const failures = watchForErrors(page)

  await page.goto('/')
  await startDownload(page)
  const first = await importedTimings(page)
  await page.getByRole('button', { name: 'Run query' }).click()
  await expect(page.locator('#data-panel table.results tbody tr')).toHaveCount(15, {
    timeout: 120_000,
  })
  const rows = await page
    .locator('#data-panel table.results tbody tr')
    .first()
    .locator('td')
    .nth(1)
    .innerText()

  // The state an aborted index build leaves behind, followed by a rotation: a
  // sidecar beside the staging slot, and a resume record that keeps the slot
  // from being reclaimed but whose bitmap no longer covers it — so the next run
  // rewrites the main file rather than reopening it.
  await page.goto('/no-such-page')
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const write = async (name: string, bytes: BufferSource | string) => {
      const handle = await root.getFileHandle(name, { create: true })
      const writable = await handle.createWritable()
      await writable.write(bytes)
      await writable.close()
    }
    await write('cve-b.sqlite', new Uint8Array(4096))
    await write('cve-b.sqlite-mj0a1b2c3d', new Uint8Array(8192).fill(0xd9))

    const manifest = await (await fetch('/data/manifest.json', { cache: 'no-cache' })).json()
    const snapshot = manifest.snapshot
    const chunks = [...snapshot.chunks]
      .sort((a: { offset: number }, b: { offset: number }) => a.offset - b.offset)
      .map((c: { name: string; offset: number; raw_bytes: number; sha256: string }) => ({
        name: c.name,
        offset: c.offset,
        rawBytes: c.raw_bytes,
        sha256: c.sha256,
      }))
    await write(
      'staging.json',
      JSON.stringify({
        v: 1,
        file: 'cve-b.sqlite',
        path: snapshot.path,
        rev: typeof snapshot.rev === 'number' ? snapshot.rev : null,
        rawBytes: snapshot.raw_bytes,
        chunks,
        done: chunks.map((_: unknown, index: number) => index === 0),
      })
    )
  })
  expect(await opfsEntries(page)).toContain('cve-b.sqlite-mj0a1b2c3d')

  await page.goto('/')
  await openDataControls(page)
  await page.getByRole('button', { name: 'Re-download data' }).click()
  const redone = await importedTimings(page)
  expect(redone.records).toBe(first.records)

  // Gone, and the promoted database answers the same query.
  await awaitIdle(page, 300_000)
  await page.goto('/no-such-page')
  expect(await opfsEntries(page)).toEqual(['cve-b.sqlite'])
  await page.goto('/')
  await openDataControls(page)
  await page.getByRole('button', { name: 'Run query' }).click()
  await expect(page.locator('#data-panel table.results tbody tr')).toHaveCount(15, {
    timeout: 120_000,
  })
  await expect(
    page.locator('#data-panel table.results tbody tr').first().locator('td').nth(1)
  ).toHaveText(rows)

  expect(failures, `console/page errors:\n${failures.join('\n')}`).toEqual([])
})

/**
 * Regression: a file header is not the authority on which slot is live.
 *
 * `user_version` sits at header offset 60 and reading it directly is a hundred
 * bytes instead of an open — but the bytes on disk are not the committed state.
 * SQLite writes the dirty pages and only then deletes the rollback journal, so
 * a crash between those steps leaves a header advertising a promotion that the
 * next open rolls straight back (reproduced offline, D-061). Believing it picks
 * the wrong slot as live.
 *
 * The in-browser stand-in is a slot whose header claims a high counter and
 * which SQLite cannot open at all: the raw reader ranks it first and loses the
 * real database behind it; asking SQLite skips it.
 */
test('a slot whose header claims a promotion SQLite cannot confirm is not live', async ({
  page,
}) => {
  test.setTimeout(600_000)
  const failures = watchForErrors(page)

  await page.goto('/')
  await startDownload(page)
  await importedTimings(page)
  await page.getByRole('button', { name: 'Run query' }).click()
  await expect(page.locator('#data-panel table.results tbody tr')).toHaveCount(15, {
    timeout: 120_000,
  })
  const rows = await page
    .locator('#data-panel table.results tbody tr')
    .first()
    .locator('td')
    .nth(1)
    .innerText()

  await page.goto('/no-such-page')
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    // The real header, so the magic and page size are genuine, with the
    // promotion counter raised and nothing behind it.
    const live = await (await root.getFileHandle('cve-a.sqlite')).getFile()
    const header = new Uint8Array(await live.slice(0, 100).arrayBuffer())
    new DataView(header.buffer).setUint32(60, 99, false)
    const handle = await root.getFileHandle('cve-b.sqlite', { create: true })
    const writable = await handle.createWritable()
    await writable.write(header)
    await writable.close()
  })

  await page.goto('/')
  // The real copy is still what the page reports and queries.
  await expect(page.locator('main')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
  await openPanel(page, 'data')
  await page.getByRole('button', { name: 'Run query' }).click()
  await expect(page.locator('#data-panel table.results tbody tr')).toHaveCount(15, {
    timeout: 120_000,
  })
  await expect(
    page.locator('#data-panel table.results tbody tr').first().locator('td').nth(1)
  ).toHaveText(rows)

  expect(failures, `console/page errors:\n${failures.join('\n')}`).toEqual([])
})

/**
 * Regression: a crash *after* the chunks land must not refetch the snapshot.
 *
 * D-061 promises the retry starts at the index build, because the bitmap is
 * already complete. That only holds if the staleness check tolerates the file
 * having grown: the client builds its indexes into the staged database (D-035),
 * taking it well past `raw_bytes`, so an exact-length test reads a completed
 * download as a stale record and throws away every chunk.
 */
test('a crash during index building resumes at the index build, not the download', async ({
  page,
}) => {
  test.setTimeout(600_000)
  const failures = watchForErrors(page)

  await page.goto('/')
  await startDownload(page)
  const first = await importedTimings(page)

  // Reconstruct the state a kill during index building leaves: every chunk on
  // disk, a complete bitmap, and a file already grown by a partial index.
  await page.goto('/no-such-page')
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const source = await (await root.getFileHandle('cve-a.sqlite')).getFile()
    const staged = await root.getFileHandle('cve-b.sqlite', { create: true })
    const writable = await staged.createWritable()
    await writable.write(source)
    await writable.close()
    // Unpromoted: this is a staging file, not a second live copy.
    const patch = await staged.createWritable({ keepExistingData: true })
    await patch.write({ type: 'write', position: 60, data: new Uint8Array(4) })
    await patch.close()

    const manifest = await (await fetch('/data/manifest.json', { cache: 'no-cache' })).json()
    const snapshot = manifest.snapshot
    const chunks = [...snapshot.chunks]
      .sort((a: { offset: number }, b: { offset: number }) => a.offset - b.offset)
      .map((c: { name: string; offset: number; raw_bytes: number; sha256: string }) => ({
        name: c.name,
        offset: c.offset,
        rawBytes: c.raw_bytes,
        sha256: c.sha256,
      }))
    const record = await root.getFileHandle('staging.json', { create: true })
    const out = await record.createWritable()
    await out.write(
      JSON.stringify({
        v: 1,
        file: 'cve-b.sqlite',
        path: snapshot.path,
        rev: typeof snapshot.rev === 'number' ? snapshot.rev : null,
        rawBytes: snapshot.raw_bytes,
        chunks,
        done: chunks.map(() => true),
      })
    )
    await out.close()
  })

  await page.goto('/')
  await openDataControls(page)
  await page.getByRole('button', { name: 'Re-download data' }).click()
  const resumed = await importedTimings(page)

  // Not one chunk crossed the wire.
  expect(resumed.chunksFetched).toBe(0)
  expect(resumed.chunksTotal).toBe(first.chunksTotal)
  expect(resumed.records).toBe(first.records)

  await page.getByRole('button', { name: 'Run query' }).click()
  await expect(page.locator('#data-panel table.results tbody tr')).toHaveCount(15, {
    timeout: 120_000,
  })

  expect(failures, `console/page errors:\n${failures.join('\n')}`).toEqual([])
})

/**
 * Regression: an unreadable *live* file must not be reclaimed as an empty
 * origin.
 *
 * The probe cannot open every file it finds, and returning "no database" for
 * one it could not read hands the sweep an empty keep list — over what may be
 * the user's only copy. The earlier fix covered errors raised before the open
 * (a directory where a file belongs); this covers the open itself.
 */
test('a local copy that cannot be opened is reported unknown, not deleted', async ({ page }) => {
  test.setTimeout(600_000)
  const failures = watchForErrors(page)

  await page.goto('/')
  await startDownload(page)
  await importedTimings(page)
  await awaitIdle(page, 300_000)

  await page.goto('/no-such-page')
  expect(await opfsEntries(page)).toEqual(['cve-a.sqlite'])
  // Make the one database on disk unopenable, leaving nothing else behind.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle('cve-a.sqlite', { create: true })
    const writable = await handle.createWritable()
    await writable.write(new Uint8Array(4096).fill(0x41))
    await writable.close()
  })

  await page.goto('/')
  await expect(page.locator('main')).toHaveAttribute('data-status', 'unknown', { timeout: 60_000 })
  await expect(page.locator('[data-error]')).toContainText('unknown')

  // Still there. "I could not read it" is not a licence to delete it.
  await page.goto('/no-such-page')
  expect(await opfsEntries(page)).toEqual(['cve-a.sqlite'])

  expect(failures, `console/page errors:\n${failures.join('\n')}`).toEqual([])
})

/**
 * A published-style corpus — real `meta`, real records, valid schema — carrying
 * `user_version = 99` and **no client-built FTS tables**. 2 KB, generated
 * offline. It stands for publisher drift: an artifact that arrives already
 * carrying a counter, which nothing upstream forbids.
 */
const UNINDEXED_CORPUS =
  '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'

/**
 * Regression: a counter without the client-built indexes is not a promotion.
 *
 * The promotion gate runs before `buildSearchIndexes`, so it cannot be what
 * proves a promotion finished. The FTS tables can: nothing but this client
 * creates them, and it does so immediately before writing the counter. Without
 * that check, an artifact that ever shipped with a non-zero `user_version`
 * would be adopted straight out of a staging file — retiring the real copy and
 * leaving a database that cannot be searched.
 */
test('a counter on a corpus with no client-built indexes does not win discovery', async ({
  page,
}) => {
  test.setTimeout(600_000)
  const failures = watchForErrors(page)

  await page.goto('/')
  await startDownload(page)
  await importedTimings(page)
  await page.getByRole('button', { name: 'Run query' }).click()
  await expect(page.locator('#data-panel table.results tbody tr')).toHaveCount(15, {
    timeout: 120_000,
  })
  const rows = await page
    .locator('#data-panel table.results tbody tr')
    .first()
    .locator('td')
    .nth(1)
    .innerText()

  await page.goto('/no-such-page')
  await page.evaluate(async (base64: string) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle('cve-b.sqlite', { create: true })
    const writable = await handle.createWritable()
    await writable.write(bytes)
    await writable.close()
  }, UNINDEXED_CORPUS)

  await page.goto('/')
  await expect(page.locator('main')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
  await openPanel(page, 'data')
  await page.getByRole('button', { name: 'Run query' }).click()
  await expect(page.locator('#data-panel table.results tbody tr')).toHaveCount(15, {
    timeout: 120_000,
  })
  await expect(
    page.locator('#data-panel table.results tbody tr').first().locator('td').nth(1)
  ).toHaveText(rows)

  await page.goto('/no-such-page')
  expect(await opfsEntries(page)).toEqual(['cve-a.sqlite'])

  expect(failures, `console/page errors:\n${failures.join('\n')}`).toEqual([])
})

/**
 * A minimal, perfectly valid SQLite database carrying `user_version = 99` and
 * no `meta` table — 512 bytes, generated offline. It stands for anything that
 * opens but is not this app's corpus.
 */
const DECOY_DATABASE =
  'U1FMaXRlIGZvcm1hdCAzAAIAAQEAQCAgAAAAAQAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAC52iQ0AAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

/**
 * Regression: a promotion counter is not evidence on its own.
 *
 * Discovery retires the other slot on the strength of the counter, so a file
 * that merely *carries* one must not win — only one this build would actually
 * serve. Otherwise anything that opens, with a high enough number in its
 * header, evicts the user's real corpus.
 */
test('a high counter on a database this build would not serve does not win discovery', async ({
  page,
}) => {
  test.setTimeout(600_000)
  const failures = watchForErrors(page)

  await page.goto('/')
  await startDownload(page)
  await importedTimings(page)
  await page.getByRole('button', { name: 'Run query' }).click()
  await expect(page.locator('#data-panel table.results tbody tr')).toHaveCount(15, {
    timeout: 120_000,
  })
  const rows = await page
    .locator('#data-panel table.results tbody tr')
    .first()
    .locator('td')
    .nth(1)
    .innerText()

  await page.goto('/no-such-page')
  await page.evaluate(async (base64: string) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle('cve-b.sqlite', { create: true })
    const writable = await handle.createWritable()
    await writable.write(bytes)
    await writable.close()
  }, DECOY_DATABASE)

  await page.goto('/')
  // The real copy is still live and still answers.
  await expect(page.locator('main')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
  await openPanel(page, 'data')
  await page.getByRole('button', { name: 'Run query' }).click()
  await expect(page.locator('#data-panel table.results tbody tr')).toHaveCount(15, {
    timeout: 120_000,
  })
  await expect(
    page.locator('#data-panel table.results tbody tr').first().locator('td').nth(1)
  ).toHaveText(rows)

  // And the decoy is reclaimed rather than promoted: it opened, so discovery
  // saw the whole picture and the sweep was safe to run.
  await page.goto('/no-such-page')
  expect(await opfsEntries(page)).toEqual(['cve-a.sqlite'])

  expect(failures, `console/page errors:\n${failures.join('\n')}`).toEqual([])
})

/**
 * A chunk that fails its SHA-256, which had no test at any level (M2).
 *
 * The manifest's per-chunk hash is the only thing standing between a corrupted
 * transfer and a promoted database, and it is checked *before* decompression —
 * so the bad bytes never reach the staging file, its bit is never recorded, and
 * the download is refused rather than promoted. All three are asserted here:
 * the refusal names the checksum, the live copy is untouched, and the retry
 * fetches the chunk that failed instead of trusting a bitmap that claims it.
 */
test('a chunk that fails its checksum refuses the download, and the retry refetches it', async ({
  page,
}) => {
  test.setTimeout(600_000)
  const failures = watchForErrors(page)

  await page.goto('/')
  await startDownload(page)
  const first = await importedTimings(page)
  const rows = await queryFirstCell(page)

  // Corrupt the *last* chunk, so the ones before it land and are recorded —
  // which is what makes the resume assertion below mean something.
  const chunks = await snapshotChunks(page)
  const doomed = chunks[chunks.length - 1]!
  let corruptions = 0
  await page.route(`**/${doomed}`, async (route) => {
    const response = await route.fetch()
    const body = Buffer.from(await response.body())
    // One byte, in the middle: enough to fail SHA-256, and nothing else about
    // the response changes — same length, same headers, same status.
    const at = Math.floor(body.length / 2)
    body[at] = (body[at] ?? 0) ^ 0xff
    corruptions += 1
    await route.fulfill({ response, body })
  })

  await test.step('the download is refused and says why', async () => {
    await page.getByRole('button', { name: 'Re-download data' }).click()
    await expect(page.locator('[data-error]')).toContainText('checksum mismatch', {
      timeout: 180_000,
    })
    expect(corruptions).toBeGreaterThan(0)
  })

  await test.step('and the copy the user already had still answers', async () => {
    await expect(page.getByRole('button', { name: 'Re-download data' })).toBeEnabled()
    await expect(page.locator('.notice')).toContainText('The MITRE Corporation')
    expect(await queryFirstCell(page)).toBe(rows)
  })

  await test.step('the retry refetches the chunk that failed', async () => {
    await page.unroute(`**/${doomed}`)
    await page.goto('/')
    await openDataControls(page)
    await page.getByRole('button', { name: 'Re-download data' }).click()
    const retried = await importedTimings(page)

    // At least the corrupted one, and never all of them at the scale this runs
    // at by default: the chunks that landed before the failure are still
    // staged. A bitmap that had recorded the failed chunk would show zero here
    // and promote a database with a hole where its bytes belong.
    expect(retried.chunksFetched).toBeGreaterThan(0)
    expect(retried.chunksFetched).toBeLessThan(retried.chunksTotal)
    expect(retried.records).toBe(first.records)
    expect(await queryFirstCell(page)).toBe(rows)
  })

  expect(failures, `console/page errors:\n${failures.join('\n')}`).toEqual([])
})

/**
 * A snapshot rotation mid-download (M2).
 *
 * The *decision* is unit-tested — `bindsTo` refuses a record whose plan names a
 * different generation — but the file behaviour was not: what has to be true is
 * that the client is never stranded. It keeps the copy it has, it never resumes
 * one generation's download into another's staging file, and the next download
 * simply starts over against the generation the origin now advertises.
 *
 * The rotation is served rather than performed: the manifest is rewritten to
 * name a different snapshot directory, whose chunks resolve to the real ones.
 * That is what a D-060 rotation looks like to a client — the same content at a
 * new immutable path — and it exercises the one thing that matters here, a
 * staged file left over from a path the manifest no longer names.
 */
test('a snapshot rotation mid-download starts over rather than stranding the client', async ({
  page,
}) => {
  test.setTimeout(600_000)
  const failures = watchForErrors(page)

  await page.goto('/')
  await startDownload(page)
  const first = await importedTimings(page)
  const rows = await queryFirstCell(page)

  await test.step('a download dies partway, leaving a staged generation behind', async () => {
    await page.goto('/?stop=1')
    await openDataControls(page)
    await page.getByRole('button', { name: 'Re-download data' }).click()
    await expect(page.locator('[data-error]')).toContainText('stopAfterChunks', {
      timeout: 180_000,
    })
    await page.goto('/no-such-page')
    expect(await opfsEntries(page)).toContain('staging.json')
  })

  // From here the origin advertises a different generation at a different
  // path. `ROTATED` is a directory name of the shape publish.py writes, which
  // is the only shape the client will fetch from (D-055).
  const ROTATED = 'snapshot-99999'
  const published = await page.evaluate(async () => {
    const manifest = await (await fetch('/data/manifest.json', { cache: 'no-cache' })).json()
    return manifest.snapshot.path as string
  })
  await page.route('**/data/manifest.json', async (route) => {
    const response = await route.fetch()
    const manifest = (await response.json()) as Manifest
    manifest.snapshot.path = ROTATED
    await route.fulfill({ response, json: manifest })
  })
  await page.route(`**/data/${ROTATED}/*.br`, async (route) => {
    // The rotated generation holds the same bytes at a new path, which is what
    // a D-060 rotation republishes: same content, new immutable URL.
    const url = route.request().url().replace(`/${ROTATED}/`, `/${published}/`)
    await route.continue({ url })
  })

  await test.step('the stale staged copy is discarded, not resumed into', async () => {
    await page.goto('/')
    await openDataControls(page)
    // Still usable while the origin has moved on: a rotation is not an outage.
    expect(await queryFirstCell(page)).toBe(rows)

    await page.getByRole('button', { name: 'Re-download data' }).click()
    const rotated = await importedTimings(page)
    // Every chunk, because nothing staged for the old generation may be reused
    // — a resumed mix of two generations is a database whose per-chunk hashes
    // all pass and whose contents belong to neither.
    expect(rotated.chunksFetched).toBe(rotated.chunksTotal)
    expect(rotated.records).toBe(first.records)
    expect(await queryFirstCell(page)).toBe(rows)
  })

  await test.step('and the origin ends holding one generation, with no stale record', async () => {
    await awaitIdle(page, 300_000)
    await page.goto('/no-such-page')
    expect(await opfsEntries(page)).toEqual(['cve-b.sqlite'])
  })

  expect(failures, `console/page errors:\n${failures.join('\n')}`).toEqual([])
})

/**
 * Stall detection (D-052), as the user meets it.
 *
 * D-052 draws the line at forward progress rather than elapsed time, so both
 * halves are asserted here: a transfer that stops receiving bytes is reported
 * as stalled — with the local copy intact and the staged chunks still worth
 * something — and a transfer that is merely slow is left alone. The timeout is
 * shortened with `?stall=` for the same reason `?stop=` exists: waiting out the
 * real sixty seconds in every run is a minute an assertion does not need.
 */
test('a download that stops receiving data is reported as stalled, not left spinning', async ({
  page,
}) => {
  test.setTimeout(600_000)
  const failures = watchForErrors(page)

  await page.goto('/')
  await startDownload(page)
  const first = await importedTimings(page)
  const rows = await queryFirstCell(page)

  const chunks = await snapshotChunks(page)
  const doomed = chunks[chunks.length - 1]!
  // Accepted and never answered: the connection a dead link or a wedged server
  // leaves behind, which is exactly what an elapsed-time budget cannot tell
  // apart from a slow one. Held open until the test lets go, rather than for a
  // fixed sleep — a handler still sleeping when the run ends is a teardown
  // hazard for a property that has nothing to do with sleeping.
  let release = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`**/${doomed}`, async (route) => {
    await released
    await route.abort().catch(() => undefined)
  })

  await test.step('the stall is named as a stall', async () => {
    await page.goto('/?stall=2000')
    await openDataControls(page)
    await page.getByRole('button', { name: 'Re-download data' }).click()

    const error = page.locator('[data-error]')
    await expect(error).toContainText('stalled', { timeout: 120_000 })
    // The distinction D-052 exists for, in the message itself.
    await expect(error).toContainText('rather than a slow one')
    await expect(error).toContainText('untouched')
  })

  await test.step('and it costs nothing but the chunks that never arrived', async () => {
    await expect(page.locator('.notice')).toContainText('The MITRE Corporation')
    expect(await queryFirstCell(page)).toBe(rows)

    release()
    await page.unroute(`**/${doomed}`)

    await page.goto('/')
    await openDataControls(page)
    await page.getByRole('button', { name: 'Re-download data' }).click()
    const resumed = await importedTimings(page)
    // The chunks that did land are still staged: a stall is a failed transfer,
    // not a lost download.
    expect(resumed.chunksFetched).toBeLessThan(resumed.chunksTotal)
    expect(resumed.records).toBe(first.records)
  })

  await test.step('a slow transfer is not a stalled one', async () => {
    // Every chunk arrives, each after a pause that is most of the timeout. The
    // import has to complete: "slow" and "stuck" are different conditions, and
    // a watch that cannot tell them apart is worse than none — it turns a
    // working download on a bad link into an error the user cannot get past.
    // (The unbounded version of this — a transfer that beats for ten minutes
    // under a one-minute timeout — is in tests/unit/stall.test.ts.)
    await page.route('**/data/snapshot-*/*.br', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      await route.continue()
    })
    await page.goto('/?stall=5000')
    await openDataControls(page)
    await page.getByRole('button', { name: 'Clear local copy' }).click()
    await expect(
      page.getByRole('button', { name: 'Download CVE dataset', exact: true })
    ).toBeVisible({
      timeout: 60_000,
    })
    await startDownload(page)
    const slow = await importedTimings(page)
    expect(slow.chunksFetched).toBe(slow.chunksTotal)
    expect(slow.records).toBe(first.records)
    await expect(page.locator('[data-error]')).toHaveCount(0)
  })

  expect(failures, `console/page errors:\n${failures.join('\n')}`).toEqual([])
})

/** The snapshot's chunk file names, in file order, as the origin advertises them. */
async function snapshotChunks(page: Page): Promise<string[]> {
  return await page.evaluate(async () => {
    const manifest = await (await fetch('/data/manifest.json', { cache: 'no-cache' })).json()
    return [...manifest.snapshot.chunks]
      .sort((a: { offset: number }, b: { offset: number }) => a.offset - b.offset)
      .map((chunk: { name: string }) => chunk.name)
  })
}

/**
 * Start the first download of this origin from the landing view's CTA — the
 * workspace and its Data panel do not exist until a copy is usable. Waiting
 * out `pending` first keeps the click from racing the Worker's first status.
 */
async function startDownload(page: Page): Promise<void> {
  await expect(page.locator('main')).not.toHaveAttribute('data-status', 'pending', {
    timeout: 60_000,
  })
  await downloadButton(page).click()
}

/**
 * Wait for the workspace to report the live copy, then open the Data panel —
 * where the re-download, demo-query and clear controls live since the UI
 * revamp. The idle wait asserts the same facts the old "Re-download data is
 * enabled" wait did: a status message arrived, a copy is live, and the Worker
 * is not busy (which also covers the report the canvas auto-runs when a copy
 * first becomes ready in a page load).
 */
async function openDataControls(page: Page): Promise<void> {
  await awaitIdle(page, 60_000)
  await openPanel(page, 'data')
}

/**
 * Run the demo query and return one cell of it — the cheapest proof that the
 * database on disk is the corpus and not a truncated or half-written copy.
 */
async function queryFirstCell(page: Page): Promise<string> {
  // Idle first: right after an import the canvas's auto-run report is still
  // in flight, and a click dispatched into the disabled→enabled re-render is
  // a click the swapped-in button can miss.
  await awaitIdle(page, 60_000)
  await openPanel(page, 'data')
  await page.getByRole('button', { name: 'Run query' }).click()
  await expect(page.locator('#data-panel table.results tbody tr')).toHaveCount(15, {
    timeout: 120_000,
  })
  return await page
    .locator('#data-panel table.results tbody tr')
    .first()
    .locator('td')
    .nth(1)
    .innerText()
}

/**
 * Everything the origin holds in OPFS, read from a page that runs no Worker.
 *
 * The entry-set assertions call `awaitIdle` (ui.ts) before listing: `imported`
 * is not the end of the operation — a download continues into a catch-up and
 * then a KEV refresh (M6), and both write to the *live* database. Listing OPFS
 * before they finish catches a rollback journal mid-transaction — which is not
 * a leaked generation, but is enough to fail an exact-set assertion, and
 * navigating away at that moment leaves the journal behind for real. Idle is
 * read from a control the page disables while the Worker is busy, so it is the
 * same fact the UI uses.
 */
async function opfsEntries(page: Page): Promise<string[]> {
  return await page.evaluate(async () => {
    const root = (await navigator.storage.getDirectory()) as unknown as {
      entries(): AsyncIterable<[string, unknown]>
    }
    const names: string[] = []
    for await (const [name] of root.entries()) names.push(name)
    return names.sort()
  })
}

async function importedTimings(page: Page): Promise<Timings> {
  await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible({ timeout: 300_000 })
  const json = await page.locator('.timings').getAttribute('data-json')
  const timings = JSON.parse(json ?? 'null') as Timings
  // Recorded, not just asserted on. D-061 quotes numbers from this spec, and a
  // number a future agent cannot re-derive from the run that produced it is the
  // kind of claim rule 3 exists to stop.
  test.info().annotations.push({
    type: 'D-061',
    description:
      `${timings.chunksFetched}/${timings.chunksTotal} chunks, ` +
      `${(timings.compressedBytes / 1e6).toFixed(1)} MB snapshot, ` +
      `${(timings.rawBytes / 1e6).toFixed(1)} MB expanded, ` +
      `${timings.records.toLocaleString()} records, ` +
      `OPFS ${timings.opfsBytes === null ? 'unmeasured' : `${(timings.opfsBytes / 1e6).toFixed(1)} MB`}, ` +
      `${(timings.totalMs / 1000).toFixed(1)} s total`,
  })
  // Quiet before returning: the catch-up, KEV refresh and auto-run report all
  // follow an import, and a click dispatched into one of their busy flickers
  // lands on a disabled button and is swallowed — the run-2 failure mode.
  await awaitIdle(page, 60_000)
  return timings
}

/**
 * Fail the test on any page or console error.
 *
 * Every test here drives paths that fail loudly in the Worker when they fail at
 * all — a swallowed console error is how a "passing" run hides a broken import.
 */
function watchForErrors(page: Page): string[] {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(String(error)))
  page.on('console', (message) => {
    // The `/no-such-page` navigations these tests use to get a Worker-free
    // document are expected 404s, not defects.
    if (message.type() === 'error' && !message.text().includes('404')) {
      failures.push(message.text())
    }
  })
  return failures
}
