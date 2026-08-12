'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { gateMessage, type CapabilityReport } from '@/lib/capabilities'
import { newCancelFlag, requestCancel } from '@/lib/cancel'
import { hasConsent, setConsent, streamChat, systemPrompt, type ChatMessage } from '@/lib/chat'
import { canvasContext } from '@/lib/tools'
import { runChatTurn, type ChatTurn } from '@/lib/chat-loop'
import { NO_SHELL, registerShell, shellVersion, type ShellState } from '@/lib/shell'
import { draftToFilters, filtersToDraft } from '@/lib/draft'
import type { Dimension, SortKey } from '@/lib/filters'
import { describeFreshness, KEV_STALE_AFTER_MS } from '@/lib/freshness'
import type { ExportFormat } from '@/lib/export'
import { inlineSql } from '@/lib/inline-sql'
import type { KevStatus } from '@/lib/kev'
import { DEFAULT_CACHE_MIB, DEFAULT_CONCURRENCY, DEFAULT_VFS } from '@/lib/protocol'
import type {
  BenchResult,
  CveDetail,
  ImportOptions,
  Progress,
  QueryResult,
  Request,
  Response,
  SearchRequest,
  SyncOutcome,
  Timings,
  ToolCall,
  ToolOutcome,
} from '@/lib/protocol'
import { defaultReport, emptyReport, fromFragment, REPORT_VERSION, type Report } from '@/lib/report'
import { persistenceMessage, requestPersistence, type StorageReport } from '@/lib/storage'
import {
  clearRecent,
  emptyStore,
  loadStore,
  recordRecent,
  removeSaved,
  saveNamed,
  writeStore,
  type ReportStore,
} from '@/lib/saved'

import { Canvas, type ReportOutcome } from './canvas'
import { ChatPanel } from './chat'
import { Console, EXAMPLES } from './console'
import { DataPanel } from './data-panel'
import { Diagnostics } from './diagnostics'
import type { SearchOutcome } from './explore'
import { FiltersPanel } from './filters-panel'
import { Landing } from './landing'
import { ProgressBar } from './progress'
import { SavedTab } from './saved'

/**
 * M1's end-to-end path: download the published chunks, decompress them in
 * WASM, store the database in OPFS, build the search indexes, and render one
 * real query — carrying MITRE's notice (D-008).
 */
const DEMO_QUERY = `SELECT v.name AS vendor, count(*) AS cves, round(avg(c.cvss_score), 1) AS avg_cvss
FROM cve c
JOIN cve_prod cp ON cp.cve_id = c.id
JOIN product p ON p.id = cp.product_id
JOIN vendor v ON v.id = p.vendor_id
WHERE c.state = 1 AND c.cvss_score IS NOT NULL
GROUP BY v.id
ORDER BY cves DESC
LIMIT 15`

const IDLE: Progress = { phase: 'idle', fraction: null, detail: '' }

/** How many records a list asks for. Bounded again in the Worker (D-052 §4). */
const PAGE_ROWS = 100

/** The workspace's collapsible panels. Chat is its own column, not one of these. */
interface Panels {
  filters: boolean
  sql: boolean
  data: boolean
  saved: boolean
}

const CLOSED: Panels = { filters: false, sql: false, data: false, saved: false }

/**
 * Import knobs from the query string, for the Q-003/Q-004 sweep and the
 * staged-replacement tests only (`?vfs=opfs-sahpool&concurrency=8&cache=64`,
 * `?stop=1`). Every default is the measured one (D-049 – D-051); anything
 * unrecognised falls back rather than failing, because this is a diagnostic
 * affordance and not a feature.
 *
 * These are only a convenience: the Worker clamps them again, because a URL is
 * something a stranger can hand you and the memory bound is not negotiable
 * there.
 *
 * The knob to be wary of is **`vfs`**, not the others. `?stop=` ends a download
 * early, `?stall=` shortens the no-progress timeout, `?schema=` changes the
 * schema version this build claims to read (D-068), `?probe=` forces the
 * capability gate's verdict downwards so the gate's own message can be tested
 * (M5), `?ops=` and `?analyze=`
 * turn off the query progress handler and the statistics pass so the M3 sweep
 * can price them (D-066, D-067) — all of which leave the local copy where it
 * was by construction. `?vfs=` selects the `opfs-sahpool` path, which cannot
 * stage (D-051) and so clears local storage — both slots included — *before*
 * fetching anything: one click on a crafted link costs a working local copy. It
 * stays reachable because `pnpm measure` needs it to re-run Q-004.
 *
 * Note what is *not* here: a report never travels in the query string. It is
 * made of predicates, and a query string reaches nginx's request line and its
 * access log (D-014, D-032). Reports arrive in the fragment, which is never
 * sent — read once on mount, below.
 */
function importOptions(search: string): ImportOptions {
  const params = new URLSearchParams(search)
  const vfs = params.get('vfs')
  const stop = positive(params.get('stop'))
  const stall = positive(params.get('stall'))
  const schema = positive(params.get('schema'))
  // Zero is meaningful here — it means "install no progress handler" — so this
  // one is read as a plain integer rather than through `positive`.
  const ops = params.get('ops')
  const progressOps = ops !== null && /^\d+$/.test(ops.trim()) ? Number(ops) : null
  // `?analyze=0` only: anything else leaves the default, which is on.
  const analyze = params.get('analyze') === '0' ? false : null
  // `?probe=` forces the capability gate's verdict, and only downwards (M5).
  const probeRaw = params.get('probe')
  const probe = probeRaw === 'async' || probeRaw === 'unavailable' ? probeRaw : null
  // `?free=` makes the storage preflight see a smaller figure, never a larger.
  const freeRaw = params.get('free')
  const freeBytes = freeRaw !== null && /^\d+$/.test(freeRaw.trim()) ? Number(freeRaw.trim()) : null
  // `?remote=0` turns the hosted query tier off for the session (D-084). It can
  // only narrow: with it, no query leaves the browser; without it, nothing new
  // is reachable that the page would not reach anyway.
  const remote = params.get('remote') === '0' ? false : null
  return {
    concurrency: positive(params.get('concurrency')) ?? DEFAULT_CONCURRENCY,
    cacheMib: positive(params.get('cache')) ?? DEFAULT_CACHE_MIB,
    vfs: vfs === 'opfs' || vfs === 'opfs-sahpool' ? vfs : DEFAULT_VFS,
    ...(stop === null ? {} : { stopAfterChunks: stop }),
    ...(stall === null ? {} : { stallMs: stall }),
    ...(schema === null ? {} : { schema }),
    ...(progressOps === null ? {} : { progressOps }),
    ...(analyze === null ? {} : { analyze }),
    ...(probe === null ? {} : { probe }),
    ...(freeBytes === null ? {} : { freeBytes }),
    ...(remote === null ? {} : { remote }),
  }
}

/** A positive integer, or null for absent/empty/NaN/fractional/negative. */
function positive(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : null
}

