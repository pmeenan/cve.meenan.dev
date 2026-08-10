import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { cpus, release } from 'node:os'
import { dirname } from 'node:path'
import { expect, test, type Browser, type Page } from '@playwright/test'

import type { BenchResult, ImportOptions, Timings, Vfs } from '../../lib/protocol'

import { downloadButton, openPanel } from './ui'

/**
 * Q-003 and Q-004 at full scale: the sweep the M1 budgets come from.
 *
 * Skipped unless `MEASURE=1`, because it needs the **full** published artifact
 * (~377 MB expanded) rather than the bounded development slice, and takes
 * minutes. `pnpm measure` sets that up:
 *
 *     SERVE_DATA_ROOT=<full pub dir> pnpm measure
 *
 * `pnpm measure` clears the ledger first, so it is a full sweep. To fill in one
 * case without discarding the rest, run playwright directly with `MEASURE=1`
 * and a `--grep`: results append.
 *
 * It reads the Worker's own numbers out of `[data-json]` rather than re-parsing
 * rounded labels, and adds the two things the browser cannot see about itself:
 * peak resident memory of the renderer holding the Worker, and how a second tab
 * behaves. The result is written as markdown next to the run so the numbers in
 * features.md are transcribed from a file, not from a scrollback.
 *
 * Nothing here asserts a budget — the budgets are being *set* from these
 * numbers, so asserting one would be circular (same reasoning as import.spec).
 * The assertions are correctness-only: the import completed and the records are
 * all there.
 */

const MEASURING = process.env.MEASURE === '1'
/** Gitignored, like the ledger beside it: this is evidence, not a document.
 * The numbers get transcribed into features.md by hand, with judgement. */
const REPORT = process.env.MEASURE_REPORT ?? 'measurements/measurement.md'
/**
 * Results are appended here as each one lands, and the report is rebuilt from
 * the file rather than from memory. Playwright discards and restarts its worker
 * after a timeout, which took the whole in-memory result set with it the first
 * time this ran — an hour of measurement lost to a bookkeeping choice.
 *
 * Deliberately *not* under `test-results/`: Playwright empties its output
 * directory at the start of every run, so a ledger there is erased by the next
 * invocation — including a `--grep`ped one meant to top up the previous sweep.
 */
const LEDGER = process.env.MEASURE_LEDGER ?? 'measurements/measurement.jsonl'

/** Every chunk arrives before this; a hang is a failure, not a slow machine. */
const IMPORT_TIMEOUT = 600_000
/**
 * Generous, because one case here is *meant* to be pathological: at the stock
 * 2 MiB page cache a single benchmark pass takes minutes (D-050). A tight
 * timeout would delete the evidence for the decision.
 */
const CASE_TIMEOUT = 1_800_000

/**
 * A deliberately ordinary broadband link, not a bad one: if overlapping fetches
 * do not help here they will not help on a good connection either.
 */
const THROTTLE = {
  label: '50 Mbps / 40 ms',
  downloadThroughput: (50 * 1e6) / 8,
  uploadThroughput: (10 * 1e6) / 8,
  latency: 40,
}

type Entry = { kind: 'run'; run: Run } | { kind: 'note'; key: string; note: string }

/**
 * What a single run was measured on. Stamped onto *every* run rather than once
 * per sweep: the ledger is appended to by `--grep` top-ups that may happen days
 * later, against a different artifact revision or a rebuilt browser, and a
 * report that quotes the first environment for every row misattributes exactly
 * the runs most likely to differ.
 */
interface Env {
  browser: string
  platform: string
  arch: string
  cpus: number
  recorded: string
  rev: number
  records: number
}

interface Run {
  label: string
  env: Env
  timings: Timings
  /** Renderer high-water RSS in bytes, from /proc — see rendererPeak(). */
  peakRssBytes: number | null
  bench?: BenchResult[]
  /** SQLite's WASM heap *after* the benchmark, which import cannot observe. */
  benchHeapBytes?: number
}

function record(entry: Entry): void {
  mkdirSync(dirname(LEDGER), { recursive: true })
  appendFileSync(LEDGER, `${JSON.stringify(entry)}\n`, 'utf8')
  const report = renderReport()
  writeFileSync(REPORT, report, 'utf8')
  process.stdout.write(`\n${report}\n`)
}

