'use client'

/**
 * Saved reports and history (M4).
 *
 * Two lists with different rules. **Saved** is what the user named, and nothing
 * removes an entry but the user. **Recent** is automatic, capped, and
 * deduplicated on the definition itself — so a session's work is twenty
 * distinct reports rather than twenty runs of the last one.
 *
 * Both live in `localStorage` rather than in the SQLite copy, which is a
 * rebuildable cache a re-download or a schema bump destroys (D-013, D-068).
 * Losing a week of saved reports to a schema bump is exactly the quiet
 * wrongness vision criterion 7 rules out — see `lib/saved.ts`.
 */

import { describeDraft, filtersToDraft } from '@/lib/draft'
import { DIMENSION_LABELS } from '@/lib/filters'
import type { Report } from '@/lib/report'
import type { ReportStore, SavedReport } from '@/lib/saved'

export function SavedTab({
  store,
  onOpen,
  onRemove,
  onClearRecent,
  storable,
}: {
  store: ReportStore
  onOpen: (report: Report) => void
  onRemove: (id: string) => void
  onClearRecent: () => void
  /** False when writes to `localStorage` do not stick — reported, not hidden. */
  storable: boolean
}) {
  return (
    <section aria-labelledby="saved-heading">
      <h2 id="saved-heading">Saved reports</h2>
      {!storable && (
        <p className="error" data-storage-warning="1">
          This browser is not letting the page store anything for this site, so saved reports and
          history will not survive a reload. Permalinks still work — they carry the whole definition
          in the URL.
        </p>
      )}
      <p className="muted">
        Kept in this browser only, never sent anywhere. They survive a re-download of the corpus and
        a schema change, because they are not stored in the database.
      </p>

      <h3>Named</h3>
      {store.saved.length === 0 ? (
        <p className="muted" data-saved-empty="1">
          Nothing saved yet. Build a report and give it a name.
        </p>
      ) : (
        <ul className="plain saved-list" data-saved={store.saved.length}>
          {store.saved.map((entry) => (
            <Entry key={entry.id} entry={entry} kind="saved" onOpen={onOpen}>
              <button
                type="button"
                className="quiet"
                aria-label={`Delete saved report: ${entry.name}`}
                onClick={() => onRemove(entry.id)}
              >
                Delete
              </button>
            </Entry>
          ))}
        </ul>
      )}

      <h3>Recently run</h3>
      {store.recent.length === 0 ? (
        <p className="muted" data-recent-empty="1">
          No history yet.
        </p>
      ) : (
        <>
          <ul className="plain saved-list" data-recent={store.recent.length}>
            {store.recent.map((entry) => (
              <Entry key={entry.id} entry={entry} kind="recent" onOpen={onOpen} />
            ))}
          </ul>
          <button type="button" className="quiet" onClick={onClearRecent}>
            Clear history
          </button>
        </>
      )}
    </section>
  )
}

function Entry({
  entry,
  kind,
  onOpen,
  children,
}: {
  entry: SavedReport
  /** Which list this row is in. Part of the accessible name, see below. */
  kind: 'saved' | 'recent'
  onOpen: (report: Report) => void
  children?: React.ReactNode
}) {
  const name = entry.name || entry.report.title || describe(entry.report)
  return (
    <li className="saved-entry">
      <button
        type="button"
        className="quiet link"
        // The accessible name carries the report *and* which list it is in. The
        // word "Open" alone would give twenty identical buttons; the name alone
        // is still ambiguous, because a report that was saved has usually also
        // just been run and appears in both lists.
        aria-label={`Open ${kind} report: ${name}`}
        onClick={() => onOpen(entry.report)}
      >
        {name}
      </button>
      <span className="muted">{summary(entry.report)}</span>
      <time className="muted" dateTime={new Date(entry.at).toISOString()}>
        {entry.at ? new Date(entry.at).toLocaleString() : ''}
      </time>
      {children}
    </li>
  )
}

function describe(report: Report): string {
  return report.series
    ? `${DIMENSION_LABELS[report.rows]} × ${DIMENSION_LABELS[report.series]}`
    : DIMENSION_LABELS[report.rows]
}

/**
 * What this report counts, in one line.
 *
 * Built from the same chip description the builder shows, so a saved entry and
 * the form it opens into cannot describe the report differently.
 */
function summary(report: Report): string {
  const chips = describeDraft(filtersToDraft(report.filters))
  return `${describe(report)} · ${chips.map((chip) => chip.label).join(' · ')}`
}
