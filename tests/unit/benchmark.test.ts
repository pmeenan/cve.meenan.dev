import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it } from 'vitest'

import { BENCH_QUESTIONS, scoreLine, scoreQuestion, type StepFacts } from '../../lib/benchmark'
import { bucketLabel } from '../../lib/chart'
import { DIMENSIONS, type Dimension } from '../../lib/filters'
import { CONSOLE_ROW_LIMIT } from '../../lib/authorizer'
import { KEV_DDL } from '../../lib/kev'
import { SEARCH_INDEXES, indexSql } from '../../lib/search'
import { TOOL_NAMES } from '../../lib/tools'

/**
 * The benchmark's own rules (D-046).
 *
 * Scoring is a set of decisions — what counts as a match, what counts as the
 * model's fault, what is merely a display choice — and a decision that only
 * ever runs against live inference is one nobody can check. So the rules are
 * pure and they are tested here, with no model and no corpus.
 *
 * The two that took a correction before the harness ever ran are the ones most
 * worth pinning: a chart showing the top 12 of 336 months is a **correct**
 * answer, and "how many CRITICAL CVEs affect Cisco" is a count whose grouping
 * axis is not the question. Both would have scored a right answer wrong.
 */

function step(over: Partial<StepFacts> = {}): StepFacts {
  return {
    tool: 'aggregate',
    status: 'done',
    ms: 12,
    rows: 'year',
    series: 'severity',
    matches: 100,
    cells: [],
    ...over,
  }
}

const question = BENCH_QUESTIONS.find((entry) => entry.id === 'severity-over-time')!
const counted = BENCH_QUESTIONS.find((entry) => entry.id === 'cisco-criticals')!

describe('the question set', () => {
  it('has eleven questions with unique ids', () => {
    expect(BENCH_QUESTIONS).toHaveLength(11)
    expect(new Set(BENCH_QUESTIONS.map((entry) => entry.id)).size).toBe(11)
  })

  it('exercises every tool at least once (D-046)', () => {
    const covered = new Set(BENCH_QUESTIONS.map((entry) => entry.tool))
    for (const name of TOOL_NAMES) expect([...covered], name).toContain(name)
  })

  it('leads with D-046’s two canonical items', () => {
    expect(BENCH_QUESTIONS[0]!.id).toBe('severity-over-time')
    expect(BENCH_QUESTIONS[1]!.id).toBe('vendor-product-severity-2y')
  })

  it('never names a tool or an axis in the question a person types', () => {
    // A question that says "use aggregate with rows=year" measures nothing.
    for (const entry of BENCH_QUESTIONS) {
      const asked = entry.ask.toLowerCase()
      for (const name of TOOL_NAMES) expect(asked, entry.id).not.toContain(name)
      expect(asked, entry.id).not.toContain('rows=')
      expect(asked, entry.id).not.toContain('series')
    }
  })

  it('produces runnable SQL for every axis a model might pick', () => {
    // A time question answered with `rows: 'vendor'` must still yield valid
    // truth SQL — otherwise a wrong answer crashes the harness instead of
    // being scored, and the run ends with no scorecard at all.
    for (const entry of BENCH_QUESTIONS) {
      for (const rows of [null, ...DIMENSIONS] as (Dimension | null)[]) {
        const sql = entry.truth(rows)
        expect(sql, `${entry.id} / ${rows}`).toMatch(/^SELECT /)
        expect(sql, `${entry.id} / ${rows}`).not.toContain('undefined')
      }
    }
  })

  it('runs, against real SQLite with the published schema', () => {
    // The check that would have saved an hour: the harness runs these through
    // the SQL console *after* a full-corpus download and ten inference round
    // trips, so a typo or a column that does not exist is discovered at the
    // very end of a long run. Here it is discovered in 200 ms.
    //
    // The database is empty on purpose. What is being checked is that each
    // statement prepares and executes — names, joins, window functions, the
    // `kev` overlay and the client-built FTS index all resolving — not what it
    // returns, which depends on a corpus no unit test should need.
    const db = new DatabaseSync(':memory:')
    db.exec(readFileSync('pipeline/schema.sql', 'utf-8'))
    // Both are created by the *client* after import, not shipped in the
    // artifact (D-035, D-076), so a truth query touching them needs them here.
    for (const statement of KEV_DDL) db.exec(statement)
    for (const index of SEARCH_INDEXES) db.exec(indexSql(index).create)

    for (const entry of BENCH_QUESTIONS) {
      for (const rows of [null, 'year', 'month', 'quarter', 'product'] as (Dimension | null)[]) {
        const sql = entry.truth(rows)
        expect(() => db.prepare(sql).all(), `${entry.id} / ${rows}: ${sql}`).not.toThrow()
      }
    }
    db.close()
  })

  it('bounds every ground-truth query below the console row cap', () => {
    // The harness reads these back through the SQL console, which caps at
    // CONSOLE_ROW_LIMIT and says so. A capped truth is not a truth: the rows
    // past the cap score as "the model invented this". Month × severity alone
    // is 2,016 rows.
    for (const entry of BENCH_QUESTIONS) {
      const sql = entry.truth('month')
      // Only the ones that can return many rows. A bare `count(*)` with no
      // GROUP BY returns exactly one and needs no bound.
      if (!/GROUP BY/i.test(sql)) continue
      expect(sql, entry.id).toMatch(/LIMIT \d+/)
      const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? '0')
      expect(limit, entry.id).toBeLessThan(CONSOLE_ROW_LIMIT)
    }
  })

  it('orders each ground truth the way the chart narrows, so the cap keeps the right rows', () => {
    // Without this the truth holds the *oldest* months while the chart shows
    // the newest, and every correct answer scores as wrong.
    const overTime = BENCH_QUESTIONS.find((entry) => entry.id === 'severity-over-time')!
    expect(overTime.truth('month')).toContain('ORDER BY bucket DESC')
    const byCwe = BENCH_QUESTIONS.find((entry) => entry.id === 'top-cwes')!
    expect(byCwe.truth(null)).toContain('ORDER BY cves DESC')
  })

  it('writes ground truth as a single SELECT, never a script', () => {
    for (const entry of BENCH_QUESTIONS) {
      const sql = entry.truth('year')
      expect(sql.trim().endsWith(';'), entry.id).toBe(false)
      expect(sql, entry.id).not.toMatch(/;\s*\w/)
    }
  })
})

