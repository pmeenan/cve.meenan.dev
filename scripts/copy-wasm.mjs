/**
 * Copy the SQLite WASM distribution into public/ so the Worker can load it at
 * runtime instead of through the bundler.
 *
 * @sqlite.org/sqlite-wasm uses bare `import()` with a computed specifier, which
 * Turbopack cannot statically resolve ("Can't resolve <dynamic>"). Serving the
 * distribution as plain static files sidesteps the bundler entirely and has the
 * side benefit that sqlite3-opfs-async-proxy.js and sqlite3.wasm resolve
 * relative to the module URL exactly as upstream expects.
 */
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const from = resolve(root, 'node_modules/@sqlite.org/sqlite-wasm/dist')
const to = resolve(root, 'public/sqlite')

await rm(to, { recursive: true, force: true })
await mkdir(to, { recursive: true })
await cp(from, to, { recursive: true })
process.stdout.write(`copied sqlite-wasm -> public/sqlite\n`)
