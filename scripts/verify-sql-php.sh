#!/usr/bin/env bash
# Verify public/api/sql.php against a real PHP runtime (D-084).
#
# `pnpm check` cannot execute PHP, so the endpoint's behaviour — the
# validation ladder, the authorizer, the heap limit, the CPU deadline, the
# immutable open — is proven here instead: a fixture hosted database is built
# by the real pipeline code, php's own dev server serves the real sql.php in
# the official php:8.3-cli container, and a PHP client drives the cases.
#
# Opt-in, like MEASURE and BENCH: it needs docker and ~a minute. Run it after
# touching sql.php, hosted.py, or lib/remote.ts's contract:
#
#     bash scripts/verify-sql-php.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
IMAGE=php:8.3-cli

echo "== building the fixture hosted database (real pipeline code)"
python3 - "$WORK" <<'PYEOF'
import os, sys
work = sys.argv[1]
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))) if '__file__' in dir() else '.', 'pipeline'))
sys.path.insert(0, 'pipeline')
sys.path.insert(0, 'pipeline/tests')
import fixtures, hosted
import kev as kev_module
artifact = fixtures.build_artifact(work, fixtures.corpus_v1(), "v1", rev=1)
pub = os.path.join(work, "pub"); os.makedirs(pub)
kev_module.sample(artifact, os.path.join(pub, "kev.json"), limit=10)
report = hosted.build(artifact, pub, os.path.join(work, "hosted.sqlite"))
print(f"   built {report['out']} ({report['bytes']} bytes)")
PYEOF

cp "$ROOT/public/api/sql.php" "$WORK/sql.php"
mkdir -p "$WORK/docroot/api"
cp "$ROOT/public/api/sql.php" "$WORK/docroot/api/sql.php"

cat > "$WORK/client.php" <<'CLIENTEOF'
<?php
// The verification client. Each case is (name, request, assertion).
$base = $argv[1];
$fails = 0;

function post(string $base, string $body, array $headers = []): array
{
    $lines = array_merge(['Content-Type: application/json'], $headers);
    $context = stream_context_create(['http' => [
        'method' => 'POST',
        'header' => implode("\r\n", $lines),
        'content' => $body,
        'ignore_errors' => true,
        'timeout' => 30,
    ]]);
    $text = file_get_contents($base, false, $context);
    $status = 0;
    foreach ($http_response_header ?? [] as $line) {
        if (preg_match('#^HTTP/\S+ (\d+)#', $line, $hit)) $status = (int) $hit[1];
    }
    return [$status, $text === false ? '' : $text];
}

function sql(string $base, string $sql, array $params = [], int $limit = 100): array
{
    return post($base, json_encode(['sql' => $sql, 'params' => $params, 'limit' => $limit]));
}

function check(string $name, bool $ok, string $detail = ''): void
{
    global $fails;
    if ($ok) {
        echo "   ok: {$name}\n";
    } else {
        $fails++;
        echo "  FAIL: {$name} — {$detail}\n";
    }
}

// --- transport ladder ---------------------------------------------------------
$context = stream_context_create(['http' => ['method' => 'GET', 'ignore_errors' => true]]);
file_get_contents($base, false, $context);
$status = 0;
foreach ($http_response_header ?? [] as $line) {
    if (preg_match('#^HTTP/\S+ (\d+)#', $line, $hit)) $status = (int) $hit[1];
}
check('GET is 405', $status === 405, "got {$status}");

[$status, ] = post($base, '{"sql":"SELECT 1"}', ['Origin: https://evil.example']);
check('cross-origin is 403', $status === 403, "got {$status}");

[$status, ] = post($base, '{"sql":"SELECT 1"}', ['Origin: https://cve.meenan.dev']);
check('the real origin is accepted', $status === 200, "got {$status}");

[$status, ] = post($base, str_repeat('x', 300000));
check('an oversized body is 413', $status === 413, "got {$status}");

