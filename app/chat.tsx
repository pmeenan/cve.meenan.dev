'use client'

/**
 * The chat column (M7, revamped into the workspace's third pane — D-081).
 *
 * **A column beside the canvas, not a separate view.** A question is usually
 * about what is on the canvas, and the canvas is where every answer lands: an
 * aggregate or record search the model runs is applied there automatically by
 * the page. What this panel renders inline is the *same* components the
 * canvas uses — `Chart`, `ChartTable`, `RecordTable` — never a compact
 * reimplementation of them (D-044). A parallel renderer is how a chat answer
 * and the canvas beside it would end up disagreeing about the same numbers.
 * The per-record view is the furthest case: rather than mounting a second
 * `Detail`, chat sends the reader to the canvas's records view, where the one
 * that exists already lives.
 *
 * **Every rendered definition can leave the conversation.** The durable
 * artifact is the report definition, not the prose: it is hand-editable,
 * permalinkable, saveable and re-runnable with no model in the loop (D-069,
 * D-072). The conversation itself is session-only and is gone on reload, which
 * is what makes the tier's "nothing is stored" disclosure true on the client as
 * well as on the server.
 *
 * **Model prose is text, always.** Rendered into a text node, no markdown
 * parsing, no linkification, no `dangerouslySetInnerHTML` anywhere in this
 * file. The model reads attacker-influenced CVE text (rule 4), so anything it
 * emits is a stranger's input — and the one thing it must never be able to do
 * is mint a link.
 *
 * **The backing query is one click away, on every number.** Vision criterion 7
 * in a chat: each step discloses the SQL and the bound values that produced it,
 * and each aggregate discloses the definition it came from.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { bucketLabel, buildChart, timeSpan } from '@/lib/chart'
import type { StepFacts } from '@/lib/benchmark'
import type { ChatStep, ChatTurn } from '@/lib/chat-loop'
import { CONSENT_TEXT } from '@/lib/chat'
import { DIMENSION_LABELS } from '@/lib/filters'
import type { Coverage, ToolOutcome } from '@/lib/protocol'
import { CHART_ROWS, TABLE_ROWS, type Report } from '@/lib/report'

import { Chart, ChartTable } from './chart'
import { RecordTable } from './explore'

/** What each tool is called where a person reads it. */
const STEP_LABELS: Record<string, string> = {
  aggregate: 'Counting and charting',
  search_records: 'Finding records',
  cve_detail: 'Reading a record',
  kev_lookup: 'Checking CISA KEV',
  sql: 'Running SQL',
  compute: 'Computing over the last result',
}

/**
 * How long a wait may go unannounced.
 *
 * D-052 §3: anything over a second reports itself. Below that, a label that
 * appears and vanishes is noise — and a `cve_detail` against a local SQLite
 * copy is single-digit milliseconds.
 */
const ANNOUNCE_AFTER_MS = 1_000

