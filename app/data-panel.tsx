'use client'

/**
 * The data panel (UI revamp) — everything about the *copy* rather than a query
 * over it: re-download, KEV refresh, the import timings, the latency
 * benchmark, the demo query, clearing local storage, and diagnostics.
 *
 * This was the Data tab, and it opens itself after an import finishes so the
 * run that just happened reports where the reader is looking. The rest of the
 * time it stays out of the way — the workspace is for questions, and "how the
 * sausage was downloaded" is a panel, not a home page.
 */

import type { BenchResult, QueryResult, Timings } from '@/lib/protocol'

export function DataPanel({
  ready,
  busy,
  blocked,
  onDownload,
  onRefreshKev,
  onRunDemo,
  onBench,
  onReset,
  timings,
  benchmark,
  result,
  cancelledDemoMs,
  vfsWarning,
  children,
}: {
  ready: boolean
  busy: boolean
  blocked: boolean
  onDownload: () => void
  onRefreshKev: () => void
  onRunDemo: () => void
  onBench: () => void
  onReset: () => void
  timings: Timings | null
  benchmark: { results: BenchResult[]; wasmHeapBytes: number } | null
  result: QueryResult | null
  cancelledDemoMs: number | null
  /** The `?vfs=` diagnostic mode caveat, when it applies. */
  vfsWarning: string | null
  /** The diagnostics disclosure, shared with the landing view. */
  children?: React.ReactNode
}) {
  return (
    <section className="data-panel" aria-labelledby="data-heading">
      <h2 id="data-heading">Data</h2>
      <section className="controls">
        <button onClick={onDownload} disabled={busy || blocked}>
          {ready ? 'Re-download data' : 'Download data'}
        </button>
        <button onClick={onRefreshKev} disabled={!ready || busy || blocked}>
          Refresh KEV
        </button>
        <button onClick={onRunDemo} disabled={!ready || busy}>
          Run query
        </button>
        <button onClick={onBench} disabled={!ready || busy}>
          Measure query latency
        </button>
        <button onClick={onReset} disabled={busy} className="quiet">
          Clear local copy
        </button>
      </section>

      {children}

      {vfsWarning && (
        <p className="error">
          Diagnostic mode: <code>{vfsWarning}</code>. This VFS cannot stage a download (D-051), so
          “Re-download data” <strong>deletes the local copy before fetching anything</strong> — a
          failure part-way leaves nothing. Remove <code>?vfs=</code> from the URL to use the normal
          path.
        </p>
      )}

      {timings && (
        <section>
          <h3>Import</h3>
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
                snapshot, and a resumed run may have fetched none of it. */}
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
          <h3>Query latency</h3>
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

      {cancelledDemoMs !== null && (
        <p className="muted">Query cancelled after {(cancelledDemoMs / 1000).toFixed(1)} s.</p>
      )}

      {result && (
        <section>
          <h3>Most-reported vendors</h3>
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
    </section>
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