function ledger(): Entry[] {
  try {
    return readFileSync(LEDGER, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Entry)
  } catch {
    return []
  }
}

test.describe('full-scale measurement', () => {
  test.skip(!MEASURING, 'set MEASURE=1 and point SERVE_DATA_ROOT at the full artifact')
  test.describe.configure({ timeout: CASE_TIMEOUT })

  // Each case is its own test so that one slow or hanging configuration cannot
  // take the rest of the sweep down with it.

  // D-041 left "how many chunks at once" open. 12 chunks, so 16 would only
  // prove that a window wider than the corpus behaves like one that is.
  for (const concurrency of [1, 2, 4, 8]) {
    test(`concurrency ${concurrency} (D-041)`, async ({ browser }) => {
      record({
        kind: 'run',
        run: await importOnce(browser, `concurrency=${concurrency}`, { concurrency }),
      })
    })
  }

  /**
   * The same sweep over a link that behaves like one. Unthrottled, the server
   * is on loopback and transport is nearly free, so concurrency can only lose —
   * which would answer D-041 with an artifact of the test rig. A real visitor
   * has bandwidth and latency, and that is where overlapping fetches are
   * supposed to pay for themselves.
   */
  for (const concurrency of [1, 4, 8]) {
    test(`concurrency ${concurrency} throttled (D-041)`, async ({ browser }) => {
      record({
        kind: 'run',
        run: await importOnce(
          browser,
          `concurrency=${concurrency} @ ${THROTTLE.label}`,
          {
            concurrency,
          },
          { throttle: true }
        ),
      })
    })
  }

  for (const vfs of ['opfs', 'opfs-sahpool'] as Vfs[]) {
    test(`VFS ${vfs} (Q-004)`, async ({ browser }) => {
      record({
        kind: 'run',
        run: await importOnce(browser, `vfs=${vfs}`, { vfs }, { bench: true }),
      })
    })
  }

  /**
   * The page cache is the difference between a query reading from memory and
   * reading through OPFS, and the stock 2 MB is 0.5% of a 377 MB corpus. It
   * trades directly against the memory budget being set in the same run, so
   * both numbers come from the same sweep (D-050).
   */
  for (const cacheMib of [2, 64, 256, 512]) {
    test(`page cache ${cacheMib} MiB (D-050)`, async ({ browser }) => {
      record({
        kind: 'run',
        run: await importOnce(browser, `cache=${cacheMib}MiB`, { cacheMib }, { bench: true }),
      })
    })
  }

  /**
   * M3's tuning, as three runs that differ in one thing each.
   *
   * `m3:baseline` is M1's shipped behaviour — indexes built, no statistics, no
   * progress handler on the query path — and is what "no regression against the
   * M1 baseline" is measured against on *this* machine and *this* artifact,
   * rather than against a table recorded in a different month. `m3:handler`
   * adds the progress handler that makes a query reportable and cancellable,
   * which is a cost paid on every query. The last two add `ANALYZE`, which is
   * what the milestone is buying, and differ only in whether it reads every
   * index or samples — the trade D-067 turns on.
   *
   * Same import path, same page cache, same VFS: the only variables are the
   * knobs, so the benchmark columns can be read against each other.
   *
   * The two rejected variants are not cases here — a bare `ANALYZE` including
   * the full-text shadow tables, and a sampled one (`PRAGMA analysis_limit`) —
   * because both were measured once and lost (D-067). Re-running either is two
   * lines in `buildSearchIndexes`.
   */
  for (const [label, options] of [
    ['m3:baseline (no stats, no handler)', { analyze: false, progressOps: 0 }],
    ['m3:handler (no stats)', { analyze: false }],
    ['m3:stats — shipped', {}],
  ] as [string, ImportOptions][]) {
    test(`${label} (M3)`, async ({ browser }) => {
      record({ kind: 'run', run: await importOnce(browser, label, options, { bench: true }) })
    })
  }

  /**
   * The reopen path, which is a different question from the import path and was
   * being answered with the import's `openMs` — a number taken mid-import, with
   * the WASM module already instantiated and the file cache hot. What criterion
   * 1 actually promises is that *reopening the app* with a local copy is fast,
   * so this measures a real reload: navigation, Worker boot, WASM instantiate,
   * OPFS open, and a query returning rows.
   */
  test('reopen with a local copy (D-049)', async ({ browser }) => {
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await importInPage(page, {})

      const started = Date.now()
      await page.reload()
      // The workspace header only renders once the Worker has reported the
      // local copy, so the Sync button appearing is the moment the old Data
      // tab's enabled Re-download button used to mark.
      await expect(page.getByRole('button', { name: 'Sync', exact: true })).toBeVisible({
        timeout: 120_000,
      })
      const ready = Date.now() - started

      // The demo query lives in the Data panel now, which a reload leaves
      // closed. Note the canvas also auto-runs the most recent report on
      // reopen, and the demo click waits behind it — `queried` includes that.
      await openPanel(page, 'data')
      await page.getByRole('button', { name: 'Run query' }).click()
      // D-052: this query takes seconds on a cold page cache, so it has to say
      // it is running. Asserted here rather than in import.spec because only
      // the full corpus is slow enough for the check to mean anything.
      await expect(page.locator('.progress')).toContainText('Running query')
      // Scoped to the Data panel: the canvas's chart table is `.results` too.
      await expect(page.locator('#data-panel table.results tbody tr')).toHaveCount(15, {
        timeout: 120_000,
      })
      const queried = Date.now() - started

      record({
        kind: 'note',
        key: 'reopen',
        note: `- reopen after a reload: **${ready} ms** to report the local copy, **${queried} ms** to rendered query results (cold page, warm OPFS; includes the canvas auto-running the most recent report ahead of the demo query).`,
      })
    } finally {
      await context.close()
    }
  })

  /**
   * Q-004's other half. SQLite's own documentation says `opfs-sahpool` forbids
   * simultaneous connections; `opfs` is said to allow them. Both claims are
   * checked here rather than quoted — a second tab is not an exotic case, it is
   * what a user does with a bookmark.
   */
  for (const vfs of ['opfs', 'opfs-sahpool'] as Vfs[]) {
    test(`second tab on ${vfs} (Q-004)`, async ({ browser }) => {
      const context = await browser.newContext()
      try {
        const first = await context.newPage()
        await importInPage(first, { vfs })

        const second = await context.newPage()
        const errors: string[] = []
        second.on('pageerror', (error) => errors.push(String(error)))
        await second.goto('/')

        // Every step below is bounded and its result recorded rather than
        // asserted. "It hangs" is a legitimate answer to Q-004 — the first run
        // of this spent 30 minutes proving that and then reported nothing but a
        // Playwright timeout, which is the one outcome that teaches nothing.
        const outcome = await bounded(secondTabOutcome(second), 150_000, 'it stopped responding')
        record({
          kind: 'note',
          key: `second-tab:${vfs}`,
          note: `- \`${vfs}\`: second tab — ${outcome}${errors.length ? ` (page errors: ${errors.join('; ')})` : ''}`,
        })

        // Whatever the second tab did, the first must still work: a tab that
        // breaks its sibling is a different failure from one that waits. Its
        // Data panel is still open — it opened itself after the import.
        const survived = await bounded(
          (async () => {
            await first.getByRole('button', { name: 'Run query' }).click()
            await expect(first.locator('#data-panel table.results tbody tr')).toHaveCount(15, {
              timeout: 120_000,
            })
            return 'still queries normally'
          })(),
          150_000,
          '**stopped responding** — the second tab broke it'
        )
        record({
          kind: 'note',
          key: `first-tab:${vfs}`,
          note: `  - first tab afterwards: ${survived}`,
        })
      } finally {
        await context.close()
      }
    })
  }

  /**
   * M4's cross-tab, at full scale — the number the milestone closed without.
   *
   * `crossSql` is a query shape D-067's benchmark does not cover: two grouped
   * axes, each narrowed by its own total in a CTE before the cross-tab is
   * computed, over 372,322 records rather than the 39,196-record development
   * slice every M4 test runs against. The shapes below are the ones the UI
   * actually offers, chosen to span what makes them expensive: a time axis is a
   * scan with a `strftime` per row, a lookup axis multiplies through a link
   * table, and `Vendor × CWE` is the one pair that joins two independent chains
   * at once (D-069).
   *
   * Two passes each, for the same reason `runBench` takes two: the first pays
   * for whatever the 256 MiB page cache has not read yet, and only the second
   * is the steady-state number a reader of the UI would experience. Both are
   * recorded — the cold one is what someone meets after a reopen.
   *
   * Nothing is asserted but correctness. These numbers are being *set*, so a
   * budget here would be circular (the same reasoning as the rest of this file).
   */
  test('M4 report shapes (D-069)', async ({ browser }) => {
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      const failures: string[] = []
      page.on('pageerror', (error) => failures.push(String(error)))
      const timings = await importInPage(page, {})

      // Bounded and asserted before anything is clicked. An import is followed
      // by a catch-up (M2), and a failure there can leave the workspace not
      // rendering — at which point clicking into it waits for the *case*
      // timeout with no CPU and no output, which is half an hour spent
      // learning nothing. Naming the state here turns that into a sentence.
      // The Filters toggle only exists once the Worker reports a usable copy.
      const filtersToggle = page.locator('[data-toggle="filters"]')
      await expect(filtersToggle, `page errors: ${failures.join('; ')}`).toBeVisible({
        timeout: 300_000,
      })
      // An error banner is *recorded*, not fatal. The copy is queryable at the
      // snapshot's revision whether or not the catch-up that follows an import
      // succeeded, and these numbers are about query cost — but an unexplained
      // banner is exactly the thing a measurement run should not swallow, so it
      // goes in the report beside the numbers it might explain.
      const banner = (await page.locator('[data-error]').allInnerTexts()).join(' | ')
      if (banner || failures.length) {
        record({
          kind: 'note',
          key: 'm4:reports:state',
          note:
            `- **the app reported something during this run**: ` +
            `${banner || '(no banner)'}${failures.length ? ` — page errors: ${failures.join('; ')}` : ''}`,
        })
      }
      // The report axes and "Run report" live in the Filters panel now.
      await openPanel(page, 'filters')
      // An import is followed by a catch-up (M2), and "Run report" is disabled
      // while the Worker is busy — so without this the *first* shape's wall
      // time is the sync's, not the query's. It read 284 s once, which is a
      // number nobody would have questioned in a table headed "report".
      // The canvas also auto-runs a default report once the copy is ready —
      // one extra query after the import. Harmless to the shapes measured
      // below: each waits on its own data-run increment, and this wait
      // outlasts the auto-run too.
      await expect(page.locator('.progress')).toBeHidden({ timeout: 600_000 })

      const lines: string[] = []
      for (const [rows, series] of SHAPES) {
        await page.locator('#report-rows').selectOption({ label: rows })
        await page
          .locator('#report-series')
          .selectOption(series === null ? { value: '' } : { label: series })
        const cold = await runOneReport(page)
        const warm = await runOneReport(page)
        lines.push(
          `| ${rows}${series ? ` × ${series}` : ''} | ${cold.ms} | ${warm.ms} | ` +
            `${cold.wallMs} | ${warm.cells}${warm.truncated ? ' (capped)' : ''} |`
        )
        // Written after *every* shape, under one key so the table stays whole:
        // notes are last-write-wins, and this file's own header records what it
        // cost to learn that a result set held only in memory dies with the
        // worker that a timeout restarts.
        record({ kind: 'note', key: 'm4:reports', note: reportNote(timings.records, lines) })
      }
    } finally {
      await context.close()
    }
  })
})

