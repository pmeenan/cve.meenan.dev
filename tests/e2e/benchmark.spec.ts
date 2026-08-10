import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'

import { expect, test, type Page } from '@playwright/test'

import {
  BENCH_QUESTIONS,
  scoreLine,
  scoreQuestion,
  type Score,
  type StepFacts,
} from '../../lib/benchmark'
import type { Dimension } from '../../lib/filters'

import { requireLocalStorage } from './support'
import { importCorpus, openChat, openPanel } from './ui'

/**
 * The tool-calling benchmark (D-046), against the pinned model.
 *
 * **Opt-in, like `MEASURE=1`, and for the same reason**: it needs the private
 * `llm` host and a real inference round trip, which is not a unit test and is
 * not something a routine `pnpm e2e` should depend on. Run it deliberately:
 *
 *     BENCH=1 pnpm e2e benchmark
 *
 * and against the deployed origin, which is where the relay lives:
 *
 *     BENCH=1 BASE_URL=https://cve.meenan.dev pnpm e2e benchmark
 *
 * Everything below the model is the shipped path — our tool schemas, our system
 * prompt, our SQLite schema, the real relay — because a benchmark against a
 * mock integration measures the mock. What is scored is *data*: the definition
 * the model emitted and the rows it produced, against hand-written SQL run in
 * the same browser moments later (lib/benchmark.ts). No LLM judge.
 *
 * The scorecard is the milestone's honest-expectations artifact. A failing
 * question is a *result*, not a broken test — so the run records every score
 * and only fails on the one thing that is a defect rather than a model
 * limitation: the harness being unable to drive the integration at all.
 */

const RUN = process.env.BENCH === '1'
const OUT = 'measurements/benchmark.jsonl'

/** Where the run writes its scorecard. Beside the M1–M5 measurements. */
function record(entry: unknown): void {
  mkdirSync('measurements', { recursive: true })
  appendFileSync(OUT, `${JSON.stringify(entry)}\n`)
}

/**
 * Run the ground-truth SQL through the SQL console and read the rows back.
 *
 * The console rather than a second database handle: it is a real surface over
 * the same connection, it is guarded by the same authorizer, and a second
 * connection to an OPFS database is a locking problem nobody needs in a
 * benchmark. The rows come out of the rendered table, which is bounded and is
 * what a person would read.
 */
async function truth(page: Page, sql: string): Promise<(string | number | null)[][]> {
  await openPanel(page, 'sql')
  // `fill` before every run, never trusting prior contents: the SQL panel
  // auto-fills with the query of the last report or chat answer that ran
  // while it was closed (UI revamp).
  await page.locator('textarea.sql-input').fill(sql)
  // `.count()` first, because on the first call of a page there is no result
  // yet — and `getAttribute` on a locator that matches nothing *waits* for it,
  // with no action timeout configured, which is a run that hangs until the
  // test's own hour is up and writes no scorecard at all.
  const rows = page.locator('[data-console-rows]')
  const before = (await rows.count()) ? await rows.getAttribute('data-run') : null
  await page.getByRole('button', { name: 'Run SQL' }).click()
  // Poll for a result **or a refusal**, not just a result. Waiting only for
  // `[data-console-rows]` means a query the console rejects never satisfies the
  // poll, so the three minutes are spent before the error — which was sitting
  // on screen the whole time — is ever read. Every arm returns rather than
  // waiting on a locator, because inside `expect.poll` a callback that never
  // settles is a hang and not a timeout (RE-032).
  const error = page.locator('[data-console-error]')
  await expect
    .poll(
      async () => {
        if (await error.count()) return 'error'
        return (await rows.count()) ? await rows.getAttribute('data-run') : null
      },
      { timeout: 180_000 }
    )
    .not.toBe(before)
  if (await error.count()) throw new Error(`ground truth failed: ${await error.textContent()}`)
  // The console caps at CONSOLE_ROW_LIMIT and says so. A capped ground truth is
  // not ground truth — the rows beyond the cap would score as "not in the
  // truth" — so every truth query is ordered to put the rows a chart actually
  // selects first, and this is the check that the ordering was enough.
  const capped = await page.locator('[data-console-rows]').textContent()
  if (capped?.includes('capped')) {
    throw new Error(`ground truth was capped by the console row limit: ${capped.trim()}`)
  }
  return page.locator('table.console tbody tr').evaluateAll((rows) =>
    rows.map((row) =>
      [...row.querySelectorAll('td')].map((cell) => {
        const text = cell.textContent ?? ''
        const asNumber = Number(text)
        return text !== '' && Number.isFinite(asNumber) ? asNumber : text
      })
    )
  )
}

/** Every step of the newest turn, as the panel published it. */
async function facts(page: Page): Promise<StepFacts[]> {
  const raw = await page
    .locator('[data-chat-turn]')
    .last()
    .locator('[data-chat-json]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-chat-json') ?? '{}'))
  return raw.map((entry) => JSON.parse(entry) as StepFacts)
}

