/**
 * The compute sandbox document (D-088): where the `compute` tool's JavaScript
 * runs. `lib/sandbox.ts` embeds it as `<iframe sandbox="allow-scripts"
 * srcdoc=…>` and talks to it with `postMessage`.
 *
 * Why `srcdoc` and not a file: every response this origin serves carries
 * `Cross-Origin-Resource-Policy: same-origin` (D-034), and a sandboxed frame
 * without `allow-same-origin` has an *opaque* origin — so Firefox refuses to
 * load a file into it at all (CORP fails against the opaque requester;
 * Chromium happens to allow the navigation). A `srcdoc` document is never
 * fetched, so there is nothing for CORP to refuse, and it is sandboxed and
 * policed exactly the same:
 *
 * - **Opaque origin** (`sandbox` without `allow-same-origin`): no cookies, no
 *   localStorage, no IndexedDB, no Cache API, no OPFS — the corpus lives
 *   there — and no claim on the site's origin. A blob: worker made inside it
 *   reports `location.origin === 'null'`.
 * - **This CSP** is the network boundary. `default-src 'none'` leaves
 *   `connect-src` empty, so fetch, XMLHttpRequest, WebSocket, EventSource and
 *   sendBeacon are refused by the engine; `script-src` allows this inline
 *   script and blob: workers, and `'unsafe-eval'` is what lets the worker
 *   build a `Function` from the code. A `srcdoc` document also *inherits* the
 *   parent page's policy (`connect-src 'self'`, app/layout.tsx); both apply,
 *   and a request must pass both, so the stricter wins. A dedicated worker
 *   made from a blob: URL inherits the document's policy (CSP3 §7.2), which
 *   `tests/e2e/compute.spec.ts` checks from inside the worker on both engines
 *   rather than assumes.
 * - **A Worker**, not this window, runs the code: a worker can be terminated
 *   at the deadline where a window's infinite loop cannot, and a dedicated
 *   worker has no RTCPeerConnection, no `<img>`, no `<link>`, no navigation —
 *   the exits CSP does not cover are simply not there. This window only
 *   spawns, times, bounds and relays.
 *
 * Kept as plain strings so the page's bundle carries the sandbox and the
 * e2e suite can build the same frame.
 */

/** The frame document's own policy — the network boundary. */
export const SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:"

/**
 * The worker's source. It receives `{code, columns, rows, maxChars, maxLogs}`,
 * answers once with `{ok, value, error, logs, truncated, ms}`, and is
 * terminated by the frame. Written without template literals so it can sit
 * inside one.
 */
export const RUNNER_SOURCE = [
  "'use strict';",
  'var clip = function (text, max) { return text.length > max ? { text: text.slice(0, max), cut: true } : { text: text, cut: false } };',
  'function safeJson(value) {',
  "  try { var json = JSON.stringify(value, function (k, v) { return typeof v === 'bigint' ? String(v) : v === undefined ? null : v }); return json === undefined ? 'null' : json }",
  '  catch (err) { return JSON.stringify(String(value)) }',
  '}',
  'self.onmessage = async function (event) {',
  '  var code = event.data.code, columns = event.data.columns, rows = event.data.rows, maxChars = event.data.maxChars, maxLogs = event.data.maxLogs;',
  // Not the boundary — the CSP and the opaque origin are — but no accidental
  // reach either: a script that types `fetch` gets a ReferenceError with a
  // message rather than a CSP violation it cannot read.
  "  var gone = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'Worker', 'SharedWorker', 'indexedDB', 'caches', 'navigator', 'BroadcastChannel', 'MessageChannel'];",
  '  for (var i = 0; i < gone.length; i++) { try { Object.defineProperty(self, gone[i], { value: undefined, configurable: false, writable: false }) } catch (e) {} }',
  '  var data = rows.map(function (row) { var o = {}; for (var c = 0; c < columns.length; c++) o[columns[c]] = row[c]; return o });',
  '  var logs = [];',
  "  var log = function () { if (logs.length < maxLogs) { var parts = []; for (var p = 0; p < arguments.length; p++) parts.push(typeof arguments[p] === 'string' ? arguments[p] : safeJson(arguments[p])); logs.push(parts.join(' ')) } };",
  '  var console = { log: log, info: log, warn: log, error: log, debug: log };',
  '  var started = performance.now();',
  '  var value, error = null;',
  '  try {',
  "    var fn = new Function('rows', 'columns', 'data', 'console', code);",
  '    value = fn(rows, columns, data, console);',
  "    if (value && typeof value.then === 'function') value = await value;",
  '  } catch (err) {',
  "    error = err && err.message ? String(err.name || 'Error') + ': ' + String(err.message) : String(err);",
  '  }',
  '  var text = null, cut = false;',
  '  if (error === null) { var clipped = clip(safeJson(value === undefined ? null : value), maxChars); text = clipped.text; cut = clipped.cut }',
  '  self.postMessage({ ok: error === null, value: text, error: error, logs: logs, truncated: cut, ms: Math.round(performance.now() - started) });',
  '};',
].join('\n')

