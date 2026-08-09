/**
 * The chat loop (M7): question → model → tool calls → grounded answer.
 *
 * Here rather than in the panel because it is the part with rules, and the
 * panel is the part with JSX. Everything it needs from the outside — a stream
 * of model events, a way to run a tool, a clock — arrives as a dependency, so
 * the whole loop runs in a unit test with no model, no Worker and no network.
 * That matters more here than usual: the failure modes worth testing are a
 * model that never stops calling tools, a model that calls a tool that does not
 * exist, and a user who presses Stop in the middle — none of which are
 * reproducible against a real 8B model on demand.
 *
 * Three rules the loop enforces, rather than hoping the model follows them.
 *
 * **Tool calls run one at a time.** The Worker serializes requests anyway, and
 * the cancellation flag is one flag (lib/cancel.ts) — so a turn that issued
 * three calls at once would have one cancellable query and two queued ones that
 * still ran after the user pressed Stop.
 *
 * **A refusal goes back to the model, not to the user as a failure.** An
 * invented tool, an invented argument, a KEV question against a copy with no
 * catalog: each is something the model can read and act on, and turning any of
 * them into a red banner would end a conversation that had one more move in it.
 *
 * **The turn is bounded, and a repeat is refused before it runs.** A model that
 * keeps calling tools stops after `MAX_CHAT_TURNS`, and the panel says so.
 * Unbounded is not a hypothetical with a small model — a refusal it does not
 * understand is exactly the shape that loops. Neither is the *repeat*: the
 * D-046 benchmark caught `gemma4:e4b` calling `aggregate` three times with the
 * same arguments for a question `aggregate` cannot express, burning three
 * inference round trips to get the same rows back. The database cannot change
 * mid-turn, so an identical call cannot produce new information; it is refused
 * with a message that says so and names the tools it has not tried.
 */

import { MAX_CHAT_TURNS, type ChatEvent, type ChatMessage, type WireToolCall } from './chat'
import type { ToolCall, ToolOutcome } from './protocol'
import { describeToolResult, parseToolCall, TOOL_NAMES } from './tools'

/** One tool call as the panel shows it, from issued to answered. */
export interface ChatStep {
  /**
   * Unique within the turn — the round and position, not the model's id.
   *
   * A small model reissues the same call id round after round, and providers
   * that mint none get a positional one, so the model's id is not a key. This
   * is what React lists on, and `id` below is what the Worker answers to.
   */
  key: string
  id: string
  /** What the model called it. May not be a tool that exists — that is the point. */
  name: string
  status: 'running' | 'done' | 'refused'
  /** The arguments as validated, for the "what did it actually run" disclosure. */
  call?: ToolCall
  outcome?: ToolOutcome
  ms?: number
  /** Present when the call never reached a tool: an unknown name, bad arguments. */
  error?: string
}

/** What the panel renders for one exchange. Rebuilt, never mutated in place. */
export interface ChatTurn {
  id: string
  question: string
  /** The model's prose. Rendered as plain text, never markup (D-044). */
  answer: string
  /** Its reasoning, shown behind a disclosure — separate from the answer. */
  thinking: string
  steps: ChatStep[]
  /** What the loop is waiting on right now, so past a second it can say so. */
  waiting: { on: 'model' | 'tool'; what: string } | null
  status: 'running' | 'done' | 'stopped' | 'error' | 'exhausted'
  /** A sentence, when something went wrong. Never a stack trace. */
  error?: string
  /**
   * How many earlier tool results were dropped from the model's context to
   * make room for this turn.
   *
   * Shown rather than kept quiet: this changes what the model can see, and a
   * conversation that silently stops knowing what it found earlier is exactly
   * the failure the eviction exists to replace. The results themselves are
   * still on screen — it is the model's copy that goes.
   */
  evicted: number
}

