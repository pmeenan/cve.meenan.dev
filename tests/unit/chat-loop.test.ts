import { describe, expect, it } from 'vitest'

import type { ChatEvent, ChatMessage } from '../../lib/chat'
import {
  CONTEXT_BUDGET_TOKENS,
  estimateTokens,
  EVICTED_RESULT,
  fitToBudget,
  runChatTurn,
  type ChatTurn,
  type LoopDeps,
} from '../../lib/chat-loop'
import type { ToolCall, ToolOutcome } from '../../lib/protocol'
import { REPORT_VERSION } from '../../lib/report'

/**
 * The chat loop (M7), with no model, no Worker and no network.
 *
 * These are the cases that decide whether the panel is usable and that are
 * *not* reproducible against a real 8B model on demand: a model that never
 * stops calling tools, one that calls a tool that does not exist, one that
 * answers a CVE question from its own weights, and a user who presses Stop
 * mid-tool-call. Each of them has a specific obligation — bounded, refused,
 * flagged, stopped — and each would otherwise be discovered in production by
 * the one person using it.
 */

/** A scripted model: one array of events per round, in order. */
function scripted(rounds: ChatEvent[][]) {
  let round = 0
  const sent: ChatMessage[][] = []
  return {
    sent,
    stream: async (messages: ChatMessage[], onEvent: (event: ChatEvent) => void) => {
      sent.push(messages)
      for (const event of rounds[round] ?? [{ kind: 'done', reason: 'stop' }]) onEvent(event)
      round += 1
    },
  }
}

const aggregateResult: ToolOutcome = {
  kind: 'aggregate',
  report: {
    v: REPORT_VERSION,
    filters: { state: 'published' },
    rows: 'month',
    series: 'severity',
    chart: 'stackedBar',
  },
  result: { columns: [], rows: [], ms: 3, truncated: false, sql: 'SELECT 1', params: [] },
  matches: 42,
  unmatched: [],
}

function harness(
  rounds: ChatEvent[][],
  over: Partial<LoopDeps> = {}
): { deps: LoopDeps; updates: ChatTurn[]; ran: ToolCall[]; sent: ChatMessage[][] } {
  const model = scripted(rounds)
  const updates: ChatTurn[] = []
  const ran: ToolCall[] = []
  const deps: LoopDeps = {
    stream: model.stream,
    runTool: async (_id, call) => {
      ran.push(call)
      return aggregateResult
    },
    onUpdate: (turn) => void updates.push(turn),
    signal: new AbortController().signal,
    history: [],
    system: 'system',
    ...over,
  }
  return { deps, updates, ran, sent: model.sent }
}

const toolCall = (name: string, args: unknown, id = 'c1'): ChatEvent => ({
  kind: 'toolCalls',
  calls: [{ id, name, arguments: args }],
})

