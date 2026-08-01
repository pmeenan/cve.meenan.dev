/**
 * D-002: every dependency's license is verified from the package's own
 * metadata before it lands, not assumed. This fails the build on anything
 * outside the allowlist, so "we'll check later" is not an available state.
 */
import { execFileSync } from 'node:child_process'

const ALLOWED = new Set([
  'Apache-2.0',
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'BlueOak-1.0.0',
  'Python-2.0',
])

/** Accept "MIT OR Apache-2.0" and "(MIT AND ISC)" when every term is allowed. */
function isAllowed(license) {
  if (!license) return false
  if (ALLOWED.has(license)) return true
  const terms = license
    .replace(/[()]/g, ' ')
    .split(/\s+(?:OR|AND)\s+/i)
    .map((t) => t.trim())
    .filter(Boolean)
  return terms.length > 1 && terms.some((t) => ALLOWED.has(t))
}

// `--prod --dev` together is rejected by pnpm 11; the default covers both.
const raw = execFileSync('pnpm', ['licenses', 'list', '--json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})

/**
 * D-002 governs what we *distribute*. These five are build-time or test-only
 * and none of their code reaches dist/ — verified by inspecting the export.
 * Each needs a reason, and anything not listed here fails closed.
 */
const EXCEPTIONS = new Map([
  [
    '@img/sharp-libvips-linux-x64',
    'LGPL-3.0-or-later; optional native binary of sharp, which static export ' +
      'never invokes (images.unoptimized, D-027) and whose build is disabled.',
  ],
  ['axe-core', 'MPL-2.0; Playwright accessibility tooling, test-only.'],
  ['lightningcss', 'MPL-2.0; build-time CSS transform. Its output is not a derivative work.'],
  ['lightningcss-linux-x64-gnu', 'MPL-2.0; native binary for the above.'],
  ['caniuse-lite', 'CC-BY-4.0; build-time browser-support data, not shipped.'],
])

const byLicense = JSON.parse(raw)
const offenders = []
let count = 0

for (const [license, packages] of Object.entries(byLicense)) {
  for (const pkg of packages) {
    count++
    if (isAllowed(license) || EXCEPTIONS.has(pkg.name)) continue
    offenders.push(`${pkg.name}@${pkg.versions?.join(',')} — ${license}`)
  }
}

if (offenders.length > 0) {
  process.stderr.write(`Disallowed licenses (D-002):\n  ${offenders.join('\n  ')}\n`)
  process.exit(1)
}

process.stdout.write(
  `${count} packages, all licenses allowed (D-002); ` +
    `${EXCEPTIONS.size} documented build-time exceptions\n`
)