/** The cross-tab table, rebuilt from every shape measured so far. */
function reportNote(records: number, lines: string[]): string {
  return (
    `- **M4 cross-tabs over ${records.toLocaleString()} records**, ` +
    `256 MiB page cache, statistics shipped:\n\n` +
    `  | report | cold ms | warm ms | cold wall ms | cells |\n` +
    `  | --- | --- | --- | --- | --- |\n` +
    lines.map((line) => `  ${line}`).join('\n') +
    `\n\n  \`ms\` is SQLite's own time for the cross-tab statement; ` +
    `\`wall ms\` is click to rendered answer, which also carries the ` +
    `\`count(*)\` the UI asks for beside every report.`
  )
}

/** The report shapes the sweep times. `null` series is a one-axis aggregate. */
const SHAPES: [string, string | null][] = [
  ['Month', 'Severity'],
  ['Year', 'Severity'],
  ['Vendor', 'Severity'],
  ['Product', 'Severity'],
  ['CWE', 'Severity'],
  ['CNA', 'Severity'],
  ['Reference host', 'Severity'],
  ['Vendor', 'CWE'],
  ['Month', null],
]

/** This surface's answer counter, or null when it has not answered yet. */
async function answeredRun(page: Page): Promise<string | null> {
  const cell = page.locator('[data-report-matches]').first()
  if ((await cell.count()) === 0) return null
  return cell.getAttribute('data-run')
}