export interface LoopDeps {
  /** Send one turn and deliver events. Resolves when the stream ends. */
  stream(messages: ChatMessage[], onEvent: (event: ChatEvent) => void): Promise<void>
  /** Hand a validated call to the Worker and wait for its outcome. */
  runTool(id: string, call: ToolCall): Promise<ToolOutcome>
  /** Called on every state change, so the panel re-renders as it goes. */
  onUpdate(turn: ChatTurn): void
  signal: AbortSignal
  /** The conversation so far, without the system message. Session-only. */
  history: ChatMessage[]
  system: string
  maxTurns?: number
}

/**
 * The estimated-token budget for the conversation, excluding the system message.
 *
 * Not half the window, which would fire on the second question and mean
 * nothing. The budget is what is left after the two fixed costs either side of
 * it, against the relay's `NUM_CTX` of 32,768:
 *
 *   32,768 − 8,192 (`MAX_PREDICT`, generation) − 3,717 (the floor: system
 *   prompt and five tool schemas, measured) = 20,859, and 18,000 keeps ~2,800
 *   of margin for an estimate that is an estimate.
 *
 * Overrunning is not a loud failure, which is the reason any of this exists.
 * Measured 2026-08-09 against the deployed relay: a 30-exchange conversation
 * was accepted with `prompt_eval_count` pinned at 29,743 however much more was
 * posted — no error, no field saying anything had been dropped.
 */
export const CONTEXT_BUDGET_TOKENS = 18_000

/**
 * Estimated tokens in a string, deliberately pessimistic.
 *
 * There is no tokenizer in the browser and shipping one to count what the
 * server will count anyway is not worth 300 KB. Two characters per token is
 * measured against the real thing rather than assumed: a 6,800-character
 * 50-row tool result costs 3,215 prompt tokens on `qwen3:8b` — 2.12 characters
 * each — because tool output is JSON, where the punctuation is most of it.
 * English prose runs nearer four, so this over-counts prose and lands close on
 * the messages that actually matter. Over-counting is the safe direction: it
 * evicts a little early rather than a little late, and late is silent.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2)
}

/** What replaces an evicted result. Says where it went, and does not answer. */
export const EVICTED_RESULT =
  'This result is no longer in the conversation — it was dropped to make room. ' +
  'It is still on screen for the user. Do not answer from it; run the tool again if ' +
  'you need these rows.'

/**
 * Bring a conversation under budget by dropping the payload of the oldest tool
 * results, oldest first.
 *
 * **Only tool results are eligible, and that is the whole design.** Measured on
 * the deployed surface: the fixed floor is 3,717 tokens (system prompt and five
 * tool schemas), one realistic 50-row result is 3,215, and the model's own
 * answer is about 30. A conversation is ~99% tool output by volume, so dropping
 * only that recovers nearly everything while keeping every word either party
 * said — which is what makes the *first* question, the one that sets what the
 * conversation is about, structurally not a candidate for eviction.
 *
 * That matters more than it sounds. A conversation over budget does not fail
 * loudly; the model reconstructs the topic from whatever content is still in
 * the window. Measured with contradicting rows in the results, "which vendor am
 * I investigating?" answered *Cisco* after eight refinements of a conversation
 * that opened with Fortinet — at 26k tokens, below the truncation point, so
 * this is attention rather than truncation. With the intent kept and the bulk
 * gone, neither failure has the room to happen.
 *
 * The message is kept and emptied rather than removed: a tool result answers an
 * assistant message that called for it, and deleting one leaves a call with no
 * reply for the chat template to pair up.
 *
 * Summarising instead was considered and refused (D-080). A summary is
 * model-written prose full of counts that are no longer distinguishable from
 * tool output, in a conversation whose first rule is that no number may be
 * stated unless a tool returned it — and it would give text out of the corpus a
 * way to persist past the round it arrived in.
 */
export function fitToBudget(
  messages: readonly ChatMessage[],
  budget = CONTEXT_BUDGET_TOKENS
): { messages: ChatMessage[]; evicted: number } {
  const kept = messages.map((message) => ({ ...message }))
  let total = kept.reduce((sum, message) => sum + estimateTokens(message.content), 0)
  let evicted = 0
  for (const message of kept) {
    if (total <= budget) break
    // Already emptied by an earlier pass: no room left to recover here, and
    // re-counting it would evict something newer for nothing.
    if (message.role !== 'tool' || message.content === EVICTED_RESULT) continue
    const before = estimateTokens(message.content)
    const after = estimateTokens(EVICTED_RESULT)
    if (after >= before) continue
    message.content = EVICTED_RESULT
    total -= before - after
    evicted += 1
  }
  return { messages: kept, evicted }
}