[$status, ] = post($base, 'not json');
check('a non-JSON body is 400', $status === 400, "got {$status}");

[$status, ] = post($base, '{"sql": 42}');
check('a non-string sql is 400', $status === 400, "got {$status}");

[$status, ] = post($base, '{"sql": "SELECT ?", "params": [null]}');
check('a null parameter is 400', $status === 400, "got {$status}");

// --- results ------------------------------------------------------------------
[$status, $text] = sql($base, 'SELECT 1 AS one, ? AS two', ['x']);
$out = json_decode($text, true);
check('a SELECT answers with columns and rows',
    $status === 200 && $out['columns'] === ['one', 'two'] && $out['rows'] === [[1, 'x']],
    $text);

[, $text] = sql($base, "SELECT v FROM meta WHERE k = 'schema'");
$out = json_decode($text, true);
check('the meta table answers (hosted probe shape)',
    is_int($out['rows'][0][0] ?? null), $text);

[, $text] = sql($base, "SELECT count(*) FROM fts WHERE fts MATCH 'the'");
$out = json_decode($text, true);
check('an fts5 MATCH answers (RE-033: data_version pragma admitted)',
    isset($out['rows'][0][0]) && !isset($out['error']), $text);

[, $text] = sql($base, 'SELECT count(*) FROM kev JOIN cve ON cve.id = kev.cve_id');
$out = json_decode($text, true);
check('the kev overlay is present and joins', ($out['rows'][0][0] ?? 0) > 0, $text);

[, $text] = sql($base, 'SELECT id FROM cve ORDER BY id', [], 1);
$out = json_decode($text, true);
check('the row limit truncates and says so',
    count($out['rows'] ?? []) === 1 && $out['truncated'] === true, $text);

[, $text] = sql($base, 'SELECT 1; DROP TABLE meta');
$out = json_decode($text, true);
check('a trailing second statement is dead text',
    ($out['rows'][0][0] ?? null) === 1 && !isset($out['error']), $text);

[, $text] = sql($base, 'SELECT hex(zeroblob(2000000))');
$out = json_decode($text, true);
check('an over-cap single cell overflows, distinct from a row cap',
    ($out['truncated'] ?? false) === true && ($out['overflowed'] ?? false) === true, $text);

[, $text] = sql($base, "SELECT 'caf\xc3\xa9' AS s");
check('non-ASCII is not \\u-escaped (JSON_UNESCAPED_UNICODE)',
    str_contains($text, 'caf') && !str_contains($text, '\\u00e9'), $text);

// --- the guards ---------------------------------------------------------------
[, $text] = sql($base, "INSERT INTO meta(k, v) VALUES('x', 'y')");
$out = json_decode($text, true);
check('INSERT is refused by the authorizer, by name',
    str_contains($out['error'] ?? '', 'read-only'), $text);

[, $text] = sql($base, 'PRAGMA hard_heap_limit=33554432');
$out = json_decode($text, true);
check('a caller PRAGMA is refused by the authorizer',
    str_contains($out['error'] ?? '', 'PRAGMA'), $text);

[, $text] = sql($base, "ATTACH DATABASE '/tmp/x.db' AS x");
$out = json_decode($text, true);
check('ATTACH is refused', str_contains($out['error'] ?? '', 'read-only'), $text);

[, $text] = sql($base, 'PRAGMA query_only=OFF');
$out = json_decode($text, true);
check('query_only cannot be flipped', str_contains($out['error'] ?? '', 'PRAGMA'), $text);

[, $text] = sql($base, 'SELECT load_extension(?)', ['x']);
$out = json_decode($text, true);
check('load_extension is refused by name',
    str_contains($out['error'] ?? '', 'not available'), $text);

