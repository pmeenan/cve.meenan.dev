/**
 * The SQL console's read-only guarantee, as a SQLite authorizer (M3, and the
 * first instalment of D-044's tool-surface commitment).
 *
 * D-044 says the SQL surface is enforced "structurally (read-only connection or
 * SQLite authorizer), never by inspecting query text", and the plan repeats it:
 * not query-text inspection, and not the `query_only` pragma alone. Both of the
 * alternatives fail the same way — they are a filter in front of a parser, and
 * the parser is the thing that decides what the statement means. A denylist of
 * words loses to an inline comment splitting a keyword, to quoted identifiers,
 * to a second statement after a semicolon; `query_only` loses to
 * `PRAGMA query_only=OFF` in the same string it is guarding.
 *
 * The authorizer is not a filter in front of the parser. SQLite calls it *from*
 * the parser, once per action the statement will actually perform, with the
 * action already resolved to a code and its operands (see
 * https://sqlite.org/c3ref/set_authorizer.html). A statement that would write
 * is refused at prepare time with SQLITE_AUTH, and there is no spelling of a
 * write that does not produce a write action.
 *
 * Everything here is pure. The two drivers that install it — the WASM build in
 * the Worker and `node:sqlite` in the unit tests — pass the same action code
 * and operands in a different argument order, and `tests/unit/authorizer.test.ts`
 * runs the real thing against real SQLite rather than trusting this table.
 */

/**
 * SQLite's authorizer action codes.
 *
 * Part of SQLite's stable C ABI (`sqlite3.h`'s `SQLITE_CREATE_INDEX` block), so
 * naming them here rather than reading them from a driver keeps this module
 * driver-independent — and the test asserts our numbers against
 * `node:sqlite`'s own constants, so a drift would fail rather than silently
 * allow the wrong thing.
 */
export const ACTION = {
  CREATE_INDEX: 1,
  CREATE_TABLE: 2,
  CREATE_TEMP_INDEX: 3,
  CREATE_TEMP_TABLE: 4,
  CREATE_TEMP_TRIGGER: 5,
  CREATE_TEMP_VIEW: 6,
  CREATE_TRIGGER: 7,
  CREATE_VIEW: 8,
  DELETE: 9,
  DROP_INDEX: 10,
  DROP_TABLE: 11,
  DROP_TEMP_INDEX: 12,
  DROP_TEMP_TABLE: 13,
  DROP_TEMP_TRIGGER: 14,
  DROP_TEMP_VIEW: 15,
  DROP_TRIGGER: 16,
  DROP_VIEW: 17,
  INSERT: 18,
  PRAGMA: 19,
  READ: 20,
  SELECT: 21,
  TRANSACTION: 22,
  UPDATE: 23,
  ATTACH: 24,
  DETACH: 25,
  ALTER_TABLE: 26,
  REINDEX: 27,
  ANALYZE: 28,
  CREATE_VTABLE: 29,
  DROP_VTABLE: 30,
  FUNCTION: 31,
  SAVEPOINT: 32,
  RECURSIVE: 33,
} as const

/** The authorizer's own return codes. */
export const AUTH_OK = 0
export const AUTH_DENY = 1

/** Action code to name, for an error a person can act on. */
const ACTION_NAMES = new Map<number, string>(
  Object.entries(ACTION).map(([name, code]) => [code, name])
)

/**
 * What the console is allowed to do.
 *
 * `SELECT` is the statement itself; `READ` is one column of one table it touches;
 * `FUNCTION` is a scalar or aggregate call, which includes fts5's `bm25`,
 * `snippet` and `highlight`; `RECURSIVE` is a recursive CTE, which is read-only
 * and useful — and, being a legitimate way to write a query that never
 * finishes, is the reason cancellation ships in the same milestone.
 *
 * Everything else is denied, including the ones that look harmless. `ANALYZE`
 * and `REINDEX` write. `TRANSACTION` and `SAVEPOINT` do not, but they exist
 * only to wrap writes and a console that can open a transaction can hold a
 * lock the sync path then fails on. `PRAGMA` is the one that matters most:
 * denying it is what makes `PRAGMA query_only=OFF` — the flip that would undo
 * the older defence — a refusal rather than a re-arming. It is denied here and
 * re-admitted for exactly one read-only name in `ALLOWED_PRAGMAS`, which fts5
 * cannot work without.
 */
