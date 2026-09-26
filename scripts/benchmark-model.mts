/**
 * Replay D-046 directly against one model, using the deployed hosted tier as
 * the tool runtime. This is the fast model-comparison harness: one headless
 * page owns the exact shipped Worker/tool implementation, while model turns
 * go straight to LocalAI's OpenAI-compatible endpoint. There is no corpus
 * download, UI driving, or LLM judge.
 *
 * Run deliberately:
 *
 *   MODEL=qwen3:8b node --experimental-strip-types --import ./scripts/ts-hooks.mjs \
 *     scripts/benchmark-model.mts
 */

import { chromium, type Page } from '@playwright/test'

import {
  BENCH_QUESTIONS,
  scoreLine,
  scoreQuestion,
  type Score,
  type StepFacts,
} from '../lib/benchmark.ts'
import { TODAY_TOKEN, systemPrompt } from '../lib/chat.ts'
import { parseToolCall, TOOLS } from '../lib/tools.ts'

const MODEL = process.env.MODEL ?? ''
const LOCALAI = process.env.LOCALAI_URL ?? 'http://llm:11434/v1/chat/completions'
const BASE_URL = process.env.BASE_URL ?? 'https://cve.meenan.dev'
const MAX_TURNS = 6
const MAX_TOKENS = Number(process.env.MAX_TOKENS ?? 8192)
const REASONING_EFFORT = process.env.REASONING_EFFORT ?? 'high'
const selectedIds = new Set(
  (process.env.BENCH_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
)
const QUESTIONS = selectedIds.size
  ? BENCH_QUESTIONS.filter((question) => selectedIds.has(question.id))
  : BENCH_QUESTIONS

if (!MODEL) throw new Error('MODEL is required')

interface FunctionCall {
  name: string
  arguments: unknown
}

interface ModelToolCall {
  id?: string
  function?: FunctionCall
}

interface ModelMessage {
  role: 'assistant'
  content?: string | null
  reasoning?: string | null
  tool_calls?: ModelToolCall[]
}

interface ConversationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}

interface AgentGlobal {
  ready: boolean
  call(name: string, args?: unknown): Promise<string>
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

async function ready(page: Page): Promise<void> {
  await page.goto(BASE_URL)
  await page.waitForFunction(
    () => {
      const agent = (window as unknown as { cveExplorer?: AgentGlobal }).cveExplorer
      return agent?.ready === true
    },
    undefined,
    { timeout: 60_000 }
  )
}

async function ask(messages: ConversationMessage[]): Promise<ModelMessage> {
  const response = await fetch(LOCALAI, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages,
      tools: TOOLS.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
      max_tokens: MAX_TOKENS,
      reasoning_effort: REASONING_EFFORT,
    }),
    signal: AbortSignal.timeout(180_000),
  })
  const body = (await response.json()) as {
    error?: { message?: string } | string
    choices?: Array<{ message?: ModelMessage }>
  }
  if (!response.ok || !body.choices?.[0]?.message) {
    const detail =
      typeof body.error === 'string'
        ? body.error
        : (body.error?.message ?? `HTTP ${response.status}`)
    throw new Error(`LocalAI: ${detail}`)
  }
  return body.choices[0].message
}

async function callTool(page: Page, name: string, args: unknown): Promise<string> {
  return page.evaluate(
    ([toolName, toolArgs]) =>
      (
        window as unknown as {
          cveExplorer: AgentGlobal
        }
      ).cveExplorer.call(toolName, toolArgs),
    [name, args] as const
  )
}

async function truth(page: Page, sql: string): Promise<(string | number | null)[][]> {
  const result = await page.evaluate(async (query) => {
    const response = await fetch('/api/sql.php', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql: query, params: [], limit: 1_000 }),
    })
    return (await response.json()) as {
      error?: string
      rows?: unknown[][]
      truncated?: boolean
      overflowed?: boolean
    }
  }, sql)
  if (result.error) throw new Error(`ground truth: ${result.error}`)
  if (result.truncated || result.overflowed) throw new Error('ground truth was capped')
  return (result.rows ?? []) as (string | number | null)[][]
}

function scalar(value: unknown): string | number | null {
  return value === null || value === undefined
    ? null
    : typeof value === 'number'
      ? value
      : String(value)
}