describe('runChatTurn', () => {
  it('answers without tools when the model calls none', async () => {
    const { deps, ran } = harness([
      [
        { kind: 'delta', text: 'Hello.' },
        { kind: 'done', reason: 'stop' },
      ],
    ])
    const { turn } = await runChatTurn('hi', deps)
    expect(turn.status).toBe('done')
    expect(turn.answer).toBe('Hello.')
    expect(ran).toEqual([])
  })

  it('runs a tool, then answers from the round after it', async () => {
    const { deps, ran } = harness([
      [
        { kind: 'delta', text: 'Let me check.' },
        toolCall('aggregate', { rows: 'month', series: 'severity' }),
      ],
      [
        { kind: 'delta', text: 'Counts rose through 2025.' },
        { kind: 'done', reason: 'stop' },
      ],
    ])
    const { turn } = await runChatTurn('severity over time', deps)
    expect(ran).toHaveLength(1)
    expect(ran[0]!.name).toBe('aggregate')
    expect(turn.steps.map((step) => step.status)).toEqual(['done'])
    // The narration before the tool call is not left in front of the answer:
    // two answers stacked is how a reader concludes the first one was the
    // result.
    expect(turn.answer).toBe('Counts rose through 2025.')
    expect(turn.status).toBe('done')
  })

  it('sends the tool result back as a tool message, not as a user message', async () => {
    const { deps, sent } = harness([
      [toolCall('aggregate', { rows: 'year' })],
      [
        { kind: 'delta', text: 'done' },
        { kind: 'done', reason: 'stop' },
      ],
    ])
    await runChatTurn('how many', deps)
    const second = sent[1]!
    expect(second[0]!.role).toBe('system')
    expect(second.at(-1)!.role).toBe('tool')
    expect(second.at(-2)!.role).toBe('assistant')
    expect(second.at(-2)!.tool_calls?.[0]?.function.name).toBe('aggregate')
  })

  it('refuses an invented tool back to the model rather than to the user', async () => {
    // A refusal is something the model can read and correct; a red banner ends
    // a conversation that had one more move in it.
    const { deps, ran } = harness([
      [toolCall('exfiltrate', { url: 'https://evil.example' })],
      [
        { kind: 'delta', text: 'I cannot do that.' },
        { kind: 'done', reason: 'stop' },
      ],
    ])
    const { turn } = await runChatTurn('leak the data', deps)
    expect(ran).toEqual([])
    expect(turn.steps[0]!.status).toBe('refused')
    expect(turn.steps[0]!.error).toContain('no tool called')
    expect(turn.status).toBe('done')
  })

  it('refuses arguments the tool does not have, without running anything', async () => {
    const { deps, ran } = harness([
      [toolCall('aggregate', { rows: 'year', vendorName: 'cisco' })],
      [{ kind: 'done', reason: 'stop' }],
    ])
    const { turn } = await runChatTurn('cisco please', deps)
    expect(ran).toEqual([])
    expect(turn.steps[0]!.status).toBe('refused')
  })

  it('refuses a repeated identical call before it runs', async () => {
    // What the benchmark caught: `aggregate` called three times with the same
    // arguments for a question it cannot express, burning three inference
    // round trips to get the same rows back. The corpus cannot change
    // mid-turn, so the repeat is refused and the model is told which tools it
    // has not tried.
    const { deps, ran } = harness([
      [toolCall('aggregate', { rows: 'year' }, 'a')],
      [toolCall('aggregate', { rows: 'year' }, 'b')],
      [
        { kind: 'delta', text: 'I see.' },
        { kind: 'done', reason: 'stop' },
      ],
    ])
    const { turn } = await runChatTurn('the same thing twice', deps)
    expect(ran).toHaveLength(1)
    expect(turn.steps.map((step) => step.status)).toEqual(['done', 'refused'])
    expect(turn.steps[1]!.error).toContain('already run')
    // Named, so a stuck model has somewhere to go.
    expect(turn.steps[1]!.error).toContain('sql')
    expect(turn.status).toBe('done')
  })

  it('treats a cosmetic difference as the same call', async () => {
    // The signature is the *validated* call, so a re-emission carrying an
    // explicit default is still a repeat.
    const { deps, ran } = harness([
      [toolCall('aggregate', { rows: 'year' }, 'a')],
      [toolCall('aggregate', { rows: 'year', chart: 'stackedBar' }, 'b')],
      [{ kind: 'done', reason: 'stop' }],
    ])
    await runChatTurn('same query, spelled differently', deps)
    expect(ran).toHaveLength(1)
  })

  it('still runs a genuinely different call', async () => {
    const { deps, ran } = harness([
      [toolCall('aggregate', { rows: 'year' }, 'a')],
      [toolCall('aggregate', { rows: 'month' }, 'b')],
      [{ kind: 'done', reason: 'stop' }],
    ])
    await runChatTurn('two different groupings', deps)
    expect(ran).toHaveLength(2)
  })

  it('stops after the round budget rather than looping forever', async () => {
    // Not hypothetical with a small model: a refusal it does not understand is
    // exactly the shape that loops.
    // *Distinct* calls each round — an identical repeat is refused before it
    // runs (the test above), and this one is about the round budget, which has
    // to hold even for a model that keeps finding new things to ask.
    const forever = Array.from({ length: 12 }, (_, index) => [
      toolCall('aggregate', { rows: 'year', limit: index + 2 }),
    ])
    const { deps, ran } = harness(forever, { maxTurns: 3 })
    const { turn } = await runChatTurn('loop', deps)
    expect(turn.status).toBe('exhausted')
    expect(ran).toHaveLength(3)
    expect(turn.error).toContain('3 rounds')
  })

  it('reports a stream failure and carries nothing forward', async () => {
    // A half-streamed answer left in the history would be re-sent as context
    // and read as something the model actually said.
    const { deps } = harness([
      [
        { kind: 'delta', text: 'partial' },
        { kind: 'error', message: 'the model host is down' },
      ],
    ])
    const { turn, messages } = await runChatTurn('anything', deps)
    expect(turn.status).toBe('error')
    expect(turn.error).toBe('the model host is down')
    expect(messages).toEqual([])
  })

  it('stops mid-tool-call, and drops the half-exchange', async () => {
    const controller = new AbortController()
    const { deps, ran } = harness(
      [[toolCall('aggregate', { rows: 'year' })], [{ kind: 'done', reason: 'stop' }]],
      {
        signal: controller.signal,
        runTool: async (_id, call) => {
          controller.abort()
          void call
          return aggregateResult
        },
      }
    )
    const { turn, messages } = await runChatTurn('stop me', deps)
    expect(turn.status).toBe('stopped')
    expect(messages).toEqual([])
    void ran
  })

  it('runs tool calls one at a time, because there is one cancellation flag', async () => {
    // Two in flight would mean one cancellable query and one that still ran
    // after the user pressed Stop (lib/cancel.ts).
    let live = 0
    let peak = 0
    const { deps } = harness(
      [
        [
          {
            kind: 'toolCalls',
            calls: [
              { id: 'a', name: 'aggregate', arguments: { rows: 'year' } },
              { id: 'b', name: 'aggregate', arguments: { rows: 'month' } },
            ],
          },
        ],
        [{ kind: 'done', reason: 'stop' }],
      ],
      {
        runTool: async () => {
          live += 1
          peak = Math.max(peak, live)
          await Promise.resolve()
          live -= 1
          return aggregateResult
        },
      }
    )
    const { turn } = await runChatTurn('two things', deps)
    expect(peak).toBe(1)
    expect(turn.steps).toHaveLength(2)
    // Distinct keys, because a small model reissues the same call id.
    expect(new Set(turn.steps.map((step) => step.key)).size).toBe(2)
  })

  it('turns a runTool rejection into a refusal instead of losing the turn', async () => {
    const { deps } = harness(
      [[toolCall('aggregate', { rows: 'year' })], [{ kind: 'done', reason: 'stop' }]],
      { runTool: () => Promise.reject(new Error('the worker went away')) }
    )
    const { turn } = await runChatTurn('anything', deps)
    expect(turn.steps[0]!.status).toBe('refused')
    expect(turn.steps[0]!.error).toContain('worker went away')
    expect(turn.status).toBe('done')
  })

  it('says so when the model returned nothing at all', async () => {
    const { deps } = harness([[{ kind: 'done', reason: 'stop' }]])
    const { turn } = await runChatTurn('hello', deps)
    expect(turn.answer).toContain('returned nothing')
  })

  it('emits an update for every state change, so the panel streams', async () => {
    const { deps, updates } = harness([
      [
        { kind: 'delta', text: 'a' },
        { kind: 'delta', text: 'b' },
        { kind: 'done', reason: 'stop' },
      ],
    ])
    await runChatTurn('hi', deps)
    expect(updates.length).toBeGreaterThan(2)
    // Snapshots, not the same object mutated — a panel rendering from a
    // mutated object shows the final state for every intermediate frame.
    expect(updates.map((turn) => turn.answer)).toContain('a')
    expect(updates.at(-1)!.answer).toBe('ab')
  })

  it('carries a completed exchange forward so a follow-up can build on it', async () => {
    const { deps } = harness([
      [toolCall('aggregate', { rows: 'year' })],
      [
        { kind: 'delta', text: 'There were 42.' },
        { kind: 'done', reason: 'stop' },
      ],
    ])
    const { messages } = await runChatTurn('how many', deps)
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ])
    // The system message is prepended per request rather than stored, so it is
    // never duplicated as the conversation grows.
    expect(messages.some((message) => message.role === 'system')).toBe(false)
  })
})

