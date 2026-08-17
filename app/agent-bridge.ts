'use client'

/**
 * Registers the agent surface on the live page (D-086, 2026-08-16): the six
 * chat tools plus the guide, on WebMCP where the browser has it and on
 * `window.cveExplorer` everywhere. Pure descriptors come from `lib/agent.ts`;
 * this file is only the part that has to touch the document.
 *
 * WebMCP is `[Exposed=Window]` — main thread only — which is why registration
 * lives in a page hook and not in the Worker: `execute` runs on the page's
 * event loop and posts to the Worker exactly as a chat tool call does. Chrome
 * ≥150 exposes it as `document.modelContext`; earlier previews and the
 * polyfills as `navigator.modelContext`. Absent both, the window global is the
 * whole surface, and an extension's JavaScript tool is the way in.
 *
 * Registration is torn down with an `AbortSignal` (the spec's mechanism since
 * `unregisterTool` was removed), so a re-mount — React StrictMode mounts twice
 * in development — never trips the duplicate-name `InvalidStateError`.
 */

import { useEffect, useRef } from 'react'

import { agentGlobal, agentTools, AGENT_GLOBAL, type AgentCall, type AgentTool } from '@/lib/agent'
import type { LastResult, ToolCall, ToolOutcome } from '@/lib/protocol'

/** The subset of the WebMCP `ModelContext` interface this bridge uses. */
interface ModelContextLike {
  registerTool(tool: AgentTool, options?: { signal?: AbortSignal }): Promise<void> | void
}

/** Where the browser exposes WebMCP, if it does. */
export function modelContext(): ModelContextLike | null {
  if (typeof document === 'undefined') return null
  const doc = document as Document & { modelContext?: ModelContextLike }
  const nav = navigator as Navigator & { modelContext?: ModelContextLike }
  const found = doc.modelContext ?? nav.modelContext
  return found && typeof found.registerTool === 'function' ? found : null
}

export type AgentSurface = 'webmcp' | 'global'

/**
 * Register the agent surface once per page. `runTool` is the page's Worker
 * bridge (the same one chat uses); `ready` says whether a copy can answer;
 * `onOutcome` lets the page land a result the Worker's message handler does
 * not already land (a record opened by `cve_detail`).
 *
 * Returns nothing: what it did is written to `document.documentElement`'s
 * `data-agent` attribute (`webmcp` or `global`), which is what a test reads.
 */
export function useAgentBridge({
  runTool,
  ready,
  last,
  onCall,
}: {
  runTool: (id: string, call: ToolCall, signal: AbortSignal) => Promise<ToolOutcome>
  ready: boolean
  /** The most recent result, for `window.cveExplorer.last()` (D-088). */
  last: () => LastResult | null
  /**
   * Every agent call, refusals included, once it has an outcome — for the
   * page's "Agent activity" log, so what an agent did is on screen for the
   * person at it, rendered through the same step component chat uses.
   */
  onCall?: (call: AgentCall) => void
}): void {
  // Refs, so the tools registered once see the current page rather than the
  // render they were built in — written in an effect, as the rules require.
  const runRef = useRef(runTool)
  const readyRef = useRef(ready)
  const lastRef = useRef(last)
  const callRef = useRef(onCall)
  useEffect(() => {
    runRef.current = runTool
    readyRef.current = ready
    lastRef.current = last
    callRef.current = onCall
  }, [runTool, ready, last, onCall])

  useEffect(() => {
    let sequence = 0
    const tools = agentTools(
      async (call, signal) => {
        sequence += 1
        return runRef.current(`agent-${Date.now()}-${sequence}`, call, signal)
      },
      undefined,
      (call) => callRef.current?.(call)
    )
    const global = agentGlobal(
      tools,
      () => readyRef.current,
      () => lastRef.current(),
      (call) => callRef.current?.(call)
    )
    const win = window as Window & { [AGENT_GLOBAL]?: unknown }
    win[AGENT_GLOBAL] = global

    const controller = new AbortController()
    const context = modelContext()
    let surface: AgentSurface = 'global'
    if (context) {
      surface = 'webmcp'
      for (const tool of tools) {
        // Each registration on its own: one refusal (a name the browser
        // rejects, a policy that denies the page) must not take the rest
        // down, and it is logged rather than surfaced — the page works the
        // same without an agent.
        Promise.resolve()
          .then(() => context.registerTool(tool, { signal: controller.signal }))
          .catch((error: unknown) => {
            console.warn(`WebMCP: could not register ${tool.name}`, error)
          })
      }
    }
    document.documentElement.dataset.agent = surface

    return () => {
      controller.abort()
      delete win[AGENT_GLOBAL]
      delete document.documentElement.dataset.agent
    }
  }, [])
}
