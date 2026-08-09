/**
 * The tool-calling benchmark (D-046, M7).
 *
 * Ten analyst questions, each with **hand-written SQL ground truth** computed
 * against the real corpus in the same browser, in the same session, moments
 * apart. Scoring is a data comparison — no LLM judge — which is what D-044's
 * report definitions bought: the model's output is a definition and a result
 * set, and both are comparable to a query anyone can read.
 *
 * Three things about the shape are deliberate.
 *
 * **The ground truth runs in the browser under test.** A number recorded here
 * would be a number about whichever generation was current when it was written,
 * and the corpus grows daily (D-058). So the truth query runs against the same
 * local copy the model just queried, and the comparison is between two answers
 * to the same question at the same moment.
 *
 * **"Over time" has three right answers.** Year, quarter and month are all
 * legitimate readings, and a benchmark that demanded one would be scoring
 * prompt-guessing rather than tool use. So a question can accept a *set* of
 * axes, and the truth SQL is written per grain — still hand-written, just three
 * of them.
 *
 * **A wrong tool is scored separately from wrong data.** They fail differently:
 * the first is the model not understanding the surface, the second is it
 * understanding the surface and getting the arguments wrong, and D-057's
 * accepted risk — mistaking an 8B model's failures for tool-surface bugs — is
 * only separable if the scorecard keeps them apart.
 */

import { TIME_DIMENSIONS, type Dimension } from './filters'
import type { ToolName } from './tools'

/** How a question's answer is reduced to something comparable. */
export type Compare =
  /** Sorted `[bucket, series, count]` triples from the aggregate's own cells. */
  | 'cells'
  /** One number: how many records matched. */
  | 'matches'
  /** One row of scalars — what the `sql` tool returned. */
  | 'row'
  /** `[cveId, found]` — the record exists in this copy. */
  | 'record'
  /** `[cveId, listed]` — CISA lists it, or does not. */
  | 'kev'

export interface BenchQuestion {
  id: string
  /** What a person types. Never a hint about which tool to use. */
  ask: string
  /** Why this one is in the set — what it would catch if it failed. */
  what: string
  /** The tool a grounded answer has to go through. */
  tool: ToolName
  compare: Compare
  /**
   * Which `rows` axes are acceptable. Absent means the axis is not scored —
   * for questions where the grouping is not the thing being tested.
   */
  rows?: readonly Dimension[]
  /** Which `series` axis is required. `null` means "no split". */
  series?: Dimension | null
  /**
   * The ground truth, as SQL. A function of the chosen row axis for the
   * time-grain questions, a constant for the rest — each branch hand-written.
   *
   * **Ordered the way `crossSql` narrows, and bounded under the console's
   * 1,000-row cap.** The harness reads these back through the SQL console,
   * which caps and says so; a capped truth is not a truth, because the rows
   * past the cap would score as "the model invented this". Month × severity is
   * 336 × 6 = 2,016 rows and product × severity is far more, so without an
   * `ORDER BY` matching the narrowing — recent first for time, biggest first
   * for identity — the truth would hold the *oldest* months while the chart
   * showed the newest, and every correct answer would score as wrong.
   */
  truth: (rows: Dimension | null) => string
}

/** `strftime` for each grain, matching `lib/filters.ts`'s dimension SQL exactly. */
const GRAIN: Record<string, string> = {
  year: "strftime('%Y', c.published, 'unixepoch')",
  month: "strftime('%Y-%m', c.published, 'unixepoch')",
  quarter:
    "strftime('%Y', c.published, 'unixepoch') || '-Q' || " +
    "((CAST(strftime('%m', c.published, 'unixepoch') AS INTEGER) + 2) / 3)",
}

