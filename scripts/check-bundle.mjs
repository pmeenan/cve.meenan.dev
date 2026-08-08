/**
 * Refuse a build whose SQL is not the SQL we wrote.
 *
 * This exists because of a defect that no other check in the project could see.
 * `lib/filters.ts` builds SQL from string constants, and one of them was a
 * template literal carrying `${…}` concatenated across two lines with `+`:
 *
 *     `… k.ransomware = ${RANSOMWARE_KNOWN} THEN 0 ` +
 *     `WHEN k.ransomware = ${RANSOMWARE_UNKNOWN} THEN 1 ELSE 99 END`
 *
 * The bundler folded that into `… k.ransomware = 1WHEN k.ransomware = 0 …` —
 * dropping ` THEN 0 ` entirely — and SQLite refused the statement with
 * `unrecognized token: "1WHEN"`. **Every unit test passed**, because unit tests
 * import the source; `pnpm check` was green; only a full browser run against
 * the built export failed, and it failed several steps away from the cause
 * (RE-028).
 *
 * So this scans the emitted chunks for SQL keywords glued to the token before
 * them, which is the shape any recurrence of that folding takes. It is a
 * property of the *output*, checked where the output is, and it costs
 * milliseconds.
 *
 * It is deliberately narrow. It does not parse JavaScript and it does not know
 * which strings are SQL — it looks for a keyword that could only be adjacent to
 * a digit or a quote by accident. False positives are conceivable in minified
 * identifiers, which is why the keyword list is short and upper-case only:
 * minifiers do not generate upper-case identifiers, and our own SQL is written
 * in upper case throughout.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'dist'

/**
 * A SQL keyword preceded immediately by a **digit**.
 *
 * `THEN 0 WHEN` is correct; `THEN 0WHEN` is the defect, and a digit is the one
 * neighbour that cannot be innocent: every interpolation this file is guarding
 * (`${RANSOMWARE_KNOWN}`, `${KEV_LISTED}`, the severity and state codes) is a
 * number, and a minifier does not emit upper-case identifiers for a digit to
 * abut. A *quote* before a keyword is deliberately not matched — `"SELECT …`
 * is simply a string literal beginning, and matching it produced 53 hits of
 * pure noise on the first run.
 */
const GLUED = /[0-9](WHEN|THEN|ELSE|END|FROM|WHERE|AND|OR|JOIN|SELECT|GROUP|ORDER|LIMIT)\b/g

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (path.endsWith('.js') || path.endsWith('.mjs')) out.push(path)
  }
  return out
}

let bad = 0
for (const file of walk(ROOT)) {
  const text = readFileSync(file, 'utf-8')
  for (const found of text.matchAll(GLUED)) {
    // Enough context to identify which expression it is, without dumping a
    // minified chunk into the terminal.
    const from = Math.max(0, found.index - 70)
    process.stderr.write(
      `${file}: SQL keyword glued to the token before it — ` +
        `…${text.slice(from, found.index + 70).replace(/\s+/g, ' ')}…\n`
    )
    bad += 1
  }
}

if (bad > 0) {
  process.stderr.write(
    `\n${bad} glued SQL keyword(s) in the built output. The source is probably fine and the\n` +
      'bundler folded a template literal that was concatenated with `+` across lines —\n' +
      'write it as one literal instead (RE-028). A unit test cannot see this: it runs the\n' +
      'source, and only the browser runs the bundle.\n'
  )
  process.exit(1)
}
process.stdout.write('bundle: no glued SQL keywords\n')
