/**
 * Stall detection for the transfer paths (D-052, M2).
 *
 * D-052 removed every duration ceiling and replaced it with one distinction: a
 * *slow* transfer is legitimate and a *stalled* one is a failure. So the signal
 * here is never elapsed time — it is time since the last byte. A download that
 * takes an hour on a bad link keeps beating and keeps running; one that stops
 * receiving data is reported as stalled, with a message, instead of leaving a
 * bar that never moves.
 *
 * Polling rather than a one-shot timer per beat, for two reasons. Beats arrive
 * once per network read — thousands per chunk — and rearming a timer that often
 * is pure churn. And a Worker's timers are throttled in a background tab, which
 * makes "the timer fired" a fact about the scheduler rather than about the
 * network: measuring the gap when the tick *does* run is what makes throttling
 * cost detection latency instead of producing a false stall.
 *
 * What this cannot see is a synchronous stall: an OPFS write or an fts5 build
 * blocks the Worker thread, so no tick runs until it returns. That is why every
 * long synchronous step in the Worker beats immediately after it — otherwise
 * the first tick after a 58-second index build would measure the build and
 * report it as a stall.
 */

/**
 * How long without a byte counts as stalled.
 *
 * Sixty seconds is chosen against what it must not do: fire on a transfer that
 * is merely slow, or on a TCP retransmit, a server pause, a laptop that briefly
 * suspends. It is not a latency budget — a download may take as long as it
 * takes — so the cost of it being generous is only how late a genuinely dead
 * connection is reported.
 */
export const DEFAULT_STALL_MS = 60_000

/**
 * The floor a caller-supplied timeout is clamped to.
 *
 * The knob exists so a test can stall a transfer deterministically without
 * waiting a minute, and it arrives from a query string, so it is
 * attacker-influenced in the way any link is. The damage is bounded by
 * construction — the worst a crafted `?stall=1` can do is end a download early,
 * which leaves the live copy untouched (D-061) — but a floor keeps it from
 * being a value at which nothing can ever succeed.
 */
export const MIN_STALL_MS = 500

/** A ceiling, so a link cannot disable stall detection outright. */
export const MAX_STALL_MS = 600_000

export interface StallWatch {
  /** Record forward progress. Cheap enough to call per network read. */
  beat(): void
  /** Stop watching. Idempotent, and safe to call after a stall has fired. */
  stop(): void
}

export interface StallOptions {
  timeoutMs: number
  /** Called once, with the observed idle time, when the gap exceeds the timeout. */
  onStall(idleMs: number): void
  /** Injectable so the policy can be tested without waiting on a real clock. */
  now?: () => number
}

/**
 * How often to check. A quarter of the timeout keeps the report close to the
 * threshold, bounded so a long timeout does not mean a five-minute-late report
 * and a short one does not spin.
 */
function tickInterval(timeoutMs: number): number {
  return Math.min(Math.max(timeoutMs / 4, 100), 5_000)
}

/** Start watching for a gap in forward progress. */
export function watchForStalls(options: StallOptions): StallWatch {
  const now = options.now ?? (() => performance.now())
  let last = now()
  let done = false

  const timer = setInterval(() => {
    if (done) return
    const idle = now() - last
    if (idle < options.timeoutMs) return
    // Fires once: the caller's response is to abort the transfer, and a second
    // report of the same stall would race the error already on its way out.
    done = true
    clearInterval(timer)
    options.onStall(idle)
  }, tickInterval(options.timeoutMs))

  return {
    beat() {
      if (!done) last = now()
    },
    stop() {
      done = true
      clearInterval(timer)
    },
  }
}

/**
 * The error a stalled transfer reports.
 *
 * It says three things deliberately: that this is a stall rather than slowness
 * (the distinction D-052 exists for), how long nothing arrived, and what the
 * user still has — because the answer is "everything", and a failed transfer
 * that reads like data loss is its own kind of wrong.
 */
export function stallError(what: string, idleMs: number, recovery: string): Error {
  return new Error(
    `${what} stalled: nothing arrived for ${Math.round(idleMs / 1000)} s. ` +
      `This is a stalled transfer rather than a slow one. ${recovery}`
  )
}

/** Clamp a caller-supplied stall timeout into a range that can still succeed. */
export function stallTimeout(value: number | undefined): number {
  const ms = Math.trunc(Number(value))
  if (!Number.isFinite(ms) || ms < 1) return DEFAULT_STALL_MS
  return Math.min(Math.max(ms, MIN_STALL_MS), MAX_STALL_MS)
}
