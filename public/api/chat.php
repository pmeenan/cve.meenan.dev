<?php

/**
 * The chat relay (M7, D-057) — the one dynamic endpoint in this project, and
 * the only code here that is not a static file.
 *
 * It relays a chat completion to an Ollama instance on the private network at
 * http://llm:11434/ and streams the answer back. It is deliberately the
 * thinnest thing that can do that, for two reasons: D-006's rules bound what a
 * dynamic endpoint may be, and every line of logic here is a line that cannot
 * be unit-tested the way the rest of this project is. Normalising the stream
 * into the shape the chat loop wants happens in TypeScript (`lib/chat.ts`),
 * where it has tests; this forwards upstream's NDJSON lines unchanged.
 *
 * What it will not do, structurally rather than by checking:
 *
 *   - **No caller-supplied model, URL, host or path.** UPSTREAM and MODEL are
 *     constants. There is one operation — chat completion — because there is
 *     one URL in this file, and nothing the caller sends is concatenated into
 *     it. Ollama's model management, pull and embeddings endpoints are not
 *     reachable through here because nothing here can name them.
 *   - **No caller-supplied system prompt or tools.** Both are pinned from
 *     `surface.php`, generated at build time from `lib/chat.ts` and
 *     `lib/tools.ts` (`scripts/build-surface.mjs`). This is what stops the
 *     endpoint being a free general-purpose assistant: whatever is posted to
 *     it, it answers as the CVE analyst with the five read-only tools, and a
 *     caller who wants a poem gets a model trying to query a vulnerability
 *     database. A `system` message in the request is **refused**, not ignored,
 *     because silently dropping it would let a caller believe they had changed
 *     the behaviour.
 *   - **No storage.** Nothing is written to disk, to a session, or to a log.
 *     The nginx access log records that the endpoint was hit — its log_format
 *     carries $request, not $request_body — and this script adds nothing.
 *   - **No CORS headers**, which is how same-origin is enforced on this origin
 *     (D-034). The Origin check below is a second line, not the first: it can
 *     only refuse, never permit, and a caller that sends no Origin is left to
 *     the nginx rate and connection limits, because absence-of-CORS stops
 *     cross-site browsers and not curl (D-057).
 *   - **No unbounded anything.** POST only, a capped body, a capped message
 *     count, a capped per-message length, a capped generation, and a capped
 *     wall clock. A GPU box serving one small model is the scarce resource
 *     being protected.
 *
 * Streaming through php-fpm is not free and the three things that make it work
 * were measured, not assumed (the D-057 experiment, 2026-08-08): PHP's own
 * output_buffering has to be unwrapped, `X-Accel-Buffering: no` is what turns
 * nginx's fastcgi buffering off for this response, and the content type has to
 * stay out of nginx's gzip_types. Together they put the first token in the
 * browser 405-431 ms after the request, against 336-368 ms at this process.
 */

declare(strict_types=1);

/** The private box. Not routable from the internet, and not caller-supplied. */
const UPSTREAM = 'http://llm:11434/api/chat';

/**
 * Server-pinned (D-057). Swapping it is operational configuration, and this
 * swap is the D-046 benchmark doing the job it exists for.
 *
 * `qwen3:8b` replaced `gemma4:e4b` on 2026-08-09 on measured tool-calling
 * quality, not on reputation: 6/6 against 0/6 on benchmark item #2, 6/6 against
 * 3/6 on choosing the SQL tool, identical on item #1 — at 5.2 GB against
 * 9.6 GB and the same ~1.25 s warm latency. It advertises `tools` and
 * `thinking`, which the chat loop uses. Notably `qwen3:14b` is *worse* on item
 * #2 and three times slower, so this is not "bigger is better".
 */
const MODEL = 'qwen3:8b';

/** The origin this endpoint belongs to. A different one is somebody else's page. */
const ORIGIN = 'https://cve.meenan.dev';

const MAX_BODY_BYTES     = 262144;   // 256 KB: a long conversation with tool results
const MAX_MESSAGES       = 64;
const MAX_MESSAGE_CHARS  = 65536;
const MAX_TOOLS          = 12;