describe('scoreQuestion', () => {
  it('accepts a grounded answer through an `also` route, and says so', () => {
    // The compute question (D-088) is a ratio over a result set; a model that
    // writes it as one SELECT has answered well. Scored as a tool match with
    // the route in the note, so a scorecard reader sees which way it went —
    // and a wrong number through either route is still wrong.
    const computed = BENCH_QUESTIONS.find((entry) => entry.id === 'compute-perfect-share')!
    const truth = [[0.12]]
    const viaCompute = scoreQuestion(
      computed,
      [step({ tool: 'search_records', cells: [] }), step({ tool: 'compute', cells: [['0.12']] })],
      truth,
      1,
      900
    )
    expect(viaCompute.toolMatch).toBe(true)
    expect(viaCompute.dataMatch).toBe(true)
    expect(viaCompute.note).toBe('exact')
    const viaSql = scoreQuestion(computed, [step({ tool: 'sql', cells: [[0.12]] })], truth, 1, 900)
    expect(viaSql.toolMatch).toBe(true)
    expect(viaSql.dataMatch).toBe(true)
    expect(viaSql.note).toBe('exact (via sql)')
    const wrong = scoreQuestion(computed, [step({ tool: 'sql', cells: [[0.5]] })], truth, 1, 900)
    expect(wrong.toolMatch).toBe(true)
    expect(wrong.dataMatch).toBe(false)
    expect(wrong.note).toMatch(/via sql/)
    // The final answer is what is scored: a wrong compute the model then
    // corrected with SQL is a right answer via sql, not a wrong one via compute.
    const corrected = scoreQuestion(
      computed,
      [step({ tool: 'compute', cells: [['0.9']] }), step({ tool: 'sql', cells: [[0.12]] })],
      truth,
      2,
      900
    )
    expect(corrected.dataMatch).toBe(true)
    expect(corrected.note).toBe('exact (via sql)')
    const other = scoreQuestion(computed, [step({ tool: 'aggregate' })], truth, 1, 900)
    expect(other.toolMatch).toBe(false)
  })

  it('scores a correct top-N chart as correct', () => {
    // The correction that matters: `crossSql` narrows each axis by design, so a
    // chart shows 12 of 336 months. Set equality would fail every right answer
    // to a broad question, which is scoring the row cap.
    const truth = Array.from({ length: 336 }, (_, index) => [`2020-${index}`, 'HIGH', index])
    const cells = truth.slice(0, 12)
    const score = scoreQuestion(question, [step({ cells })], truth, 1, 900)
    expect(score.dataMatch).toBe(true)
    expect(score.coverage).toEqual({ emitted: 12, available: 336 })
    expect(score.note).toContain('all correct')
  })

  it('catches a wrong number inside an otherwise plausible chart', () => {
    const truth = [
      ['2025', 'HIGH', 10],
      ['2025', 'CRITICAL', 4],
    ]
    const cells = [
      ['2025', 'HIGH', 10],
      ['2025', 'CRITICAL', 5],
    ]
    const score = scoreQuestion(question, [step({ cells })], truth, 1, 900)
    expect(score.dataMatch).toBe(false)
    expect(score.note).toContain('1 of 2 cells')
  })

  it('refuses to call an empty answer a subset match', () => {
    // Every set contains the empty set, so a tool that returned nothing would
    // otherwise score as "all correct" — the one way this comparison could be
    // catastrophically wrong.
    const score = scoreQuestion(question, [step({ cells: [] })], [['2025', 'HIGH', 10]], 1, 900)
    expect(score.dataMatch).toBe(false)
    expect(score.note).toContain('no cells')
  })

  it('compares a count exactly, whatever the model grouped by', () => {
    const score = scoreQuestion(
      counted,
      [step({ matches: 4_312, rows: 'year', cells: [['2025', 12]] })],
      [[4_312]],
      1,
      500
    )
    expect(score.dataMatch).toBe(true)
    // The axis is not scored for a "how many" question, so it is not judged.
    expect(score.axesMatch).toBeNull()
  })

  it('separates the wrong tool from wrong data', () => {
    // D-057's accepted risk is only separable if these fail differently.
    const score = scoreQuestion(question, [step({ tool: 'sql' })], [['2025', 'HIGH', 1]], 2, 4_000)
    expect(score.toolMatch).toBe(false)
    expect(score.dataMatch).toBe(false)
    expect(score.called).toEqual(['sql'])
    expect(score.note).toContain('called sql instead')
  })

  it('ignores a step that refused, and says no tool was reached', () => {
    const score = scoreQuestion(
      question,
      [step({ status: 'refused', cells: [] })],
      [['2025', 'HIGH', 1]],
      1,
      100
    )
    expect(score.toolMatch).toBe(false)
    // …and distinguishes it from calling the wrong tool: "aggregate refused"
    // and "it used sql instead" are different failures with different fixes.
    expect(score.note).toContain('refused')
  })

  it('compares against the labels the chart renders, not stored codes', () => {
    // The bug this pins cost a benchmark run: `crossSql` returns `c.cvss_sev`
    // in the label column for a code dimension, so the panel published `4` and
    // `null` while the ground truth said `CRITICAL` and `(not scored)`, and
    // every correct answer scored as wrong. `bucketLabel` is the one function
    // every surface uses, and the truth SQL spells its output exactly.
    const sql = question.truth('year')
    expect(sql).toContain("'CRITICAL'")
    // `(not scored)` for an unscored CVE — *not* `(not assessed)`, which is an
    // SSVC point nobody looked at. Half the corpus is in this band.
    expect(sql).toContain("'(not scored)'")
    expect(sql).not.toContain('(not assessed)')
    expect(bucketLabel('severity', null, null)).toBe('(not scored)')
    expect(bucketLabel('severity', 4, 4)).toBe('CRITICAL')
  })

  it('scores axes against the accepted set, not one blessed answer', () => {
    // "Over time" is year, quarter *or* month; demanding one measures
    // prompt-guessing rather than tool use.
    for (const rows of ['year', 'quarter', 'month'] as Dimension[]) {
      expect(scoreQuestion(question, [step({ rows })], [], 1, 1).axesMatch, rows).toBe(true)
    }
    expect(scoreQuestion(question, [step({ rows: 'vendor' })], [], 1, 1).axesMatch).toBe(false)
    // …and the split still has to be right.
    expect(scoreQuestion(question, [step({ series: null })], [], 1, 1).axesMatch).toBe(false)
  })

  it('does not care about row order, which is a display decision', () => {
    const truth = [
      ['a', 'HIGH', 1],
      ['b', 'HIGH', 2],
    ]
    const cells = [
      ['b', 'HIGH', 2],
      ['a', 'HIGH', 1],
    ]
    expect(scoreQuestion(question, [step({ cells })], truth, 1, 1).dataMatch).toBe(true)
  })

  it('compares numbers and their string spellings as equal', () => {
    // The truth rows come back out of a rendered table as text; the tool's own
    // cells are numbers. A benchmark that failed on that would be measuring
    // the DOM.
    const score = scoreQuestion(
      question,
      [step({ cells: [['2025', 'HIGH', 10]] })],
      [['2025', 'HIGH', '10']],
      1,
      1
    )
    expect(score.dataMatch).toBe(true)
  })

  it('renders a scorecard line with every field a reader needs', () => {
    const line = scoreLine(scoreQuestion(question, [step({ cells: [] })], [], 3, 12_345))
    expect(line).toContain('severity-over-time')
    expect(line).toContain('tool ✓')
    expect(line).toContain('3 turns')
    expect(line).toContain('12345 ms')
  })
})