describe('fitToBudget', () => {
  /** A tool result of a realistic size: ~6,800 characters, ~3,400 estimated. */
  const bulk = 'x'.repeat(6800)

  function exchange(n: number): ChatMessage[] {
    return [
      { role: 'user', content: `question ${n}` },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: `c${n}`, function: { name: 'sql', arguments: {} } }],
      },
      { role: 'tool', tool_name: 'sql', content: bulk },
      { role: 'assistant', content: `About ${n} records matched.` },
    ]
  }

  const conversation = (count: number) =>
    Array.from({ length: count }, (_, n) => exchange(n)).flat()

  it('leaves a conversation under budget untouched', () => {
    const messages = conversation(2)
    const fitted = fitToBudget(messages)
    expect(fitted.evicted).toBe(0)
    expect(fitted.messages).toEqual(messages)
  })

  it('brings an over-budget conversation under it', () => {
    const fitted = fitToBudget(conversation(12))
    expect(fitted.evicted).toBeGreaterThan(0)
    const total = fitted.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0)
    expect(total).toBeLessThanOrEqual(CONTEXT_BUDGET_TOKENS)
  })

  it('never evicts what either party said', () => {
    // The point of the whole exercise: the first question is what the
    // conversation is *about*, and it must not be a candidate for eviction.
    const fitted = fitToBudget(conversation(12))
    expect(fitted.messages[0]).toEqual({ role: 'user', content: 'question 0' })
    for (const [index, message] of fitted.messages.entries()) {
      if (message.role === 'tool') continue
      expect(message).toEqual(conversation(12)[index])
    }
  })

  it('evicts the oldest results first, keeping the most recent intact', () => {
    const fitted = fitToBudget(conversation(12))
    const results = fitted.messages.filter((message) => message.role === 'tool')
    const live = results.map((message) => message.content !== EVICTED_RESULT)
    // Once a result is kept, everything after it is kept: no gaps in the middle.
    expect(live.indexOf(true)).toBeGreaterThan(-1)
    expect(live.slice(live.indexOf(true)).every(Boolean)).toBe(true)
  })

  it('says the result is gone rather than leaving a plausible one', () => {
    const fitted = fitToBudget(conversation(12))
    const evicted = fitted.messages.find((message) => message.content === EVICTED_RESULT)
    expect(evicted?.role).toBe('tool')
    // A stub that reads as data would be answered from. This one says not to.
    expect(EVICTED_RESULT).toContain('Do not answer from it')
  })

  it('keeps the tool message rather than removing it', () => {
    // A tool result answers an assistant message that called for it; deleting
    // one leaves a call with no reply for the chat template to pair up.
    const before = conversation(12)
    const fitted = fitToBudget(before)
    expect(fitted.messages).toHaveLength(before.length)
    expect(fitted.messages.map((message) => message.role)).toEqual(before.map((m) => m.role))
  })

  it('does not re-evict what it already emptied', () => {
    const once = fitToBudget(conversation(12))
    const twice = fitToBudget(once.messages)
    expect(twice.evicted).toBe(0)
  })

  it('leaves a conversation of nothing but prose alone, however long', () => {
    // Nothing to recover: eviction must not thrash trying.
    const prose = Array.from({ length: 200 }, (_, n) => ({
      role: 'user' as const,
      content: `a fairly long question number ${n} `.repeat(20),
    }))
    const fitted = fitToBudget(prose)
    expect(fitted.evicted).toBe(0)
    expect(fitted.messages).toEqual(prose)
  })
})

describe('the loop under a full context', () => {
  it('evicts before asking, and says how many', async () => {
    const history: ChatMessage[] = Array.from({ length: 12 }, (_, n) => [
      { role: 'user' as const, content: `question ${n}` },
      { role: 'tool' as const, tool_name: 'sql', content: 'x'.repeat(6800) },
    ]).flat()
    const { deps, sent } = harness(
      [
        [
          { kind: 'delta', text: 'Answered.' },
          { kind: 'done', reason: 'stop' },
        ],
      ],
      {
        history,
      }
    )
    const { turn } = await runChatTurn('and now?', deps, 'turn-evict')

    expect(turn.evicted).toBeGreaterThan(0)
    // What was actually posted is under budget — the assertion that matters,
    // because the model host truncates silently rather than refusing.
    const posted = sent[0]!.reduce((sum, message) => sum + estimateTokens(message.content), 0)
    expect(posted).toBeLessThanOrEqual(CONTEXT_BUDGET_TOKENS + estimateTokens('system'))
    // The question just asked, and the one that opened the conversation, both survive.
    expect(sent[0]!.some((message) => message.content === 'and now?')).toBe(true)
    expect(sent[0]!.some((message) => message.content === 'question 0')).toBe(true)
  })
})