interface ReportRun {
  ms: number
  cells: number
  truncated: boolean
  wallMs: number
}

/**
 * Run the report on screen and read the Worker's own timing back.
 *
 * Waits on the answer counter rather than on the progress bar: a report that
 * finishes quickly may never render one, and the assertion would then read the
 * previous shape's numbers — which is how a sweep records the same query nine
 * times (the same trap `report.spec.ts` documents).
 */
async function runOneReport(page: Page): Promise<ReportRun> {
  // Read through `count()` rather than straight off the locator. Before the
  // first report has ever run the element does not exist, and `getAttribute`
  // has no timeout of its own here — so it waits for the *case* timeout, with
  // an idle CPU and no output. That is half an hour spent learning nothing, and
  // it is how this helper was first written.
  const before = await answeredRun(page)
  const started = Date.now()
  await page.getByRole('button', { name: 'Run report' }).click()
  await expect
    .poll(
      async () => {
        const after = await answeredRun(page)
        return after !== null && after !== before
      },
      { timeout: CASE_TIMEOUT }
    )
    .toBe(true)
  const wallMs = Date.now() - started
  const payload = JSON.parse(
    (await page.locator('[data-report-matches]').first().getAttribute('data-json')) ?? 'null'
  ) as { ms: number; cells: number; truncated: boolean } | null
  expect(payload, 'the report reported no numbers').not.toBeNull()
  return { ...payload!, wallMs }
}

