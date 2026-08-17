/**
 * The compute sandbox's page side (D-088): the `compute` tool's JavaScript
 * runs in `SANDBOX_DOCUMENT` (lib/sandbox-doc.ts), embedded here as an
 * `<iframe sandbox="allow-scripts" srcdoc=…>` — no `allow-same-origin`, so
 * the frame has an opaque origin with no storage (the corpus in OPFS
 * included) and, by its own CSP, no network. Inside it a blob: Worker runs
 * the code so it can be terminated at the deadline. This module creates the
 * frame lazily, hands it the code and the rows, and turns its answer into a
 * `compute` outcome.
 *
 * Two deadlines, on purpose. The frame terminates the worker at
 * `COMPUTE_DEADLINE_MS`; the page waits a little longer and, if the frame
 * itself has stopped answering, tears it down and lets the next call build a
 * fresh one. A frame that is wedged is not something to reason with.
 *
 * Browser-only, and not unit-tested: what matters about it is checked in the
 * browser (`tests/e2e/compute.spec.ts`), from inside the sandbox — that
 * fetch, storage and the parent are out of reach, and that a runaway loop is
 * stopped.
 */

import type { LastResult, ToolOutcome } from './protocol'
import { SANDBOX_DOCUMENT } from './sandbox-doc'
import { COMPUTE_DEADLINE_MS, MAX_COMPUTE_LOGS, MAX_MODEL_RESULT_CHARS } from './tools'

/** How much longer than the worker's deadline the page waits on the frame. */
const FRAME_GRACE_MS = 2_000

type Answer = {
  ok: boolean
  value: string | null
  error: string | null
  logs: string[]
  truncated: boolean
  ms: number
}

type Waiter = { resolve: (answer: Answer) => void; timer: number }

export class Sandbox {
  private frame: HTMLIFrameElement | null = null
  private ready: Promise<Window> | null = null
  private waiters = new Map<string, Waiter>()
  private sequence = 0
  private readonly onMessage = (event: MessageEvent) => {
    if (!this.frame || event.source !== this.frame.contentWindow) return
    const data = event.data as { type?: unknown; id?: unknown } | null
    if (!data || data.type !== 'computed' || typeof data.id !== 'string') return
    const waiter = this.waiters.get(data.id)
    if (!waiter) return
    this.waiters.delete(data.id)
    window.clearTimeout(waiter.timer)
    const answer = data as unknown as Answer
    waiter.resolve({
      ok: answer.ok === true,
      value: typeof answer.value === 'string' ? answer.value : null,
      error: typeof answer.error === 'string' ? answer.error : null,
      logs: Array.isArray(answer.logs) ? answer.logs.map(String) : [],
      truncated: answer.truncated === true,
      ms: typeof answer.ms === 'number' ? answer.ms : 0,
    })
  }

  /**
   * Run one piece of code against a result. Never rejects: every failure —
   * a frame that would not load, a deadline, a thrown error — is a `compute`
   * outcome with `ok: false`, which is what the model should be told.
   */
  async compute(code: string, last: LastResult | null, signal?: AbortSignal): Promise<ToolOutcome> {
    const input = {
      source: last?.source ?? null,
      rows: last?.rows.length ?? 0,
      columns: last?.columns ?? [],
    }
    const outcome = (answer: Answer): ToolOutcome => ({ kind: 'compute', code, input, ...answer })
    if (signal?.aborted) return outcome(failed('stopped'))

    let target: Window
    try {
      target = await this.open()
    } catch (error) {
      return outcome(failed(`the sandbox could not start: ${message(error)}`))
    }

    this.sequence += 1
    const id = `compute-${Date.now()}-${this.sequence}`
    const answer = await new Promise<Answer>((resolve) => {
      const timer = window.setTimeout(() => {
        // The frame missed its own deadline: it is wedged, or gone. Drop it so
        // the next call starts clean rather than queueing behind it.
        this.waiters.delete(id)
        this.close()
        resolve(failed(`stopped: the sandbox did not answer within ${COMPUTE_DEADLINE_MS} ms`))
      }, COMPUTE_DEADLINE_MS + FRAME_GRACE_MS)
      this.waiters.set(id, { resolve, timer })
      const onAbort = () => {
        const waiter = this.waiters.get(id)
        if (!waiter) return
        this.waiters.delete(id)
        window.clearTimeout(waiter.timer)
        resolve(failed('stopped'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      // Targeted at '*' because the frame's origin is opaque and matches no
      // other target; the frame checks `event.source === parent` on its side.
      target.postMessage(
        {
          type: 'compute',
          id,
          code,
          columns: last?.columns ?? [],
          rows: last?.rows ?? [],
          deadlineMs: COMPUTE_DEADLINE_MS,
          maxChars: MAX_MODEL_RESULT_CHARS,
          maxLogs: MAX_COMPUTE_LOGS,
        },
        '*'
      )
    })
    return outcome(answer)
  }

  /** The frame, created on first use and kept for the page's lifetime. */
  private open(): Promise<Window> {
    if (this.ready) return this.ready
    this.ready = new Promise<Window>((resolve, reject) => {
      const frame = document.createElement('iframe')
      // `allow-scripts` alone: no `allow-same-origin`, which is the whole
      // point — the document gets an opaque origin, and its own CSP does the
      // rest. Not `hidden`: some engines throttle or never load a display:none
      // frame's workers. Visually gone instead.
      frame.setAttribute('sandbox', 'allow-scripts')
      frame.setAttribute('aria-hidden', 'true')
      frame.setAttribute('title', 'compute sandbox')
      frame.setAttribute('data-compute-sandbox', '1')
      frame.style.cssText =
        'position:absolute;width:1px;height:1px;left:-9999px;top:0;border:0;opacity:0;pointer-events:none'
      // `srcdoc`, not `src`: see lib/sandbox-doc.ts — a file would be a
      // cross-origin fetch from an opaque origin, which this site's CORP
      // header refuses on Firefox.
      frame.srcdoc = SANDBOX_DOCUMENT
      const onReady = (event: MessageEvent) => {
        if (event.source !== frame.contentWindow) return
        const data = event.data as { type?: unknown } | null
        if (!data || data.type !== 'sandbox-ready') return
        window.removeEventListener('message', onReady)
        window.clearTimeout(timer)
        if (frame.contentWindow) resolve(frame.contentWindow)
        else reject(new Error('the sandbox frame has no window'))
      }
      const timer = window.setTimeout(() => {
        window.removeEventListener('message', onReady)
        this.close()
        reject(new Error('the sandbox frame did not load'))
      }, COMPUTE_DEADLINE_MS)
      window.addEventListener('message', onReady)
      window.addEventListener('message', this.onMessage)
      this.frame = frame
      document.body.appendChild(frame)
    })
    return this.ready
  }

  /** Tear the frame down; the next call rebuilds it. */
  close(): void {
    window.removeEventListener('message', this.onMessage)
    this.frame?.remove()
    this.frame = null
    this.ready = null
    for (const [id, waiter] of this.waiters) {
      window.clearTimeout(waiter.timer)
      waiter.resolve(failed('stopped: the sandbox was closed'))
      this.waiters.delete(id)
    }
  }
}

function failed(error: string): Answer {
  return { ok: false, value: null, error, logs: [], truncated: false, ms: 0 }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