/**
 * The generation budget for one model call — **thinking included**.
 *
 * Raised from 2,048 on 2026-08-09, because thinking spends it: 6 of 68
 * on-topic probes hit the cap mid-thought and returned `done_reason: length`
 * with neither a tool call nor prose, which the client can only report as "the
 * model returned nothing at all". A ~9% silent-failure rate on a budget that
 * exists to bound cost, not to end answers.
 *
 * 8,192 rather than more, bounded by the two limits either side of it:
 *
 *   - **Wall clock.** Decode measured 126 tok/s idle on this box, and ~82 tok/s
 *     per stream with both `OLLAMA_NUM_PARALLEL` slots busy. 8,192 is ~65 s
 *     idle and ~100 s loaded, inside `TIMEOUT_SECONDS`. 16,384 would be ~205 s
 *     loaded — past the timeout, so the tail would fail as a dropped
 *     connection rather than as a long answer.
 *   - **Context.** This is added to the prompt, not carved out of it. A turn
 *     carrying an aggregate result is ~5,300 tokens and a six-round
 *     conversation more, so 8,192 leaves room inside `NUM_CTX`. Exceeding it
 *     does not error and does not stop: measured 2026-08-09, a conversation
 *     of 30 exchanges was accepted with `prompt_eval_count` pinned at 29,743
 *     however much more was posted. The **system prompt survives** — a
 *     sentinel planted in it was still recalled at 30 exchanges — so what
 *     goes is the oldest conversation, silently and with no field saying so.
 *
 * The cost is that a runaway thought now occupies a slot four times as long,
 * and there are two slots. `TIMEOUT_SECONDS` is the backstop for that, which is
 * the right place for it: a bound on time, not on the length of an answer.
 */
const MAX_PREDICT        = 8192;

/**
 * The pinned prompt and tool schemas, beside this file in the export root.
 *
 * A `.php` file returning a JSON string, not a `.json` one: the docroot is
 * served, and a direct request for this executes it and yields nothing rather
 * than handing over the system prompt.
 */
const SURFACE_FILE = __DIR__ . '/surface.php';

/**
 * The context window to ask for, rather than inheriting the box's default.
 *
 * Measured 2026-08-08: the system prompt plus the five tool schemas is ~3,500
 * tokens *before the question*, and one turn carrying an aggregate result is
 * ~5,300. A six-round conversation goes well past that. Ollama's own default is
 * 4,096 unless `OLLAMA_CONTEXT_LENGTH` says otherwise — this box sets 32,768,
 * so nothing is being truncated today, and that is exactly the problem: the
 * relay would silently start dropping the oldest messages, schema and all, if
 * the box were ever rebuilt without that variable. Asking explicitly makes the
 * app say what it needs instead of depending on somebody's systemd unit.
 *
 * 32,768 is a **measured pairing with `OLLAMA_NUM_PARALLEL=2` on the box**, not
 * an arbitrary number, and the two have to move together: the KV cache is
 * allocated per slot, so the context this asks for is multiplied by the number
 * of slots. A cache that does not fit does not fail — it silently spills to
 * CPU and everything gets slow.
 *
 * Measured on the 12 GB card, 512-token thinking turns:
 *
 *   1 slot  × 40,960 →  8.3 GB, 100% GPU, 4.7 s single,  0.21 req/s at N=4
 *   2 slots × 40,960 → 12.0 GB, *89% GPU*, 11.3 s single, 0.14 req/s  ← spilled
 *   2 slots × 32,768 → 10.0 GB, 100% GPU, 4.66 s single, 0.32 req/s
 *
 * So two slots cost nothing in single-request latency and buy ~52% throughput,
 * because decode is memory-bandwidth-bound and a second sequence rides along
 * on weights already being read. 40,960 (the model's native maximum) is what
 * had to give, and 32,768 is ample: a first turn is ~3,500 tokens and a turn
 * carrying an aggregate result ~5,300, so six rounds plus `thinking` sit well
 * inside it.
 *
 * **Raising this above 32,768 without dropping to one slot puts the model back
 * on the CPU.** The relay states the value rather than inheriting
 * `OLLAMA_CONTEXT_LENGTH` so the pairing is visible here, next to the code that
 * depends on it.
 */
const NUM_CTX           = 32768;
const MAX_UPSTREAM_BYTES = 8388608;  // 8 MB of NDJSON is far past any real answer
const TIMEOUT_SECONDS    = 180;

