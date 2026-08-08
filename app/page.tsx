'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { gateMessage, SUPPORT_FLOOR, type CapabilityReport } from '@/lib/capabilities'
import { newCancelFlag, requestCancel } from '@/lib/cancel'
import { NO_SHELL, registerShell, shellVersion, type ShellState } from '@/lib/shell'
import { draftToFilters, filtersToDraft } from '@/lib/draft'
import { describeFreshness, KEV_STALE_AFTER_MS } from '@/lib/freshness'
import type { ExportFormat } from '@/lib/export'
import type { KevStatus } from '@/lib/kev'
import { DEFAULT_CACHE_MIB, DEFAULT_CONCURRENCY, DEFAULT_VFS, SCHEMA_VERSION } from '@/lib/protocol'
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
} from '@/lib/protocol'
import { emptyReport, fromFragment, REPORT_VERSION, type Report } from '@/lib/report'
import {
  bytes as formatBytes,
  persistenceMessage,
  requestPersistence,
  type StorageReport,
} from '@/lib/storage'
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

import { Console } from './console'
import { Explore, type SearchOutcome } from './explore'
import { ReportTab, type ReportOutcome } from './report-tab'
import { SavedTab } from './saved'
import { Tabs, TabPanel, type TabSpec } from './tabs'

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