/**
 * The severity labels, as SQL — **exactly what `bucketLabel` renders**.
 *
 * Including `(not scored)` for NULL, which is what the chart says and is *not*
 * `(not assessed)`: nobody scored the CVE, as against nobody having assessed an
 * SSVC decision point, and `lib/chart.ts` keeps the two apart on purpose
 * (D-070, D-073). Getting it wrong here would fail a correct answer on the one
 * band that covers half the corpus.
 */
const SEVERITY_LABEL =
  "CASE c.cvss_sev WHEN 0 THEN 'NONE' WHEN 1 THEN 'LOW' WHEN 2 THEN 'MEDIUM' " +
  "WHEN 3 THEN 'HIGH' WHEN 4 THEN 'CRITICAL' ELSE '(not scored)' END"

/**
 * Two years before today, in unix seconds, computed at run time.
 *
 * It was the literal 1,722,470,400 — 2024-08-01, borrowed from
 * `lib/queries.ts`, where a fixed epoch is right because it is an example
 * someone reads. Here it was wrong twice over: it drifts further from "the
 * last two years" every day the file is not edited, and on 2026-08-09 it was
 * already eight days wider than any correct reading of the question. A model
 * that resolved the window *perfectly* still scored `data ✗`, because the rows
 * it counted were a strict subset of the rows the truth counted.
 *
 * Now the same date arithmetic the model is asked to do, so a right answer can
 * score right. What it cannot settle is the ambiguity in the question itself —
 * a model that reads "the last two years" as whole calendar years is not
 * wrong, and will still miss. That is a property of the question, which is
 * deliberately the kind of thing a person actually types.
 */
function twoYearsAgo(): number {
  const now = new Date()
  const then = Date.UTC(now.getUTCFullYear() - 2, now.getUTCMonth(), now.getUTCDate())
  return Math.floor(then / 1000)
}

