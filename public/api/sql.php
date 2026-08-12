<?php

/**
 * The hosted query tier (D-084) — one read-only statement per request, run
 * against the server's copy of the published corpus.
 *
 * A visitor with no local copy sends the same SQL the local tier would have
 * run — compiled client-side from the same builders — plus its bound
 * parameters and a row limit, and gets rows back. "Make available offline"
 * retires this endpoint for that visitor.
 *
 * The posture is the chat relay's (D-057, `chat.php`): same-origin by the
 * absence of CORS headers (D-034), nginx rate limits keyed on the real
 * visitor (RE-031) plus a global concurrency cap (`nginx-sql.conf`), nothing
 * stored, nothing logged from here, no caller-supplied URL, path or ref —
 * the only file this endpoint can open is the one named below.
 *
 * **Every caller is untrusted and every statement is guarded.** The stack
 * mirrors the Worker's guarded path (D-078), measured on php:8.3 (D-084):
 *
 *   - read-only open of a file whose inode is never written — the publisher
 *     replaces it by atomic rename only (`pipeline/hosted.py`), which is what
 *     makes a plain `SQLITE3_OPEN_READONLY` sufficient. (SQLite's
 *     `immutable=1` would also skip locking, but PHP's binding takes no URI
 *     filenames — measured, not assumed: the constructor treats `file:…` as
 *     a literal path and fails to open.)
 *   - the M3 authorizer (`SQLite3::setAuthorizer`, PHP >= 8.0), the same
 *     decision table as `lib/authorizer.ts` — every action but reading is
 *     refused from inside SQLite's parser, including PRAGMA in all but its
 *     one fts5-required read form (RE-033). `tests/unit/hosted-parity.test.ts`
 *     holds the two tables equal.
 *   - `set_time_limit` — soft CPU limit plus `zend.hard_timeout` (Linux
 *     default 2 s) terminates a statement stuck inside a single
 *     `sqlite3_step()` at soft+2 s, measured six of six. The abort skips
 *     destructors, so the fpm pool's `pm.max_requests` recycling absorbs the
 *     leak; **verify `zend.hard_timeout` is non-zero on the origin.**
 *   - a retained-byte-and-cell budget in the row loop — the row cap is not a
 *     memory bound, because a row can be any size (D-078). This bounds what the
 *     response *retains and sends*, not what the engine transiently builds.
 *
 * **There is deliberately no in-engine memory bound (owner decision,
 * 2026-08-12, amends D-084).** `PRAGMA hard_heap_limit` was the only one PHP
 * offers — `memory_limit` never sees libsqlite3's `malloc`, and PHP has no
 * `sqlite3_limit` binding — but it is *process-global and a one-way ratchet*:
 * once set it can only be lowered, never raised or reset, so on the shared
 * php-fpm pool one request here would clamp every other endpoint and app on
 * the worker to 32 MB for the worker's whole life. A `length()`-wrapped value
 * bomb (`SELECT length(hex(zeroblob(1e8)))`, `length(group_concat(descr))`)
 * therefore runs to completion, spiking RSS to the value size — ~309 MB and
 * ~977 MB measured, up to ~concurrency× that. Accepted: the origin has 64 GB
 * and light load, the CPU deadline bounds how long such a spike lasts, and the
 * retained-byte budget bounds what actually reaches the client.
 *
 * The one guard that still verifies itself before caller SQL runs is the
 * authorizer: a missing/uninstallable one is a 503, not a silently unguarded
 * query (D-077's refuse-rather-than-guess).
 *
 * Like the relay, this file is deliberately the thinnest possible thing: it
 * cannot be unit-tested by `pnpm check` (no PHP runtime there), so everything
 * with a decision in it lives client-side in `lib/remote.ts` or is held equal
 * by the parity test, and this file is verified against a real PHP in a
 * container (`scripts/verify-sql-php.sh`) and against the live origin
 * (`tests/e2e/headers.spec.ts`).
 *
 * One statement per request, and only the first statement of the text:
 * `SQLite3::prepare` compiles the first and exposes no tail, so trailing
 * statements are dead text rather than an execution path. The client never
 * sends more than one.
 */

// --- configuration -----------------------------------------------------------

