/**
 * How old the local copy's data is, and whether that is worth saying out loud
 * (M2 freshness).
 *
 * Sync is manual after the first one (D-025), so nothing stops a user sitting
 * on a month-old corpus and getting confident-looking counts out of it — the
 * quiet wrongness vision criterion 7 is about. The indicator is the guard, and
 * it reads the *data's* age rather than the app's: `meta.generated` is the
 * moment the pipeline built the revision this copy holds, it travels with every
 * delta (D-058 §4a made it one value per revision), and it is therefore the
 * same number whether the copy was downloaded or synced to that revision.
 *
 * What this deliberately does **not** claim is that the origin has something
 * newer. Knowing that needs a manifest fetch, and `status` performs no network
 * request — that is what keeps a reopen working offline (D-048). So the verdict
 * is about age, and the prompt is to check rather than an assertion that there
 * is something to fetch.
 */

/** Milliseconds in the units this reports in. */
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * When an age becomes worth flagging.
 *
 * The pipeline publishes daily (D-058), so data more than two days old means at
 * least one publication has come and gone without this copy taking it — either
 * because the user has not synced, or because the origin stopped advancing.
 * Both are things the user should be told; which one it is takes a manifest,
 * which is what the Sync button is for.
 */
export const STALE_AFTER_MS = 2 * DAY

/**
 * The same question for the KEV catalog, and a different answer (M6).
 *
 * CISA publishes about *business*-daily, not daily, so a catalog released on a
 * Friday is three days old by Monday morning with nothing wrong and nothing to
 * fetch — and the corpus's two-day threshold would paint it red every weekend.
 * A week plus slack is the point at which "CISA has published nothing" stops
 * being an ordinary gap and starts being worth checking. Borrowing the corpus's
 * number would have been the quiet kind of wrong: a warning that fires on
 * schedule teaches people to ignore the warning.
 */
export const KEV_STALE_AFTER_MS = 8 * DAY

export interface Freshness {
  /** Milliseconds since the data was built, clamped at zero. */
  ageMs: number
  /** ISO-8601, for a `datetime` attribute and for a test to read. */
  iso: string
  /** "4 hours old", "3 days old" — the phrase the indicator renders. */
  age: string
  /** Past `STALE_AFTER_MS`, so the UI says so rather than only reporting it. */
  stale: boolean
}

/**
 * Describe the age of data built at `generated` (unix *seconds*, as `meta`
 * stores it), or `null` when there is no usable timestamp to describe.
 *
 * A timestamp in the future is clamped to "just now" rather than rendered as a
 * negative age: a client clock behind the server's is ordinary, and there is
 * nothing to warn about — the data is newer than this machine thinks now is.
 */
export function describeFreshness(
  generated: unknown,
  nowMs: number,
  staleAfterMs: number = STALE_AFTER_MS
): Freshness | null {
  if (typeof generated !== 'number' || !Number.isFinite(generated) || generated <= 0) return null
  const builtMs = generated * 1000
  if (!Number.isFinite(builtMs)) return null
  const ageMs = Math.max(0, nowMs - builtMs)
  return {
    ageMs,
    iso: new Date(builtMs).toISOString(),
    age: describeAge(ageMs),
    stale: ageMs > staleAfterMs,
  }
}

/**
 * Coarse on purpose. The useful question is "is this today's data or last
 * month's", and a copy whose age is reported to the minute invites reading
 * precision into a number that is really "when the pipeline last ran".
 */
function describeAge(ageMs: number): string {
  if (ageMs < HOUR) return 'less than an hour old'
  if (ageMs < DAY) return plural(Math.floor(ageMs / HOUR), 'hour', 'hours') + ' old'
  return plural(Math.floor(ageMs / DAY), 'day', 'days') + ' old'
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`
}