test.describe('D-046 tool-calling benchmark', () => {
  test.skip(!RUN, 'opt-in: BENCH=1, and it needs the private llm host')

  /**
   * Every action gets a deadline.
   *
   * Playwright's default `actionTimeout` is 0 — bounded only by the test
   * timeout, which this run deliberately sets to an hour because ten inference
   * round trips are slow. The two together mean *any* unexpected page state —
   * a button not yet enabled, a panel that did not open — is not a failure but
   * a silent stall that eats the whole hour and produces no scorecard at all.
   * That cost two runs before it was named (RE-032). A minute is far longer
   * than any click here legitimately needs, and it turns every such stall into
   * one unscored question with a reason, which is what the per-question guard
   * below is for.
   */
  test.use({ actionTimeout: 60_000 })

  test('the pinned model, scored against hand-written ground truth', async ({ page }) => {
    // Ten questions, each an inference round trip against an 8B model on one
    // small GPU, plus a full-corpus download first.
    test.setTimeout(3_600_000)
    writeFileSync(OUT, '')

    await page.goto('/')
    await requireLocalStorage(page)
    // `importCorpus` navigates again; the probe above only needs a loaded page.
    await importCorpus(page, 900_000)
    // **And then wait for the catalog**, which the download rebuilds *after* the
    // import heading appears (`refreshKev`, workers/db.worker.ts). Without this
    // the first `page.reload()` below tore down the Worker mid-refresh, and
    // nothing retries it — a refresh only runs on a download, a sync or an
    // explicit KEV action. Both KEV questions then scored zero with "no such
    // table: kev" from the *ground truth*, which reads like a model failure and
    // is not: the model was never asked. The same idiom as `kev.spec.ts`.
    const kevLine = page.locator('[data-kev]')
    await expect(kevLine).toBeVisible({ timeout: 300_000 })
    await expect(kevLine).not.toHaveAttribute('data-kev', 'none', { timeout: 300_000 })

    // The chat column auto-opens at this viewport; be explicit anyway.
    await openChat(page)
    const consent = page.getByRole('button', { name: 'Turn chat on' })
    if (await consent.isVisible()) await consent.click()

    const scores: Score[] = []
    for (const question of BENCH_QUESTIONS) {
      // **One question cannot end the run.** A benchmark whose ninth question
      // hangs and throws away the eight before it is not a benchmark, and the
      // failure modes here are exactly the ones a model produces: a turn that
      // never terminates, a ground-truth query that will not settle, a panel
      // in a state the harness did not expect. Each becomes a zero with a
      // reason attached, and the run continues.
      const started = Date.now()
      try {
        await test.step(question.id, async () => {
          // A fresh page per question: history is session-only, and a
          // conversation carrying nine previous answers is a different prompt
          // from the one a user asks first (D-046 scores the integration, not
          // the effect of context accumulating).
          await page.reload()
          // The column reopens itself once the copy is ready; `openChat` waits
          // for the workspace either way, and the consent flag survives the
          // reload so the composer is what renders.
          await openChat(page)
          await expect(page.getByLabel('Your question')).toBeEnabled({ timeout: 120_000 })

          await page.getByLabel('Your question').fill(question.ask)
          // The submit button is unique now — the old header opener is gone.
          await page.getByRole('button', { name: 'Ask', exact: true }).click()
          // The turn has to *exist* before its status can be polled. Without
          // this the poll below calls `.last().getAttribute()` on a locator
          // matching nothing, which does not time out inside `expect.poll` —
          // it never settles, and the run hangs for the test's whole hour with
          // the questions after it unscored. The same shape cost a run.
          const turn = page.locator('[data-chat-turn]').last()
          await expect(turn).toBeVisible({ timeout: 120_000 })
          // Done, stopped, errored or exhausted — every terminal state, so a
          // model that gives up is scored rather than timing the run out.
          await expect
            .poll(async () => turn.getAttribute('data-chat-turn'), { timeout: 600_000 })
            .not.toBe('running')
          const ms = Date.now() - started

          const steps = await facts(page)
          const aggregate = steps.find((step) => step.tool === question.tool)
          const rows = (aggregate?.rows ?? null) as Dimension | null
          const expected = await truth(page, question.truth(rows))

          const score = scoreQuestion(question, steps, expected, turnsOf(steps), ms)
          scores.push(score)
          record({ ...score, ask: question.ask, what: question.what })
          // The scorecard is the artifact this run exists to produce.
          console.log(scoreLine(score))
        })
      } catch (error) {
        const failed: Score = {
          id: question.id,
          expected: question.tool,
          called: [],
          toolMatch: false,
          axesMatch: null,
          dataMatch: false,
          coverage: null,
          turns: 0,
          ms: Date.now() - started,
          note: `the harness could not score this: ${String(error).slice(0, 160)}`,
        }
        scores.push(failed)
        record({ ...failed, ask: question.ask, what: question.what })
        console.log(scoreLine(failed))
      }
    }

    const summary = {
      questions: scores.length,
      toolMatch: scores.filter((score) => score.toolMatch).length,
      axesMatch: scores.filter((score) => score.axesMatch === true).length,
      dataMatch: scores.filter((score) => score.dataMatch).length,
      medianMs: median(scores.map((score) => score.ms)),
    }
    record({ summary })
    // The scorecard is the artifact this run exists to produce.
    console.log('\n', JSON.stringify(summary, null, 2), `\nwritten to ${OUT}`)

    // **The only assertion.** A model that scores badly is the result this
    // exists to produce (D-057's accepted risk, measured rather than argued);
    // a harness that could not drive the integration at all is a defect, and
    // the two must not fail the same way. Every question reached a terminal
    // state above, so what is left to check is that the scorer saw something.
    expect(scores).toHaveLength(BENCH_QUESTIONS.length)
    expect(
      scores.some((score) => score.toolMatch),
      'no question reached its tool at all — the integration is broken, not the model'
    ).toBe(true)
  })
})

/** Model rounds, inferred from the steps: one round per issued call, at least one. */
function turnsOf(steps: readonly StepFacts[]): number {
  return Math.max(1, steps.length)
}

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
}
