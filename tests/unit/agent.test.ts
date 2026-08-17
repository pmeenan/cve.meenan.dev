import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  agentGlobal,
  agentGuide,
  agentResult,
  agentTools,
  GUIDE_TOOL,
  type AgentCall,
  type ToolRunner,
} from '../../lib/agent'
import { SCHEMA_BRIEF, TODAY_TOKEN } from '../../lib/chat'
import type { ToolCall, ToolOutcome } from '../../lib/protocol'
import { REPORT_VERSION } from '../../lib/report'
import { TOOL_NAMES, TOOLS } from '../../lib/tools'

/**
 * The agent surface (D-086): the same tools as chat, validated the same way,
 * wrapped in the MCP result envelope. What is under test is that nothing new
 * is reachable through it, and that the WebMCP annotations say what the
 * surface is.
 */

const AGGREGATE: ToolOutcome = {
  kind: 'aggregate',
  report: {
    v: REPORT_VERSION,
    filters: { state: 'published' },
    rows: 'year',
    series: null,
    chart: 'stackedBar',
  },
  result: {
    columns: ['bucket', 'label', 'cves'],
    rows: [['2025', '2025', 12]],
    ms: 3,
    truncated: false,
    sql: 'SELECT …',
    params: [],
  },
  matches: 12,
  unmatched: [],
}

/** A runner that records what reached it and answers with a fixed outcome. */
function runner(outcome: ToolOutcome = AGGREGATE): ToolRunner & { calls: ToolCall[] } {
  const calls: ToolCall[] = []
  const run: ToolRunner = async (call) => {
    calls.push(call)
    return outcome
  }
  return Object.assign(run, { calls })
}

describe('agentTools', () => {
  it('offers exactly the chat tools plus the guide, with the chat schemas verbatim', () => {
    const tools = agentTools(runner())
    expect(tools.map((tool) => tool.name)).toEqual([GUIDE_TOOL, ...TOOL_NAMES])
    for (const spec of TOOLS) {
      const tool = tools.find((entry) => entry.name === spec.name)!
      expect(tool.description).toBe(spec.description)
      expect(tool.inputSchema).toBe(spec.parameters)
    }
  })

  it('annotates every tool read-only, and every result but the guide as untrusted text', () => {
    for (const tool of agentTools(runner())) {
      expect(tool.annotations.readOnlyHint, tool.name).toBe(true)
      expect(tool.annotations.untrustedContentHint, tool.name).toBe(tool.name !== GUIDE_TOOL)
      // WebMCP names: 1–128 chars of [A-Za-z0-9_.-].
      expect(tool.name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/)
    }
  })

  it('validates a call exactly as the chat loop does, and never runs a refused one', async () => {
    const run = runner()
    const aggregate = agentTools(run).find((tool) => tool.name === 'aggregate')!
    const refused = await aggregate.execute({ rows: 'exploit_status' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]!.text).toContain('exploit_status')
    expect(run.calls).toHaveLength(0)

    const ok = await aggregate.execute({ rows: 'year', vendor: ['Cisco'] })
    expect(ok.isError).toBeUndefined()
    expect(run.calls).toHaveLength(1)
    expect(run.calls[0]).toMatchObject({ name: 'aggregate', report: { rows: 'year' } })
    // The text is the chat model's own bounded JSON, not rows.
    expect(JSON.parse(ok.content[0]!.text).recordsMatched).toBe(12)
  })

  it('answers a runner failure as a refusal rather than rejecting', async () => {
    const failing: ToolRunner = async () => {
      throw new Error('worker gone')
    }
    const sql = agentTools(failing).find((tool) => tool.name === 'sql')!
    const result = await sql.execute({ sql: 'SELECT 1' })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('worker gone')
  })

  it('reports every call to the observer — refused before running, run, or failed', async () => {
    // What the page's "Agent activity" log is built from: an agent's KEV
    // claim or computed value has to be on screen for the person at it, and
    // a call refused by validation is part of that record too.
    const seen: AgentCall[] = []
    const run = runner()
    const tools = agentTools(run, undefined, (call) => seen.push(call))
    const aggregate = tools.find((tool) => tool.name === 'aggregate')!
    await aggregate.execute({ rows: 'nope' })
    await aggregate.execute({ rows: 'year' })
    const failing = agentTools(
      async () => {
        throw new Error('worker gone')
      },
      undefined,
      (call) => seen.push(call)
    ).find((tool) => tool.name === 'sql')!
    await failing.execute({ sql: 'SELECT 1' })
    // …and an invented name through the window global, which is refused
    // before any tool's execute could report it.
    await agentGlobal(
      tools,
      () => true,
      () => null,
      (call) => seen.push(call)
    ).call('no_such')
    expect(seen.map((call) => [call.name, call.outcome.kind, call.call !== undefined])).toEqual([
      ['aggregate', 'refused', false],
      ['aggregate', 'aggregate', true],
      ['sql', 'refused', true],
      ['no_such', 'refused', false],
    ])
    expect(seen.every((call) => call.ms >= 0)).toBe(true)
  })
})

