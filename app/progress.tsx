'use client'

/**
 * The one progress surface, shared by the landing view and the workspace so a
 * download reports itself identically wherever it was started (D-052: anything
 * over a second says so).
 */

import type { Progress } from '@/lib/protocol'

export function ProgressBar({
  progress,
  cancelFlag,
  stopping,
  onCancel,
  lead,
}: {
  progress: Progress
  /** Null on a browser with no SharedArrayBuffer — the UI says so instead. */
  cancelFlag: Int32Array | null
  stopping: boolean
  onCancel: () => void
  /** Why this is running, when the page started it rather than the reader. */
  lead?: string | null
}) {
  return (
    <section className="progress" aria-live="polite" data-auto-sync={lead ? '1' : undefined}>
      {lead && <p className="progress-lead">{lead}</p>}
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
      {/* Only queries can be stopped. An import or a sync has its own answer
          to "this is taking too long" — the stall watch (D-064) — and
          stopping one part way is what staged replacement already makes safe
          without a button. */}
      {(progress.phase === 'query' || progress.phase === 'export') && (
        <p className="muted">
          {cancelFlag === null ? (
            <span data-cancel="unavailable">
              This browser is not cross-origin isolated, so a running query cannot be stopped from
              here. The tab stays responsive; the query finishes on its own.
            </span>
          ) : (
            <button type="button" className="quiet" onClick={onCancel} disabled={stopping}>
              {stopping ? 'Stopping…' : 'Cancel query'}
            </button>
          )}
        </p>
      )}
    </section>
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