const ALLOWED = new Set<number>([ACTION.SELECT, ACTION.READ, ACTION.FUNCTION, ACTION.RECURSIVE])

/**
 * Pragmas the console may run, in their **query** form only.
 *
 * `PRAGMA` is denied wholesale above, and that is deliberate: it is what makes
 * `PRAGMA query_only=OFF` — the flip that would undo the older defence — a
 * refusal rather than a re-arming. But "wholesale" turned out to include a
 * pragma **fts5 issues by itself**: every fts5 query begins by reading
 * `data_version` to decide whether its cached configuration is still valid, so
 * denying it made *every* full-text query through the console fail with
 * "PRAGMA (data_version) is refused" — including the console's own
 * "Critical CVEs mentioning deserialization" example. Broken since M3 and
 * invisible until the D-046 benchmark ran an FTS query through this path,
 * because the app's own searches (Explore, Report) run unguarded and were
 * never affected.
 *
 * The allowlist is by name **and** by shape: a pragma with an argument is a
 * *setting*, so only the no-argument form is permitted. `data_version` is a
 * counter SQLite bumps when another connection commits; reading it discloses
 * nothing and changes nothing.
 */
const ALLOWED_PRAGMAS = new Set(['data_version'])

/**
 * Functions refused by name even though `FUNCTION` is allowed.
 *
 * None of these are registered in this build — `load_extension` is compiled out
 * and the file-system ones are the `sqlite3` CLI's, not the library's — so this
 * is redundant today and deliberately so: it is one line of defence against a
 * future build flag or a registered helper that quietly widens the surface, and
 * "no tool reaches the network or the filesystem" (D-044) is a permanent
 * commitment rather than a property of today's compile options.
 */
const DENIED_FUNCTIONS = new Set([
  'load_extension',
  'readfile',
  'writefile',
  'edit',
  'fts5_decode',
  'fts5_decode_none',
])

export interface Verdict {
  ok: boolean
  /** Present when denied: what was refused, in words the console shows. */
  reason?: string
}

/**
 * Decide one action.
 *
 * `arg1`/`arg2` are SQLite's operands for the action — for `READ` the table and
 * column, for `FUNCTION` the function name in `arg2` — and are only ever used
 * to *narrow* the verdict, never to widen it.
 */
export function authorize(code: number, arg1: string | null, arg2: string | null): Verdict {
  if (code === ACTION.FUNCTION) {
    const name = (arg2 ?? '').toLowerCase()
    if (DENIED_FUNCTIONS.has(name)) {
      return { ok: false, reason: `the function ${name}() is not available here` }
    }
    return { ok: true }
  }
  if (code === ACTION.PRAGMA) {
    const name = (arg1 ?? '').toLowerCase()
    // `arg2` is the pragma's argument. Absent means the read form; present
    // means someone is setting something, and nothing on the allowlist has a
    // setting worth permitting.
    if (ALLOWED_PRAGMAS.has(name) && (arg2 === null || arg2 === '')) return { ok: true }
    return { ok: false, reason: refusal(code, arg1) }
  }
  if (ALLOWED.has(code)) return { ok: true }
  return { ok: false, reason: refusal(code, arg1) }
}

/**
 * The message a refusal carries. It names the action rather than saying
 * "denied", because the console's whole job is to be usable: "this console is
 * read-only, so INSERT is refused" tells a person what to do next.
 */
function refusal(code: number, arg1: string | null): string {
  const name = ACTION_NAMES.get(code) ?? `action ${code}`
  const target = arg1 ? ` (${arg1})` : ''
  return `this console is read-only: ${name}${target} is refused by the database itself`
}