/**
 * The hosted database — corpus, FTS tables and KEV, built by
 * `pipeline/hosted.py` and replaced by atomic rename. Outside the docroot
 * (D-053): this path is nginx-unreachable and this endpoint never takes a
 * path from a caller. The env override exists for the container harness.
 */
define('DB_PATH', getenv('CVE_HOSTED_DB') ?: '/var/www/meenan.dev/cve.data/hosted/hosted.sqlite');

/** The one origin whose pages may call this (D-034). */
const ORIGIN = 'https://cve.meenan.dev';

/**
 * Request bounds. The client mirrors these in `lib/remote.ts` so oversized
 * requests fail there with a readable message; these are the enforcement.
 * A body is SQL text plus parameters: 64 KiB of SQL and 1,000 parameters fit
 * comfortably under 256 KiB.
 */
const MAX_BODY_BYTES = 262144;
const MAX_SQL_CHARS = 65536;
const MAX_PARAMS = 1000;
const MAX_PARAM_CHARS = 65536;

/**
 * Rows per response: the client asks for what its surface needs (a sentinel
 * above a chart cap, one row for a count) and this clamps it. 20,000 covers
 * the densest cross-tab the report surface can request; the byte budget below
 * is what actually bounds the response.
 */
const MAX_ROWS = 20000;

/**
 * Retained bytes across all cells, the D-078 budget. The local tier holds
 * 8,000,000 UTF-16 *characters*; bytes here are the stricter reading of the
 * same number, and what a JSON response body can be sized by.
 */
const RESULT_BYTE_BUDGET = 8000000;

/**
 * Largest single cell a result may retain, bytes — parity with the local
 * tier's `MAX_GUARDED_CELL_BYTES` (1 MiB, `lib/authorizer.ts`). The local tier
 * enforces it inside the engine via `SQLITE_LIMIT_LENGTH`; PHP's binding
 * exposes no such limit, so it is enforced in the row loop instead — an
 * over-cap cell stops collection rather than being held.
 */
const MAX_CELL_BYTES = 1048576;

/**
 * Soft CPU-seconds per statement; `zend.hard_timeout` adds its ~2 s hard stop
 * inside a wedged native call. Queries the app compiles run in milliseconds
 * at the server's cache temperatures; whole-corpus aggregates in the low
 * seconds. The cost ceiling per request is this plus the hard stop.
 */
const TIME_LIMIT_SECONDS = 4;

/**
 * The authorizer's decision table — `lib/authorizer.ts`, in PHP. Codes are
 * SQLite's stable C ABI; the class constants exist since the authorizer
 * binding landed in PHP 8.0, but the *policy* — which codes, which pragma,
 * which function names — is ours, and the parity test reads both files.
 */
const AUTH_ALLOWED = [
    SQLite3::SELECT => true,
    SQLite3::READ => true,
    SQLite3::FUNCTION => true,
    SQLite3::RECURSIVE => true,
];
const AUTH_ALLOWED_PRAGMAS = ['data_version' => true];
const AUTH_DENIED_FUNCTIONS = [
    'load_extension' => true,
    'readfile' => true,
    'writefile' => true,
    'edit' => true,
    'fts5_decode' => true,
    'fts5_decode_none' => true,
];

// --- helpers -----------------------------------------------------------------

/**
 * Fail with a single JSON object. Deliberately terse: the caller is a browser
 * on our own page, and a message that echoed back what it sent would be a
 * reflection surface for no benefit.
 */
function refuse(int $status, string $message): never
{
    http_response_code($status);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    echo json_encode(['error' => $message]), "\n";
    exit;
}

/**
 * A SQL-level failure is a 200 with an `error` field, mirroring how the local
 * tier surfaces one — in the result channel, not as transport failure. The
 * transport codes stay meaningful for the transport (403/405/413/429/503).
 */
function sqlError(string $message): never
{
    http_response_code(200);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    echo json_encode(['error' => $message]), "\n";
    exit;
}

// --- the validation ladder (chat.php's, without the streaming) ---------------

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    refuse(405, 'POST only');
}

// A mismatch is a real signal; an absent Origin is curl, which the nginx
// limits are for (see chat.php for the reasoning).
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '' && $origin !== ORIGIN) {
    refuse(403, 'cross-origin requests are not accepted');
}

$declared = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
if ($declared > MAX_BODY_BYTES) {
    refuse(413, 'request body is too large');
}