/** One import in a fresh context, so OPFS starts empty every time. */
async function importOnce(
  browser: Browser,
  label: string,
  options: ImportOptions,
  extra: { bench?: boolean; throttle?: boolean } = {}
): Promise<Run> {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    if (extra.throttle) {
      const cdp = await context.newCDPSession(page)
      await cdp.send('Network.enable')
      await cdp.send('Network.emulateNetworkConditions', { offline: false, ...THROTTLE })
    }
    const timings = await importInPage(page, options)
    // Whether CDP throttling reaches a dedicated Worker's fetches is not
    // documented anywhere we trust, so it is checked rather than assumed.
    // The test is on *elapsed* transport, not on `fetchMs`: that is cumulative
    // across concurrent chunks, and already exceeds 10 s unthrottled at
    // concurrency 4, so a threshold on it would only catch the serial case.
    // 62.7 MB at 50 Mbps cannot elapse in under ~10 s at any concurrency.
    // `verifyMs` is subtracted too: verification, promotion and sweeping a
    // replaced 441 MB generation sit between the stages stamped above, and
    // without it they are reported as transport (D-061).
    const elapsedTransportMs = timings.totalMs - timings.indexMs - timings.openMs - timings.verifyMs
    if (extra.throttle && elapsedTransportMs < 10_000) {
      record({
        kind: 'note',
        key: `throttle:${label}`,
        note: `- **throttling did not reach the Worker**: \`${label}\` moved 62.7 MB in ${elapsedTransportMs} ms elapsed, which is loopback speed. Treat that row as unthrottled.`,
      })
    }

    const run: Run = { label, env: await envFor(page, timings), timings, peakRssBytes: null }
    if (extra.bench) {
      // Twice: the first pass pays for whatever the page cache has not read
      // yet, and only the second is the steady-state number a UI would show.
      await runBench(page)
      const second = await runBench(page)
      run.bench = second.results
      run.benchHeapBytes = second.wasmHeapBytes
    }
    // Last, so the high-water mark covers the queries too: `VmHWM` only ever
    // rises, and an aggregate's temp b-trees are exactly the allocation the
    // memory budget has to bound. Reading it before the benchmark would have
    // measured index building and called it peak.
    run.peakRssBytes = await rendererPeak(page)
    return run
  } finally {
    await context.close()
  }
}

/** What this particular run ran on, read from the artifact it just imported. */
async function envFor(page: Page, timings: Timings): Promise<Env> {
  // The *snapshot's* revision, not the manifest's head: an import fetches
  // chunks and nothing else, so once deltas exist a head of N+k would label a
  // snapshot-N measurement as something it never ran on (D-055). Older
  // manifests have no `snapshot.rev`, and there the two are the same number.
  const manifest = (await page.evaluate(() =>
    fetch('/data/manifest.json', { cache: 'no-cache' }).then((r) => r.json())
  )) as { rev: number; snapshot?: { rev?: number } }
  return {
    browser: page.context().browser()?.version() ?? 'unknown',
    platform: `${process.platform} ${release()}`,
    arch: process.arch,
    cpus: cpus().length,
    recorded: new Date().toISOString(),
    rev: manifest.snapshot?.rev ?? manifest.rev,
    records: timings.records,
  }
}

