/**
 * Static server for local runs and Playwright.
 *
 * Its job is to be boring and to match production, because the browser
 * measurements (Q-003, Q-004) are only worth anything if they run against the
 * same headers nginx sends. Specifically:
 *
 *   - COOP/COEP on documents, which the `opfs` VFS requires (D-030, Q-004)
 *   - /data/ served from a directory outside the export root (D-034)
 *   - no Access-Control-Allow-Origin anywhere: same-origin enforcement is the
 *     absence of CORS headers, not a header check (D-034)
 *   - .br served as opaque bytes with NO Content-Encoding, because the client
 *     decompresses in WASM (D-040)
 *
 * The type table below is the one place this server has been *wrong* by being
 * generous: it mapped .mjs to JavaScript when nginx's stock mime.types did not,
 * so a build that could not boot in production passed every local test
 * (RE-012). When the two disagree, make this stricter — never production looser.
 */
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'

const PORT = Number(process.env.PORT ?? 4747)
const ROOT = resolve(process.env.SERVE_ROOT ?? 'dist')
const DATA_ROOT = resolve(process.env.SERVE_DATA_ROOT ?? 'pipeline/pub')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.br': 'application/octet-stream',
  '.sqlite': 'application/octet-stream',
}

/** Resolve a URL path under a root, refusing anything that escapes it. */
function safeJoin(root, urlPath) {
  // `decodeURIComponent('/%')` throws, and this runs inside an async request
  // handler with nothing above it to catch — so a single stray `%` in any URL
  // took the whole server down and every later request in the suite failed with
  // a connection error pointing nowhere near the cause. nginx answers the same
  // request with a 400, which is what returning null here produces.
  let decoded
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const full = resolve(join(root, normalize(decoded)))
  return full === root || full.startsWith(root + sep) ? full : null
}

async function resolveFile(path) {
  try {
    const s = await stat(path)
    if (s.isDirectory()) return resolveFile(join(path, 'index.html'))
    return s.isFile() ? path : null
  } catch {
    return null
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const isData = url.pathname.startsWith('/data/')
  const root = isData ? DATA_ROOT : ROOT
  const rel = isData ? url.pathname.slice('/data'.length) : url.pathname

  const candidate = safeJoin(root, rel)
  const file = candidate && (await resolveFile(candidate))
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('404\n')
    return
  }

  const ext = extname(file)
  const headers = { 'content-type': TYPES[ext] ?? 'application/octet-stream' }

  if (isData) {
    // manifest.json is the only mutable file; everything else is immutable.
    headers['cache-control'] = file.endsWith('manifest.json')
      ? 'no-cache'
      : 'public, max-age=31536000, immutable'
  } else if (url.pathname.startsWith('/sqlite/')) {
    // D-054: unversioned files that must upgrade as a set, so they revalidate.
    // Production says exactly this; omitting it here is how the last
    // production-only cache bug stayed invisible locally (RE-012, RE-013).
    headers['cache-control'] = 'no-cache'
  } else if (url.pathname === '/sw.js') {
    // The service worker script decides which *other* files may be answered
    // from a cache, so a stale one is a stale shell that outlives its own fix
    // (D-048, D-054). Browsers already bypass the HTTP cache for this request
    // when `max-age` exceeds a day, but relying on that would leave a 24-hour
    // window and depend on a behaviour we do not control.
    headers['cache-control'] = 'no-cache'
  } else if (ext === '.html') {
    headers['cache-control'] = 'no-cache, must-revalidate'
  }

  // Production sets COOP/COEP at the nginx *server* level, not per-location, and
  // that distinction is load-bearing: a dedicated worker spawned from a
  // COEP:require-corp document must itself be served with COEP, or the browser
  // refuses it with ERR_BLOCKED_BY_RESPONSE and no console message. CORP covers
  // every other subresource the document embeds.
  headers['cross-origin-opener-policy'] = 'same-origin'
  headers['cross-origin-embedder-policy'] = 'require-corp'
  headers['cross-origin-resource-policy'] = 'same-origin'

  const { size } = await stat(file)
  headers['content-length'] = String(size)
  headers['accept-ranges'] = 'bytes'

  res.writeHead(200, headers)
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
})

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`serving ${ROOT} (data: ${DATA_ROOT}) on http://127.0.0.1:${PORT}/\n`)
})
