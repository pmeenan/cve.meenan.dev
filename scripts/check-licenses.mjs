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

/**
 * Evaluate an SPDX license expression against the allowlist with real AND/OR
 * semantics: `OR` is a choice (any allowed branch suffices), `AND` is a
 * conjunction (every branch must be allowed). The previous implementation
 * split on both operators and accepted if *any* term was allowed, which let
 * "MIT AND GPL-3.0" through (D-047 review finding).
 *
 * Grammar (SPDX simple expressions):
 *   expr   := term (OR term)*
 *   term   := factor (AND factor)*
 *   factor := '(' expr ')' | LICENSE ['WITH' EXCEPTION]
 *
 * A `WITH` clause is kept as part of the token and is allowed only if the full
 * "License WITH Exception" string is explicitly allowlisted — an exception
 * changes the terms, so the base license being allowed is not enough. Any
 * malformed expression evaluates to not-allowed (fail closed).
 */
function isAllowed(license) {
  if (!license) return false
  if (ALLOWED.has(license)) return true
  const tokens = license.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').split(/\s+/).filter(Boolean)
  // Reattach WITH clauses: ["MIT", "WITH", "X"] -> ["MIT WITH X"]
  const merged = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].toUpperCase() === 'WITH' && merged.length > 0 && tokens[i + 1]) {
      merged[merged.length - 1] += ` WITH ${tokens[++i]}`
    } else {
      merged.push(tokens[i])
    }
  }

  let pos = 0
  const peek = () => merged[pos]
  const isOp = (t, op) => t !== undefined && t.toUpperCase() === op

  function factor() {
    const token = merged[pos++]
    if (token === undefined || token === ')') throw new Error('malformed')
    if (token === '(') {
      const value = expr()
      if (merged[pos++] !== ')') throw new Error('malformed')
      return value
    }
    return ALLOWED.has(token)
  }
  function term() {
    let value = factor()
    while (isOp(peek(), 'AND')) {
      pos++
      value = factor() && value
    }
    return value
  }
  function expr() {
    let value = term()
    while (isOp(peek(), 'OR')) {
      pos++
      value = term() || value
    }
    return value
  }

  try {
    const value = expr()
    return pos === merged.length && value
  } catch {
    return false
  }
}

// `--prod --dev` together is rejected by pnpm 11; the default covers both.
const raw = execFileSync('pnpm', ['licenses', 'list', '--json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})

/**
 * D-002 governs what we *distribute*. These five are build-time or test-only
 * and none of their code reaches dist/ — verified by inspecting the export.
 * Each exception is bound to the exact license it was reviewed under: if the
 * package's license ever changes, the exception no longer applies and the
 * audit fails until a human re-reviews (D-047 review finding).
 */
const EXCEPTIONS = new Map([
  [
    '@img/sharp-libvips-linux-x64',
    {
      license: 'LGPL-3.0-or-later',
      reason:
        'optional native binary of sharp, which static export never invokes ' +
        '(images.unoptimized, D-027) and whose build is disabled.',
    },
  ],
  ['axe-core', { license: 'MPL-2.0', reason: 'Playwright accessibility tooling, test-only.' }],
  [
    '@axe-core/playwright',
    {
      license: 'MPL-2.0',
      reason:
        'the Playwright binding for the above (M4 accessibility criterion). Same terms and ' +
        'the same reasoning: a devDependency invoked from tests/e2e, whose code never ' +
        'reaches dist/. MPL-2.0 is file-level copyleft on distribution, and we distribute ' +
        'none of it.',
    },
  ],
  [
    'lightningcss',
    {
      license: 'MPL-2.0',
      reason: 'build-time CSS transform. Its output is not a derivative work.',
    },
  ],
  ['lightningcss-linux-x64-gnu', { license: 'MPL-2.0', reason: 'native binary for the above.' }],
  [
    'caniuse-lite',
    { license: 'CC-BY-4.0', reason: 'build-time browser-support data, not shipped.' },
  ],
])

const byLicense = JSON.parse(raw)
const offenders = []
let count = 0

for (const [license, packages] of Object.entries(byLicense)) {
  for (const pkg of packages) {
    count++
    if (isAllowed(license)) continue
    const exception = EXCEPTIONS.get(pkg.name)
    if (exception && exception.license === license) continue
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