/** Runs are only comparable if these match; the report says so when they do not. */
function envKey(env: Env): string {
  return `${env.browser} | ${env.platform} | ${env.arch} | ${env.cpus} cores | rev ${env.rev} | ${env.records} records`
}

async function importInPage(page: Page, options: ImportOptions): Promise<Timings> {
  const query = new URLSearchParams()
  if (options.concurrency) query.set('concurrency', String(options.concurrency))
  if (options.cacheMib) query.set('cache', String(options.cacheMib))
  if (options.vfs) query.set('vfs', options.vfs)
  if (options.analyze === false) query.set('analyze', '0')
  if (options.progressOps !== undefined) query.set('ops', String(options.progressOps))
  await page.goto(`/?${query}`)

  // The landing CTA, once the Worker has spoken — clicking across the
  // pre-status render is the click ui.ts's importCorpus guards against.
  await expect(page.locator('main')).not.toHaveAttribute('data-status', 'pending', {
    timeout: 15_000,
  })
  await downloadButton(page).click()
  // `.timings` renders in the Data panel, which opens itself on the import
  // that filled it. The canvas then auto-runs a default report — one extra
  // query after import, invisible to these timings, which the Worker stamps
  // before it runs.
  await expect(page.locator('.timings')).toBeVisible({ timeout: IMPORT_TIMEOUT })

  const timings = JSON.parse(
    (await page.locator('.timings').getAttribute('data-json')) ?? 'null'
  ) as Timings
  // The corpus is all-or-nothing (vision criterion 7): a short import is a
  // wrong answer, not a slow one. This is also the guard against measuring the
  // development slice by accident and reporting it as full scale.
  expect(timings.records).toBeGreaterThan(370_000)
  return timings
}

async function runBench(page: Page): Promise<{ results: BenchResult[]; wasmHeapBytes: number }> {
  await page.getByRole('button', { name: 'Measure query latency' }).click()
  // The page clears the previous table on click, so this waits for *this* run
  // rather than reading the one before it.
  await expect(page.locator('.bench')).toBeHidden()
  await expect(page.locator('.bench')).toBeVisible({ timeout: IMPORT_TIMEOUT })
  const payload = JSON.parse(
    (await page.locator('.bench').getAttribute('data-json')) ?? 'null'
  ) as { results: BenchResult[]; wasmHeapBytes: number } | null
  expect(payload?.results.length).toBeGreaterThan(0)
  return payload!
}

/**
 * Resolve to `onTimeout` instead of waiting forever. Playwright's own timeouts
 * do not help here: a locator query against a page whose main thread is wedged
 * never returns, and the abandoned work keeps running underneath — so this
 * bounds the *reporting*, not the page.
 */
async function bounded(work: Promise<string>, ms: number, onTimeout: string): Promise<string> {
  let timer: NodeJS.Timeout | undefined
  const expiry = new Promise<string>((resolve) => {
    timer = setTimeout(
      () => resolve(`no verdict within ${Math.round(ms / 1000)} s — ${onTimeout}`),
      ms
    )
  })
  try {
    return await Promise.race([work.catch((error: unknown) => `failed: ${String(error)}`), expiry])
  } finally {
    clearTimeout(timer)
  }
}