function facts(name: string, text: string, ms: number): StepFacts {
  let result: Record<string, unknown> = {}
  try {
    result = JSON.parse(text) as Record<string, unknown>
  } catch {
    return {
      tool: name,
      status: 'refused',
      ms,
      rows: null,
      series: null,
      matches: null,
      cells: [],
      error: 'the tool returned something the direct harness could not read',
    }
  }

  const refused = result.refused === true
  const base: StepFacts = {
    tool: name,
    status: refused ? 'refused' : 'done',
    ms,
    rows: null,
    series: null,
    matches: null,
    cells: [],
    ...(refused && typeof result.reason === 'string' ? { error: result.reason } : {}),
  }
  if (refused) return base

  switch (name) {
    case 'aggregate':
      base.rows = typeof result.rows === 'string' ? (result.rows as StepFacts['rows']) : null
      base.series =
        result.series === null || typeof result.series === 'string'
          ? (result.series as StepFacts['series'])
          : null
      base.matches = typeof result.recordsMatched === 'number' ? result.recordsMatched : null
      base.cells = Array.isArray(result.cells)
        ? (result.cells as unknown[][]).map((row) => row.map(scalar))
        : []
      break
    case 'search_records':
      base.matches = typeof result.recordsMatched === 'number' ? result.recordsMatched : null
      break
    case 'cve_detail':
      base.cells = [[scalar(result.cveId), result.found === true ? 1 : 0]]
      break
    case 'kev_lookup':
      base.cells = [
        [
          scalar(result.cveId),
          result.knownToThisCopy === false ? -1 : result.listedByCisa === true ? 1 : 0,
        ],
      ]
      break
    case 'sql':
      base.cells = Array.isArray(result.rows)
        ? (result.rows as unknown[][]).map((row) => row.map(scalar))
        : []
      break
    case 'compute':
      base.cells = [[result.ok === true ? scalar(result.value) : scalar(result.error)]]
      break
  }
  return base
}

async function runQuestion(page: Page, question: (typeof BENCH_QUESTIONS)[number]): Promise<Score> {
  await page.reload()
  await page.waitForFunction(
    () => (window as unknown as { cveExplorer?: AgentGlobal }).cveExplorer?.ready === true,
    undefined,
    { timeout: 60_000 }
  )

  const started = Date.now()
  const steps: StepFacts[] = []
  const messages: ConversationMessage[] = [
    {
      role: 'system',
      content: systemPrompt().replace(TODAY_TOKEN, today()),
    },
    { role: 'user', content: question.ask },
  ]
  const seen = new Set<string>()
  let turns = 0

  for (; turns < MAX_TURNS; turns += 1) {
    const reply = await ask(messages)
    const calls = Array.isArray(reply.tool_calls) ? reply.tool_calls : []
    if (!calls.length) break

    const normalized = calls.map((call, index) => {
      const name = call.function?.name ?? ''
      const raw = call.function?.arguments ?? '{}'
      return {
        id: call.id || `call_${turns}_${index}`,
        type: 'function' as const,
        function: {
          name,
          arguments: typeof raw === 'string' ? raw : JSON.stringify(raw),
        },
        raw,
      }
    })
    messages.push({
      role: 'assistant',
      content: reply.content ?? '',
      tool_calls: normalized.map(({ raw: _raw, ...call }) => call),
    })

    for (const call of normalized) {
      const parsed = parseToolCall(call.function.name, call.raw)
      const signature = parsed.ok ? JSON.stringify(parsed.call) : ''
      let output: string
      const toolStarted = Date.now()
      if (!parsed.ok) {
        output = JSON.stringify({
          tool: call.function.name,
          refused: true,
          reason: parsed.error,
        })
      } else if (seen.has(signature)) {
        output = JSON.stringify({
          tool: call.function.name,
          refused: true,
          reason:
            'this exact call already ran and returned the rows above; use those rows or make a different call',
        })
      } else {
        seen.add(signature)
        output = await callTool(page, call.function.name, call.raw)
      }
      steps.push(facts(call.function.name, output, Date.now() - toolStarted))
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: output,
      })
    }
  }

  const accepted = [...steps]
    .reverse()
    .find(
      (step) =>
        step.status === 'done' &&
        (step.tool === question.tool || (question.also ?? []).includes(step.tool as never))
    )
  const expected = await truth(page, question.truth(accepted?.rows ?? null))
  return scoreQuestion(question, steps, expected, Math.max(1, turns + 1), Date.now() - started)
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
try {
  await ready(page)
  const scores: Score[] = []
  for (const question of QUESTIONS) {
    try {
      const score = await runQuestion(page, question)
      scores.push(score)
      console.log(scoreLine(score))
    } catch (error) {
      const score: Score = {
        id: question.id,
        expected: question.tool,
        called: [],
        toolMatch: false,
        axesMatch: null,
        dataMatch: false,
        coverage: null,
        turns: 0,
        ms: 0,
        note: `harness error: ${String(error).slice(0, 200)}`,
      }
      scores.push(score)
      console.log(scoreLine(score))
    }
  }
  // A harness timeout has `ms: 0` because no model duration completed. Do not
  // let that sentinel make a slow or failed model look faster in the summary.
  const sorted = scores
    .map((score) => score.ms)
    .filter((ms) => ms > 0)
    .sort((left, right) => left - right)
  const summary = {
    model: MODEL,
    questions: scores.length,
    toolMatch: scores.filter((score) => score.toolMatch).length,
    axesMatch: scores.filter((score) => score.axesMatch === true).length,
    dataMatch: scores.filter((score) => score.dataMatch).length,
    medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
  }
  console.log(`SUMMARY ${JSON.stringify(summary)}`)
} finally {
  await browser.close()
}