/**
 * Fail with a single JSON object and no stream.
 *
 * Deliberately terse: the caller is a browser on our own page, and a message
 * that echoed back what it sent would be a reflection surface for no benefit.
 */
function refuse(int $status, string $message): never
{
    http_response_code($status);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    echo json_encode(['error' => $message]), "\n";
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    refuse(405, 'POST only');
}

// Second line, not the first. Browsers send Origin on every same-origin POST,
// so a *mismatch* is a real signal; an absent one is curl, which the nginx
// limits are for. Refusing on absence would be trading a defence we do not
// have for a breakage we would not notice.
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '' && $origin !== ORIGIN) {
    refuse(403, 'cross-origin requests are not accepted');
}

// Content-Length first, so an oversized body is refused before it is read.
$declared = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
if ($declared > MAX_BODY_BYTES) {
    refuse(413, 'request body is too large');
}

// One byte past the cap, so a chunked body that lied about its length is caught
// by what actually arrived rather than by what it claimed.
$body = file_get_contents('php://input', false, null, 0, MAX_BODY_BYTES + 1);
if ($body === false) {
    refuse(400, 'could not read the request body');
}
if (strlen($body) > MAX_BODY_BYTES) {
    refuse(413, 'request body is too large');
}

$in = json_decode($body, true, 32);
if (!is_array($in)) {
    refuse(400, 'body is not a JSON object');
}

// --- the payload is rebuilt, never forwarded ---------------------------------
//
// Every field below is one this file chose. Anything else the caller sent —
// `model`, `keep_alive`, `format`, a different `stream` — is not copied, so it
// cannot reach Ollama at all. That is the difference between a relay and a
// proxy, and it is the whole of D-057's "none of the rest of Ollama's API".

$messages = $in['messages'] ?? null;
if (!is_array($messages) || $messages === [] || count($messages) > MAX_MESSAGES) {
    refuse(400, 'messages must be a list of 1 to ' . MAX_MESSAGES . ' entries');
}

$clean = [];
foreach ($messages as $message) {
    if (!is_array($message)) {
        refuse(400, 'each message must be an object');
    }
    $role = $message['role'] ?? '';
    if (!in_array($role, ['user', 'assistant', 'tool'], true)) {
        refuse(400, 'each message needs a role of user, assistant or tool');
    }
    $content = $message['content'] ?? '';
    if (!is_string($content) || strlen($content) > MAX_MESSAGE_CHARS) {
        refuse(400, 'message content must be a string of at most ' . MAX_MESSAGE_CHARS . ' bytes');
    }
    $entry = ['role' => $role, 'content' => $content];

    // A tool round trip needs two more fields, and only in the roles that can
    // carry them: the assistant turn that asked, and the tool turn answering.
    if ($role === 'assistant' && isset($message['tool_calls']) && is_array($message['tool_calls'])) {
        $entry['tool_calls'] = array_slice($message['tool_calls'], 0, MAX_TOOLS);
    }
    if ($role === 'tool' && isset($message['tool_name']) && is_string($message['tool_name'])) {
        $entry['tool_name'] = substr($message['tool_name'], 0, 64);
    }
    $clean[] = $entry;
}

// The pinned surface. Read here rather than embedded above so it stays
// generated from the TypeScript the client validates against.
$raw = is_readable(SURFACE_FILE) ? require SURFACE_FILE : null;
$surface = is_string($raw) ? json_decode($raw, true, 32) : null;
if (!is_array($surface) || !is_string($surface['system'] ?? null) || !is_array($surface['tools'] ?? null)) {
    // Fail closed. Running without the pinned prompt would silently turn this
    // into the general-purpose endpoint the pinning exists to prevent.
    refuse(503, 'the chat surface is not available on this server');
}

// Today's date, written into the pinned prompt here because this is the only
// part of the path that knows it. The prompt is generated once per build and
// deploys are not daily, so a literal date would be stale the day after it
// shipped — and stale here is invisible: the model resolves "this year" against
// it and answers confidently. Measured 2026-08-09, with no date at all, "the
// last two years" was filtered as 2021-2023 in 2 of 3 probes.
//
// Server-side, not caller-supplied, like everything else in this payload: a
// caller who could set the date could move the corpus's present.
$system = str_replace('{{TODAY}}', gmdate('Y-m-d'), $surface['system']);