/**
 * How many rows the console returns before it stops asking for more.
 *
 * Lower than the filter surface's cap because the console can ask for anything:
 * every row is held in the Worker and structured-cloned to the page, so the cap
 * is a memory bound, not a display preference. Reaching it is reported, never
 * silent — a truncated result set that looks complete is the same class of
 * quiet wrongness as a missing state predicate (D-022).
 */
export const CONSOLE_ROW_LIMIT = 1_000

/**
 * Longest single cell the console renders, in characters.
 *
 * Descriptions run to tens of kilobytes and the corpus is hostile input (rule
 * 4): a `SELECT descr FROM cve_text` should not be able to lock the main thread
 * up laying out 400 MB of text. React escapes the content, so this is about
 * volume rather than markup.
 *
 * **This is a display cap and never was a memory bound.** It is applied by the
 * renderer, which is downstream of the Worker having already held the value and
 * structured-cloned it to the page. The bounds below are the memory ones.
 */
export const CONSOLE_CELL_CHARS = 2_000

/**
 * The largest single value a caller-supplied query may produce, in bytes.
 *
 * Applied as SQLite's own `SQLITE_LIMIT_LENGTH` on the connection, for the
 * duration of a guarded query only. That placement is the whole point: it is
 * the only bound that acts *before* the value exists, so
 * `SELECT group_concat(descr) FROM cve_text` — one row holding the entire text
 * table, and a plain read the authorizer allows because it is one — fails with
 * `SQLITE_TOOBIG` instead of being built, held and copied.
 *
 * Restored after every guarded query, including on the exception and
 * cancellation paths: left in place it would make the *sync* path fail on any
 * delta record larger than this, hours later and nowhere near the cause.
 */
export const MAX_GUARDED_CELL_BYTES = 1_048_576

/**
 * How many characters of result a caller-supplied query may retain.
 *
 * The row cap is not a memory bound, because a row can be any size:
 * `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1000)
 * SELECT hex(zeroblob(500000)) FROM n` lands exactly on `CONSOLE_ROW_LIMIT`
 * with a gigabyte behind it, and every byte of it is held in the Worker and
 * then cloned to the page — UTF-16 on both sides, so four times the figure.
 * Measured at 1.4 s to produce, against real SQLite under the real authorizer
 * policy, which allows it because it is a read.
 *
 * `MAX_GUARDED_CELL_BYTES` bounds one value; this bounds their sum. Both are
 * needed: a thousand values just under the per-value limit is a gigabyte.
 */
export const RESULT_CHAR_BUDGET = 8_000_000

/**
 * How long a caller-supplied query may run (D-044: "row-capped, timed-out").
 *
 * Enforced through SQLite's progress handler, which is the only code that runs
 * while a statement is executing — and which therefore inherits that
 * mechanism's documented limitation (lib/cancel.ts): a single long-running
 * opcode is not interruptible, so the deadline is checked between opcodes
 * rather than during one.
 *
 * Generous, because the corpus is 372k records and a legitimate cross-tab
 * through the link tables takes seconds. It is not a latency budget — D-052
 * removed those — it is the difference between a slow query and one that has
 * frozen the Worker, which serializes every other request behind it.
 */
export const TOOL_DEADLINE_MS = 60_000

/**
 * What one result row costs against `RESULT_CHAR_BUDGET`.
 *
 * Only strings and blobs count: numbers and nulls are fixed-size and counting
 * them would make the budget about column count rather than about bytes. Here
 * rather than inline in the Worker so it can be tested — the Worker is the one
 * module `pnpm check` cannot execute, and this is arithmetic that decides
 * whether a tab survives.
 */
export function rowCost(row: readonly unknown[]): number {
  let cost = 0
  for (const cell of row) {
    if (typeof cell === 'string') cost += cell.length
    else if (cell instanceof Uint8Array) cost += cell.byteLength
  }
  return cost
}