export const BENCH_QUESTIONS: readonly BenchQuestion[] = [
  {
    id: 'severity-over-time',
    ask: 'Show me a stacked count of CVEs by severity over time.',
    what: "D-046 item #1 — the owner's founding question, and the milestone's exit criterion",
    tool: 'aggregate',
    compare: 'cells',
    rows: ['year', 'quarter', 'month'],
    series: 'severity',
    truth: (rows) =>
      `SELECT ${isTimeGrain(rows) ? GRAIN[rows as string] : GRAIN.year} AS bucket, ` +
      `${SEVERITY_LABEL} AS series, count(*) AS cves ` +
      `FROM cve c WHERE c.state = 1 GROUP BY bucket, c.cvss_sev ` +
      `ORDER BY bucket DESC LIMIT 900`,
  },
  {
    id: 'vendor-product-severity-2y',
    ask: 'Break down CVE counts by vendor and product and severity for the last two years.',
    what: "D-046 item #2 — M4's exit-criterion variant, and the only three-way question here",
    tool: 'aggregate',
    compare: 'cells',
    // `product` labels as `vendor / product` (lib/filters.ts), which is why one
    // axis covers two of the three dimensions the question names.
    rows: ['product'],
    series: 'severity',
    truth: () =>
      `SELECT v.name || ' / ' || p.name AS bucket, ${SEVERITY_LABEL} AS series, ` +
      `count(DISTINCT c.id) AS cves FROM cve c ` +
      `JOIN cve_prod cp ON cp.cve_id = c.id JOIN product p ON p.id = cp.product_id ` +
      `JOIN vendor v ON v.id = p.vendor_id ` +
      `WHERE c.state = 1 AND c.published >= ${twoYearsAgo()} GROUP BY p.id, c.cvss_sev ` +
      `ORDER BY sum(count(DISTINCT c.id)) OVER (PARTITION BY p.id) DESC, p.id LIMIT 900`,
  },
  {
    id: 'critical-by-cna',
    ask: 'Which CNAs assign the most CRITICAL CVEs?',
    what: 'a filter and a grouping at once — the shape most analyst questions have',
    tool: 'aggregate',
    compare: 'cells',
    rows: ['cna'],
    series: null,
    truth: () =>
      `SELECT n.name AS bucket, count(*) AS cves FROM cve c JOIN cna n ON n.id = c.cna_id ` +
      `WHERE c.state = 1 AND c.cvss_sev = 4 GROUP BY c.cna_id ORDER BY cves DESC LIMIT 900`,
  },
  {
    id: 'top-cwes',
    ask: 'What are the most common weakness types in the corpus?',
    what: 'a grouping through a link table, where a join would count records twice',
    tool: 'aggregate',
    compare: 'cells',
    rows: ['cwe'],
    series: null,
    truth: () =>
      `SELECT w.cwe || ' — ' || w.descr AS bucket, count(DISTINCT c.id) AS cves FROM cve c ` +
      `JOIN cve_cwe x ON x.cve_id = c.id JOIN cwe w ON w.id = x.cwe_id ` +
      `WHERE c.state = 1 GROUP BY w.id ORDER BY cves DESC LIMIT 900`,
  },
  {
    id: 'kev-by-year',
    ask: 'How many known-exploited CVEs were published each year?',
    what: 'the KEV overlay as a filter rather than as a lookup (M6)',
    tool: 'aggregate',
    compare: 'cells',
    rows: ['year'],
    series: null,
    truth: () =>
      `SELECT ${GRAIN.year} AS bucket, count(*) AS cves FROM cve c ` +
      `WHERE c.state = 1 AND EXISTS (SELECT 1 FROM kev k WHERE k.cve_id = c.id) ` +
      `GROUP BY bucket ORDER BY bucket DESC LIMIT 900`,
  },
  {
    id: 'search-deserialization',
    ask: 'Find CRITICAL CVEs about deserialization.',
    what: 'full text plus a code filter, and the one tool whose rows the model never sees',
    tool: 'search_records',
    compare: 'matches',
    // `count(*)`, not `count(DISTINCT c.id)`: `fts.rowid` is `cve.id`, so the
    // join produces one row per record and the DISTINCT is redundant — and it
    // is not free. With it, this query did not finish inside the harness's
    // three-minute ground-truth budget and the question went unscored.
    truth: () =>
      `SELECT count(*) FROM fts JOIN cve c ON c.id = fts.rowid ` +
      `WHERE fts MATCH 'deserialization' AND c.state = 1 AND c.cvss_sev = 4`,
  },
  {
    id: 'cisco-criticals',
    ask: 'How many CRITICAL CVEs affect Cisco products?',
    what: 'a lookup-axis filter, where a wrong vendor name is a plausible empty answer',
    tool: 'aggregate',
    // The *count*, not the cells. Which axis the model groups a "how many"
    // question by is not the question, and scoring cells would fail a correct
    // answer for grouping by year rather than by severity — which is scoring
    // taste, not tool use. `recordsMatched` is the count under the filters,
    // whatever the grouping.
    compare: 'matches',
    truth: () =>
      `SELECT count(DISTINCT c.id) FROM cve c ` +
      `WHERE c.state = 1 AND c.cvss_sev = 4 AND EXISTS (` +
      `SELECT 1 FROM cve_prod cp JOIN product p ON p.id = cp.product_id ` +
      `JOIN vendor v ON v.id = p.vendor_id ` +
      `WHERE cp.cve_id = c.id AND lower(v.name) = 'cisco')`,
  },
  {
    id: 'log4shell-detail',
    ask: 'Tell me about CVE-2021-44228.',
    what: 'one record by identifier — the tool a model most often answers from memory instead',
    tool: 'cve_detail',
    compare: 'record',
    truth: () => `SELECT 'CVE-2021-44228', 1 FROM cve WHERE lower(cve_id) = 'cve-2021-44228'`,
  },
  {
    id: 'kev-listed',
    ask: 'Is CVE-2021-44228 in CISA’s known exploited vulnerabilities catalog?',
    what: 'the KEV lookup, on a record that is listed',
    tool: 'kev_lookup',
    compare: 'kev',
    truth: () =>
      `SELECT 'CVE-2021-44228', CASE WHEN EXISTS (SELECT 1 FROM kev k JOIN cve c ON c.id = k.cve_id ` +
      `WHERE lower(c.cve_id) = 'cve-2021-44228') THEN 1 ELSE 0 END`,
  },
  {
    id: 'sql-highest-score',
    ask: 'What is the single highest CVSS score in the corpus, and how many records have it?',
    what: 'a question no curated tool can express, so the SQL tool is the only grounded route',
    tool: 'sql',
    compare: 'row',
    truth: () =>
      `SELECT max(cvss_score), count(*) FROM cve WHERE state = 1 AND cvss_score = ` +
      `(SELECT max(cvss_score) FROM cve WHERE state = 1)`,
  },
]