export function ChatPanel({
  open,
  turns,
  running,
  ready,
  consented,
  consentStorable,
  onConsent,
  onAsk,
  onStop,
  onClose,
  onOpenReport,
  onOpenSearch,
  onOpenRecord,
  coverage,
}: {
  open: boolean
  turns: ChatTurn[]
  running: boolean
  /** A corpus is answering — the local copy, or the hosted tier standing in. */
  ready: boolean
  consented: boolean
  /** `localStorage` is usable, so the choice will be remembered. */
  consentStorable: boolean
  onConsent: (accepted: boolean) => void
  onAsk: (question: string) => void
  onStop: () => void
  onClose: () => void
  onOpenReport: (report: Report) => void
  /**
   * Hand a record search to the canvas's records view.
   *
   * A record result and an aggregate result get *different* destinations, and
   * the difference is not cosmetic: a record search opened as a report renders
   * the same predicates as a year-by-year count, which is a different view of
   * what the reader was looking at (`searchReport`).
   */
  onOpenSearch: (report: Report) => void
  /**
   * Open one record. Deliberately *not* a detail panel of this component's
   * own: the record view is `Detail`, it lives on the canvas, and two mounted
   * copies of it would both grab focus and both claim the same headings. Chat
   * sends the reader to the one that exists.
   */
  onOpenRecord: (cveId: string) => void
  /**
   * The copy's date extent, for the charts a turn draws: what a time axis is
   * filled across and its partial buckets judged against, the same as the
   * canvas (`timeSpan`). Null until the Worker has said.
   */
  coverage: Coverage | null
}) {
  const [question, setQuestion] = useState('')
  const log = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    // Follow the answer as it streams. `scrollTop` rather than `scrollIntoView`
    // so the *panel* scrolls and the page behind it does not move under the
    // reader — the point of a side panel is that the tab stays where it was.
    const node = log.current
    if (node) node.scrollTop = node.scrollHeight
  }, [turns])

  if (!open) return null

  return (
    <aside className="chat" data-chat="open" aria-label="Ask about the corpus">
      <header className="chat-head">
        <h2>Chat</h2>
        <button type="button" className="quiet" onClick={onClose} aria-label="Close chat">
          Close
        </button>
      </header>

      {!consented ? (
        <Consent storable={consentStorable} onConsent={onConsent} />
      ) : (
        <>
          <div className="chat-log" ref={log} data-chat-log="1">
            {turns.length === 0 && (
              <div className="muted chat-hint">
                <p>Ask a question about the CVE List in plain language. For example:</p>
                <ul>
                  <li>Stacked CVE counts by severity over time</li>
                  <li>Which Cisco products have the most CRITICAL CVEs?</li>
                  <li>Are the total counts of CVEs trending up or down recently?</li>
                </ul>
              </div>
            )}
            {turns.map((turn) => (
              <Turn
                key={turn.id}
                turn={turn}
                onOpenReport={onOpenReport}
                onOpenSearch={onOpenSearch}
                onOpenRecord={onOpenRecord}
                coverage={coverage}
              />
            ))}
          </div>

          <form
            className="chat-ask"
            onSubmit={(event) => {
              event.preventDefault()
              const asked = question.trim()
              if (!asked || running || !ready) return
              setQuestion('')
              onAsk(asked)
            }}
          >
            <label className="field" htmlFor="chat-question">
              <span className="visually-hidden">Your question</span>
              <textarea
                id="chat-question"
                rows={2}
                value={question}
                disabled={!ready}
                placeholder={
                  ready
                    ? 'Ask about the corpus…'
                    : 'The corpus is unreachable — download it, then chat can query it'
                }
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  // Enter sends, Shift+Enter breaks the line. A question is one
                  // or two sentences; a textarea that needed a mouse to submit
                  // would be the wrong shape for it.
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    event.currentTarget.form?.requestSubmit()
                  }
                }}
              />
            </label>
            <div className="actions">
              <button type="submit" disabled={running || !ready || !question.trim()}>
                Ask
              </button>
              {running && (
                <button type="button" className="quiet" onClick={onStop} data-chat-stop="1">
                  Stop
                </button>
              )}
            </div>
            <p className="muted small">
              Your question and the results of its queries go to cve.meenan.dev and our model host;
              nothing is stored, and this conversation is gone on reload.{' '}
              <button type="button" className="quiet link" onClick={() => onConsent(false)}>
                Turn chat off
              </button>
            </p>
          </form>
        </>
      )}
    </aside>
  )
}

/**
 * The first-use disclosure (D-057).
 *
 * A gate rather than a banner: nothing is sent until it is accepted, and the
 * composer does not exist until then. This is the first feature where
 * analysis-related content reaches infrastructure we operate, and D-009's "no
 * telemetry" claim survives only because this traffic is user-initiated and
 * opted into — which requires the opt-in to be real.
 */
