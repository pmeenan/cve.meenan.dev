/**
 * Cancelling a running query, and saying that it is running (M3, implementing
 * D-052 §3 and its "M3 owns query feedback and cancellation" consequence).
 *
 * The problem is that the Worker owns the database and SQLite is synchronous:
 * while `db.exec` is inside SQLite, the Worker's event loop does not turn, so a
 * `postMessage({type:'cancel'})` sits in a queue that nothing will read until
 * the query it was meant to stop has finished. Terminating the Worker would
 * work and is unacceptable — it drops the sync access handle mid-statement, and
 * D-061's whole point is that the local copy survives failures.
 *
 * So the signal travels through memory rather than through the message queue: a
 * `SharedArrayBuffer` the page writes and the Worker reads from inside SQLite's
 * own progress handler (https://sqlite.org/c3ref/progress_handler.html), which
 * SQLite calls every `PROGRESS_OPS` virtual-machine instructions and which
 * aborts the statement with SQLITE_INTERRUPT when it returns non-zero. The same
 * callback is where "still running, 4.2 s" comes from, because it is the only
 * place that runs at all during a long query.
 *
 * `SharedArrayBuffer` needs cross-origin isolation, which this app already has
 * and depends on for the `opfs` VFS (D-030, D-051) — so a browser that can hold
 * the corpus can also cancel a query. Where it is missing, `newCancelFlag`
 * returns null and the UI says cancellation is unavailable rather than
 * offering a button that does nothing.
 */

/**
 * Virtual-machine instructions between progress callbacks.
 *
 * The trade is cancellation latency against the cost of crossing the WASM/JS
 * boundary. At the rate SQLite steps in WASM this is a callback every few
 * milliseconds, so a cancel lands within about a frame and the overhead stays
 * inside run-to-run noise — measured over the ten benchmark shapes at full
 * scale (M3's tuning pass) rather than assumed.
 *
 * The callback cannot help with time spent inside a *single* opcode: a large
 * sort or an fts5 match is one step of the VDBE, so a query can sit
 * uncancellable inside it. That is a real limit of this mechanism, not a bug in
 * this constant.
 */
export const PROGRESS_OPS = 50_000

/**
 * How often a running query says so. Fast enough to feel live, rare enough that
 * the reporting is not itself the work — the same reasoning as the index
 * build's 96 updates (lib/search.ts).
 */
export const QUERY_REPORT_MS = 250

/**
 * Below this, a query does not report at all: D-052 §3 puts the line at "roughly
 * a second", on the grounds that feedback below it is noise.
 */
export const QUERY_QUIET_MS = 700

/** One Int32 slot. Nothing else shares the buffer, so its layout is this line. */
const CANCEL_SLOT = 0

/**
 * A cancellation flag both threads can see, or null where `SharedArrayBuffer`
 * is unavailable.
 *
 * Created by the page and handed to the Worker, rather than the other way
 * round: the page is where the button is, and a Worker that never receives one
 * simply runs queries that cannot be cancelled — which is exactly the honest
 * degradation for a browser without cross-origin isolation.
 */
export function newCancelFlag(): Int32Array | null {
  if (typeof SharedArrayBuffer !== 'function') return null
  try {
    return new Int32Array(new SharedArrayBuffer(4))
  } catch {
    // Some environments expose the constructor and refuse to allocate; that is
    // a "no", not a crash.
    return null
  }
}

/** Ask the running query to stop. Safe to call when nothing is running. */
export function requestCancel(flag: Int32Array | null): void {
  if (flag) Atomics.store(flag, CANCEL_SLOT, 1)
}

/**
 * Clear the flag. The Worker calls this *before* every query, which is what
 * makes a stale click — one that arrived after the previous query had already
 * returned — unable to kill the next one.
 */
export function armCancel(flag: Int32Array | null): void {
  if (flag) Atomics.store(flag, CANCEL_SLOT, 0)
}

/** Read by the progress handler, thousands of times a second. */
export function cancelRequested(flag: Int32Array | null): boolean {
  return flag !== null && Atomics.load(flag, CANCEL_SLOT) !== 0
}

/**
 * SQLite's result code for a statement stopped by the progress handler. Part of
 * the stable ABI, and distinct from the authorizer's `SQLITE_DELETE`, which
 * happens to share the number in its own namespace.
 */
export const SQLITE_INTERRUPT = 9

/**
 * True for the error a cancelled statement raises.
 *
 * The oo1 wrapper carries `resultCode`, but a cancelled statement can also
 * surface through a path that only has a message, so the text is checked too.
 * Both are narrow enough that an unrelated failure cannot be mistaken for a
 * cancellation — which would report "cancelled" for a query that actually
 * broke.
 */
export function isInterrupt(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { resultCode?: unknown }).resultCode
  if (code === SQLITE_INTERRUPT) return true
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && /\binterrupt(ed)?\b/i.test(message)
}

/** `4.2 s` / `340 ms` — the elapsed figure a running query reports. */
export function elapsedLabel(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`
}