export interface LoopResult {
  turn: ChatTurn
  /**
   * The conversation to carry forward — the history plus this exchange,
   * including the tool round trips, so a follow-up question can refer to what
   * was already found without running it again.
   */
  messages: ChatMessage[]
}

/**
 * Run one question to an answer.
 *
 * Never throws: every failure is a `status` on the turn, because a thrown error
 * inside a chat panel is a conversation that stops with nothing on screen.
 */
export async function runChatTurn(
  question: string,
  deps: LoopDeps,
  id = `turn-${Date.now()}`
): Promise<LoopResult> {
  const turn: ChatTurn = {
    id,
    question,
    answer: '',
    thinking: '',
    steps: [],
    waiting: { on: 'model', what: 'the model' },
    status: 'running',
    evicted: 0,
  }
  const emit = () => deps.onUpdate({ ...turn, steps: turn.steps.map((step) => ({ ...step })) })
  emit()

  const conversation: ChatMessage[] = [...deps.history, { role: 'user', content: question }]
  const maxTurns = deps.maxTurns ?? MAX_CHAT_TURNS
  /** Signatures of the calls already executed this turn, for the repeat check. */
  const alreadyRun = new Set<string>()

  for (let round = 0; round < maxTurns; round++) {
    if (deps.signal.aborted) return stop(turn, deps.history, emit)

    let text = ''
    let thinking = ''
    let calls: WireToolCall[] = []
    let failure: string | null = null

    turn.waiting = { on: 'model', what: 'the model' }
    emit()

    // Wrapped, though `streamChat` reports its own failures as events: this
    // loop must not be able to reject. A rejection here leaves the panel's
    // "running" flag set for the rest of the session — a Stop button that
    // stops nothing and an Ask button that never re-enables.
    const collect = (event: ChatEvent) => {
      switch (event.kind) {
        case 'delta':
          text += event.text
          turn.answer = text
          emit()
          break
        case 'thinking':
          thinking += event.text
          turn.thinking = thinking
          emit()
          break
        case 'toolCalls':
          // Accumulated rather than replaced: a model may emit calls across
          // several frames, and taking only the last frame's would silently
          // drop the first call of a multi-call turn.
          calls = [...calls, ...event.calls]
          break
        case 'error':
          failure = event.message
          break
        case 'done':
          break
      }
    }
    // Every round, not once per question: the growth that overruns the window
    // is tool results, and a six-round question produces them faster than a
    // six-question conversation does.
    const fitted = fitToBudget(conversation)
    if (fitted.evicted) {
      conversation.splice(0, conversation.length, ...fitted.messages)
      turn.evicted += fitted.evicted
    }

    try {
      await deps.stream([{ role: 'system', content: deps.system }, ...conversation], collect)
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }

    if (deps.signal.aborted) return stop(turn, deps.history, emit)

    if (failure) {
      turn.status = 'error'
      turn.error = failure
      turn.waiting = null
      emit()
      // The failed exchange is not carried forward: a half-streamed answer in
      // the history would be re-sent as context for the next question and read
      // as something the model actually said.
      return { turn, messages: deps.history }
    }

    if (!calls.length) {
      turn.status = 'done'
      turn.waiting = null
      // A model that answered without calling anything has answered from its
      // own weights, which for a CVE question is the one thing it must not do.
      // Said plainly rather than hidden, because it is exactly the case a
      // reader cannot tell apart from a grounded answer (D-046, vision 7).
      if (!turn.steps.length && !turn.answer.trim()) {
        turn.answer = 'The model returned nothing at all. Ask again, or rephrase the question.'
      }
      conversation.push({ role: 'assistant', content: text })
      emit()
      return { turn, messages: conversation }
    }

    conversation.push({
      role: 'assistant',
      content: text,
      tool_calls: calls.map((call) => ({
        id: call.id,
        function: { name: call.name, arguments: call.arguments },
      })),
    })

    for (const [index, call] of calls.entries()) {
      if (deps.signal.aborted) return stop(turn, deps.history, emit)

      const step: ChatStep = {
        key: `${round}-${index}-${call.id}`,
        id: call.id,
        name: call.name,
        status: 'running',
      }
      turn.steps.push(step)
      turn.waiting = { on: 'tool', what: call.name }
      emit()

      const parsed = parseToolCall(call.name, call.arguments)
      let described: string
      if (!parsed.ok) {
        // Not an error the user sees as a failure: it is what the model is told
        // so it can correct itself on the next round.
        step.status = 'refused'
        step.error = parsed.error
        described = describeToolResult({ kind: 'refused', tool: call.name, error: parsed.error })
      } else if (alreadyRun.has(signatureOf(parsed.call))) {
        // Refused *before* it runs. The corpus cannot change mid-turn, so an
        // identical call returns identical rows — and a model that repeats one
        // is stuck rather than working, which the round budget would otherwise
        // hide until it ran out.
        const repeat =
          `this exact ${call.name} call has already run in this conversation and returned ` +
          'the rows above; running it again cannot produce anything new. Either answer from ' +
          'what you already have, or use a different tool — ' +
          `${otherTools(call.name)} — or different arguments.`
        step.status = 'refused'
        step.error = repeat
        described = describeToolResult({ kind: 'refused', tool: call.name, error: repeat })
      } else {
        step.call = parsed.call
        alreadyRun.add(signatureOf(parsed.call))
        const started = Date.now()
        let outcome: ToolOutcome
        try {
          outcome = await deps.runTool(call.id, parsed.call)
        } catch (error) {
          if (deps.signal.aborted) return stop(turn, deps.history, emit)
          outcome = {
            kind: 'refused',
            tool: call.name,
            error: error instanceof Error ? error.message : String(error),
          }
        }
        step.outcome = outcome
        step.ms = Date.now() - started
        step.status = outcome.kind === 'refused' ? 'refused' : 'done'
        if (outcome.kind === 'refused') step.error = outcome.error
        described = describeToolResult(outcome)
      }
      conversation.push({ role: 'tool', tool_name: call.name, content: described })
      emit()
    }

    // The next round starts with a clean answer: everything before a tool call
    // was the model narrating its plan, and leaving it in front of the real
    // answer reads as two answers.
    turn.answer = ''
    emit()
  }

  turn.status = 'exhausted'
  turn.waiting = null
  turn.error =
    `The model was still calling tools after ${maxTurns} rounds and was stopped. ` +
    'Whatever it did run is shown above; try a narrower question.'
  emit()
  return { turn, messages: deps.history }
}

/**
 * What makes two tool calls the same call.
 *
 * The *validated* call, not the model's raw arguments: `{rows:'year'}` and
 * `{rows:'year', chart:'stackedBar'}` are the same query once defaults are
 * applied, and a model that re-emits one with a cosmetic difference is as stuck
 * as one that re-emits it exactly.
 */
function signatureOf(call: ToolCall): string {
  return JSON.stringify(call)
}

/** The tools this one is not, named so a stuck model has somewhere to go. */
function otherTools(name: string): string {
  return TOOL_NAMES.filter((tool) => tool !== name).join(', ')
}

/**
 * The user pressed Stop. A result, not a failure — nothing was changed.
 *
 * The stopped exchange is **dropped from the conversation** rather than carried
 * forward. Half of it exists: a user message with no reply, or tool results the
 * model never got to read, and either one would be re-sent as context for the
 * next question — where a truncated assistant turn reads as something the model
 * said and meant. What actually ran is still on screen in `turn.steps`, which
 * is where the user needs it; the model starts the next question clean.
 */
function stop(turn: ChatTurn, history: ChatMessage[], emit: () => void): LoopResult {
  turn.status = 'stopped'
  turn.waiting = null
  emit()
  return { turn, messages: history }
}