function Consent({
  storable,
  onConsent,
}: {
  storable: boolean
  onConsent: (accepted: boolean) => void
}) {
  return (
    <div className="chat-consent" data-chat-consent="1">
      <h3>Before you ask</h3>
      {CONSENT_TEXT.map((paragraph) => (
        <p key={paragraph.slice(0, 24)}>{paragraph}</p>
      ))}
      {!storable && (
        <p className="stale">
          This browser will not let the site remember your choice, so this notice comes back every
          time you open the page.
        </p>
      )}
      <div className="actions">
        <button type="button" onClick={() => onConsent(true)} data-chat-accept="1">
          Turn chat on
        </button>
        <button type="button" className="quiet" onClick={() => onConsent(false)}>
          No thanks
        </button>
      </div>
    </div>
  )
}

function Turn({
  turn,
  onOpenReport,
  onOpenSearch,
  onOpenRecord,
  coverage,
}: {
  turn: ChatTurn
  onOpenReport: (report: Report) => void
  onOpenSearch: (report: Report) => void
  onOpenRecord: (cveId: string) => void
  coverage: Coverage | null
}) {
  return (
    <article className="chat-turn" data-chat-turn={turn.status}>
      {/* The user's own words, as a text node. They are also a stranger's input
          the moment a permalink or a saved report carries them. */}
      <p className="chat-question">{turn.question}</p>

      {turn.thinking.trim() && (
        <details className="chat-thinking">
          <summary>How it reasoned</summary>
          <p>{turn.thinking}</p>
        </details>
      )}

      {turn.steps.map((step) => (
        <Step
          key={step.key}
          step={step}
          onOpenReport={onOpenReport}
          onOpenSearch={onOpenSearch}
          onOpenRecord={onOpenRecord}
          coverage={coverage}
        />
      ))}

      {turn.answer.trim() && (
        <p className="chat-answer" data-chat-answer="1">
          {turn.answer}
        </p>
      )}

      {turn.waiting && (
        <Waiting key={`${turn.waiting.on}:${turn.waiting.what}`} waiting={turn.waiting} />
      )}

      {turn.status === 'stopped' && (
        <p className="muted" data-chat-stopped="1">
          Stopped. Nothing was changed, and anything already run is above.
        </p>
      )}
      {turn.error && (
        <p className="error" data-chat-error="1">
          {turn.error}
        </p>
      )}
      {turn.evicted > 0 && (
        // Said out loud, because it changes what the model could see when it
        // answered. The results are still above; it is the model's copy that
        // was dropped, and a follow-up about them may need to run the query
        // again.
        <p className="muted" data-chat-evicted={turn.evicted}>
          {turn.evicted === 1 ? 'One earlier result was' : `${turn.evicted} earlier results were`}{' '}
          dropped from the model&rsquo;s context to make room. They are still shown above.
        </p>
      )}
      {turn.status === 'done' && turn.steps.length === 0 && turn.answer.trim() && (
        // The one failure a reader cannot see: an answer with no query behind
        // it is the model's own weights talking, and for a CVE question that is
        // exactly what the tools exist to prevent (D-046, vision criterion 7).
        <p className="stale" data-chat-ungrounded="1">
          The model answered without querying the corpus, so nothing above came from your local
          copy. Treat it as a guess and ask again more specifically.
        </p>
      )}
    </article>
  )
}

/**
 * "Still working", but only once it is worth saying (D-052 §3).
 *
 * The elapsed figure comes from a timer rather than from a render, because the
 * whole point is to say something while nothing else is changing.
 *
 * Mounted under a `key` of what is being waited on, so moving from the model to
 * a tool restarts the clock by remounting rather than by resetting state from
 * an effect — which is the same thing and the one React's rules allow.
 */