$body = file_get_contents('php://input', false, null, 0, MAX_BODY_BYTES + 1);
if ($body === false) {
    refuse(400, 'could not read the request body');
}
if (strlen($body) > MAX_BODY_BYTES) {
    refuse(413, 'request body is too large');
}

$in = json_decode($body, true, 8);
if (!is_array($in)) {
    refuse(400, 'body is not a JSON object');
}

// --- the payload is rebuilt, never trusted -----------------------------------

$sql = $in['sql'] ?? null;
if (!is_string($sql) || trim($sql) === '') {
    refuse(400, 'sql must be a non-empty string');
}
if (strlen($sql) > MAX_SQL_CHARS) {
    refuse(400, 'sql is too long');
}

$params = $in['params'] ?? [];
if (!is_array($params) || $params !== array_values($params)) {
    refuse(400, 'params must be an array');
}
if (count($params) > MAX_PARAMS) {
    refuse(400, 'too many parameters');
}
foreach ($params as $value) {
    // The compiled builders bind strings and numbers only (`SqlParam`); null
    // and everything else is refused rather than coerced.
    if (is_string($value)) {
        if (strlen($value) > MAX_PARAM_CHARS) {
            refuse(400, 'a parameter is too long');
        }
    } elseif (!is_int($value) && !is_float($value)) {
        refuse(400, 'parameters must be strings or numbers');
    }
}

$limit = $in['limit'] ?? 1000;
if (!is_int($limit) || $limit < 1) {
    refuse(400, 'limit must be a positive integer');
}
$limit = min($limit, MAX_ROWS);

// --- open, and verify the guards took ----------------------------------------

if (!class_exists('SQLite3') || !method_exists('SQLite3', 'setAuthorizer')) {
    // PHP < 8.0 or no sqlite3 extension: unguardable, so unavailable.
    refuse(503, 'the hosted query tier is unavailable');
}
if (!is_readable(DB_PATH)) {
    refuse(503, 'the hosted query tier is unavailable');
}

try {
    // Read-only is safe against the publisher because the publisher never
    // writes this inode: replacement is `os.replace` of a finished file, so a
    // connection that opened the old one keeps reading its unchanged bytes.
    // (`immutable=1` was the first choice and PHP's binding cannot express
    // it — no URI filenames; see the header and the container harness.)
    // The path is this file's own constant — never a caller's (D-006).
    $db = new SQLite3(DB_PATH, SQLITE3_OPEN_READONLY);
} catch (Throwable $e) {
    refuse(503, 'the hosted query tier is unavailable');
}
$db->enableExceptions(true);
$db->busyTimeout(0);

try {
    // Belt: the file is opened read-only; this refuses writes even if it were
    // not. The authorizer is what makes flipping it back off a refusal. It is
    // per-connection and reset when the connection closes, so unlike
    // `hard_heap_limit` (removed, owner decision — process-global and a one-way
    // ratchet, see the header) it never leaks to another request.
    $db->exec('PRAGMA query_only=ON');
} catch (Throwable $e) {
    refuse(503, 'the hosted query tier is unavailable');
}

/** Set by the authorizer when it denies, so the error can name the action. */
$denial = null;

$authorized = $db->setAuthorizer(function (int $action, ...$args) use (&$denial): int {
    if ($action === SQLite3::FUNCTION) {
        // For FUNCTION the name is the second operand, as in the C API.
        $name = strtolower((string) ($args[1] ?? ''));
        if (isset(AUTH_DENIED_FUNCTIONS[$name])) {
            $denial ??= "the function {$name}() is not available here";
            return SQLite3::DENY;
        }
        return SQLite3::OK;
    }
    if ($action === SQLite3::PRAGMA) {
        $name = strtolower((string) ($args[0] ?? ''));
        $argument = $args[1] ?? null;
        // The read form of exactly the pragma fts5 itself issues (RE-033).
        if (isset(AUTH_ALLOWED_PRAGMAS[$name]) && ($argument === null || $argument === '')) {
            return SQLite3::OK;
        }
        $denial ??= "this endpoint is read-only: PRAGMA ({$name}) is refused";
        return SQLite3::DENY;
    }
    if (isset(AUTH_ALLOWED[$action])) {
        return SQLite3::OK;
    }
    $denial ??= "this endpoint is read-only: action {$action} is refused by the database itself";
    return SQLite3::DENY;
});
if ($authorized !== true) {
    refuse(503, 'the hosted query tier is unavailable');
}

