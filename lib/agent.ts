/**
 * The agent surface: the same six read-only tools the built-in chat uses,
 * offered to any AI agent that can reach the page — a browser's own agent
 * through **WebMCP** (`document.modelContext`, Chrome 146+ behind a flag or
 * origin trial, `navigator.modelContext` before Chrome 150), and any extension
 * with a JavaScript tool through **`window.cveExplorer`** (D-086, 2026-08-16).
 *
 * Nothing new is reachable through it. Every call is validated by
 * `parseToolCall` — the same refusals the chat layer gets — and executed by the
 * same Worker path, so the read-only, render-only property of the tool surface
 * (D-044) holds by construction: an agent gets the same counts and record text
 * the chat model gets, rendered on the same canvas, and no tool fetches,
 * writes or reaches the network. Tool output is CVE text, which is
 * attacker-influenced; the WebMCP annotation `untrustedContentHint` says so to
 * the agent in the vocabulary the spec provides.
 *
 * What this module contains is the *pure* half — the descriptors, the guide
 * text, the result envelope — so it can be unit-tested. The registration
 * itself is `app/agent-bridge.ts`.
 */

import { SCHEMA_BRIEF, systemPrompt, TODAY_TOKEN } from './chat'
import type { LastResult, ToolCall, ToolOutcome } from './protocol'
import {
  describeToolResult,
  DIMENSION_GUIDE,
  parseToolCall,
  TOOL_NAMES,
  TOOLS,
  type ToolSpec,
} from './tools'

/** The window global an extension's JavaScript tool reaches. */
export const AGENT_GLOBAL = 'cveExplorer'

/** The extra tool that carries what WebMCP has no primitive for: the guide. */
export const GUIDE_TOOL = 'cve_explorer_guide'

/**
 * A WebMCP tool descriptor, as the spec's `ModelContextTool` dictionary
 * (https://webmachinelearning.github.io/webmcp/). `execute` returns an MCP
 * `CallToolResult`-shaped object, which the browser serialises to JSON for the
 * agent and which the MCP-B polyfill family also understands.
 */
export interface AgentTool {
  name: string
  title?: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean }
  execute: (
    input: unknown,
    options?: { signal?: AbortSignal }
  ) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>
}

/** How the bridge runs one validated call: the page's Worker round trip. */
export type ToolRunner = (call: ToolCall, signal: AbortSignal) => Promise<ToolOutcome>

/**
 * One agent call, as the page is told about it — every call, including one
 * refused before it ran, so the page can render an audit trail of what an
 * agent did (the "Agent activity" log): what a KEV claim or a computed value
 * came from is visible to the person at the screen, not only to the agent.
 */
export interface AgentCall {
  name: string
  /** The validated call, when there was one. */
  call?: ToolCall
  outcome: ToolOutcome
  ms: number
}
export type AgentObserver = (call: AgentCall) => void

/**
 * The guide an agent reads first: the chat model's own system prompt (with
 * today's date filled in here, since no relay is in the path), what the page
 * does with each result, and the schema. WebMCP has no page-level
 * instructions primitive — only per-tool descriptions — so this travels as a
 * tool an agent calls, and as `window.cveExplorer.guide()`.
 */
export function agentGuide(now: Date = new Date()): string {
  const today = now.toISOString().slice(0, 10)
  return [
    'CVE Explorer (cve.meenan.dev) — guide for AI agents driving this page.',
    '',
    'This page holds the complete CVE List (cvelistV5, 370,000+ records) with a CISA KEV ' +
      'overlay, queried in the browser (or, before the corpus is downloaded, on this site’s ' +
      `own server, read-only). The tools are ${GUIDE_TOOL} (this guide) and the six the ` +
      `built-in chat uses — ${TOOL_NAMES.join(', ')}; every result they return is also ` +
      'rendered on the page: an `aggregate` becomes the chart on the canvas, a ' +
      '`search_records` becomes the record list, `cve_detail` opens the record, ' +
      '`kev_lookup` reads the CISA KEV entry, `sql` fills the SQL panel, and `compute` runs ' +
      'JavaScript over the full rows of the most recent of those, in a sandbox with no ' +
      'network or storage. Nothing here writes, fetches a URL or reaches the network.',
    '',
    'The same rules the built-in assistant follows:',
    systemPrompt().replace(TODAY_TOKEN, today),
    '',
    `Dimensions for aggregate rows/series: ${DIMENSION_GUIDE}.`,
    '',
    'Programmatic access without WebMCP: `window.cveExplorer.tools()` lists the tools with ' +
      'their JSON Schemas, `window.cveExplorer.call(name, args)` runs one and resolves to the ' +
      'same text a WebMCP execute would return, `window.cveExplorer.guide()` returns this text ' +
      'and `window.cveExplorer.schema` the schema brief. `window.cveExplorer.last()` returns ' +
      'the most recent result whole — every row the query layer returned, its columns, the ' +
      'SQL and the match count — as a copy, for an agent that would rather process the data ' +
      'itself than through `compute`. `window.cveExplorer.ready` is false until a copy of the ' +
      'corpus can answer.',
  ].join('\n')
}