function Waiting({ waiting }: { waiting: NonNullable<ChatTurn['waiting']> }) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const started = Date.now()
    const timer = setInterval(() => setElapsed(Date.now() - started), 250)
    return () => clearInterval(timer)
  }, [])

  if (elapsed < ANNOUNCE_AFTER_MS) return null
  const seconds = (elapsed / 1000).toFixed(0)
  return (
    <p className="muted" aria-live="polite" data-chat-waiting={waiting.on}>
      {waiting.on === 'model'
        ? `Waiting for the model — ${seconds} s`
        : `${STEP_LABELS[waiting.what] ?? waiting.what} — ${seconds} s`}
    </p>
  )
}

/**
 * One tool step — a chat turn's, or an agent's (D-086: the page's "Agent
 * activity" log renders agent calls through this same component, so what an
 * agent did is on screen the way what the model did is).
 */
export function Step({
  step,
  onOpenReport,
  onOpenSearch,
  onOpenRecord,
  compact,
  coverage,
}: {
  step: ChatStep
  onOpenReport: (report: Report) => void
  onOpenSearch: (report: Report) => void
  onOpenRecord: (cveId: string) => void
  /** The copy's date extent, for a chart drawn here (see `ChatPanel`). */
  coverage: Coverage | null
  /**
   * Summarise a result that is already on the canvas — an aggregate, a
   * record search, SQL — instead of rendering a second chart or table beside
   * it (the agent log's mode). A record read, a KEV lookup, a computed
   * value and a refusal render in full either way: the canvas does not
   * carry them, so this is where they are seen.
   */
  compact?: boolean
}) {
  return (
    <section
      className="chat-step"
      data-chat-step={step.name}
      data-chat-status={step.status}
      // The D-046 benchmark scores by comparing *data*, not prose, so what it
      // needs is the answer in a machine-readable form. Read from here rather
      // than scraped back out of the rendered table — the same convention the
      // import and report panels use for `measure.spec.ts`, and for the same
      // reason: a re-parsed label is a test of the formatter.
      data-chat-json={JSON.stringify(stepFacts(step))}
    >
      <p className="muted small">
        {STEP_LABELS[step.name] ?? `Tool: ${step.name}`}
        {step.status === 'running' && ' — running'}
        {step.ms !== undefined && ` — ${step.ms} ms`}
      </p>
      {step.status === 'refused' && step.error && (
        // Shown, not hidden. A refusal is what the model was told, and a reader
        // who can see it can tell "the tool said no" from "the model made
        // something up" — which is the difference the whole surface rests on.
        <p className="stale" data-chat-refused="1">
          {step.error}
        </p>
      )}
      {step.outcome &&
        (compact && onCanvas(step.outcome) ? (
          <Landed outcome={step.outcome} onOpenReport={onOpenReport} onOpenSearch={onOpenSearch} />
        ) : (
          <Outcome
            outcome={step.outcome}
            onOpenReport={onOpenReport}
            onOpenSearch={onOpenSearch}
            onOpenRecord={onOpenRecord}
            coverage={coverage}
          />
        ))}
    </section>
  )
}

/** The outcomes the page lands on the canvas as they arrive (see `toolResult` in page.tsx). */
function onCanvas(outcome: ToolOutcome): boolean {
  return outcome.kind === 'aggregate' || outcome.kind === 'records' || outcome.kind === 'sql'
}

/**
 * A result that is on the canvas, in one line: what it counted, and the way
 * back to it. The chart or the list is not repeated here — the canvas is the
 * one place it renders, which is what keeps "the number on screen" singular.
 */
