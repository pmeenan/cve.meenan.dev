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
 * the older defence — a refusal rather than a re-arming.
 */
const ALLOWED = new Set<number>([ACTION.SELECT, ACTION.READ, ACTION.FUNCTION, ACTION.RECURSIVE])

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
 */
export const CONSOLE_CELL_CHARS = 2_000