/** What a freshly opened second tab settled on, in words. */
async function secondTabOutcome(page: Page): Promise<string> {
  // The workspace header (and its Data toggle) renders only once the Worker
  // reports an existing copy; the landing CTA renders while there is none.
  // exact on the CTA, because `Download CVE dataset` is a substring-sibling of
  // `Re-download CVE dataset` — the opposite state — and the verdict this
  // function produces is D-051's central evidence.
  const existing = page.locator('[data-toggle="data"]')
  const fresh = page.getByRole('button', { name: 'Download CVE dataset', exact: true })
  const failed = page.locator('.error')
  const started = Date.now()
  for (;;) {
    if (await failed.isVisible().catch(() => false)) return `error: ${await failed.innerText()}`
    if (await existing.isVisible().catch(() => false)) {
      // It sees the database — but seeing it and being able to read it are
      // different questions, so open the Data panel and ask it for rows.
      await openPanel(page, 'data')
      await page.getByRole('button', { name: 'Run query' }).click()
      // Scoped to the panel: the canvas's auto-run chart table is `.results`
      // too, and this tab may have run one.
      const rows = page.locator('#data-panel table.results tbody tr')
      try {
        await expect(rows).toHaveCount(15, { timeout: 60_000 })
        return 'opened the existing database and queried it'
      } catch {
        const message = await failed.innerText().catch(() => '')
        return `opened the database but the query did not return${message ? `: ${message}` : ''}`
      }
    }
    if ((await fresh.isVisible().catch(() => false)) && Date.now() - started > 90_000) {
      // "Offers a download" and "hung opening the database" look identical in
      // the DOM — the difference is whether the bytes are actually there, so
      // ask OPFS directly rather than inferring from the button.
      return `it never reported the existing database after 90 s, and OPFS holds ${await opfsContents(page)}`
    }
    await page.waitForTimeout(1000)
  }
}

/** Top-level OPFS entries with sizes, as a phrase — evidence that the database
 * is (or is not) on disk independently of what the app says about it. */
async function opfsContents(page: Page): Promise<string> {
  const entries = await page
    .evaluate(async () => {
      const found: string[] = []
      const root = await navigator.storage.getDirectory()
      for await (const handle of (
        root as unknown as { values(): AsyncIterable<FileSystemHandle> }
      ).values()) {
        if (handle.kind !== 'file') {
          found.push(`${handle.name}/`)
          continue
        }
        try {
          // `getFile()` on a file another tab holds a sync access handle on is
          // exactly the case being investigated here, so it must not be what
          // breaks the investigation.
          const size = (await (handle as FileSystemFileHandle).getFile()).size
          found.push(`${handle.name} (${(size / 1e6).toFixed(1)} MB)`)
        } catch (error) {
          found.push(`${handle.name} (unreadable: ${String(error)})`)
        }
      }
      return found
    })
    .catch((error: unknown) => [`could not be listed: ${String(error)}`])
  return entries.length ? entries.join(', ') : 'nothing'
}

/**
 * Peak resident memory of the renderer process that hosts the page and its
 * Worker, read from `/proc/<pid>/status`'s `VmHWM` — a high-water mark the
 * kernel keeps, so it needs no sampling and cannot miss a spike between polls.
 *
 * Linux-only and best-effort: it returns null anywhere else, and the run still
 * produces every other number. It exists because the in-page alternative does
 * not work — `performance.measureUserAgentSpecificMemory()` is unavailable in
 * this Chromium despite cross-origin isolation, and absent outright in Workers
 * (RE-011).
 *
 * Processes are matched by executable path, so only the browser Playwright
 * launched is counted and a Chrome the developer happens to have open is not.
 */
async function rendererPeak(page: Page): Promise<number | null> {
  if (process.platform !== 'linux') return null
  // Make sure the renderer exists and is the one showing this page.
  await page.evaluate(() => document.title)

  const matches: number[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8')
      if (!cmdline.includes('ms-playwright') || !cmdline.includes('--type=renderer')) continue
      const hwm = /VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${entry}/status`, 'utf8'))?.[1]
      if (hwm) matches.push(Number(hwm) * 1024)
    } catch {
      /* the process exited while we were reading it */
    }
  }

  if (!matches.length) return null
  // Matching is by executable path, not by pid, so it cannot prove the process
  // it found is *this* page's. It can only over-report — and a run with more
  // than one renderer alive (a stray `pnpm e2e` in another terminal, a slow
  // reap) would silently inflate a number the memory budget is set from. Say so
  // rather than quietly returning the max.
  if (matches.length > 1) {
    record({
      kind: 'note',
      key: 'rss-attribution',
      note: `- **peak RSS is not attributable**: ${matches.length} Playwright renderers were alive (${matches.map((b) => mb(b)).join(', ')}). The reported peak is the largest, which may not be this page's.`,
    })
  }
  return Math.max(...matches)
}