function Landed({
  outcome,
  onOpenReport,
  onOpenSearch,
}: {
  outcome: ToolOutcome
  onOpenReport: (report: Report) => void
  onOpenSearch: (report: Report) => void
}) {
  switch (outcome.kind) {
    case 'aggregate':
      return (
        <p className="muted small" data-chat-landed="aggregate">
          {outcome.matches === null
            ? 'Counted'
            : `${outcome.matches.toLocaleString()} records match`}
          {' — '}
          {DIMENSION_LABELS[outcome.report.rows]}
          {outcome.report.series ? ` × ${DIMENSION_LABELS[outcome.report.series]}` : ''}, on the
          canvas.{' '}
          <button
            type="button"
            className="quiet link"
            data-chat-open-report="1"
            onClick={() => onOpenReport(outcome.report)}
          >
            Open on canvas
          </button>
        </p>
      )
    case 'records':
      return (
        <p
          className="muted small"
          data-chat-landed="records"
          data-chat-matches={outcome.matches ?? ''}
        >
          {outcome.matches === null
            ? `${outcome.result.rows.length.toLocaleString()} records`
            : `${outcome.matches.toLocaleString()} records match`}
          , {outcome.result.rows.length.toLocaleString()} listed on the canvas.{' '}
          <button
            type="button"
            className="quiet link"
            data-chat-open-search="1"
            onClick={() => onOpenSearch(outcome.report)}
          >
            Open in records view
          </button>
        </p>
      )
    case 'sql':
      return (
        <p className="muted small" data-chat-landed="sql">
          {outcome.result.rows.length.toLocaleString()} rows in {outcome.result.ms} ms
          {outcome.result.truncated && ' (capped)'} — in the SQL panel.
        </p>
      )
    default:
      return null
  }
}

/**
 * One step, reduced to what a scorer can compare (D-046).
 *
 * Every value here is already on screen; this is the same answer in a shape
 * that does not depend on how it is formatted. Bounded to the aggregate's own
 * cell cap, which is what is rendered anyway.
 */
function stepFacts(step: ChatStep): StepFacts {
  const outcome = step.outcome
  const facts: StepFacts = {
    tool: step.name,
    status: step.status,
    ms: step.ms ?? null,
    rows: null,
    series: null,
    matches: null,
    cells: [],
    ...(step.error ? { error: step.error } : {}),
  }
  if (!outcome) return facts
  switch (outcome.kind) {
    case 'aggregate':
      facts.rows = outcome.report.rows
      facts.series = outcome.report.series
      facts.matches = outcome.matches
      // **The labels the table renders, not the stored codes.** `crossSql`
      // returns `c.cvss_sev` in the label column for a code dimension, and
      // `bucketLabel` is what turns 4 into CRITICAL and NULL into "(not
      // scored)" for every surface. Publishing the codes here would make the
      // benchmark compare a code against a hand-written label and score every
      // correct answer as wrong — which is exactly what it did.
      facts.cells = outcome.result.rows.map((row) =>
        outcome.report.series === null
          ? [bucketLabel(outcome.report.rows, row[0], row[1]), cell(row[2])]
          : [
              bucketLabel(outcome.report.rows, row[0], row[1]),
              bucketLabel(outcome.report.series, row[2], row[3]),
              cell(row[4]),
            ]
      )
      break
    case 'records':
      facts.matches = outcome.matches
      break
    case 'detail':
      facts.cells = [[outcome.cveId, outcome.detail ? 1 : 0]]
      break
    case 'kev':
      // `known` first: "this copy has no such record" is not the same answer as
      // "CISA does not list it", and a scorecard that conflated them would
      // score the wrong thing right.
      facts.cells = [[outcome.cveId, outcome.known ? (outcome.kev ? 1 : 0) : -1]]
      break
    case 'sql':
      facts.cells = outcome.result.rows.map((row) => row.map(cell))
      break
    case 'compute':
      facts.cells = [[outcome.ok ? (outcome.value ?? null) : (outcome.error ?? 'failed')]]
      break
    case 'refused':
      break
  }
  return facts
}

function cell(value: unknown): string | number | null {
  if (value === null || value === undefined) return null
  return typeof value === 'number' ? value : String(value)
}

