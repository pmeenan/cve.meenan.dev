/**
 * What CVE record content has to pass through before it leaves this app or
 * becomes a link (M4, rule 4).
 *
 * The corpus is attacker-influenced text. Descriptions, product names and
 * reference URLs are written by whoever filed the record, and three of the ways
 * that text can act rather than describe are not React's problem:
 *
 * **A spreadsheet executes cells.** A CSV field beginning `=`, `+`, `-`, `@`
 * or a control character is a formula in Excel, LibreOffice and Sheets — and
 * `=HYPERLINK(...)`, `=WEBSERVICE(...)` and DDE payloads turn an export into a
 * request the exporter never made. Escaping quotes is not enough, because the
 * spreadsheet strips the quoting before it decides what the cell is.
 *
 * **Control characters travel invisibly.** A description with an embedded NUL,
 * a bidirectional override or a bare CR is a cell that lies about its own
 * content — the classic Trojan Source shape, and in CSV a bare newline also
 * splits a record in half for every parser that is not fully quoted-aware.
 *
 * **A URL is not a link until we decide it is.** `javascript:` and `data:` in
 * an `href` execute in this origin; `blob:` and `filesystem:` are barely better.
 * A reference in a CVE record is a string the record's author chose, so it is
 * held to an allowlist and shown with its host, rather than trusted because it
 * came from an official-looking corpus (D-011's referrer concern is the second
 * half of this, and lives in the component that renders the anchor).
 *
 * None of this is a substitute for the structural defences elsewhere — values
 * reach SQL as bound parameters (lib/filters.ts) and reach the DOM as text
 * nodes. This is about the two boundaries React and SQLite do not cover: a file
 * the user opens in another program, and an `href`.
 */

/**
 * The characters a spreadsheet reads as "this cell is a formula".
 *
 * Tab and carriage return are on the list because a leading one of either is
 * skipped by the parser and the *next* character then leads — so `\t=cmd` is a
 * formula. They are stripped by `stripControls` anyway; the check is kept
 * because the two functions are separately callable and this one must be safe
 * on its own.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/

/**
 * Strip control characters and the invisible direction overrides.
 *
 * Everything in C0 and C1 except nothing at all: a description has no
 * legitimate use for them, and a lone `\n` inside a CSV field is exactly the
 * character that makes a hand-rolled parser see two records. They become a
 * single space rather than vanishing, so words either side do not run together
 * and the removal is visible as a gap rather than as a silent edit.
 *
 * U+202A–U+202E and U+2066–U+2069 are the bidirectional embedding and isolate
 * controls — the Trojan Source characters, which can make rendered text read in
 * a different order than it is stored. They are not C0/C1 and would otherwise
 * survive.
 */
export function stripControls(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]+/gu, ' ')
}

/**
 * One CSV field, always quoted, never executable.
 *
 * Always quoting is deliberate: it makes commas, quotes and stray whitespace a
 * non-question, and it means the escaping rule is one rule rather than a
 * decision per value. The formula guard goes *inside* the quotes, prefixed with
 * an apostrophe, which is the form every major spreadsheet treats as "this is
 * text" — and which a plain CSV reader sees as one leading apostrophe rather
 * than as corruption.
 */
export function csvField(value: unknown): string {
  const text = stripControls(value === null || value === undefined ? '' : String(value))
  const guarded = FORMULA_LEAD.test(text) ? `'${text}` : text
  return `"${guarded.replace(/"/g, '""')}"`
}

/** One CSV record, terminated CRLF as RFC 4180 asks for. */
export function csvRow(cells: readonly unknown[]): string {
  return `${cells.map(csvField).join(',')}\r\n`
}

/**
 * What a JSON export carries for a text value.
 *
 * `JSON.stringify` already makes the *file* safe to parse; this is about what
 * happens after it is parsed, since the usual next step is a spreadsheet or a
 * script. Control characters are stripped for the same reason as in CSV, and
 * the formula guard is deliberately **not** applied — a JSON string is not a
 * cell, and prefixing an apostrophe there would corrupt the value for every
 * consumer in order to protect one.
 */
export function jsonText(value: unknown): string {
  return stripControls(value === null || value === undefined ? '' : String(value))
}

/**
 * Schemes an `href` from a CVE record may carry.
 *
 * `http` and `https` only. `mailto:` is deliberately absent: a reference in
 * this corpus is a web page, and every scheme allowed is a scheme whose
 * handler-launching behaviour we would have to reason about. Everything else —
 * `javascript:`, `data:`, `blob:`, `vbscript:`, `file:`, an unknown custom
 * scheme registered by some installed application — renders as text.
 */
export const SAFE_SCHEMES = ['http:', 'https:'] as const

export interface SafeUrl {
  /** The href to use, or null when the URL is not one we will link. */
  href: string | null
  /** The host, shown next to the link so the destination is visible before the click. */
  host: string
  /** Why it was refused, for the UI to show instead of a link. */
  refused: string | null
}

/**
 * Decide whether a reference URL may become a link, and what to show for it.
 *
 * Parsed with the URL parser rather than matched with a regular expression: the
 * question "what scheme is this" is exactly the question the parser answers,
 * and every regular expression that has tried has been defeated by whitespace,
 * embedded newlines or `java\tscript:`. `stripControls` runs first anyway, so
 * the two agree.
 *
 * The host is returned separately because a link whose text is a 300-character
 * URL tells the reader nothing about where it goes — and where it goes is the
 * one thing that matters for a link nobody should follow blindly.
 */
export function safeUrl(raw: unknown): SafeUrl {
  const text = stripControls(raw === null || raw === undefined ? '' : String(raw)).trim()
  if (!text) return { href: null, host: '', refused: 'empty' }
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return { href: null, host: '', refused: 'not a URL' }
  }
  if (!(SAFE_SCHEMES as readonly string[]).includes(parsed.protocol)) {
    // The scheme is named because "refused" with no reason invites the reader
    // to assume the app is broken rather than that the record is odd.
    return { href: null, host: parsed.host, refused: `${parsed.protocol} links are not opened` }
  }
  // `parsed.href`, not the original text: the parser has normalized escaping,
  // so what the anchor carries is what the parser agreed the URL means rather
  // than a string that two parsers could read differently.
  return { href: parsed.href, host: parsed.host, refused: null }
}