describe('agentGuide', () => {
  it('carries the chat prompt with today filled in, the dimensions and the schema', () => {
    const guide = agentGuide(new Date('2026-08-16T12:00:00Z'))
    expect(guide).toContain('Today is 2026-08-16')
    expect(guide).not.toContain(TODAY_TOKEN)
    expect(guide).toContain('week (Week)')
    expect(guide).toContain('window.cveExplorer')
    // The schema brief is the one `tests/unit/chat.test.ts` checks against schema.sql.
    expect(guide).toContain(SCHEMA_BRIEF.split('\n')[0]!)
  })
})

describe('agentGlobal', () => {
  it('lists the tools, runs one by name to its text, and refuses an unknown name', async () => {
    const run = runner()
    const global = agentGlobal(agentTools(run), () => true)
    expect(global.ready).toBe(true)
    expect(global.tools().map((tool) => tool.name)).toContain('kev_lookup')
    expect(global.schema).toBe(SCHEMA_BRIEF)
    expect(global.guide()).toContain('CVE Explorer')
    const text = await global.call('aggregate', { rows: 'year' })
    expect(JSON.parse(text).recordsMatched).toBe(12)
    const nope = await global.call('drop_tables')
    expect(nope).toContain('no tool called')
    expect(run.calls).toHaveLength(1)
  })

  it('reports readiness live rather than at construction', () => {
    let ready = false
    const global = agentGlobal(agentTools(runner()), () => ready)
    expect(global.ready).toBe(false)
    ready = true
    expect(global.ready).toBe(true)
  })
})

describe('agentResult', () => {
  it('flags a refusal as an error and nothing else', () => {
    expect(agentResult(AGGREGATE).isError).toBeUndefined()
    expect(agentResult({ kind: 'refused', tool: 'sql', error: 'no' }).isError).toBe(true)
  })
})

/**
 * The prose half of the surface (AGENTS.md rule 9): what `lib/agent.ts` builds
 * from `TOOLS` stays current by construction, but `public/llms.txt` and the
 * in-page note are hand-written. These fail when a tool, or a member of the
 * window global, is added without being named there — the same discipline
 * `tests/unit/chat.test.ts` applies to the schema brief.
 */
describe('the agent-facing prose names the whole surface', () => {
  const tools = agentTools(runner())
  const globalMembers = Object.keys(agentGlobal(tools, () => true))
  const toolNames = tools.map((tool) => tool.name)

  it('public/llms.txt names every tool and every window.cveExplorer member', () => {
    const text = readFileSync('public/llms.txt', 'utf-8')
    for (const name of toolNames) expect(text, name).toContain(name)
    for (const member of globalMembers) expect(text, member).toMatch(new RegExp(`\\b${member}\\b`))
    expect(text).toContain('window.cveExplorer')
    expect(text).toContain('modelContext')
  })

  it('the in-page agent note names every tool and the global', () => {
    const page = readFileSync('app/page.tsx', 'utf-8')
    const start = page.indexOf('data-agent-notes')
    expect(start).toBeGreaterThan(0)
    const note = page.slice(start, page.indexOf('</section>', start))
    for (const name of toolNames) expect(note, name).toContain(name)
    expect(note).toContain('window.cveExplorer')
    for (const member of ['tools()', 'call(', 'guide()']) expect(note).toContain(member)
  })

  it('the guide names every tool it is a guide to', () => {
    const guide = agentGuide()
    for (const name of toolNames) expect(guide, name).toContain(name)
    for (const member of globalMembers)
      expect(guide, member).toContain(`window.cveExplorer.${member}`)
  })
})