function Outcome({
  outcome,
  onOpenReport,
  onOpenSearch,
  onOpenRecord,
  coverage,
}: {
  outcome: ToolOutcome
  onOpenReport: (report: Report) => void
  onOpenSearch: (report: Report) => void
  onOpenRecord: (cveId: string) => void
  coverage: Coverage | null
}) {
  switch (outcome.kind) {
    case 'aggregate':
      return (
        <Aggregate
          report={outcome.report}
          rows={outcome.result.rows}
          matches={outcome.matches}
          ms={outcome.result.ms}
          truncated={outcome.result.truncated}
          sql={outcome.result.sql}
          params={outcome.result.params}
          onOpenReport={onOpenReport}
          coverage={coverage}
        />
      )
    case 'records':
      return (
        <>
          <p className="muted small" data-chat-matches={outcome.matches ?? ''}>
            {outcome.matches === null
              ? `${outcome.result.rows.length.toLocaleString()} records`
              : `${outcome.matches.toLocaleString()} records match`}
            , {outcome.result.rows.length.toLocaleString()} shown
            {outcome.result.truncated && ' (capped)'}
          </p>
          <div className="scroll" tabIndex={0}>
            <RecordTable result={outcome.result} onOpenRecord={onOpenRecord} />
          </div>
          <p className="actions">
            <button
              type="button"
              className="quiet"
              data-chat-open-search="1"
              onClick={() => onOpenSearch(outcome.report)}
            >
              Open in records view
            </button>
          </p>
          <Backing sql={outcome.result.sql} params={outcome.result.params} />
        </>
      )
    case 'detail':
      return outcome.detail ? (
        <p className="muted small">
          <button
            type="button"
            className="quiet link"
            onClick={() => onOpenRecord(outcome.cveId)}
            aria-label={`Open record ${outcome.cveId}`}
          >
            {outcome.cveId}
          </button>{' '}
          — {outcome.detail.record.cna ?? 'no CNA recorded'}
          {outcome.detail.record.score !== null && `, CVSS ${outcome.detail.record.score}`}
        </p>
      ) : (
        <p className="muted small">No record in this copy carries that identifier.</p>
      )
    case 'kev':
      return (
        <p className="muted small" data-chat-kev={outcome.kev ? 'listed' : 'not-listed'}>
          {!outcome.known
            ? `This copy holds no record called ${outcome.cveId}.`
            : outcome.kev
              ? `In CISA’s KEV catalog ${outcome.catalog.version}, added ${outcome.kev.added}, due ${outcome.kev.due}.`
              : `Not in CISA’s KEV catalog ${outcome.catalog.version} (released ${outcome.catalog.released}).`}
        </p>
      )
    case 'sql':
      return (
        <>
          <p className="muted small">
            {outcome.result.rows.length.toLocaleString()} rows in {outcome.result.ms} ms
            {outcome.result.overflowed
              ? ' — stopped early: more data than the browser will hold'
              : outcome.result.truncated && ' (capped)'}
          </p>
          <div className="scroll" tabIndex={0}>
            <table className="results">
              <thead>
                <tr>
                  {outcome.result.columns.map((column) => (
                    <th scope="col" key={column}>
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {outcome.result.rows.slice(0, 50).map((row, index) => (
                  <tr key={index}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex}>{String(cell ?? '')}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Backing sql={outcome.result.sql} params={outcome.result.params} />
        </>
      )
    case 'compute':
      // The code and what it produced, both as text nodes (never markup):
      // the reader can see exactly what was run over which result, which is
      // what lets a number the model states from it be checked (D-088).
      return (
        <>
          <p className="muted small" data-chat-compute={outcome.ok ? 'ok' : 'failed'}>
            {outcome.input.rows.toLocaleString()} rows of the last{' '}
            {outcome.input.source === 'aggregate'
              ? 'aggregate'
              : outcome.input.source === 'records'
                ? 'record search'
                : outcome.input.source === 'sql'
                  ? 'SQL result'
                  : 'result (nothing had run)'}{' '}
            in {outcome.ms} ms{outcome.truncated && ' — output cut at the cap'}
          </p>
          {outcome.error && (
            <p className="stale" data-chat-compute-error="1">
              {outcome.error}
            </p>
          )}
          {outcome.value !== null && (
            <pre className="compute-output" data-chat-compute-value="1">
              {outcome.value}
            </pre>
          )}
          {outcome.logs.length > 0 && (
            <pre className="compute-output muted">{outcome.logs.join('\n')}</pre>
          )}
          <details className="sql">
            <summary>The code that produced this</summary>
            <pre>{outcome.code}</pre>
          </details>
        </>
      )
    case 'refused':
      return null
  }
}

function Aggregate({
  report,
  rows,
  matches,
  ms,
  truncated,
  sql,
  params,
  onOpenReport,
  coverage,
}: {
  report: Report
  rows: readonly unknown[][]
  matches: number | null
  ms: number
  truncated: boolean
  sql: string
  params: (string | number)[]
  onOpenReport: (report: Report) => void
  coverage: Coverage | null
}) {
  // The Report tab's own model builder, from the definition the Worker echoed
  // back — not from anything the model said about it. A time axis is drawn
  // across the window the call asked for over the copy that answered
  // (`timeSpan`, the canvas's own arithmetic), so a bucket in it with no
  // records is a zero rather than a gap and a partial bucket is marked.
  const model = useMemo(
    () =>
      buildChart(
        rows,
        report.rows,
        report.series,
        report.limit ?? (report.chart === 'table' ? TABLE_ROWS : CHART_ROWS),
        timeSpan(report.filters, coverage)
      ),
    [rows, report.rows, report.series, report.limit, report.chart, report.filters, coverage]
  )
  const state = report.filters.state ?? 'published'

  return (
    <>
      {state !== 'published' && (
        <p className="stale" data-state-warning={state}>
          {state === 'all'
            ? 'Including REJECTED records: about 4.8% of the corpus, which inflates every count below against the default (D-022).'
            : 'REJECTED records only — these are withdrawn CVE IDs, not vulnerabilities.'}
        </p>
      )}
      <p className="muted small" data-chat-buckets={model.rows.length}>
        {matches === null ? 'Counted' : `${matches.toLocaleString()} records match`} —{' '}
        {DIMENSION_LABELS[report.rows]}
        {report.series ? ` × ${DIMENSION_LABELS[report.series]}` : ''}, {model.rows.length} buckets
        in {ms} ms{truncated && ' (capped)'}
      </p>
      {report.chart !== 'table' && (
        <Chart
          model={model}
          type={report.chart}
          rowsDimension={report.rows}
          seriesDimension={report.series}
        />
      )}
      <ChartTable
        model={model}
        rowsDimension={report.rows}
        seriesDimension={report.series}
        view={report.chart === 'table' ? 'spreadsheet' : 'audit'}
      />
      <OpenInReport report={report} onOpenReport={onOpenReport} />
      <Backing sql={sql} params={params} />
    </>
  )
}

/**
 * The action that makes a chat answer outlive the conversation.
 *
 * The page already applies each aggregate to the canvas as it arrives; this
 * button re-applies *this* step's definition — an earlier answer the
 * conversation has scrolled past — and re-runs it fresh. The definition is the
 * durable artifact: editable, permalinkable and saveable with no model in the
 * loop (D-069, D-072).
 */
function OpenInReport({
  report,
  onOpenReport,
}: {
  report: Report
  onOpenReport: (report: Report) => void
}) {
  return (
    <p className="actions">
      <button
        type="button"
        className="quiet"
        data-chat-open-report="1"
        onClick={() => onOpenReport(report)}
      >
        Open on canvas
      </button>
    </p>
  )
}

/** The query behind the number, one click away — vision criterion 7, in a chat. */
function Backing({ sql, params }: { sql: string; params: (string | number)[] }) {
  return (
    <details className="sql">
      <summary>The SQL that produced this</summary>
      <pre>{sql}</pre>
      <p className="muted">Bound values: {params.map((value) => String(value)).join(' · ')}</p>
    </details>
  )
}
