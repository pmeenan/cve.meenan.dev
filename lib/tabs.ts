/**
 * Multi-tab behaviour (M5): one writer, every tab reading, and a replacement
 * that the tabs which did not perform it find out about.
 *
 * This is *full support* rather than honest degradation — an owner decision at
 * M5's decomposition — and it is only affordable because D-051 chose the `opfs`
 * VFS over `opfs-sahpool` precisely so a second tab could open the same
 * database. What that choice does **not** give is coordination, and there are
 * two separate problems here that look like one:
 *
 * 1. **Two writers.** A download in one tab and a sync in another are both
 *    write transactions against the same OPFS files, and a download
 *    additionally promotes a *different* file into place. Nothing in SQLite
 *    stops them; what stops them is a Web Lock, held for the whole operation.
 *    The second tab is told which operation is already running, because "please
 *    try again" is not an answer a person can act on.
 *
 * 2. **A stale reader.** A tab that was not the writer is left holding a
 *    connection to a file that has just been promoted *over* — a different OPFS
 *    entry is now the live one — and it would go on answering queries from the
 *    old generation indefinitely, with no error and a freshness line that
 *    disagrees with the tab next to it. A promotion is therefore announced, and
 *    a tab that hears one reopens.
 *
 * The channel is same-origin by construction (`BroadcastChannel` cannot cross
 * origins) and carries no record content — only revision numbers and an
 * operation name — so it adds no surface to D-007's data plane.
 */

/** The channel every tab of this origin shares. */
export const TAB_CHANNEL = 'cve-tabs'

/**
 * The Web Lock a writer holds for the whole of a download or a sync.
 *
 * One name for both, because they exclude each other as much as they exclude
 * themselves: a sync applying deltas to the live database while a download
 * promotes a different file over it is the worst of the four combinations.
 */
export const WRITER_LOCK = 'cve-writer'

/** Which write operation a tab is performing. */
export type WriterOp = 'download' | 'sync' | 'reset'

export type TabMessage =
  /** A writer started or finished, so other tabs can say what is happening. */
  | { type: 'writer'; op: WriterOp; state: 'start' | 'end' }
  /**
   * A download promoted a new generation. Any tab still holding the previous
   * slot open has to close it and reopen the live one — the file it has is not
   * merely stale, it is no longer the database.
   */
  | { type: 'promoted'; rev: number | null }
  /** A sync advanced the shared copy. Same file, new rows and a new watermark. */
  | { type: 'synced'; rev: number; generated: number | null }

/**
 * Validate a message off the channel.
 *
 * `BroadcastChannel` is same-origin, so this is not a trust boundary in the way
 * a delta file is — but it is still a message from code we did not just run,
 * possibly from a *different build* of the app during a deploy. A tab that
 * acted on `{type: 'promoted'}` from a future version's differently-shaped
 * message would close its database on a guess.
 */
export function parseTabMessage(value: unknown): TabMessage | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (raw.type === 'writer') {
    const op = raw.op
    const state = raw.state
    if (op !== 'download' && op !== 'sync' && op !== 'reset') return null
    if (state !== 'start' && state !== 'end') return null
    return { type: 'writer', op, state }
  }
  if (raw.type === 'promoted') {
    return { type: 'promoted', rev: typeof raw.rev === 'number' ? raw.rev : null }
  }
  if (raw.type === 'synced') {
    if (typeof raw.rev !== 'number') return null
    return {
      type: 'synced',
      rev: raw.rev,
      generated: typeof raw.generated === 'number' ? raw.generated : null,
    }
  }
  return null
}

/** What a tab tells the user when another tab holds the writer lock. */
export function busyMessage(op: WriterOp | null): string {
  const what =
    op === 'download'
      ? 'Another tab is downloading the corpus'
      : op === 'sync'
        ? 'Another tab is syncing'
        : op === 'reset'
          ? 'Another tab is clearing the local copy'
          : 'Another tab is downloading or syncing'
  return (
    `${what}. Only one tab can write to the local copy at a time, so this one is ` +
    'leaving it alone. You can keep querying here while it finishes; when it does, this tab ' +
    'picks up the result by itself.'
  )
}