/**
 * One tool outcome as the text an agent reads — `describeToolResult`, the JSON
 * document the chat model gets (structured, bounded, never markup), wrapped in
 * the MCP result envelope. A refusal is `isError`, so an agent that honours
 * the flag retries with a corrected call rather than reading a refusal as
 * data.
 */
export function agentResult(outcome: ToolOutcome): {
  content: { type: 'text'; text: string }[]
  isError?: boolean
} {
  const text = describeToolResult(outcome)
  return outcome.kind === 'refused'
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] }
}

/**
 * The tool descriptors, built from `TOOLS` so an agent and the chat model read
 * one description and one schema per tool, plus the guide tool. `run` is the
 * page's Worker bridge; a call that fails validation never reaches it.
 */
export function agentTools(
  run: ToolRunner,
  tools: readonly ToolSpec[] = TOOLS,
  observe: AgentObserver = () => {}
): AgentTool[] {
  const executeCall =
    (name: string) => async (input: unknown, options?: { signal?: AbortSignal }) => {
      const started = Date.now()
      const parsed = parseToolCall(name, input)
      if (!parsed.ok) {
        const outcome: ToolOutcome = { kind: 'refused', tool: name, error: parsed.error }
        observe({ name, outcome, ms: Date.now() - started })
        return agentResult(outcome)
      }
      const controller = new AbortController()
      options?.signal?.addEventListener('abort', () => controller.abort(), { once: true })
      let outcome: ToolOutcome
      try {
        outcome = await run(parsed.call, controller.signal)
      } catch (error) {
        outcome = {
          kind: 'refused',
          tool: name,
          error: error instanceof Error ? error.message : String(error),
        }
      }
      observe({ name, call: parsed.call, outcome, ms: Date.now() - started })
      return agentResult(outcome)
    }
  const guide: AgentTool = {
    name: GUIDE_TOOL,
    title: 'How to use CVE Explorer',
    description:
      'Read this first. Returns the guide for driving CVE Explorer: what the corpus is, the ' +
      'rules the other tools expect (dates, dimensions, when to use aggregate versus sql), and ' +
      'the SQLite schema the sql tool runs against.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    execute: async () => ({ content: [{ type: 'text', text: agentGuide() }] }),
  }
  return [
    guide,
    ...tools.map((tool): AgentTool => ({
      name: tool.name,
      title: tool.name.replace(/_/g, ' '),
      description: tool.description,
      inputSchema: tool.parameters,
      // Every tool is read-only; every result but the guide's carries CVE
      // record text, which is attacker-influenced input (rule 4).
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: executeCall(tool.name),
    })),
  ]
}

/** The `window.cveExplorer` object an extension's JavaScript tool reaches. */
export interface AgentGlobal {
  ready: boolean
  tools(): { name: string; description: string; inputSchema: Record<string, unknown> }[]
  call(name: string, args?: unknown): Promise<string>
  guide(): string
  schema: string
  /**
   * The most recent result, whole (D-088): every row the query layer returned
   * for the last aggregate, record search or SQL — whoever ran it — or null
   * before anything has. A copy, so an agent that mutates it mutates nothing
   * the page renders from.
   */
  last(): LastResult | null
}

export function agentGlobal(
  tools: readonly AgentTool[],
  ready: () => boolean,
  last: () => LastResult | null = () => null,
  observe: AgentObserver = () => {}
): AgentGlobal {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return {
    get ready() {
      return ready()
    },
    last: () => {
      const result = last()
      return result ? structuredClone(result) : null
    },
    tools: () =>
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    call: async (name, args) => {
      const tool = byName.get(String(name))
      if (!tool) {
        // Refused here, before any tool's `execute` — so reported here too:
        // the activity log is every call, an invented name included.
        const outcome: ToolOutcome = {
          kind: 'refused',
          tool: String(name),
          error: `no tool called ${JSON.stringify(String(name).slice(0, 60))} exists`,
        }
        observe({ name: String(name).slice(0, 60), outcome, ms: 0 })
        return agentResult(outcome).content[0]!.text
      }
      const result = await tool.execute(args ?? {})
      return result.content.map((part) => part.text).join('\n')
    },
    guide: () => agentGuide(),
    schema: SCHEMA_BRIEF,
  }
}