$payload = [
    'model'    => MODEL,
    'stream'   => true,
    // Ours, always first, and not negotiable.
    'messages' => array_merge([['role' => 'system', 'content' => $system]], $clean),
    'tools'    => array_slice($surface['tools'], 0, MAX_TOOLS),
    'options'  => ['num_predict' => MAX_PREDICT, 'num_ctx' => NUM_CTX],
];

// A caller-supplied `tools` is refused rather than ignored, for the same reason
// a `system` message is: quietly dropping it lets someone believe they widened
// the surface. The tools come from the pinned surface and nowhere else.
if (isset($in['tools'])) {
    refuse(400, 'this endpoint uses its own tools; they cannot be supplied by the caller');
}

// The model reasons before it answers, and the loop shows that separately from
// the answer. A boolean the caller may set, because it changes nothing about
// what this endpoint can reach.
if (isset($in['think'])) {
    $payload['think'] = (bool) $in['think'];
}

$encoded = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
if ($encoded === false) {
    refuse(400, 'request could not be encoded');
}

// --- stream ------------------------------------------------------------------

@set_time_limit(TIMEOUT_SECONDS + 30);

// php.ini has output_buffering = 4096. Left in place it costs ~200 ms of time
// to first token, because the first 4 KB of the stream sits here.
while (ob_get_level() > 0) {
    ob_end_flush();
}
ob_implicit_flush(true);

$sent     = 0;
$forwards = 0;
$headed   = false;

/** Send the streaming headers, once, on the first byte we are sure of. */
$begin = static function () use (&$headed): void {
    if ($headed) {
        return;
    }
    $headed = true;
    // application/x-ndjson is outside nginx's gzip_types, so the compressing
    // filter never accumulates the stream. text/plain is inside it, and
    // measured 1.35 s to first byte instead of 0.47 s.
    header('Content-Type: application/x-ndjson');
    header('Cache-Control: no-store');
    // Consumed by nginx, which turns fastcgi_buffering off for this response
    // and does not forward the header. Without it, TTFB is 0.62 s.
    header('X-Accel-Buffering: no');
};

$ch = curl_init(UPSTREAM);
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => $encoded,
    CURLOPT_HTTPHEADER     => ['Content-Type: application/json', 'Accept: application/x-ndjson'],
    CURLOPT_RETURNTRANSFER => false,
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_TIMEOUT        => TIMEOUT_SECONDS,
    CURLOPT_WRITEFUNCTION  => static function ($handle, string $chunk) use (
        &$sent,
        &$forwards,
        $begin
    ): int {
        // The browser went away — a cancelled generation, or a closed tab.
        // Returning short aborts the transfer, which is what stops the GPU
        // working on an answer nobody will read.
        if (connection_aborted() !== 0) {
            return 0;
        }
        if ($forwards === 0) {
            $code = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
            if ($code !== 200) {
                $begin();
                echo json_encode(['error' => "the model host answered {$code}"]), "\n";
                flush();
                return 0;
            }
        }
        $forwards++;
        $sent += strlen($chunk);
        if ($sent > MAX_UPSTREAM_BYTES) {
            $begin();
            echo json_encode(['error' => 'the model produced more than this endpoint relays']), "\n";
            flush();
            return 0;
        }
        $begin();
        echo $chunk;
        flush();
        return strlen($chunk);
    },
]);

curl_exec($ch);
$error = curl_error($ch);
$code  = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
curl_close($ch);

if (!$headed) {
    // Nothing was ever forwarded, so nothing has been sent and a real status
    // code is still available. This is the case a caller can act on: the box is
    // down, or it refused the request outright.
    if ($code >= 400) {
        refuse(502, "the model host answered {$code}");
    }
    refuse(502, $error === '' ? 'the model host did not answer' : 'the model host is unreachable');
}

// Mid-stream failures cannot change the status code, so they are reported the
// only way that is left: as one more line, in the same framing, for the client
// parser to surface as a stalled or broken answer rather than a silent stop.
if ($error !== '' && connection_aborted() === 0) {
    echo json_encode(['error' => 'the connection to the model host ended early']), "\n";
    flush();
}