export default function Home() {
  const workerRef = useRef<Worker | null>(null)
  const [progress, setProgress] = useState<Progress>(IDLE)
  const [ready, setReady] = useState(false)
  /**
   * What the Worker has established about local storage.
   *
   * `ready` alone cannot express it: false covers "no status yet", "there is no
   * local copy", and "I could not find out", and the landing CTA reads
   * "Download CVE dataset" in all three. The first is invisible to a user but
   * silently breaks tests, which act on the pre-status render. The third is
   * worse — clearing the panels and inviting a download implies the copy is
   * gone when it may simply be unreadable this instant (D-061).
   *
   * `pending` (no answer yet) is kept distinct from `unknown` (an answer of
   * "I could not tell") so that both the UI and a test can wait for the Worker
   * to have spoken without mistaking a failure for silence.
   */
  const [storage, setStorage] = useState<'pending' | 'unknown' | 'ready' | 'empty' | 'obsolete'>(
    'pending'
  )
  /**
   * The schema the local copy carries and the one this build reads. Equal
   * whenever the copy is usable; the pair is the announcement a bump owes
   * (M3, D-013).
   */
  const [schemas, setSchemas] = useState<{ local: number | null; speaks: number }>({
    local: null,
    speaks: 0,
  })
  const [timings, setTimings] = useState<Timings | null>(null)
  const [sync, setSync] = useState<SyncOutcome | null>(null)
  const [revision, setRevision] = useState<number | null>(null)
  /**
   * `meta.generated` — when the pipeline built the revision this copy holds,
   * which is what the staleness indicator is about. Read from the database via
   * `status`, so it survives a reload and needs no network request (D-048).
   */
  const [generated, setGenerated] = useState<number | null>(null)
  /**
   * The clock the staleness indicator is measured against, sampled in an effect
   * rather than read during render — `Date.now()` in a render body is an impure
   * read React's rules forbid, and it would also freeze the label for as long as
   * nothing else re-rendered. A tab left open overnight should notice.
   */
  const [now, setNow] = useState<number | null>(null)
  const [notice, setNotice] = useState('')
  /**
   * The CISA KEV catalog this copy holds (M6, D-076).
   *
   * From `status`, so it survives a reload and is available offline — the
   * catalog's freshness is a property of the copy, not of this page's session.
   * `kevError` is separate and *not* in `error`, because a KEV failure is not a
   * failure of the corpus operation that triggered it.
   */
  const [kev, setKev] = useState<KevStatus | null>(null)
  const [kevError, setKevError] = useState('')
  /**
   * What the hosted tier probe found (D-084) — the server copy's revision,
   * build stamp, notice and KEV catalog, or why it cannot serve. Null while
   * unasked or in flight. The ref mirrors it for the one reader that runs
   * inside `onmessage`, where state would be a render behind.
   */
  const [hosted, setHosted] = useState<{
    ok: boolean
    error?: string
    rev: number | null
    generated: number | null
    notice: string | null
    kev: KevStatus | null
  } | null>(null)
  const hostedRef = useRef<typeof hosted>(null)
  const [error, setError] = useState('')
  /**
   * Whether the run that is on screen imported successfully.
   *
   * A download is followed by a catch-up (M2), so an error can arrive *after* a
   * successful import — and the Import panel is then still describing what is
   * on disk. Clearing it there would hide an accurate report of the thing that
   * worked, which is the opposite of what the clearing rule below is for.
   */
  const importedThisRun = useRef(false)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [search, setSearch] = useState<SearchOutcome | null>(null)
  const [consoleResult, setConsoleResult] = useState<QueryResult | null>(null)
  const [consoleError, setConsoleError] = useState('')
  /** Which surface a cancellation belongs to, so it is reported where it happened. */
  const [cancelled, setCancelled] = useState<{ kind: string; ms: number } | null>(null)
  /**
   * How many answers the Worker has given this page — a result, a cancellation
   * or a refusal.
   *
   * On screen it is nothing; it is rendered as `data-run` so a test can wait for
   * *this* answer rather than reading the previous one. Without it a query that
   * finishes in single-digit milliseconds is indistinguishable from one that has
   * not started, and the assertion passes against the last result — which is how
   * a filter that never applied can look correct.
   */
  const [runSeq, setRunSeq] = useState(0)
  const [stopping, setStopping] = useState(false)
  const [benchmark, setBenchmark] = useState<{
    results: BenchResult[]
    wasmHeapBytes: number
  } | null>(null)

  // --- M5 ---------------------------------------------------------------
  /**
   * What this browser can do and what its storage looks like (D-016, M5).
   *
   * Null until the Worker has answered. The gate below is deliberately *not*
   * rendered while it is null: a browser that turns out to be fine would
   * otherwise flash a "cannot run" banner on every load, and a banner that
   * appears and disappears is one nobody believes the next time.
   */
  const [environment, setEnvironment] = useState<{
    capabilities: CapabilityReport
    storage: StorageReport
  } | null>(null)
  /** What `navigator.storage.persist()` answered, once it has been asked. */
  const [persisted, setPersisted] = useState<boolean | null>(null)
  /** The offline app shell's own account of itself (D-048, D-009). */
  const [shell, setShell] = useState<ShellState>(NO_SHELL)

  // --- The workspace (UI revamp) ---------------------------------------
  /** What the canvas is showing: the last thing that ran. */
  const [view, setView] = useState<'report' | 'records'>('report')
  const [panels, setPanels] = useState<Panels>(CLOSED)
  /**
   * Mirror of `panels.sql` for the Worker message handler, which is created
   * once and must not close over stale state: the SQL drawer is auto-populated
   * only while it is hidden, so an open drawer never loses an edit underway.
   */
  const sqlOpen = useRef(false)
  /** The report definition every surface edits. One object, many consumers (D-069). */
  const [report, setReport] = useState<Report>(() => emptyReport())
  const [reportOutcome, setReportOutcome] = useState<ReportOutcome | null>(null)
  /** Record-list controls, drawer-owned but page-held so chat can set them. */
  const [groupBy, setGroupBy] = useState<'' | Dimension>('')
  const [sort, setSort] = useState<SortKey>('published')
  /** Legend toggles and display renames — views of a result, reset per run. */
  const [hiddenSeries, setHiddenSeries] = useState<ReadonlySet<string>>(new Set())
  const [seriesLabels, setSeriesLabels] = useState<Record<string, string>>({})
  /** The SQL drawer's text: the last query that ran, editable. */
  const [sqlText, setSqlText] = useState(EXAMPLES[0]!.sql)
  /** The workspace opened once with something on the canvas. */
  const autoRan = useRef(false)

  const [store, setStore] = useState<ReportStore>(() => emptyStore())
  /**
   * The same value as `store`, readable synchronously.
   *
   * Saving, deleting and recording a run all have to *persist* the result, and
   * a `setStore(current => …)` updater is not the place to do it: React may
   * invoke an updater more than once, and an updater that writes to storage and
   * sets other state is not a pure function of its argument. So the next value
   * is computed here, written, and then handed to React — `updateStore` below.
   */
  const storeRef = useRef<ReportStore>(emptyStore())
  const [storable, setStorable] = useState(true)
  const [detailId, setDetailId] = useState<string | null>(null)
  /** `undefined` is loading, `null` is the Worker's "no such record" answer. */
  const [detail, setDetail] = useState<CveDetail | null | undefined>(undefined)
  /** The latest detail request still wanted by the UI; stale replies are ignored. */
  const detailRequest = useRef<string | null>(null)
  const [exportNote, setExportNote] = useState('')
  /**
   * The export being assembled, as `Blob` parts.
   *
   * A ref rather than state: chunks arrive faster than React would render, and
   * nothing on screen depends on how many have landed. Blob parts rather than
   * one string, because the browser is free to spill a `Blob` to disk, which is
   * what keeps a 25 MB export off the JS heap — the page's half of the bound
   * the Worker holds on its side (lib/export.ts).
   */
  const exportParts = useRef<Blob[]>([])
  /**
   * A report waiting for a database.
   *
   * Two things put one here: a URL fragment read on mount, and a saved report
   * opened before the Worker has finished reopening the copy — which is a real
   * window, because the Saved panel is readable from `localStorage` immediately
   * and the corpus takes seconds (D-049). Both need the same answer: hold the
   * definition, run it the moment a copy exists, and forget it if none ever
   * does. Without this the click silently does nothing.
   */
  const pendingReport = useRef<Report | null>(null)
  const [linkError, setLinkError] = useState('')
  /**
   * A report is waiting on a corpus.
   *
   * Rendered rather than left silent: someone who followed a report link onto a
   * browser with no readable copy lands on the landing view — and without this
   * the app looks like it ignored the click.
   */
  const [linkPending, setLinkPending] = useState(false)

  // --- M7 ---------------------------------------------------------------
  /**
   * The chat column (M7, revamped into the workspace's third pane). Everything
   * about it is session-only except the consent flag: a reload clears the
   * conversation, which is what makes the tier's "nothing is stored"
   * disclosure true on the client too (D-057).
   */
  const [chatOpen, setChatOpen] = useState(false)
  const [chatTurns, setChatTurns] = useState<ChatTurn[]>([])
  const [chatRunning, setChatRunning] = useState(false)
  const [consented, setConsented] = useState(false)
  /** The model's own view of the conversation. A ref: nothing renders from it. */
  const chatHistory = useRef<ChatMessage[]>([])
  const chatAbort = useRef<AbortController | null>(null)
  /**
   * Tool calls awaiting the Worker, by call id.
   *
   * The Worker answers asynchronously and the loop awaits a promise, so
   * something has to hold the resolver between the two. Keyed by the model's
   * call id, which the Worker echoes on every path out — including the
   * cancelled one, which is what stops a stopped turn from hanging on a promise
   * that never settles.
   */
  const toolWaiters = useRef(new Map<string, (outcome: ToolOutcome) => void>())

  /**
   * The shared cancellation flag (lib/cancel.ts). Created once here, because
   * the page owns the button; null on a browser with no `SharedArrayBuffer`,
   * where the UI says so rather than offering a Cancel that does nothing.
   *
   * `useState` with an initializer rather than `useRef`, so the render that
   * decides whether to offer Cancel sees it.
   */
  const [cancelFlag] = useState<Int32Array | null>(() => newCancelFlag())

  /** Fold a fresh query result into the SQL drawer, unless it is being edited. */
  const populateSql = useCallback((queryResult: QueryResult) => {
    if (sqlOpen.current) return
    if (!queryResult.sql) return
    setSqlText(inlineSql(queryResult.sql, queryResult.params))
  }, [])

  useEffect(() => {
    // The offline shell (D-048). Its own effect, and deliberately not awaited by
    // anything: registration failing must cost the offline *reopen* and nothing
    // else, so no part of the app below waits on it.
    let live = true
    void registerShell(navigator.serviceWorker).then(async (state) => {
      if (!live) return
      const version = await shellVersion(navigator.serviceWorker)
      if (live) setShell({ ...state, version })
    })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    const worker = new Worker(new URL('../workers/db.worker.ts', import.meta.url), {
      type: 'module',
    })
    workerRef.current = worker

    worker.onmessage = (event: MessageEvent<Response>) => {
      const message = event.data
      switch (message.type) {
        case 'progress':
          setProgress(message.progress)
          break
        case 'status':
          setStorage(message.storage)
          setReady(message.ready)
          setSchemas({ local: message.localSchema, speaks: message.schema })
          // An unknown origin asserts nothing: the panels stay, because the
          // local copy they describe may still be there.
          if (message.storage === 'unknown') {
            setError(
              'Could not read local storage, so the state of any downloaded copy is unknown. ' +
                'Reload to try again; downloading will replace it.'
            )
            break
          }
          // Every panel below is derived from a local copy that may have just
          // stopped existing — "Clear local copy" and a failed re-download both
          // land here. Leaving stale timings, results and a benchmark on screen
          // next to a "Download data" button is the UI asserting something
          // false. The notice is restored rather than cleared when a copy *is*
          // present, because D-008 requires it to accompany the data even for a
          // visitor whose page never ran an import.
          setNotice(message.notice ?? '')
          setRevision(message.rev)
          setGenerated(message.generated)
          // The KEV overlay's own freshness, read back out of the copy — which
          // is what makes it honest offline and what makes two tabs agree
          // (M6). Cleared with everything else when the copy is gone.
          //
          // A *newer* catalog clears this tab's stale failure notice too:
          // another tab may have refreshed successfully since this one failed,
          // and "here is catalog 2026.08.09" followed by "last refresh failed"
          // describes the app rather than the data, which is exactly the
          // disagreement multi-tab support exists to remove.
          setKev((current) => {
            const next = message.kev
            if (next && (!current || next.fetched > current.fetched)) setKevError('')
            return next
          })
          // The hosted tier changes what "not ready" clears (D-084): with the
          // tier live, results on screen describe the same corpus served from
          // the origin, the workspace is not about to give way to a download
          // pitch, and the Worker re-posts `status` after every failed query —
          // so clearing here would wipe the canvas on any hosted-tier error.
          if (!message.ready && hostedRef.current?.ok !== true) {
            setTimings(null)
            setResult(null)
            setSearch(null)
            setConsoleResult(null)
            setBenchmark(null)
            setSync(null)
            setReportOutcome(null)
            detailRequest.current = null
            setDetailId(null)
            setDetail(undefined)
            // A workspace that lost its copy starts over: the landing view is
            // about to render, and the next ready copy deserves a fresh canvas.
            autoRan.current = false
          }
          break
        case 'hostedStatus': {
          const value = message.ok
            ? {
                ok: true,
                rev: message.rev ?? null,
                generated: message.generated ?? null,
                notice: message.notice ?? null,
                kev: message.kev ?? null,
              }
            : {
                ok: false,
                error: message.error ?? 'the hosted query tier is unavailable',
                rev: null,
                generated: null,
                notice: null,
                kev: null,
              }
          hostedRef.current = value
          setHosted(value)
          break
        }
        case 'environment':
          setEnvironment({ capabilities: message.capabilities, storage: message.storage })
          break
        case 'imported':
          setStorage('ready')
          setReady(true)
          importedThisRun.current = true
          setTimings(message.timings)
          setNotice(message.notice)
          // The local copy now answers, so any hosted-tier probe result is
          // stale — and must be dropped, not just shadowed. `tier` prefers the
          // local copy while it is ready, but if this copy is later cleared the
          // clearing guard reads `hostedRef` and a stale `{ok:true}` would keep
          // the deleted copy's report on screen under a hosted badge. Nulling
          // both here means a later clear re-probes from scratch (D-084).
          hostedRef.current = null
          setHosted(null)
          // The run that just happened reports where the reader is looking:
          // the data panel opens itself once, on the import that filled it.
          setPanels((current) => ({ ...current, data: true }))
          break
        case 'kev':
          // Not an error, even when it failed: the corpus operation that
          // triggered this succeeded, and the previous catalog is still
          // answering. So it is its own note beside a copy that works (M6).
          setKev(message.kev)
          setKevError(message.error ?? '')
          break
        case 'synced':
          setSync(message.outcome)
          // `synced` is itself proof of the new watermark. Do not make the UI
          // depend on the follow-up storage discovery succeeding before it can
          // report the revision the Worker just committed.
          setRevision(message.outcome.to)
          break
        case 'result':
          setRunSeq((seq) => seq + 1)
          setStopping(false)
          if (message.kind === 'console') setConsoleResult(message.result)
          else if (message.kind === 'report') {
            if (message.report) {
              setReportOutcome({
                result: message.result,
                matches: message.matches ?? null,
                unmatched: message.unmatched ?? [],
                report: message.report,
              })
              setView('report')
              setHiddenSeries(new Set())
              setSeriesLabels({})
              populateSql(message.result)
            }
          } else if (message.kind === 'search') {
            setSearch({
              result: message.result,
              matches: message.matches ?? null,
              unmatched: message.unmatched ?? [],
              groupBy: message.groupBy ?? null,
              state: message.state ?? 'published',
            })
            setView('records')
            populateSql(message.result)
          } else setResult(message.result)
          break
        case 'detail':
          // The reader may close a detail panel, or open another record, while
          // SQLite is still answering. A late reply must not reopen the panel
          // they dismissed or replace the newer record.
          if (detailRequest.current !== message.cveId) break
          detailRequest.current = null
          setRunSeq((seq) => seq + 1)
          setDetailId(message.cveId)
          setDetail(message.detail)
          break
        case 'toolResult': {
          // Resolved by id rather than by arrival order: a turn can issue
          // several calls, and the loop has to pair each answer with the call
          // it answers.
          toolWaiters.current.get(message.id)?.(message.outcome)
          setRunSeq((seq) => seq + 1)
          // A chat answer *is* a report: the model's aggregate lands on the
          // canvas and in the filter drawer exactly as if the reader had built
          // it, which is what makes it editable rather than final (UI revamp).
          // The chat panel still renders its own inline copy of every step.
          const outcome = message.outcome
          if (outcome.kind === 'aggregate') {
            setReport(outcome.report)
            setReportOutcome({
              result: outcome.result,
              matches: outcome.matches,
              unmatched: outcome.unmatched,
              report: outcome.report,
            })
            setView('report')
            setHiddenSeries(new Set())
            setSeriesLabels({})
            populateSql(outcome.result)
          } else if (outcome.kind === 'records') {
            setSearch({
              result: outcome.result,
              matches: outcome.matches,
              unmatched: outcome.unmatched,
              groupBy: null,
              state: outcome.report.filters.state ?? 'published',
            })
            setReport((current) => ({ ...current, filters: outcome.report.filters }))
            if (outcome.report.sort) setSort(outcome.report.sort)
            setGroupBy('')
            setView('records')
            populateSql(outcome.result)
          } else if (outcome.kind === 'sql') {
            populateSql(outcome.result)
          }
          break
        }
        case 'exportChunk':
          exportParts.current.push(new Blob([message.text]))
          break
        case 'exported': {
          const blob = new Blob(exportParts.current, { type: message.mime })
          exportParts.current = []
          download(blob, message.filename)
          setExportNote(
            `${message.records.toLocaleString()} rows written to ${message.filename} in ` +
              `${(message.ms / 1000).toFixed(1)} s.` +
              (message.truncated
                ? ` This is the cap, not the whole match set — ${(message.matches ?? 0).toLocaleString()} records matched.`
                : '')
          )
          break
        }
        case 'cancelled':
          // Not an error and not shown as one: the user asked for it, the
          // database is untouched, and the surface that was running says so.
          setRunSeq((seq) => seq + 1)
          setStopping(false)
          setCancelled({ kind: message.kind, ms: message.ms })
          // One cancellation flag means one running query (lib/cancel.ts), so
          // the page-level Cancel button and the chat panel's Stop are the same
          // request. The Worker still posts a `toolResult` for the call, which
          // is what settles the loop's promise; this is what stops it issuing
          // the next one.
          if (message.kind === 'tool') chatAbort.current?.abort()
          if (message.kind === 'export') exportParts.current = []
          if (message.kind === 'detail') {
            detailRequest.current = null
            setDetailId(null)
            setDetail(undefined)
          }
          break
        case 'bench':
          setBenchmark({ results: message.results, wasmHeapBytes: message.wasmHeapBytes })
          break
        case 'error':
          setRunSeq((seq) => seq + 1)
          setStopping(false)
          // A refusal from the console belongs beside the console, not in the
          // page-level banner: it is the answer to what the user just typed.
          if (message.kind === 'console') {
            setConsoleError(message.message)
            setConsoleResult(null)
            break
          }
          if (message.kind === 'export') exportParts.current = []
          if (message.kind === 'detail') {
            detailRequest.current = null
            setDetailId(null)
            setDetail(undefined)
          }
          setError(message.message)
          // The Import panel describes a run that succeeded. After a failed
          // one it is describing a different origin than the one on disk —
          // most sharply in "OPFS footprint", which omits the staged file the
          // failure left behind and can understate storage several-fold. The
          // query results below it stay: they came from the live copy, which a
          // failed staged download does not touch (D-061).
          if (!importedThisRun.current) setTimings(null)
          break
      }
    }

    // A Worker that fails to *load* — a chunk that 404s, a module the browser
    // refuses (RE-012's MIME type), an offline reopen whose shell cache is
    // missing something — posts no message and throws nowhere this code can see
    // it. Without this the app sits at "pending" forever with nothing on screen,
    // which is precisely the silence D-052 forbids for anything that can fail.
    worker.onerror = (event) => {
      const detail = event instanceof ErrorEvent && event.message ? `: ${event.message}` : ''
      setError(
        `The database worker could not start${detail}. Reload the page; if you are offline, ` +
          'reconnect once so the app can fetch the part it is missing.'
      )
      setStorage('unknown')
      // A dead Worker answers no tool call, so a chat turn waiting on one would
      // wait forever. Ending the conversation is the honest outcome — the
      // failure is on screen, and the turn stops rather than spinning.
      chatAbort.current?.abort()
    }
    // And a module the worker itself fails to import rejects here rather than
    // firing `onerror` in some browsers, which is the same silence.
    worker.onmessageerror = () => {
      setError('The database worker sent a message this page could not read. Reload the page.')
    }

    // The cancellation flag first: it has to be in the Worker's hands before
    // any query can be started, and `status` is the first thing that runs.
    if (cancelFlag) {
      worker.postMessage({
        type: 'control',
        cancel: cancelFlag,
        options: importOptions(location.search),
      } satisfies Request)
    }
    worker.postMessage({
      type: 'status',
      options: importOptions(location.search),
    } satisfies Request)
    return () => worker.terminate()
  }, [cancelFlag, populateSql])

  useEffect(() => {
    // A minute is far finer than the units this reports in (hours, then days),
    // so the label is never more than a minute behind and the timer costs
    // nothing. It also means the indicator crosses into "stale" on its own,
    // rather than the next time the user happens to click something.
    const tick = () => setNow(Date.now())
    tick()
    const timer = setInterval(tick, 60_000)
    return () => clearInterval(timer)
  }, [])

  /**
   * Saved reports and history, the chat consent flag, the chat column's
   * initial state, and the permalink in the fragment.
   *
   * All are read once, on mount, and the stored ones are stranger-supplied in
   * the sense that matters: `localStorage` was written by some build of this
   * app and the fragment was written by whoever sent the link. They go through
   * the same validation (`lib/saved.ts`, `fromFragment`), which is what makes
   * a hostile link and a stale entry fail the same way (D-069).
   */
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect --
       These reads are of things that do not exist during render. This page is a
       static export, so it is prerendered at build time: reading `localStorage`,
       `location.hash` or a media query in the render body would produce markup
       the server could not have produced, which is a hydration mismatch rather
       than a performance question. Once, on mount, is the only correct time —
       the same reasoning as the `now` sample above. */
    const local = safeStorage()
    const loaded = loadStore(local)
    storeRef.current = loaded
    setStore(loaded)
    setStorable(local !== null)
    // The chat tier's disclosure (D-057). Remembered across reloads — the
    // *conversation* is what is session-only, not the decision to allow one.
    setConsented(hasConsent(local))
    // Chat is the workspace's primary interaction, so it opens by itself where
    // there is room for it; on a phone it would cover the canvas, so it waits
    // to be asked for.
    setChatOpen(window.matchMedia('(min-width: 68rem)').matches)
    if (!location.hash || location.hash === '#') return
    const parsed = fromFragment(location.hash)
    if (parsed.ok) {
      setReport(parsed.report)
      pendingReport.current = parsed.report
      setLinkPending(true)
    } else {
      setLinkError(`That report link could not be opened: ${parsed.error}`)
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [])

  /**
   * Apply a change to the saved-report store, persist it, and report whether it
   * stuck. A write that silently failed would leave a report that looks saved
   * and is gone on reload (D-072).
   */
  const updateStore = useCallback((change: (current: ReportStore) => ReportStore) => {
    const next = change(storeRef.current)
    storeRef.current = next
    setStore(next)
    setStorable(writeStore(safeStorage(), next))
  }, [])

  /**
   * Which tier answers queries right now (D-084). A ready local copy always
   * wins — the hosted tier is the *absence* of one — and null means neither:
   * no copy, and the hosted probe failed or is off, which is where the
   * download pitch stands. Declared above the callbacks that branch on it.
   */
  const tier: 'local' | 'hosted' | null = ready ? 'local' : hosted?.ok ? 'hosted' : null
  const canQuery = tier !== null

  const send = useCallback((request: Request) => {
    setError('')
    setCancelled(null)
    setStopping(false)
    // A new run's panels describe that run. Anything a previous one left on
    // screen is about to be either replaced or invalidated.
    if (request.type === 'import') {
      importedThisRun.current = false
      setSync(null)
    }
    if (request.type === 'sync') setSync(null)
    if (request.type === 'console') {
      setConsoleError('')
      setConsoleResult(null)
    }
    if (request.type === 'search') setSearch(null)
    if (request.type === 'report') setReportOutcome(null)
    if (request.type === 'detail') {
      detailRequest.current = request.cveId
      setDetail(undefined)
    }
    if (request.type === 'export') {
      // Any bytes from an abandoned export must not be prepended to this one.
      exportParts.current = []
      setExportNote('')
    }
    workerRef.current?.postMessage(request)
  }, [])

  /**
   * Run a report, and record it in the history.
   *
   * The history entry is written when the report is *run* rather than when it
   * returns: what the user did is the thing worth remembering, and a report
   * that took twenty seconds and was cancelled is still a report they built.
   */
  const runReport = useCallback(
    (definition: Report) => {
      setReport(definition)
      setView('report')
      setLinkError('')
      send({ type: 'report', request: { report: definition, count: true } })
      const at = Date.now()
      updateStore((current) => recordRecent(current, definition, at))
    },
    [send, updateStore]
  )

  /**
   * Open a report on the canvas and run it — or queue it, if there is nothing
   * to run it against yet.
   *
   * The queueing arm is not hypothetical: the Saved panel renders from
   * `localStorage` the instant the page mounts, while the Worker is still
   * reopening the copy — a fast click lands in that window.
   */
  const openReport = useCallback(
    (definition: Report) => {
      setReport(definition)
      setView('report')
      setLinkError('')
      if (canQuery) {
        runReport(definition)
        return
      }
      pendingReport.current = definition
      setLinkPending(true)
    },
    [canQuery, runReport]
  )

  useEffect(() => {
    // A link opened on a browser with no local copy waits for one rather than
    // failing: the definition is complete, it is only the corpus that is
    // missing. Runs exactly once — the ref is cleared as it fires.
    if (!canQuery || !pendingReport.current) return
    const pending = pendingReport.current
    pendingReport.current = null
    setLinkPending(false)
    autoRan.current = true
    runReport(pending)
  }, [canQuery, runReport])

  /**
   * The default canvas (UI revamp): a workspace never opens empty. The most
   * recent report is the reader's own context resumed; with no history at all
   * it is CVE counts by severity over time — the founding question.
   *
   * Deliberately *after* the pending-report check: a permalink or a saved
   * report the reader explicitly opened always wins over the default.
   */
  useEffect(() => {
    if (!canQuery || autoRan.current || pendingReport.current) return
    autoRan.current = true
    const recent = storeRef.current.recent[0]?.report
    runReport(recent ?? defaultReport())
  }, [canQuery, runReport])

  /**
   * Stop the running query.
   *
   * A write to shared memory, not a message: the Worker is inside SQLite and
   * will not read its message queue until the query it is running has finished,
   * which is the whole problem (lib/cancel.ts).
   */
  const cancel = useCallback(() => {
    setStopping(true)
    requestCancel(cancelFlag)
  }, [cancelFlag])

  /**
   * Run one validated tool call in the Worker and wait for its outcome.
   *
   * The bridge between the loop (which awaits) and the Worker (which posts).
   * Never rejects: the Worker turns every failure into a `refused` outcome and
   * answers even a cancelled call, so the only way this hangs is a Worker that
   * has died — which `worker.onerror` reports separately.
   */
  const runToolCall = useCallback(
    (id: string, call: ToolCall, signal: AbortSignal) =>
      new Promise<ToolOutcome>((resolve, reject) => {
        // The Worker answers every tool call, including a cancelled one — but
        // a Worker that has *died* answers nothing, and the loop is sitting on
        // this promise with its own abort check on the far side of the await.
        // Without this, Stop would not stop it: the button is pressed, the
        // signal fires, and nothing is listening.
        const settle = () => {
          toolWaiters.current.delete(id)
          signal.removeEventListener('abort', onAbort)
        }
        const onAbort = () => {
          settle()
          reject(new Error('stopped'))
        }
        if (signal.aborted) return onAbort()
        signal.addEventListener('abort', onAbort, { once: true })
        toolWaiters.current.set(id, (outcome) => {
          settle()
          resolve(outcome)
        })
        send({ type: 'tool', id, call })
      }),
    [send]
  )

  const askChat = useCallback(
    (question: string) => {
      const controller = new AbortController()
      chatAbort.current = controller
      setChatRunning(true)
      const id = `turn-${Date.now()}-${chatHistory.current.length}`
      void runChatTurn(
        question,
        {
          stream: (messages, onEvent) =>
            streamChat({ messages, signal: controller.signal, onEvent }),
          runTool: (toolId, call) => runToolCall(toolId, call, controller.signal),
          onUpdate: (turn) =>
            setChatTurns((current) => {
              const at = current.findIndex((entry) => entry.id === turn.id)
              if (at === -1) return [...current, turn]
              const next = [...current]
              next[at] = turn
              return next
            }),
          signal: controller.signal,
          history: chatHistory.current,
          system: systemPrompt(),
          // The canvas as it stands when the question is asked, so "change the
          // date range" edits the chart on screen rather than starting blind
          // (M9). Only once something has actually run — a fresh workspace has
          // no state worth describing.
          context:
            reportOutcome || search
              ? canvasContext(
                  report,
                  view,
                  view === 'report' ? (reportOutcome?.matches ?? null) : (search?.matches ?? null)
                )
              : undefined,
        },
        id
      ).then((result) => {
        chatHistory.current = result.messages
        finish()
      }, finish)

      // Both arms, because a rejection here would leave `chatRunning` true for
      // the rest of the session: a Stop button that stops nothing and an Ask
      // button that never re-enables. `runChatTurn` is written not to reject,
      // and this is what makes that a property rather than a hope.
      function finish() {
        setChatRunning(false)
        chatAbort.current = null
        // Anything still waiting belongs to a call the loop has stopped caring
        // about. Left in the map they would keep a closure alive for the rest
        // of the session.
        toolWaiters.current.clear()
      }
    },
    [runToolCall, report, view, reportOutcome, search]
  )

  const stopChat = useCallback(() => {
    chatAbort.current?.abort()
    // The fetch and the query are two different things to stop: the model may
    // be streaming, or a tool may be inside SQLite, and only shared memory
    // reaches the second (lib/cancel.ts).
    requestCancel(cancelFlag)
  }, [cancelFlag])

  /**
   * Run the current predicates as a record search — the filter drawer's
   * "List records", and the canvas's records view.
   */
  const runSearch = useCallback(() => {
    setView('records')
    send({
      type: 'search',
      request: {
        filters: report.filters,
        groupBy: groupBy === '' ? null : groupBy,
        sort,
        limit: PAGE_ROWS,
        // The count is a second query — over the whole corpus with no filters
        // it is a scan — so it is asked for deliberately. It is worth it: "100
        // shown" of an unknown total is not an answer.
        count: true,
      },
    })
  }, [report.filters, groupBy, sort, send])

  /**
   * Hand a chat record search to the records view, which is the surface that
   * renders records — not the report canvas, where the same predicates would
   * render as a year-by-year count (lib/tools.ts's `searchReport`).
   */
  const openSearch = useCallback(
    (definition: Report) => {
      setReport((current) => ({ ...current, filters: definition.filters }))
      if (definition.sort) setSort(definition.sort)
      setGroupBy('')
      setView('records')
      send({
        type: 'search',
        request: {
          filters: definition.filters,
          sort: definition.sort,
          limit: PAGE_ROWS,
          count: true,
        },
      })
    },
    [send]
  )

  const openRecord = useCallback(
    (cveId: string) => {
      setView('records')
      setDetailId(cveId)
      send({ type: 'detail', cveId })
    },
    [send]
  )

  const busy = progress.phase !== 'idle' && progress.phase !== 'ready' && progress.phase !== 'error'
  /**
   * The copy the status strip describes: the local one when it is live, the
   * server's when the hosted tier is answering. One set of variables so the
   * strip, the freshness line and the KEV line cannot mix tiers.
   */
  const effGenerated = tier === 'hosted' ? (hosted?.generated ?? null) : generated
  const effRevision = tier === 'hosted' ? (hosted?.rev ?? null) : revision
  const effKev = tier === 'hosted' ? (hosted?.kev ?? null) : kev
  const freshness = canQuery && now !== null ? describeFreshness(effGenerated, now) : null
  // The catalog's *release* age, not the fetch's: what matters is how old
  // CISA's list is, and a browser that re-fetched an unchanged catalog this
  // morning has not made it newer. Both numbers are on screen, so neither is
  // standing in for the other (M6).
  // …and against KEV's own threshold, not the corpus's: CISA is *business*-daily,
  // so a Friday catalog would be flagged every weekend by a number justified by
  // a pipeline that runs every day (M6).
  const kevFreshness =
    effKev && now !== null ? describeFreshness(effKev.releasedAt, now, KEV_STALE_AFTER_MS) : null
  // Read once on mount: the warning below has to be on screen *before* the
  // button is clicked, and D-061 accepts this path's destroy-then-download
  // behaviour only because it is diagnostic — an ordinary "Re-download data"
  // label hides that a crafted link costs the local copy.
  const vfs = useSyncExternalStore(
    () => () => undefined,
    // The *resolved* VFS, through the same fallback the request uses — warning
    // about `?vfs=garbage` would be warning about a run that takes the ordinary
    // staged path.
    () => importOptions(location.search).vfs ?? DEFAULT_VFS,
    () => DEFAULT_VFS
  )

  /**
   * The gate has fired, so the app cannot do the thing it exists to do.
   *
   * Only ever true once the Worker has *answered*: `environment === null` means
   * "not asked yet", and treating that as unsupported would disable the button
   * on every first paint.
   */
  const blocked = environment !== null && !environment.capabilities.supported

  /** Whether `?remote=0` left the hosted tier reachable at all (D-084). */
  const remoteEnabled = useSyncExternalStore(
    () => () => undefined,
    () => importOptions(location.search).remote !== false,
    () => true
  )

  /**
   * Ask the Worker to probe the hosted tier, once per "no local copy" state.
   *
   * Keyed on `hosted === null` so the probe is not re-fired by the `status`
   * re-posts that follow every operation — and not retried in a loop when the
   * tier is down, which would poll the origin from every open tab. Reload is
   * the retry, exactly as it is for a failed status.
   */
  useEffect(() => {
    // Only when the local check is *conclusive* that there is no usable copy:
    // `empty` (nothing here) or `obsolete` (a copy this build cannot read).
    // Deliberately NOT `unknown` — that means "could not read local storage",
    // an error state whose banner asks the user to reload and whose local copy
    // may still be there; firing the probe there would also clear that banner
    // (`send` resets the error), which is the opposite of what it is for.
    if (!remoteEnabled || hosted !== null) return
    if (storage !== 'empty' && storage !== 'obsolete') return
    /* eslint-disable-next-line react-hooks/set-state-in-effect --
       A side effect on a state transition (a conclusive no-copy result, tier
       not yet probed), not a value derivable during render: it posts a message
       to the Worker, whose async reply drives `hosted`. */
    send({ type: 'hosted', options: importOptions(location.search) })
  }, [storage, hosted, remoteEnabled, send])

  const downloadNow = useCallback(() => {
    // Asked from the click, because Firefox prompts and a prompt outside a
    // user gesture is a prompt that is dismissed. The *answer* is what gets
    // reported — a request that "succeeded" and was refused looks identical
    // from the call site otherwise.
    void requestPersistence(navigator.storage).then(setPersisted)
    send({ type: 'import', options: importOptions(location.search) })
  }, [send])

  const togglePanel = useCallback((panel: keyof Panels) => {
    setPanels((current) => {
      const next = { ...current, [panel]: !current[panel] }
      if (panel === 'sql') sqlOpen.current = next.sql
      return next
    })
  }, [])

  const diagnostics = (
    <Diagnostics
      storage={storage}
      revision={revision}
      schemas={schemas}
      timings={timings}
      ready={ready}
      kev={kev}
      kevError={kevError}
      generated={generated}
      sync={sync}
      environment={environment}
      persisted={persisted}
      shell={shell}
      onOpen={() => {
        // Re-probed on open rather than kept live: storage numbers move, and a
        // panel showing what was true at page load sends someone chasing a
        // number that already changed.
        send({ type: 'probe' })
        const controlling = Boolean(navigator.serviceWorker?.controller)
        void shellVersion(navigator.serviceWorker).then((version) =>
          setShell((current) => ({ ...current, version, controlling }))
        )
      }}
    />
  )

  const banners = (
    <>
      {/* The support gate (D-016, M5). Above every control, because the point
          is that it arrives *before* a download rather than tens of seconds
          into one — and there is no telemetry (D-009), so this sentence is the
          entire support channel for a browser that lands here. */}
      {environment && !environment.capabilities.supported && (
        <p className="error" data-gate="unsupported">
          {gateMessage(environment.capabilities)}
        </p>
      )}
      {environment && environment.capabilities.degraded.length > 0 && (
        <p className="stale" data-gate="degraded">
          This browser is missing {environment.capabilities.degraded.join(', ')}. The app works; the
          parts that depend on it do not.
        </p>
      )}

      {/* A schema bump, announced (M3). The local database is a rebuildable
          cache (D-013) and there is no in-place migration, so the honest thing
          is to say what happened, keep the bytes until a new download replaces
          them, and name the action. Silence here would look identical to a
          first visit — the state a user would meet after every schema change
          without this. */}
      {storage === 'obsolete' && (
        <p className="error" data-obsolete={schemas.local ?? ''}>
          The data format changed. Your local copy is schema {schemas.local ?? '?'} and this version
          of the app reads schema {schemas.speaks}, and there is no in-place upgrade — the local
          database is a cache that can always be rebuilt from the origin. Download the corpus again
          to replace it; the old copy stays until the new one is ready.
        </p>
      )}

      {/* The page-level banner. `data-error` distinguishes it from the other
          things styled as errors — the schema announcement above, an unmatched
          filter name below — which are statements about state rather than
          reports of a failure. */}
      {error && (
        <p className="error" data-error="1">
          {error}
        </p>
      )}

      {/* Both link banners are page-level rather than inside any panel: a link
          that arrives before there is a local copy renders the landing view,
          so a message inside the workspace would be a message nobody sees. */}
      {linkError && (
        <p className="error" data-link-error="1">
          {linkError}
        </p>
      )}
      {linkPending && !canQuery && (
        <p className="stale" data-link-pending="1">
          A report is waiting for a local copy of the corpus. Download it and the report will run by
          itself — a permalink carries its whole definition in the URL fragment, which is never sent
          to the server.
        </p>
      )}
    </>
  )

  // The hosted probe is only in flight for a conclusive no-copy result, and
  // only until it answers — this is the render's version of the effect's gate,
  // so `unknown` never waits behind a probe it will not fire (RE: staged
  // "unknown, not deleted").
  const probingHosted =
    remoteEnabled && hosted === null && (storage === 'empty' || storage === 'obsolete')

  return (
    <main data-status={storage} data-tier={tier ?? undefined}>
      {storage === 'pending' || probingHosted ? (
        <>
          {/* No landing and no workspace until the Worker has said which one
              this visit is — first the local check, then (with no local copy)
              the hosted tier probe (D-084). Rendering the download pitch here
              would flash it at every visitor the workspace is about to serve.
              The banners stay — the capability gate must not wait. The
              placeholder's own appearance is delayed in CSS, so a fast answer
              shows nothing at all. */}
          <header className="topbar">
            <div className="brand">
              <h1>CVE Explorer</h1>
              <span className="domain">cve.meenan.dev</span>
            </div>
          </header>
          {banners}
          <p className="muted checking" data-checking="1">
            Checking this browser for a local copy of the corpus…
          </p>
        </>
      ) : !canQuery ? (
        <>
          {/* Neither tier can answer: no local copy, and the hosted tier is
              off (`?remote=0`) or unreachable. This is where the old landing
              gate stood, and it keeps the gate's job — explain, then offer
              the one action that changes the situation (D-084). */}
          <header className="topbar">
            <div className="brand">
              <h1>CVE Explorer</h1>
              <span className="domain">cve.meenan.dev</span>
            </div>
          </header>
          {banners}
          <Landing
            onDownload={downloadNow}
            disabled={busy || blocked}
            busy={busy}
            obsolete={storage === 'obsolete'}
            hostedError={remoteEnabled && hosted && !hosted.ok ? (hosted.error ?? null) : null}
            progress={
              busy ? (
                <ProgressBar
                  progress={progress}
                  cancelFlag={cancelFlag}
                  stopping={stopping}
                  onCancel={cancel}
                />
              ) : null
            }
          >
            {diagnostics}
          </Landing>
        </>
      ) : (
        <>
          <header className="topbar">
            <div className="brand">
              <h1>CVE Explorer</h1>
              <span className="domain">cve.meenan.dev</span>
            </div>
            <nav className="panel-toggles" aria-label="Workspace panels">
              <button
                type="button"
                className="quiet"
                aria-expanded={panels.filters}
                aria-controls="filters-panel"
                data-toggle="filters"
                onClick={() => togglePanel('filters')}
              >
                Filters
              </button>
              <button
                type="button"
                className="quiet"
                aria-expanded={panels.sql}
                aria-controls="sql-panel"
                data-toggle="sql"
                onClick={() => togglePanel('sql')}
              >
                SQL
              </button>
              <button
                type="button"
                className="quiet"
                aria-expanded={panels.data}
                aria-controls="data-panel"
                data-toggle="data"
                onClick={() => togglePanel('data')}
              >
                Data
              </button>
              <button
                type="button"
                className="quiet"
                aria-expanded={panels.saved}
                aria-controls="saved-panel"
                data-toggle="saved"
                onClick={() => togglePanel('saved')}
              >
                Saved
                {store.saved.length > 0 && (
                  <span className="tab-badge" aria-hidden="true">
                    {store.saved.length}
                  </span>
                )}
              </button>
              {tier === 'hosted' ? (
                /* The hosted tier's one upgrade action, where Sync stands on
                   the local tier (D-084): the same import the old landing CTA
                   started, named for what it changes. `data-download` is the
                   stable hook, as on the landing fallback. */
                <button
                  type="button"
                  onClick={downloadNow}
                  disabled={busy || blocked}
                  data-download="1"
                >
                  {busy
                    ? 'Downloading…'
                    : storage === 'obsolete'
                      ? 'Re-download for offline'
                      : 'Make available offline'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => send({ type: 'sync', options: importOptions(location.search) })}
                  disabled={!ready || busy || blocked}
                >
                  Sync
                </button>
              )}
              {/* A column, not a sixth panel: a question is usually *about*
                  what is on the canvas, and chat is the primary way in. */}
              <button
                type="button"
                data-chat-toggle={chatOpen ? 'open' : 'closed'}
                aria-expanded={chatOpen}
                onClick={() => setChatOpen((open) => !open)}
              >
                Chat
              </button>
            </nav>
          </header>

          {banners}

          {/* Both of these stay outside the panels: the revision a number came
              from and MITRE's notice attach to the *copy*, not to a view of it
              (D-008), so no panel state may take either off the screen. */}
          <div className="status-strip">
            {tier === 'hosted' ? (
              /* The per-tier disclosure D-084 owes: on this tier queries are
                 executed by the server, which is the opposite of the offline
                 tier's structural claim — so the strip says which tier is
                 answering, in the place the local tier states its revision. */
              <p className="muted" data-hosted="1" data-revision={effRevision ?? undefined}>
                Queries run on this site&rsquo;s server for now
                {effRevision !== null && ` (data revision ${effRevision})`} — sent same-origin, not
                stored. &ldquo;Make available offline&rdquo; moves everything into your browser.
              </p>
            ) : (
              revision !== null && (
                <p className="muted" data-revision={revision}>
                  Local copy at revision {revision}
                  {sync && syncSummary(sync)}
                </p>
              )
            )}

            {/* Staleness, from the data's own build stamp rather than from a
                comparison with the origin: `status` makes no network request,
                which is what lets a reopen work offline (D-048). So this says
                how old the data is — a fact — and prompts a check rather than
                asserting there is something newer to fetch. */}
            {freshness !== null && (
              <p
                className={freshness.stale ? 'stale' : 'muted'}
                data-freshness={freshness.stale ? 'stale' : 'current'}
                data-age-ms={Math.round(freshness.ageMs)}
              >
                Data as of <time dateTime={freshness.iso}>{localTime(freshness.iso)}</time> —{' '}
                {freshness.age}.
                {freshness.stale &&
                  ' The corpus is published daily, so this copy is behind unless the origin has ' +
                    'stopped publishing — Sync to find out.'}
              </p>
            )}

            {/* KEV's freshness is its own line, because it is a different
                dataset on a different cadence: CISA publishes about
                business-daily and the corpus daily, so one number for both
                would be wrong about whichever moved last. Read from the local
                copy like the line above, so it is honest offline and agrees
                across tabs (M6, D-076). The provenance is in the sentence:
                "per CISA, as of …" keeps this a statement about CISA's catalog
                rather than an endorsement by it. */}
            {(effKev !== null || kevError !== '') && (
              <p
                className={kevFreshness?.stale ? 'stale' : 'muted'}
                data-kev={effKev ? effKev.version : 'none'}
                data-kev-age-ms={kevFreshness ? Math.round(kevFreshness.ageMs) : undefined}
              >
                {effKev ? (
                  <>
                    CISA KEV catalog {effKev.version}, released{' '}
                    <time dateTime={effKev.released}>{localTime(effKev.released)}</time>
                    {kevFreshness && ` — ${kevFreshness.age}`}. {effKev.entries.toLocaleString()}{' '}
                    entries
                    {effKev.unmatched > 0 &&
                      `, ${effKev.unmatched.toLocaleString()} for CVEs this copy does not hold`}
                    .
                    {/* "Fetched by this browser" is a claim about the local
                        overlay; the hosted copy's stamp is the server's build
                        time, which the released line already bounds. */}
                    {tier === 'local' && (
                      <>
                        {' '}
                        Fetched by this browser{' '}
                        <time dateTime={new Date(effKev.fetched * 1000).toISOString()}>
                          {localTime(new Date(effKev.fetched * 1000).toISOString())}
                        </time>
                        .
                      </>
                    )}
                  </>
                ) : (
                  'No CISA KEV catalog in this copy yet.'
                )}
                {kevError !== '' && ` Last refresh failed: ${kevError}`}
              </p>
            )}
          </div>

          {busy && (
            <ProgressBar
              progress={progress}
              cancelFlag={cancelFlag}
              stopping={stopping}
              onCancel={cancel}
            />
          )}

          <div className="workspace" data-chat-open={chatOpen ? '1' : undefined}>
            {panels.filters && (
              <aside id="filters-panel" className="side-panel">
                <FiltersPanel
                  report={report}
                  onChange={setReport}
                  onRunReport={runReport}
                  onListRecords={runSearch}
                  groupBy={groupBy}
                  setGroupBy={setGroupBy}
                  sort={sort}
                  setSort={setSort}
                  disabled={busy}
                />
              </aside>
            )}

            <div className="canvas-col">
              <Canvas
                view={view}
                report={report}
                onChangeReport={setReport}
                onRun={runReport}
                reportOutcome={reportOutcome}
                searchOutcome={search}
                disabled={busy}
                run={runSeq}
                cancelledMs={
                  cancelled && (cancelled.kind === 'report' || cancelled.kind === 'search')
                    ? cancelled
                    : null
                }
                exportNote={exportNote}
                onExport={(format, kind, definition) =>
                  send({
                    type: 'export',
                    request: {
                      format,
                      kind,
                      report:
                        kind === 'records' && view === 'records'
                          ? reportFor({ filters: report.filters, sort })
                          : definition,
                      title:
                        kind === 'records' && view === 'records'
                          ? 'CVE records'
                          : definition.title?.trim() || 'CVE report',
                    },
                  })
                }
                onSave={(name) =>
                  updateStore((current) => saveNamed(current, name, report, Date.now()))
                }
                onOpenRecord={openRecord}
                detailId={detailId}
                detail={detail}
                onCloseDetail={() => {
                  detailRequest.current = null
                  setDetailId(null)
                  setDetail(undefined)
                }}
                hiddenSeries={hiddenSeries}
                onToggleSeries={(key) =>
                  setHiddenSeries((current) => {
                    const next = new Set(current)
                    if (next.has(key)) next.delete(key)
                    else next.add(key)
                    return next
                  })
                }
                seriesLabels={seriesLabels}
                onSeriesLabel={(key, label) =>
                  setSeriesLabels((current) => ({ ...current, [key]: label }))
                }
                dataAsOf={freshness ? freshness.iso.slice(0, 10) : null}
              />

              {panels.sql && (
                <section id="sql-panel" className="bottom-panel">
                  <Console
                    disabled={busy}
                    hosted={tier === 'hosted'}
                    onRun={(sql: string) => send({ type: 'console', sql })}
                    result={consoleResult}
                    run={runSeq}
                    error={consoleError}
                    cancelledMs={cancelled?.kind === 'console' ? cancelled.ms : null}
                    sql={sqlText}
                    onSql={setSqlText}
                  />
                </section>
              )}

              {panels.data && (
                <section id="data-panel" className="bottom-panel">
                  <DataPanel
                    ready={ready}
                    busy={busy}
                    blocked={blocked}
                    onDownload={downloadNow}
                    onRefreshKev={() => {
                      setKevError('')
                      send({ type: 'kev', options: importOptions(location.search) })
                    }}
                    onRunDemo={() => send({ type: 'query', sql: DEMO_QUERY })}
                    onBench={() => {
                      // Drop the previous table before re-running: the Worker
                      // reports no progress for this, so a stale result on
                      // screen is indistinguishable from a finished one.
                      setBenchmark(null)
                      send({ type: 'bench' })
                    }}
                    onReset={() => send({ type: 'reset' })}
                    timings={timings}
                    benchmark={benchmark}
                    result={result}
                    cancelledDemoMs={cancelled?.kind === 'demo' ? cancelled.ms : null}
                    vfsWarning={vfs !== DEFAULT_VFS ? vfs : null}
                  >
                    {diagnostics}
                  </DataPanel>
                </section>
              )}

              {panels.saved && (
                <section id="saved-panel" className="bottom-panel">
                  <SavedTab
                    store={store}
                    storable={storable}
                    onOpen={openReport}
                    onRemove={(id) => updateStore((current) => removeSaved(current, id))}
                    onClearRecent={() => updateStore((current) => clearRecent(current))}
                  />
                </section>
              )}
            </div>

            <ChatPanel
              open={chatOpen}
              turns={chatTurns}
              running={chatRunning}
              ready={canQuery}
              hostedTier={tier === 'hosted'}
              consented={consented}
              consentStorable={storable}
              onConsent={(accepted) => {
                setConsented(accepted)
                setConsent(safeStorage(), accepted)
                // Turning it back off also drops the conversation, because
                // leaving it on screen after the tier is off would suggest it
                // is still live.
                if (!accepted) {
                  chatAbort.current?.abort()
                  setChatTurns([])
                  chatHistory.current = []
                }
              }}
              onAsk={askChat}
              onStop={stopChat}
              onClose={() => setChatOpen(false)}
              onOpenReport={openReport}
              onOpenSearch={openSearch}
              onOpenRecord={openRecord}
            />
          </div>
        </>
      )}

      {/* D-008: MITRE's notice accompanies the data whichever copy is
          answering — the local one's meta, or the hosted copy's. */}
      {(notice || (tier === 'hosted' && hosted?.notice)) && (
        <footer className="notice">{notice || hosted?.notice}</footer>
      )}
    </main>
  )
}