// There is no in-engine memory bound (owner decision, D-084): a length-wrapped
// value bomb runs to completion, spiking RSS to the value size. What is asserted
// is that it does NOT error out artificially and the worker survives it — the
// accepted behavior, on a 64 GB box. The deadline (below) is what bounds cost.
[, $text] = sql($base, 'SELECT length(hex(zeroblob(50000000)))');
$out = json_decode($text, true);
check('a value bomb completes rather than being capped in-engine',
    ($out['rows'][0][0] ?? null) === 100000000 && !isset($out['error']), $text);

$before = microtime(true);
[$status, $text] = sql($base,
    'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c');
$elapsed = microtime(true) - $before;
check('an infinite statement is terminated by the deadline',
    $status !== 200 || json_decode($text, true) === null || isset(json_decode($text, true)['error']),
    "status {$status} after {$elapsed}s: " . substr($text, 0, 120));
check('…within the budget', $elapsed < 12, "took {$elapsed}s");

// The hard timeout exits the PHP worker process (exit 124 — the measured
// behaviour D-084 records). Under php-fpm the pool master replaces the
// worker; php -S has no master, so the harness restarts it and the outer
// script asserts the post-kill liveness that fpm provides in production.

exit($fails === 0 ? 0 : 1);
CLIENTEOF

echo "== driving sql.php in $IMAGE"
docker run --rm -v "$WORK":/w --memory=512m "$IMAGE" sh -c '
  CVE_HOSTED_DB=/w/hosted.sqlite php -d zend.hard_timeout=2 -S 127.0.0.1:8080 -t /w/docroot >/dev/null 2>&1 &
  for i in $(seq 1 50); do php -r "exit(@fsockopen(\"127.0.0.1\", 8080) ? 0 : 1);" && break; sleep 0.1; done
  php /w/client.php http://127.0.0.1:8080/api/sql.php
  CODE=$?
  echo "== the fpm-respawn stand-in: restart and assert the tier answers again"
  CVE_HOSTED_DB=/w/hosted.sqlite php -d zend.hard_timeout=2 -S 127.0.0.1:8082 -t /w/docroot >/dev/null 2>&1 &
  for i in $(seq 1 50); do php -r "exit(@fsockopen(\"127.0.0.1\", 8082) ? 0 : 1);" && break; sleep 0.1; done
  php -r "
    \$ctx = stream_context_create([\"http\" => [\"method\" => \"POST\",
      \"header\" => \"Content-Type: application/json\",
      \"content\" => \"{\\\"sql\\\":\\\"SELECT 1\\\"}\", \"ignore_errors\" => true]]);
    \$t = file_get_contents(\"http://127.0.0.1:8082/api/sql.php\", false, \$ctx);
    \$ok = str_contains((string) \$t, \"[[1]]\");
    echo \$ok ? \"   ok: a fresh worker answers after the kill\n\" : \"  FAIL: \$t\n\";
    exit(\$ok ? 0 : 1);
  "
  CODE=$((CODE + $?))
  echo "== 503 when the database is unreadable"
  CVE_HOSTED_DB=/w/missing.sqlite php -S 127.0.0.1:8081 -t /w/docroot >/dev/null 2>&1 &
  for i in $(seq 1 50); do php -r "exit(@fsockopen(\"127.0.0.1\", 8081) ? 0 : 1);" && break; sleep 0.1; done
  php -r "
    \$ctx = stream_context_create([\"http\" => [\"method\" => \"POST\",
      \"header\" => \"Content-Type: application/json\",
      \"content\" => \"{\\\"sql\\\":\\\"SELECT 1\\\"}\", \"ignore_errors\" => true]]);
    file_get_contents(\"http://127.0.0.1:8081/api/sql.php\", false, \$ctx);
    \$s = 0; foreach (\$http_response_header as \$l) if (preg_match(\"#^HTTP/\\S+ (\\d+)#\", \$l, \$m)) \$s = (int) \$m[1];
    echo \$s === 503 ? \"   ok: missing database is 503\n\" : \"  FAIL: got \$s\n\";
    exit(\$s === 503 ? 0 : 1);
  "
  exit $((CODE + $?))
'
echo "== verify-sql-php: all cases passed"