function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`
}

function renderReport(): string {
  const entries = ledger()
  // Last write wins per label. The documented top-up path re-runs one case with
  // `--grep` against an existing ledger, and without this the report grows a
  // second row and a second column with the same heading and no way to tell
  // which is newer — which is what forced the first report to be assembled by
  // hand.
  const byLabel = new Map<string, Run>()
  for (const entry of entries) if (entry.kind === 'run') byLabel.set(entry.run.label, entry.run)
  const runs = [...byLabel.values()]
  // Last write wins by key, so a `--grep` top-up replaces its previous note
  // instead of leaving two contradictory lines with no way to tell which is
  // current.
  const byNote = new Map<string, string>()
  for (const entry of entries) {
    if (entry.kind === 'note') byNote.set(entry.key ?? entry.note, entry.note)
  }
  const notes = [...byNote.values()]
  const env = runs.length ? runs[runs.length - 1]!.env : null
  const mixed = [...new Set(runs.map((run) => envKey(run.env)))]

  const lines: string[] = [
    '# Q-003 / Q-004 — full-scale measurement',
    '',
    // Rule 4: a measurement that does not say what it ran on cannot be checked
    // against later, and these numbers back vision-level budgets.
    env
      ? `${env.browser} on ${env.platform} (${env.arch}, ${env.cpus} cores), ${env.recorded}. ` +
        `Artifact rev ${env.rev}, ${env.records.toLocaleString()} records.`
      : 'Environment not recorded.',
    ...(mixed.length > 1
      ? [
          '',
          `> **These rows are not comparable.** ${mixed.length} different environments appear`,
          '> in this ledger, so the header above describes only the most recent run:',
          ...mixed.map((key) => `> - ${key}`),
          '> Re-run the whole sweep (`pnpm measure`) before quoting any of it.',
        ]
      : []),
    'The server is on loopback unless a row names a throttle. Per-chunk fetch,',
    'digest, decompress and write times are cumulative across concurrent chunks',
    '(lib/protocol.ts); Open, Index and Total are wall-clock, so the per-chunk',
    'columns can exceed the total. **Transport** is the elapsed wall-clock the',
    'download actually took (Total − Index − Open) — the only column in which',
    'concurrency can show a gain, and the one D-041 turns on.',
    '',
    'Every cell is a single run. Index-build time varies by up to ~20% between',
    'otherwise identical runs, so differences smaller than that are not results.',
    '',
    '## Import',
    '',
    '| Run | Rev | Transport | Fetch | Digest | Decomp | Write | Open | Index | Total | OPFS | Cache | Heap (import) | Heap (queries) | Peak RSS |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const run of runs) {
    const t = run.timings
    lines.push(
      `| ${run.label} | ${run.env.rev} | ${((t.totalMs - t.indexMs - t.openMs) / 1000).toFixed(1)} s | ` +
        `${t.fetchMs} ms | ${t.digestMs} ms | ${t.decompressMs} ms | ${t.writeMs} ms | ` +
        `${t.openMs} ms | ${t.indexMs} ms | ${(t.totalMs / 1000).toFixed(1)} s | ` +
        `${t.opfsBytes === null ? 'unmeasured' : mb(t.opfsBytes)} | ${t.cacheMib} MiB | ` +
        `${mb(t.wasmHeapBytes)} | ${run.benchHeapBytes ? mb(run.benchHeapBytes) : '—'} | ` +
        `${run.peakRssBytes ? mb(run.peakRssBytes) : 'n/a'} |`
    )
  }

  const benched = runs.filter((run) => run.bench?.length)
  if (benched.length) {
    lines.push('', '## Query latency (warm — second benchmark pass)', '')
    // Union rather than the first run's list, so a run with a different query
    // set is visible as gaps instead of being silently truncated away.
    const names = [...new Set(benched.flatMap((run) => run.bench!.map((entry) => entry.name)))]
    lines.push(`| Query | rows | ${benched.map((run) => run.label).join(' | ')} |`)
    lines.push(`| --- | --- | ${benched.map(() => '---').join(' | ')} |`)
    for (const name of names) {
      const found = benched.map((run) => run.bench!.find((entry) => entry.name === name))
      const rows = found.find(Boolean)?.rows ?? 0
      lines.push(
        `| ${name} | ${rows} | ${found.map((entry) => (entry ? `${entry.ms} ms` : '—')).join(' | ')} |`
      )
    }
  }

  if (notes.length) lines.push('', '## Second tab, and anything that went wrong', '', ...notes)
  return lines.join('\n')
}
