'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { newCancelFlag, requestCancel } from '@/lib/cancel'
import { describeFreshness } from '@/lib/freshness'
import { DEFAULT_CACHE_MIB, DEFAULT_CONCURRENCY, DEFAULT_VFS } from '@/lib/protocol'
import type {
  BenchResult,
  ImportOptions,
  Progress,
  QueryResult,
  Request,
  Response,
  SearchRequest,
  SyncOutcome,
  Timings,
} from '@/lib/protocol'

import { Console } from './console'
import { Explore, type SearchOutcome } from './explore'

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
 * schema version this build claims to read (D-068), `?ops=` and `?analyze=`
 * turn off the query progress handler and the statistics pass so the M3 sweep
 * can price them (D-066, D-067) — all of which leave the local copy where it
 * was by construction. `?vfs=` selects the `opfs-sahpool` path, which cannot
 * stage (D-051) and so clears local storage — both slots included — *before*
 * fetching anything: one click on a crafted link costs a working local copy. It
 * stays reachable because `pnpm measure` needs it to re-run Q-004.
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
  return {
    concurrency: positive(params.get('concurrency')) ?? DEFAULT_CONCURRENCY,
    cacheMib: positive(params.get('cache')) ?? DEFAULT_CACHE_MIB,
    vfs: vfs === 'opfs' || vfs === 'opfs-sahpool' ? vfs : DEFAULT_VFS,
    ...(stop === null ? {} : { stopAfterChunks: stop }),
    ...(stall === null ? {} : { stallMs: stall }),
    ...(schema === null ? {} : { schema }),
    ...(progressOps === null ? {} : { progressOps }),
    ...(analyze === null ? {} : { analyze }),
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
          if (!message.ready) {
            setTimings(null)
            setResult(null)
            setSearch(null)
            setConsoleResult(null)
            setBenchmark(null)
            setSync(null)
          }
          break
        case 'imported':
          setStorage('ready')
          setReady(true)
          importedThisRun.current = true
          setTimings(message.timings)
          setNotice(message.notice)
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
          else if (message.kind === 'search') {
            setSearch({
              result: message.result,
              matches: message.matches ?? null,
              unmatched: message.unmatched ?? [],
              groupBy: message.groupBy ?? null,
              state: message.state ?? 'published',
            })
          } else setResult(message.result)
          break
        case 'cancelled':
          // Not an error and not shown as one: the user asked for it, the
          // database is untouched, and the surface that was running says so.
          setRunSeq((seq) => seq + 1)
          setStopping(false)
          setCancelled({ kind: message.kind, ms: message.ms })
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
    workerRef.current?.postMessage(request)
  }, [])

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

  return (
    <main data-status={storage}>
      <h1>cve.meenan.dev</h1>
      <p className="lede">
        Browser-based search and analysis over the CVE List. Everything below runs locally: the
        server hands over static files and never sees a query.
      </p>

      <section className="controls">
        <button
          onClick={() => send({ type: 'import', options: importOptions(location.search) })}
          disabled={busy}
        >
          {ready ? 'Re-download data' : 'Download data'}
        </button>
        <button
          onClick={() => send({ type: 'sync', options: importOptions(location.search) })}
          disabled={!ready || busy}
        >
          Sync
        </button>
        <button onClick={() => send({ type: 'query', sql: DEMO_QUERY })} disabled={!ready || busy}>
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
          {progress.phase === 'query' && (
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

      {vfs !== DEFAULT_VFS && (
        <p className="error">
          Diagnostic mode: <code>{vfs}</code>. This VFS cannot stage a download (D-051), so
          “Re-download data” <strong>deletes the local copy before fetching anything</strong> — a
          failure part-way leaves nothing. Remove <code>?vfs=</code> from the URL to use the normal
          path.
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

      {ready && (
        <Explore
          disabled={busy}
          onRun={(request: SearchRequest) => send({ type: 'search', request })}
          outcome={search}
          run={runSeq}
          cancelledMs={cancelled?.kind === 'search' ? cancelled.ms : null}
        />
      )}

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

      {benchmark && (
        <section>
          <h2>Query latency</h2>
          <p className="muted">
            SQLite WASM heap after these queries: {(benchmark.wasmHeapBytes / 1e6).toFixed(1)} MB
          </p>
          <div className="scroll">
            <table className="bench" data-json={JSON.stringify(benchmark)}>
              <thead>
                <tr>
                  <th>Query</th>
                  <th>ms</th>
                  <th>rows</th>
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
          <div className="scroll">
            <table className="results">
              <thead>
                <tr>
                  {result.columns.map((column) => (
                    <th key={column}>{column}</th>
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

      {notice && <footer className="notice">{notice}</footer>}
    </main>
  )
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
    default:
      return 'Working'
  }
}