/** The frame's own script: spawn a worker per request, time it, bound and relay its answer. */
const FRAME_SCRIPT = [
  '(function () {',
  `  var RUNNER = ${JSON.stringify(RUNNER_SOURCE)};`,
  '  var runnerUrl = null;',
  "  addEventListener('message', function (event) {",
  '    if (event.source !== parent) return;',
  '    var message = event.data;',
  "    if (!message || message.type !== 'compute') return;",
  '    var id = message.id, deadlineMs = message.deadlineMs, maxChars = message.maxChars, maxLogs = message.maxLogs;',
  "    var reply = function (result) { result.type = 'computed'; result.id = id; parent.postMessage(result, '*') };",
  '    var worker;',
  '    try {',
  "      if (!runnerUrl) runnerUrl = URL.createObjectURL(new Blob([RUNNER], { type: 'text/javascript' }));",
  '      worker = new Worker(runnerUrl);',
  '    } catch (err) {',
  "      reply({ ok: false, value: null, error: 'sandbox worker could not start: ' + String(err && err.message ? err.message : err), logs: [], truncated: false, ms: 0 });",
  '      return;',
  '    }',
  '    var started = performance.now();',
  '    var settled = false;',
  '    var timer = null;',
  '    var settle = function (result) { if (settled) return; settled = true; clearTimeout(timer); worker.terminate(); reply(result) };',
  "    timer = setTimeout(function () { settle({ ok: false, value: null, error: 'stopped: the code ran past ' + deadlineMs + ' ms', logs: [], truncated: false, ms: Math.round(performance.now() - started) }) }, deadlineMs);",
  '    worker.onmessage = function (answer) {',
  '      var r = answer.data || {};',
  // Bounded again on this side of the worker: the worker clips its own output,
  // but this window is what talks to the page.
  "      var value = typeof r.value === 'string' ? r.value.slice(0, maxChars) : null;",
  '      var logs = Array.isArray(r.logs) ? r.logs.slice(0, maxLogs).map(function (line) { return String(line).slice(0, 500) }) : [];',
  "      settle({ ok: r.ok === true, value: value, error: r.error == null ? null : String(r.error).slice(0, 2000), logs: logs, truncated: r.truncated === true || (typeof r.value === 'string' && r.value.length > maxChars), ms: typeof r.ms === 'number' ? r.ms : Math.round(performance.now() - started) });",
  '    };',
  "    worker.onerror = function (err) { settle({ ok: false, value: null, error: 'sandbox: ' + String((err && err.message) || 'the worker failed'), logs: [], truncated: false, ms: Math.round(performance.now() - started) }) };",
  '    worker.postMessage({ code: message.code, columns: message.columns, rows: message.rows, maxChars: maxChars, maxLogs: maxLogs });',
  '  });',
  "  parent.postMessage({ type: 'sandbox-ready' }, '*');",
  '})();',
].join('\n')

/** The whole document, for `iframe.srcdoc`. */
export const SANDBOX_DOCUMENT =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">` +
  '<title>CVE Explorer compute sandbox</title></head><body>' +
  `<script>${FRAME_SCRIPT}</script></body></html>`