// --- run the one statement ---------------------------------------------------

// No `memory_limit` override — the pool's default applies (owner decision:
// use the default settings). It never sees libsqlite3's own allocations
// anyway; what it does bound, the request-copied result, is already held to
// the ~8 MB retained-byte budget below with a compact `JSON_UNESCAPED_UNICODE`
// encode. Being per-request, whatever it is set to does not leak.
set_time_limit(TIME_LIMIT_SECONDS);
$started = hrtime(true);

try {
    $statement = $db->prepare($sql);
} catch (Throwable $e) {
    sqlError($denial ?? $db->lastErrorMsg());
}
if ($statement === false) {
    sqlError($denial ?? $db->lastErrorMsg());
}

foreach ($params as $index => $value) {
    // 1-based positions; type from the value, never from the SQL.
    $type = is_string($value) ? SQLITE3_TEXT : (is_int($value) ? SQLITE3_INTEGER : SQLITE3_FLOAT);
    $statement->bindValue($index + 1, $value, $type);
}

try {
    $result = $statement->execute();
} catch (Throwable $e) {
    sqlError($denial ?? $db->lastErrorMsg());
}
if ($result === false) {
    sqlError($denial ?? $db->lastErrorMsg());
}

$columns = [];
$columnCount = $result->numColumns();
for ($i = 0; $i < $columnCount; $i++) {
    $columns[] = $result->columnName($i);
}

$rows = [];
$truncated = false;
$spent = 0;
// A stop by *size* rather than row count, reported distinctly so the client can
// say "fewer or shorter columns" instead of "capped at N rows" — the local
// tier's `overflowed` signal (D-078), which PHP would otherwise never send.
$overflowed = false;
try {
    while (($row = $result->fetchArray(SQLITE3_NUM)) !== false) {
        if (count($rows) >= $limit) {
            // One row beyond the limit is how "exactly limit rows" and
            // "capped" stay distinguishable — the same sentinel contract the
            // local tier's builders rely on.
            $truncated = true;
            break;
        }
        // The byte budget, checked before the row is kept (D-078): the row cap
        // bounds count, never size. Both the per-cell cap and the running sum
        // are checked here. This bounds what the response *retains and sends* —
        // `fetchArray` has already materialized the cell into PHP, so an
        // over-cap cell is dropped and collection stops rather than the value
        // being kept and cloned to the client. It is not an engine bound (there
        // is none — see the header); it is the analogue of the local tier's
        // `MAX_GUARDED_CELL_BYTES` for what leaves the endpoint.
        foreach ($row as $cell) {
            if (is_string($cell)) {
                if (strlen($cell) > MAX_CELL_BYTES) {
                    $truncated = true;
                    $overflowed = true;
                    break 2;
                }
                $spent += strlen($cell);
            }
        }
        if ($spent > RESULT_BYTE_BUDGET) {
            $truncated = true;
            $overflowed = true;
            break;
        }
        $rows[] = $row;
    }
} catch (Throwable $e) {
    // Interrupted mid-iteration — deadline, heap limit, a hostile value.
    sqlError($denial ?? $db->lastErrorMsg());
}

$ms = (int) round((hrtime(true) - $started) / 1e6);

// `JSON_UNESCAPED_UNICODE`: the corpus is UTF-8 and the client parses UTF-8, so
// escaping every non-ASCII code point to `\uXXXX` would inflate a legitimate
// result up to ~6× — past the byte budget that is supposed to bound the body,
// and into a transient encode buffer. Unescaped keeps the body ≈ the budgeted
// source size. `JSON_INVALID_UTF8_SUBSTITUTE`: a lossy cell beats a result that
// vanishes because one reference carried a stray byte (the corpus is validated,
// so this is defensive).
$body = ['columns' => $columns, 'rows' => $rows, 'truncated' => $truncated, 'ms' => $ms];
if ($overflowed) {
    $body['overflowed'] = true;
}
$payload = json_encode(
    $body,
    JSON_INVALID_UTF8_SUBSTITUTE | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
);
if ($payload === false) {
    sqlError('the result could not be encoded');
}

http_response_code(200);
header('Content-Type: application/json');
header('Cache-Control: no-store');
echo $payload, "\n";
