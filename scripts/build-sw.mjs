/**
 * Generate the offline app shell's service worker (D-048), after the export.
 *
 * Runs as `postbuild`, because it needs the export to exist: the precache list
 * is *derived from `dist/`* rather than written by hand. A hand-maintained list
 * is the version of this that ships broken — Turbopack's chunk names change
 * every build, so a list that is not regenerated caches nothing that matters and
 * nobody notices until the network is gone.
 *
 * The cache version is a hash of that list plus every file's own hash, so a
 * deploy that changes one byte of one chunk gets a new cache name and the old
 * one is deleted on activate. That is what "versioned per deploy" means with no
 * build step on the server (D-003).
 *
 * **What is deliberately not in the list**: anything under `/data/`. The
 * manifest is the freshness signal (D-042) and a stale one served from a cache
 * would break the staleness indicator, which is the only guard vision criterion
 * 7 has against confident-but-old counts. The worker refuses those requests
 * structurally rather than by omission — see the template below.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const ROOT = resolve(process.env.SERVE_ROOT ?? 'dist')

/**
 * Extensions worth caching. An allowlist rather than "everything in dist",
 * because the export also contains `.txt` RSC payloads and source maps, and a
 * service worker that precaches every byte of the build is one that costs a
 * user megabytes to install for files nothing requests.
 */
const CACHE_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.css', '.wasm', '.svg', '.ico'])

/** Files the app cannot start without, even though nothing links them directly. */
const ALWAYS = ['/sqlite/index.mjs', '/sqlite/sqlite3.wasm', '/sqlite/sqlite3-opfs-async-proxy.js']

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const files = walk(ROOT)
  .map((path) => ({ path, url: `/${relative(ROOT, path).split(sep).join('/')}` }))
  .filter(({ url }) => CACHE_EXTENSIONS.has(url.slice(url.lastIndexOf('.'))))
  // Source maps are for a developer with devtools open and a network; they are
  // not part of an offline shell.
  .filter(({ url }) => !url.endsWith('.map'))

const urls = new Set(files.map((entry) => entry.url))
// The document itself is requested as `/`, which is not a file name in the
// export — `trailingSlash` (D-027) makes `index.html` answer it.
urls.add('/')
for (const url of ALWAYS) {
  if (!urls.has(url)) throw new Error(`build-sw: ${url} is missing from ${ROOT}`)
}

const digest = createHash('sha256')
for (const entry of files.sort((a, b) => a.url.localeCompare(b.url))) {
  digest.update(entry.url)
  digest.update(createHash('sha256').update(readFileSync(entry.path)).digest())
}
const version = digest.digest('hex').slice(0, 16)

const template = readFileSync(resolve('scripts/sw.template.js'), 'utf-8')
const source = template
  .replace('__CACHE_VERSION__', version)
  .replace('__PRECACHE__', JSON.stringify([...urls].sort(), null, 2))

writeFileSync(join(ROOT, 'sw.js'), source)
console.log(`service worker: ${urls.size} shell files, cache cve-shell-${version}`)
