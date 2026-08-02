'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { DEFAULT_CACHE_MIB, DEFAULT_CONCURRENCY, DEFAULT_VFS } from '@/lib/protocol'
import type {
  BenchResult,
  ImportOptions,
  Progress,
  Request,
  Response,
  Timings,
} from '@/lib/protocol'

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
 * Import knobs from the query string, for the Q-003/Q-004 sweep only
 * (`?vfs=opfs-sahpool&concurrency=8&cache=64`). Every default is the measured
 * one (D-049 – D-051); anything unrecognised falls back rather than failing,
 * because this is a diagnostic affordance and not a feature.
 *
 * These are only a convenience: the Worker clamps them again, because a URL is
 * something a stranger can hand you and the memory bound is not negotiable
 * there.
 */
function importOptions(search: string): ImportOptions {
  const params = new URLSearchParams(search)
  const vfs = params.get('vfs')
  return {
    concurrency: positive(params.get('concurrency')) ?? DEFAULT_CONCURRENCY,
    cacheMib: positive(params.get('cache')) ?? DEFAULT_CACHE_MIB,
    vfs: vfs === 'opfs' || vfs === 'opfs-sahpool' ? vfs : DEFAULT_VFS,
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
  const [timings, setTimings] = useState<Timings | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ columns: string[]; rows: unknown[][]; ms: number } | null>(
    null
  )
  const [benchmark, setBenchmark] = useState<{
    results: BenchResult[]
    wasmHeapBytes: number
  } | null>(null)

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
          setReady(message.ready)
          // Every panel below is derived from a local copy that may have just
          // stopped existing — "Clear local copy" and a failed re-download both
          // land here. Leaving stale timings, results and a benchmark on screen
          // next to a "Download data" button is the UI asserting something
          // false. The notice is restored rather than cleared when a copy *is*
          // present, because D-008 requires it to accompany the data even for a
          // visitor whose page never ran an import.
          setNotice(message.notice ?? '')
          if (!message.ready) {
            setTimings(null)
            setResult(null)
            setBenchmark(null)
          }
          break
        case 'imported':
          setReady(true)
          setTimings(message.timings)
          setNotice(message.notice)
          break
        case 'rows':
          setResult({ columns: message.columns, rows: message.rows, ms: message.ms })
          break
        case 'bench':
          setBenchmark({ results: message.results, wasmHeapBytes: message.wasmHeapBytes })
          break
        case 'error':
          setError(message.message)
          break
      }
    }

    worker.postMessage({ type: 'status' } satisfies Request)
    return () => worker.terminate()
  }, [])

  const send = useCallback((request: Request) => {
    setError('')
    workerRef.current?.postMessage(request)
  }, [])

  const busy = progress.phase !== 'idle' && progress.phase !== 'ready' && progress.phase !== 'error'

  return (
    <main>
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
        </section>
      )}

      {error && <p className="error">{error}</p>}

      {timings && (
        <section>
          <h2>Import</h2>
          {/* The rendered rows are rounded for reading; the sweep in
              tests/e2e/measure.spec.ts reads this instead, so a recorded number
              is the Worker's, not a re-parsed label. */}
          <dl className="timings" data-json={JSON.stringify(timings)}>
            <Timing label="Records" value={timings.records.toLocaleString()} />
            <Timing label="Downloaded" value={`${(timings.compressedBytes / 1e6).toFixed(1)} MB`} />
            <Timing label="Expanded to" value={`${(timings.rawBytes / 1e6).toFixed(1)} MB`} />
            <Timing label="Fetch" value={`${timings.fetchMs} ms`} />
            <Timing label="Decompress" value={`${timings.decompressMs} ms`} />
            <Timing label="Write to OPFS" value={`${timings.writeMs} ms`} />
            <Timing label="Build indexes" value={`${timings.indexMs} ms`} />
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
    case 'query':
      return 'Running query'
    default:
      return 'Working'
  }
}