type TabId = 'data' | 'explore' | 'report' | 'saved' | 'sql'

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
   * local copy", and "I could not find out", and the button reads "Download
   * data" in all three. The first is invisible to a user but silently breaks
   * tests, which act on the pre-status render. The third is worse — clearing
   * the panels and inviting a download implies the copy is gone when it may
   * simply be unreadable this instant (D-061).
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

  // --- M4 ---------------------------------------------------------------
  const [tab, setTab] = useState<TabId>('data')
  /** The report definition the builder is editing. One object, three consumers (D-069). */
  const [report, setReport] = useState<Report>(() => emptyReport())
  const [reportOutcome, setReportOutcome] = useState<ReportOutcome | null>(null)
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
  // Convert each transient message string to a Blob immediately. Keeping the
  // strings themselves in this array would retain the entire export on the JS
  // heap and then duplicate it when the final Blob is constructed; Blob parts
  // can instead be backed or spilled by the browser and are composed without
  // re-serializing their contents.
  const exportParts = useRef<Blob[]>([])
  /**
   * A report waiting for a database.
   *
   * Two things put one here: a URL fragment read on mount, and a saved report
   * opened before the Worker has finished reopening the copy — which is a real
   * window, because the Saved tab is readable from `localStorage` immediately
   * and the corpus takes seconds (D-049). Both need the same answer: hold the
   * definition, run it the moment a copy exists, and forget it if none ever
   * does. Without this the click silently does nothing.
   */
  const pendingReport = useRef<Report | null>(null)
  const [linkError, setLinkError] = useState('')
  /**
   * A report is waiting on a corpus.
   *
   * Rendered rather than left silent: someone who followed a report link, or
   * opened a saved report, onto a browser with no readable copy lands on the
   * Data tab with the Report tab disabled — and without this the app looks like
   * it ignored the click.
   */
  const [linkPending, setLinkPending] = useState(false)

  /**
   * The shared cancellation flag (lib/cancel.ts). Created once here, because
   * the page owns the button; null on a browser with no `SharedArrayBuffer`,
   * where the UI says so rather than offering a Cancel that does nothing.
   *
   * `useState` with an initializer rather than `useRef`, so the render that
   * decides whether to offer Cancel sees it.
   */
  const [cancelFlag] = useState<Int32Array | null>(() => newCancelFlag())

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
          if (!message.ready) {
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
          }
          break
        case 'environment':
          setEnvironment({ capabilities: message.capabilities, storage: message.storage })
          break
        case 'imported':
          setStorage('ready')
          setReady(true)
          importedThisRun.current = true
          setTimings(message.timings)
          setNotice(message.notice)
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
            }
          } else if (message.kind === 'search') {
            setSearch({
              result: message.result,
              matches: message.matches ?? null,
              unmatched: message.unmatched ?? [],
              groupBy: message.groupBy ?? null,
              state: message.state ?? 'published',
            })
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
  }, [cancelFlag])

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
   * Saved reports and history, and the permalink in the fragment.
   *
   * Both are read once, on mount, and both are stranger-supplied in the sense
   * that matters: `localStorage` was written by some build of this app and the
   * fragment was written by whoever sent the link. They go through the same
   * validation (`lib/saved.ts`, `fromFragment`), which is what makes a hostile
   * link and a stale entry fail the same way (D-069).
   */
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect --
       Both reads are of things that do not exist during render. This page is a
       static export, so it is prerendered at build time: reading `localStorage`
       or `location.hash` in the render body would produce markup the server
       could not have produced, which is a hydration mismatch rather than a
       performance question. Once, on mount, is the only correct time — the same
       reasoning as the `now` sample above. */
    const local = safeStorage()
    const loaded = loadStore(local)
    storeRef.current = loaded
    setStore(loaded)
    setStorable(local !== null)
    if (!location.hash || location.hash === '#') return
    const parsed = fromFragment(location.hash)
    if (parsed.ok) {
      setReport(parsed.report)
      pendingReport.current = parsed.report
      setLinkPending(true)
      setTab('report')
    } else {
      setLinkError(`That report link could not be opened: ${parsed.error}`)
      setTab('report')
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
      setLinkError('')
      send({ type: 'report', request: { report: definition, count: true } })
      const at = Date.now()
      updateStore((current) => recordRecent(current, definition, at))
    },
    [send, updateStore]
  )

  /**
   * Open a report in the builder and run it — or queue it, if there is nothing
   * to run it against yet.
   *
   * The queueing arm is not hypothetical: the Saved tab renders from
   * `localStorage` the instant the page mounts, while the Worker is still
   * reopening the database, so a fast click lands in that window.
   */
  const openReport = useCallback(
    (definition: Report) => {
      setReport(definition)
      setTab('report')
      setLinkError('')
      if (ready) {
        runReport(definition)
        return
      }
      pendingReport.current = definition
      setLinkPending(true)
    },
    [ready, runReport]
  )

  useEffect(() => {
    // A link opened on a browser with no local copy waits for one rather than
    // failing: the definition is complete, it is only the corpus that is
    // missing. Runs exactly once — the ref is cleared as it fires.
    if (!ready || !pendingReport.current) return
    const pending = pendingReport.current
    pendingReport.current = null
    setLinkPending(false)
    runReport(pending)
  }, [ready, runReport])

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

  const busy = progress.phase !== 'idle' && progress.phase !== 'ready' && progress.phase !== 'error'
  const freshness = ready && now !== null ? describeFreshness(generated, now) : null
  // The catalog's *release* age, not the fetch's: what matters is how old
  // CISA's list is, and a browser that re-fetched an unchanged catalog this
  // morning has not made it newer. Both numbers are on screen, so neither is
  // standing in for the other (M6).
  // …and against KEV's own threshold, not the corpus's: CISA is *business*-daily,
  // so a Friday catalog would be flagged every weekend by a number justified by
  // a pipeline that runs every day (M6).
  const kevFreshness =
    kev && now !== null ? describeFreshness(kev.releasedAt, now, KEV_STALE_AFTER_MS) : null
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
  const needsCorpus = ready ? undefined : 'Download the corpus first'
  const tabs: TabSpec[] = [
    { id: 'data', label: 'Data' },
    { id: 'explore', label: 'Explore', disabled: !ready, disabledReason: needsCorpus },
    { id: 'report', label: 'Report', disabled: !ready, disabledReason: needsCorpus },
    {
      id: 'saved',
      label: 'Saved',
      badge: store.saved.length ? String(store.saved.length) : undefined,
    },
    { id: 'sql', label: 'SQL', disabled: !ready, disabledReason: needsCorpus },
  ]
  // A tab can stop being usable underneath the reader — "Clear local copy" does
  // exactly that. Falling back to Data is the only honest destination.
  const active = tabs.find((entry) => entry.id === tab && !entry.disabled) ? tab : 'data'

  return (
    <main data-status={storage}>
      <h1>cve.meenan.dev</h1>
      <p className="lede">
        Browser-based search and analysis over the CVE List. Everything below runs locally: the
        server hands over static files and never sees a query.
      </p>

      {busy && (
        <section className="progress" aria-live="polite">
          <div className="bar">
            <div
              className="fill"
              style={{ width: progress.fraction === null ? '100%' : `${progress.fraction * 100}%` }}
              data-indeterminate={progress.fraction === null}
            />
          </div>
          <p className="muted">
            {phaseLabel(progress.phase)}
            {progress.detail && ` — ${progress.detail}`}
          </p>
          {/* Only queries can be stopped. An import or a sync has its own
              answer to "this is taking too long" — the stall watch (D-064) —
              and stopping one part way is what staged replacement already
              makes safe without a button. */}
          {(progress.phase === 'query' || progress.phase === 'export') && (
            <p className="muted">
              {cancelFlag === null ? (
                <span data-cancel="unavailable">
                  This browser is not cross-origin isolated, so a running query cannot be stopped
                  from here. The tab stays responsive; the query finishes on its own.
                </span>
              ) : (
                <button type="button" className="quiet" onClick={cancel} disabled={stopping}>
                  {stopping ? 'Stopping…' : 'Cancel query'}
                </button>
              )}
            </p>
          )}
        </section>
      )}

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

      {/* Both link banners are page-level rather than inside the Report panel.
          A link that arrives before there is a local copy leaves that panel
          disabled, so a message inside it would be a message nobody sees. */}
      {linkError && (
        <p className="error" data-link-error="1">
          {linkError}
        </p>
      )}
      {linkPending && !ready && (
        <p className="stale" data-link-pending="1">
          A report is waiting for a local copy of the corpus. Download it and the report will run by
          itself — a permalink carries its whole definition in the URL fragment, which is never sent
          to the server.
        </p>
      )}

      {/* Both of these stay outside the panels: the revision a number came from
          and MITRE's notice attach to the *copy*, not to a view of it (D-008),
          so switching tabs must not take either off the screen. */}
      {ready && revision !== null && (
        <p className="muted" data-revision={revision}>
          Local copy at revision {revision}
          {sync && syncSummary(sync)}
        </p>
      )}

      {/* Staleness, from the data's own build stamp rather than from a
          comparison with the origin: `status` makes no network request, which
          is what lets a reopen work offline (D-048). So this says how old the
          data is — a fact — and prompts a check rather than asserting there is
          something newer to fetch. */}
      {ready && freshness !== null && (
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

      {/* KEV's freshness is its own line, because it is a different dataset on
          a different cadence: CISA publishes about business-daily and the
          corpus daily, so one number for both would be wrong about whichever
          moved last. Read from the local copy like the line above, so it is
          honest offline and agrees across tabs (M6, D-076). The provenance is
          in the sentence rather than in a footnote: "per CISA, as of …" is what
          keeps this a statement about CISA's catalog rather than an endorsement
          by it. */}
      {ready && (kev !== null || kevError !== '') && (
        <p
          className={kevFreshness?.stale ? 'stale' : 'muted'}
          data-kev={kev ? kev.version : 'none'}
          data-kev-age-ms={kevFreshness ? Math.round(kevFreshness.ageMs) : undefined}
        >
          {kev ? (
            <>
              CISA KEV catalog {kev.version}, released{' '}
              <time dateTime={kev.released}>{localTime(kev.released)}</time>
              {kevFreshness && ` — ${kevFreshness.age}`}. {kev.entries.toLocaleString()} entries
              {kev.unmatched > 0 &&
                `, ${kev.unmatched.toLocaleString()} for CVEs this copy does not hold`}
              . Fetched by this browser{' '}
              <time dateTime={new Date(kev.fetched * 1000).toISOString()}>
                {localTime(new Date(kev.fetched * 1000).toISOString())}
              </time>
              .
            </>
          ) : (
            'No CISA KEV catalog in this copy yet.'
          )}
          {kevError !== '' && ` Last refresh failed: ${kevError}`}
        </p>
      )}

      <Tabs tabs={tabs} active={active} onSelect={(id) => setTab(id as TabId)} />

      <TabPanel id="data" active={active === 'data'}>
        <section className="controls">
          <button
            onClick={() => {
              // Asked from the click, because Firefox prompts and a prompt
              // outside a user gesture is a prompt that is dismissed. The
              // *answer* is what gets reported — a request that "succeeded" and
              // was refused looks identical from the call site otherwise.
              void requestPersistence(navigator.storage).then(setPersisted)
              send({ type: 'import', options: importOptions(location.search) })
            }}
            disabled={busy || blocked}
          >
            {ready ? 'Re-download data' : 'Download data'}
          </button>
          <button
            onClick={() => send({ type: 'sync', options: importOptions(location.search) })}
            disabled={!ready || busy || blocked}
          >
            Sync
          </button>
          <button
            onClick={() => {
              setKevError('')
              send({ type: 'kev', options: importOptions(location.search) })
            }}
            disabled={!ready || busy || blocked}
          >
            Refresh KEV
          </button>
          <button
            onClick={() => send({ type: 'query', sql: DEMO_QUERY })}
            disabled={!ready || busy}
          >
            Run query
          </button>
          <button
            onClick={() => {
              // Drop the previous table before re-running: the Worker reports no
              // progress for this, so a stale result on screen is indistinguishable
              // from a finished one — to a reader and to the sweep alike.
              setBenchmark(null)
              send({ type: 'bench' })
            }}
            disabled={!ready || busy}
          >
            Measure query latency
          </button>
          <button onClick={() => send({ type: 'reset' })} disabled={busy} className="quiet">
            Clear local copy
          </button>
        </section>

        {/* The one support channel (D-009). Nothing is collected from users —
            not analytics, not error reporting — so a bug report is whatever a
            person can read off this panel and paste. A `<details>` rather than
            a tab: it is closed by default because it is for the day something
            is wrong, and it is keyboard-operable and screen-reader-labelled
            without any code of ours. */}
        <details
          className="diagnostics"
          data-diagnostics="1"
          onToggle={(event) => {
            // Re-probed on open rather than kept live: storage numbers move,
            // and a panel showing what was true at page load is a panel that
            // sends someone chasing a number that already changed.
            if (!(event.currentTarget as HTMLDetailsElement).open) return
            send({ type: 'probe' })
            const controlling = Boolean(navigator.serviceWorker?.controller)
            void shellVersion(navigator.serviceWorker).then((version) =>
              setShell((current) => ({ ...current, version, controlling }))
            )
          }}
        >
          <summary>Diagnostics</summary>
          <p className="muted">
            Everything below is read from this browser. Nothing is sent anywhere — there is no
            telemetry in this app at all, so if something is wrong, this panel is what to copy into
            a bug report.
          </p>
          <dl className="facts" data-diagnostics-body="1">
            <dt>Local copy</dt>
            <dd data-diag="storage">
              {storage}
              {revision !== null && ` at revision ${revision}`}
            </dd>
            <dt>Schema</dt>
            <dd data-diag="schema">
              copy {schemas.local ?? '—'}, this app reads {schemas.speaks || SCHEMA_VERSION}
            </dd>
            <dt>Records</dt>
            <dd data-diag="records">
              {timings
                ? timings.records.toLocaleString()
                : ready
                  ? 'not counted this session'
                  : '—'}
            </dd>
            <dt>CISA KEV</dt>
            <dd data-diag="kev">
              {kev
                ? `${kev.version}, released ${kev.released}, ${kev.entries.toLocaleString()} ` +
                  `entries (${kev.unmatched.toLocaleString()} unmatched), fetched ` +
                  new Date(kev.fetched * 1000).toISOString()
                : 'no catalog'}
              {kevError !== '' && ` — last refresh failed: ${kevError}`}
            </dd>
            <dt>Data built</dt>
            <dd data-diag="generated">
              {generated === null ? '—' : new Date(generated * 1000).toISOString()}
            </dd>
            <dt>Last sync</dt>
            <dd data-diag="sync">
              {sync
                ? `${sync.applied} delta${sync.applied === 1 ? '' : 's'} to revision ${sync.to}`
                : 'not this session'}
            </dd>
            <dt>Storage used</dt>
            <dd data-diag="usage">
              {environment
                ? `${formatBytes(environment.storage.usage)} of ${formatBytes(
                    environment.storage.quota
                  )}`
                : '—'}
            </dd>
            <dt>Eviction</dt>
            <dd data-diag="persisted">
              {persistenceMessage(persisted ?? environment?.storage.persisted ?? null)}
            </dd>
            <dt>Offline shell</dt>
            <dd data-diag="shell">
              {!shell.supported
                ? 'not supported by this browser'
                : shell.error
                  ? `registration failed: ${shell.error}`
                  : `${shell.registered ? 'registered' : 'not registered'}, ${
                      shell.controlling ? 'controlling this page' : 'not controlling this page yet'
                    }${shell.version ? `, cache ${shell.version}` : ''}`}
            </dd>
            <dt>Browser support</dt>
            <dd data-diag="capabilities">
              {environment
                ? environment.capabilities.capabilities
                    .map((entry) => `${entry.label}: ${entry.ok ? 'yes' : 'no'}`)
                    .join('; ')
                : '—'}
            </dd>
            <dt>Support floor</dt>
            <dd data-diag="floor">{SUPPORT_FLOOR}</dd>
          </dl>
        </details>

        {vfs !== DEFAULT_VFS && (
          <p className="error">
            Diagnostic mode: <code>{vfs}</code>. This VFS cannot stage a download (D-051), so
            “Re-download data” <strong>deletes the local copy before fetching anything</strong> — a
            failure part-way leaves nothing. Remove <code>?vfs=</code> from the URL to use the
            normal path.
          </p>
        )}

        {timings && (
          <section>
            <h2>Import</h2>
            {/* The rendered rows are rounded for reading; the sweep in
                tests/e2e/measure.spec.ts reads this instead, so a recorded number
                is the Worker's, not a re-parsed label. */}
            <dl className="timings" data-json={JSON.stringify(timings)}>
              <Timing label="Records" value={timings.records.toLocaleString()} />
              <Timing
                label="Chunks fetched"
                value={
                  // Fewer than the total means this run resumed a staged download
                  // (D-061) — worth saying out loud, because it is also why the
                  // elapsed time will not match a fresh import's.
                  timings.chunksFetched === timings.chunksTotal
                    ? `${timings.chunksTotal}`
                    : `${timings.chunksFetched} of ${timings.chunksTotal} (resumed)`
                }
              />
              {/* "Snapshot size", not "Downloaded": this is the whole published
                  snapshot, and a resumed run may have fetched none of it. The
                  row above says what this run actually did. */}
              <Timing
                label="Snapshot size"
                value={`${(timings.compressedBytes / 1e6).toFixed(1)} MB`}
              />
              <Timing label="Expanded to" value={`${(timings.rawBytes / 1e6).toFixed(1)} MB`} />
              <Timing label="Fetch" value={`${timings.fetchMs} ms`} />
              <Timing label="Decompress" value={`${timings.decompressMs} ms`} />
              <Timing label="Write to OPFS" value={`${timings.writeMs} ms`} />
              <Timing label="Build indexes" value={`${timings.indexMs} ms`} />
              <Timing label="Verify and promote" value={`${timings.verifyMs} ms`} />
              <Timing label="Total" value={`${(timings.totalMs / 1000).toFixed(1)} s`} />
              <Timing
                label="OPFS footprint"
                value={
                  timings.opfsBytes === null
                    ? 'could not be measured'
                    : `${(timings.opfsBytes / 1e6).toFixed(1)} MB`
                }
              />
              <Timing
                label="SQLite WASM heap"
                value={`${(timings.wasmHeapBytes / 1e6).toFixed(1)} MB`}
              />
              <Timing
                label="VFS"
                value={`${timings.vfs} × ${timings.concurrency}, ${timings.cacheMib} MiB cache`}
              />
            </dl>
          </section>
        )}

        {benchmark && (
          <section>
            <h2>Query latency</h2>
            <p className="muted">
              SQLite WASM heap after these queries: {(benchmark.wasmHeapBytes / 1e6).toFixed(1)} MB
            </p>
            <div className="scroll" tabIndex={0}>
              <table className="bench" data-json={JSON.stringify(benchmark)}>
                <thead>
                  <tr>
                    <th scope="col">Query</th>
                    <th scope="col">ms</th>
                    <th scope="col">rows</th>
                  </tr>
                </thead>
                <tbody>
                  {benchmark.results.map((entry) => (
                    <tr key={entry.name}>
                      <td>{entry.name}</td>
                      <td>{entry.ms}</td>
                      <td>{entry.rows}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {cancelled?.kind === 'demo' && (
          <p className="muted">Query cancelled after {(cancelled.ms / 1000).toFixed(1)} s.</p>
        )}

        {result && (
          <section>
            <h2>Most-reported vendors</h2>
            <p className="muted">
              {result.rows.length} rows in {result.ms} ms. PUBLISHED records only — REJECTED are
              excluded by default.
            </p>
            <div className="scroll" tabIndex={0}>
              <table className="results">
                <thead>
                  <tr>
                    {result.columns.map((column) => (
                      <th scope="col" key={column}>
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, index) => (
                    <tr key={index}>
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex}>{String(cell ?? '')}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </TabPanel>

      <TabPanel id="explore" active={active === 'explore'}>
        {ready && (
          <Explore
            disabled={busy}
            onRun={(request: SearchRequest) => send({ type: 'search', request })}
            onOpenRecord={(cveId) => {
              setDetailId(cveId)
              send({ type: 'detail', cveId })
            }}
            onExport={(format, request) =>
              send({
                type: 'export',
                request: {
                  format,
                  kind: 'records',
                  report: reportFor(request),
                  title: 'CVE records',
                },
              })
            }
            outcome={search}
            run={runSeq}
            cancelledMs={cancelled?.kind === 'search' ? cancelled.ms : null}
            detailId={detailId}
            detail={detail}
            onCloseDetail={() => {
              detailRequest.current = null
              setDetailId(null)
              setDetail(undefined)
            }}
            exportNote={exportNote}
          />
        )}
      </TabPanel>

      <TabPanel id="report" active={active === 'report'}>
        {ready && (
          <ReportTab
            report={report}
            onChange={setReport}
            onRun={runReport}
            onExport={(format, kind, definition) =>
              send({
                type: 'export',
                request: {
                  format,
                  kind,
                  // Export the definition that produced the visible result,
                  // not edits made in the builder since that run.
                  report: definition,
                  title: definition.title?.trim() || 'CVE report',
                },
              })
            }
            onSave={(name) =>
              updateStore((current) => saveNamed(current, name, report, Date.now()))
            }
            outcome={reportOutcome}
            disabled={busy}
            run={runSeq}
            cancelledMs={cancelled?.kind === 'report' ? cancelled.ms : null}
            exportNote={exportNote}
          />
        )}
      </TabPanel>

      <TabPanel id="saved" active={active === 'saved'}>
        <SavedTab
          store={store}
          storable={storable}
          onOpen={openReport}
          onRemove={(id) => updateStore((current) => removeSaved(current, id))}
          onClearRecent={() => updateStore((current) => clearRecent(current))}
        />
      </TabPanel>

      <TabPanel id="sql" active={active === 'sql'}>
        {ready && (
          <Console
            disabled={busy}
            onRun={(sql: string) => send({ type: 'console', sql })}
            result={consoleResult}
            run={runSeq}
            error={consoleError}
            cancelledMs={cancelled?.kind === 'console' ? cancelled.ms : null}
          />
        )}
      </TabPanel>

      {notice && <footer className="notice">{notice}</footer>}
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
function reportFor(request: SearchRequest): Report {
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

function Timing({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  )
}

function phaseLabel(phase: Progress['phase']): string {
  switch (phase) {
    case 'manifest':
      return 'Reading manifest'
    case 'download':
      return 'Downloading and decompressing'
    case 'index':
      return 'Building search indexes'
    case 'sync':
      return 'Applying updates'
    case 'verify':
      // Deliberately vague: three different steps report under this phase and
      // each names itself in the detail, so a specific label here would either
      // repeat the detail or contradict it — the `opfs-sahpool` path reports
      // here too and does not verify or promote anything (D-051).
      return 'Finishing up'
    case 'query':
      return 'Running query'
    case 'export':
      return 'Writing export'
    default:
      return 'Working'
  }
}