/**
 * A search request as a report definition, for the export path.
 *
 * An export takes a `Report` because that is the shared primitive (D-069) and
 * because the Worker re-validates it before any of it reaches SQL. A record
 * export uses only the filters and the sort; `rows` is filled with a valid
 * dimension because the definition has to be a whole one, not a partial.
 */
function reportFor(request: Pick<SearchRequest, 'filters' | 'sort'>): Report {
  return {
    v: REPORT_VERSION,
    // Round-tripped through the draft conversions so an exported set is
    // provably the same predicate set the form describes.
    filters: draftToFilters(filtersToDraft(request.filters)),
    rows: 'year',
    series: null,
    chart: 'table',
    sort: request.sort,
  }
}

/**
 * Hand a finished export to the browser.
 *
 * An object URL and a synthetic click, revoked immediately after: the blob is a
 * local file this page produced, it never touches the network, and the name is
 * one `exportFilename` reduced to characters a filesystem cannot misread.
 */
function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // A revoke on the next turn rather than immediately: Safari has historically
  // needed the URL to outlive the click that started the download.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/**
 * `localStorage`, or null where it is not usable.
 *
 * Touching it can throw outright — a browser with storage blocked for this
 * origin does exactly that — so the access is guarded rather than assumed, and
 * the UI is told, because a report that appears to save and is gone on reload
 * is worse than one that says it cannot be saved.
 */
function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/**
 * What a catch-up did, in the terms a user asked the question in.
 *
 * "N new CVEs since your last sync" is the number this whole feature exists
 * for, so it leads: `inserts` are records this copy did not hold, and the
 * remainder of `upserts` are revisions of records it did. Reporting only the
 * total would answer "something changed" when the question is "what is new".
 */
function syncSummary(sync: SyncOutcome): string {
  if (sync.applied === 0) return ' — already current at the last check.'
  const revised = sync.upserts - sync.inserts
  return (
    ` — ${count(sync.applied, 'update')} applied: ` +
    `${count(sync.inserts, 'new CVE')}, ` +
    `${revised.toLocaleString()} records revised, ` +
    `${sync.deletes.toLocaleString()} withdrawn, in ${(sync.ms / 1000).toFixed(1)} s.`
  )
}

function count(value: number, noun: string): string {
  return `${value.toLocaleString()} ${noun}${value === 1 ? '' : 's'}`
}

/**
 * The build stamp in the reader's own locale and zone. The machine-readable
 * form stays in the `datetime` attribute, which is where a test reads it —
 * asserting on a locale string would be asserting on the test runner's zone.
 */
function localTime(iso: string): string {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString()
}