/** What the panel exposes per step, so a score is read from data and not from prose. */
export interface StepFacts {
  tool: string
  status: string
  ms: number | null
  /** The axes of the definition the Worker ran, when the tool emits one. */
  rows: Dimension | null
  series: Dimension | null
  matches: number | null
  /** `[bucket, series, count]` for an aggregate; `[cveId, flag]` for the lookups. */
  cells: (string | number | null)[][]
  /**
   * Why the call was refused, when it was.
   *
   * The field that separates the two failures D-057's accepted risk is about:
   * "the model invented an argument" and "our schema would not accept a
   * reasonable one" both show up as a refusal, and only the reason tells them
   * apart. Without it the scorecard says a question failed and leaves the next
   * person to reproduce it by hand.
   */
  error?: string
}

export interface Score {
  id: string
  /** The tool the question needs, and the tools actually called, in order. */
  expected: ToolName
  called: string[]
  toolMatch: boolean
  /** The axes were among the acceptable ones. Null when the question does not score them. */
  axesMatch: boolean | null
  dataMatch: boolean
  /**
   * How much of the ground truth the answer covered — emitted rows over truth
   * rows, when the comparison is over cells.
   *
   * Reported *beside* `dataMatch` rather than folded into it, because a chart
   * showing the top 12 of 336 months is a correct answer to the question and a
   * partial answer to the corpus, and only one of those is a defect. Null when
   * the comparison is a single value.
   */
  coverage: { emitted: number; available: number } | null
  /** Model rounds used — one is the ideal, more means it needed correcting. */
  turns: number
  ms: number
  /** What differed, when something did. One sentence, for the scorecard. */
  note: string
}

/**
 * Score one answered question against its ground truth.
 *
 * Pure, so the scoring rules are unit-testable without a model: what counts as
 * a match is a decision, and a decision that only ever runs against live
 * inference is one nobody can check.
 */
