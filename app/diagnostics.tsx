'use client'

/**
 * The diagnostics disclosure — the one support channel (D-009).
 *
 * Nothing is collected from users — not analytics, not error reporting — so a
 * bug report is whatever a person can read off this panel and paste. A
 * `<details>` rather than a view of its own: it is closed by default because
 * it is for the day something is wrong, and it is keyboard-operable and
 * screen-reader-labelled without any code of ours. Rendered on the landing
 * view and in the workspace alike, because a browser that cannot download the
 * corpus is exactly the one that needs it.
 */

import { SUPPORT_FLOOR, type CapabilityReport } from '@/lib/capabilities'
import type { KevStatus } from '@/lib/kev'
import { SCHEMA_VERSION, type SyncOutcome, type Timings } from '@/lib/protocol'
import { bytes as formatBytes, persistenceMessage, type StorageReport } from '@/lib/storage'
import type { ShellState } from '@/lib/shell'

export function Diagnostics({
  storage,
  revision,
  schemas,
  timings,
  ready,
  kev,
  kevError,
  generated,
  sync,
  environment,
  persisted,
  shell,
  onOpen,
}: {
  storage: string
  revision: number | null
  schemas: { local: number | null; speaks: number }
  timings: Timings | null
  ready: boolean
  kev: KevStatus | null
  kevError: string
  generated: number | null
  sync: SyncOutcome | null
  environment: { capabilities: CapabilityReport; storage: StorageReport } | null
  persisted: boolean | null
  shell: ShellState
  /** Re-probe on open: storage numbers move, and a stale panel misleads. */
  onOpen: () => void
}) {
  return (
    <details
      className="diagnostics"
      data-diagnostics="1"
      onToggle={(event) => {
        if (!(event.currentTarget as HTMLDetailsElement).open) return
        onOpen()
      }}
    >
      <summary>Diagnostics</summary>
      <p className="muted">
        Everything below is read from this browser. Nothing is sent anywhere — there is no telemetry
        in this app at all, so if something is wrong, this panel is what to copy into a bug report.
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
          {timings ? timings.records.toLocaleString() : ready ? 'not counted this session' : '—'}
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
            ? `${formatBytes(environment.storage.usage)} of ${formatBytes(environment.storage.quota)}`
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
  )
}
