/**
 * Turn a parameterized query and its bound values into one runnable statement,
 * for handing a report's backing SQL to the console drawer.
 *
 * The report path binds every user value as a parameter (lib/filters.ts) and
 * that stays true — this function runs on the *display* side only, producing
 * text for a human to read and edit. What it must not do is let a bound string
 * break out of its literal, so strings are quoted with SQLite's own convention
 * (double the quote) and everything else is refused unless it is a finite
 * number. The result still runs under the console's authorizer like anything
 * else a person types.
 */
export function inlineSql(sql: string, params: readonly (string | number)[]): string {
  let at = 0
  const out = sql.replace(/\?/g, () => {
    const value = params[at]
    at += 1
    if (value === undefined) return '?'
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
    return `'${value.replace(/'/g, "''")}'`
  })
  return out
}