export function scoreQuestion(
  question: BenchQuestion,
  steps: readonly StepFacts[],
  truth: readonly (string | number | null)[][],
  turns: number,
  ms: number
): Score {
  const called = steps.map((step) => step.tool)
  const step = steps.find((entry) => entry.tool === question.tool && entry.status === 'done')
  const base = { id: question.id, expected: question.tool, called, turns, ms }

  if (!step) {
    return {
      ...base,
      toolMatch: false,
      axesMatch: null,
      dataMatch: false,
      coverage: null,
      note: steps.some((entry) => entry.tool === question.tool)
        ? `called ${question.tool}, and it refused: ` +
          (steps.find((entry) => entry.tool === question.tool && entry.error)?.error ??
            'no reason recorded')
        : called.length
          ? `called ${called.join(', ')} instead`
          : 'called no tool at all',
    }
  }

  const axesMatch =
    question.rows === undefined
      ? null
      : step.rows !== null &&
        question.rows.includes(step.rows) &&
        (question.series === undefined || (step.series ?? null) === (question.series ?? null))

  const want = normalize(truth)

  // A single value — a count, a row, a lookup — is compared exactly.
  if (question.compare !== 'cells') {
    const got = normalize(question.compare === 'matches' ? [[step.matches]] : step.cells)
    const dataMatch = same(got, want)
    return {
      ...base,
      toolMatch: true,
      axesMatch,
      dataMatch,
      coverage: null,
      note: dataMatch ? 'exact' : difference(got, want),
    }
  }

  // Cells are compared as a **subset**, and that is the interesting decision
  // here. A chart legitimately shows the top 12 of 336 months — `crossSql`
  // narrows each axis by design — so demanding set equality would fail every
  // correct answer to a broad question and would be scoring the row cap. What
  // ground truth is *for* is whether the numbers the model produced are right,
  // so every emitted cell must appear in the truth with the same value, and
  // how much of the truth it covered is reported separately.
  const got = normalize(step.cells)
  const available = new Set(want)
  const wrong = got.filter((row) => !available.has(row))
  const dataMatch = got.length > 0 && wrong.length === 0

  return {
    ...base,
    toolMatch: true,
    axesMatch,
    dataMatch,
    coverage: { emitted: got.length, available: want.length },
    note: !got.length
      ? 'the tool returned no cells at all'
      : wrong.length
        ? `${wrong.length} of ${got.length} cells are not in the ground truth, first ${readable(wrong[0] ?? '')}`
        : `${got.length} of ${want.length} ground-truth cells, all correct`,
  }
}

/**
 * Comparable rows: trimmed, stringified, sorted.
 *
 * Sorted because ordering is a *display* decision — `crossSql` orders rows for
 * reading and the truth query does not order at all — and a benchmark that
 * failed on row order would be scoring the chart layer.
 */
const SEP = '\u0000'

function normalize(rows: readonly (string | number | null | undefined)[][]): string[] {
  // NUL, because a label legitimately contains spaces and slashes
  // (`vendor / product`) and a separator that can appear in the data would make
  // two different rows compare equal.
  return rows
    .map((row) =>
      row.map((cell) => (cell === null || cell === undefined ? '' : String(cell).trim())).join(SEP)
    )
    .sort()
}

/** A normalized row, back in something a scorecard reader can read. */
function readable(row: string): string {
  return row.split(SEP).join(' | ')
}

function same(got: readonly string[], want: readonly string[]): boolean {
  return got.length === want.length && got.every((row, index) => row === want[index])
}

/**
 * What differed, in one sentence.
 *
 * Counts first, then an example, because "it returned 12 buckets and the truth
 * has 336" and "it returned the right 12 buckets with one wrong number" are
 * different failures and the first is far commoner — a model that picked a
 * limit rather than one that miscounted.
 */
function difference(got: readonly string[], want: readonly string[]): string {
  if (got.length !== want.length) {
    return `${got.length} rows against ${want.length} in the ground truth`
  }
  const at = got.findIndex((row, index) => row !== want[index])
  if (at === -1) return 'differs'
  return `row ${at + 1} was ${readable(got[at] ?? '')}, ground truth ${readable(want[at] ?? '')}`
}

/** Every question that exercises a time grain, so a caller can pick the truth SQL. */
export function isTimeGrain(dimension: Dimension | null): boolean {
  return dimension !== null && TIME_DIMENSIONS.has(dimension)
}

/** The scorecard line for one question, in the shape the run prints. */
export function scoreLine(score: Score): string {
  const tool = score.toolMatch ? 'tool ✓' : 'tool ✗'
  const axes = score.axesMatch === null ? 'axes –' : score.axesMatch ? 'axes ✓' : 'axes ✗'
  const data = score.dataMatch ? 'data ✓' : 'data ✗'
  return (
    `${score.id.padEnd(28)} ${tool}  ${axes}  ${data}  ` +
    `${String(score.turns).padStart(2)} turns  ${String(Math.round(score.ms)).padStart(6)} ms  ` +
    `${score.note}`
  )
}
