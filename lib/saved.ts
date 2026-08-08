/**
 * Saved reports and history (M4).
 *
 * **In `localStorage`, deliberately not in the SQLite copy.** The local
 * database is a rebuildable cache (D-013): a re-download replaces it and a
 * schema bump invalidates it (D-068). Reports are not rebuildable — they are the
 * only thing in this app the user actually authored — so losing a week of them
 * to a schema bump would be exactly the quiet wrongness vision criterion 7 rules
 * out. They live in the one store whose lifetime is the origin's rather than the
 * corpus's.
 *
 * **Everything read back is re-validated.** A `localStorage` entry was written
 * by some build of this app, which may be older than this one, and it is
 * editable by anyone with the console open. So it goes through `parseReport`
 * exactly like a permalink does — the same validation, in the same place, with
 * the same refusals (D-069). A store that cannot be read at all is replaced by
 * an empty one rather than throwing: a corrupt entry must not make the app
 * unusable, because there is no way for the user to clear it if it does.
 *
 * **The history is automatic, the saves are not.** Two lists: `saved` holds
 * what the user named, `recent` records what they ran. The distinction matters
 * on eviction — the recent list is trimmed to a cap without asking, and the
 * named list never is.
 */

import { parseReport, toFragment, type Report } from './report'

/**
 * The storage key, carrying its own version.
 *
 * A new version is a new key rather than a migration: the old entry is left
 * where it is, so a user who downgrades still has their reports, and a build
 * that changes what a stored report *means* cannot half-read the previous
 * shape. `REPORT_VERSION` is a separate axis — it versions the definition, this
 * versions the envelope around the lists.
 */
export const STORE_KEY = 'cve.meenan.dev:reports:1'

/** How many runs the automatic history keeps. */
export const RECENT_LIMIT = 20
/** How many named reports may be stored, so a quota failure is not the first limit met. */
export const SAVED_LIMIT = 100
/** Longest name accepted, bounded like every other free-text field. */
export const NAME_LIMIT = 120

export interface SavedReport {
  /** Stable within this browser only; nothing outside it ever sees these. */
  id: string
  name: string
  /** Unix milliseconds, when it was saved or last run. */
  at: number
  report: Report
}

export interface ReportStore {
  saved: SavedReport[]
  recent: SavedReport[]
}

/** The `localStorage`-shaped surface this module needs, so tests can supply one. */
export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function emptyStore(): ReportStore {
  return { saved: [], recent: [] }
}

/**
 * Read the store, dropping anything that no longer validates.
 *
 * Entry by entry rather than all or nothing: one report that a newer build
 * wrote, or that names a dimension this build dropped, costs the user that
 * report — not the other nineteen.
 */
export function loadStore(storage: KeyValueStore | null): ReportStore {
  if (!storage) return emptyStore()
  let raw: string | null
  try {
    raw = storage.getItem(STORE_KEY)
  } catch {
    // Storage can throw on access alone — a browser with cookies blocked for
    // this origin does exactly that.
    return emptyStore()
  }
  if (!raw) return emptyStore()
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return emptyStore()
  }
  if (typeof value !== 'object' || value === null) return emptyStore()
  const held = value as Record<string, unknown>
  return {
    saved: parseList(held.saved).slice(0, SAVED_LIMIT),
    recent: parseList(held.recent).slice(0, RECENT_LIMIT),
  }
}

function parseList(value: unknown): SavedReport[] {
  if (!Array.isArray(value)) return []
  const out: SavedReport[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const held = entry as Record<string, unknown>
    const parsed = parseReport(held.report)
    if (!parsed.ok) continue
    const candidate = typeof held.at === 'number' && Number.isFinite(held.at) ? held.at : 0
    // `Number.isFinite` is not enough for a timestamp: values outside the
    // ECMAScript Date range produce an Invalid Date, and SavedTab calls
    // `toISOString()` while rendering. One hand-edited entry must not crash the
    // whole page and leave the user unable to delete it.
    const at = Number.isFinite(new Date(candidate).getTime()) ? candidate : 0
    out.push({
      id: typeof held.id === 'string' && held.id ? held.id.slice(0, 64) : newId(at, out.length),
      name: typeof held.name === 'string' ? held.name.slice(0, NAME_LIMIT) : '',
      at,
      report: parsed.report,
    })
  }
  return out
}

/**
 * Write the store back.
 *
 * Returns whether it landed. A quota failure is a real outcome here — a user
 * with a nearly-full origin gets a report that appears to save and is gone on
 * reload otherwise — so the caller is given the chance to say so rather than
 * the failure being swallowed.
 */
export function writeStore(storage: KeyValueStore | null, store: ReportStore): boolean {
  if (!storage) return false
  try {
    storage.setItem(
      STORE_KEY,
      JSON.stringify({
        saved: store.saved.slice(0, SAVED_LIMIT),
        recent: store.recent.slice(0, RECENT_LIMIT),
      })
    )
    return true
  } catch {
    return false
  }
}

/**
 * Add or replace a named report.
 *
 * Replacing by name rather than appending: saving "Cisco criticals" twice is
 * someone refining one report, and a list with four of them is a list nobody
 * can use. The newest is first, which is the order the list is read in.
 */
export function saveNamed(
  store: ReportStore,
  name: string,
  report: Report,
  now: number
): ReportStore {
  const trimmed = name.trim().slice(0, NAME_LIMIT) || 'Untitled report'
  const entry: SavedReport = { id: newId(now, store.saved.length), name: trimmed, at: now, report }
  const rest = store.saved.filter((held) => held.name !== trimmed)
  return { ...store, saved: [entry, ...rest].slice(0, SAVED_LIMIT) }
}

export function removeSaved(store: ReportStore, id: string): ReportStore {
  return { ...store, saved: store.saved.filter((entry) => entry.id !== id) }
}

/**
 * Record that a report was run.
 *
 * Deduplicated on the definition itself — its fragment encoding, which is the
 * canonical serialization — so running the same report five times leaves one
 * entry with the latest timestamp rather than five identical rows. That is what
 * makes a 20-entry history cover a session's work rather than its last minute.
 */
export function recordRecent(store: ReportStore, report: Report, now: number): ReportStore {
  const fragment = toFragment(report)
  const rest = store.recent.filter((entry) => toFragment(entry.report) !== fragment)
  const entry: SavedReport = {
    id: newId(now, store.recent.length),
    name: report.title?.trim() ?? '',
    at: now,
    report,
  }
  return { ...store, recent: [entry, ...rest].slice(0, RECENT_LIMIT) }
}

export function clearRecent(store: ReportStore): ReportStore {
  return { ...store, recent: [] }
}

/**
 * An id that is unique within this browser.
 *
 * Not `crypto.randomUUID`: this is a list key, it never leaves the origin, and
 * a timestamp with a discriminator is both sufficient and reproducible in a
 * test. The discriminator covers two entries created in the same millisecond,
 * which happens when a list is rewritten.
 */
function newId(now: number, salt: number): string {
  return `r${now.toString(36)}${salt.toString(36)}`
}
