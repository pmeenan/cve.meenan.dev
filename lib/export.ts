/**
 * Export: the whole match set, to a disclosed cap, in a form another program
 * can read (M4).
 *
 * Three properties shape this file.
 *
 * **An export is a copy of CVE data, so it carries MITRE's notice.** D-008
 * grants reuse on one condition — each copy reproduces the copyright
 * designation and the license — and a file the user hands to someone else is
 * exactly the copy that condition is about. It is a functional requirement of
 * the feature, not a footer (D-047), so both formats carry it and neither can
 * be built without one: `beginCsv` and `beginJson` take the notice as an
 * argument and refuse an empty one.
 *
 * **It is emitted in batches, not assembled.** The Worker holds one batch of
 * rows at a time and posts each serialized chunk, so peak memory is a batch
 * rather than the result set — the same reasoning that bounds the import to
 * chunks in flight (D-041). That is why the shape here is a small state machine
 * (`begin`, `rows`, `end`) rather than a `toCsv(rows)` function: nothing in this
 * file ever sees the whole export.
 *
 * **The bytes are hostile.** Every value goes through lib/sanitize.ts on its
 * way out, because the consumer is a spreadsheet or a script rather than a
 * browser, and neither of those has React's escaping.
 */

import { csvRow, jsonText, stripControls } from './sanitize'

export const EXPORT_FORMATS = ['csv', 'json'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

/**
 * How many records an export may carry.
 *
 * A cap rather than everything, and a *disclosed* one: the file says on its own
 * face when it was truncated, and so does the UI, because a spreadsheet of
 * 50,000 rows that silently omitted the other 300,000 is the quiet wrongness
 * vision criterion 7 rules out. The number is set by what stays workable
 * downstream rather than by what the Worker can produce — at roughly 500 bytes
 * a record this is a ~25 MB file, which is already past what most spreadsheets
 * open comfortably.
 */
export const EXPORT_LIMIT = 50_000

/**
 * Records per batch.
 *
 * Bounds the Worker's live set, and with it the string being built. Small
 * enough that a batch is a few megabytes at most; large enough that the
 * per-batch query overhead disappears next to the scan.
 */
export const EXPORT_BATCH = 2_000

/** The columns a record export carries, in order. */
export const RECORD_COLUMNS = [
  'cve',
  'state',
  'published',
  'updated',
  'cvss_version',
  'cvss_score',
  'severity',
  'cna',
  'description',
] as const

/** The columns an aggregate export carries. `series` is empty on a one-axis report. */
export const CELL_COLUMNS = ['rows', 'series', 'cves'] as const

/**
 * A serializer that never holds more than one batch.
 *
 * `begin` returns the file's opening text, `rows` the text for one batch, and
 * `end` whatever has to close the document. The caller concatenates them in
 * order and never asks this object for anything it has already emitted.
 */
export interface ExportWriter {
  begin(): string
  rows(batch: readonly (readonly unknown[])[]): string
  end(): string
  /** The MIME type and file extension, for the download the page triggers. */
  readonly mime: string
  readonly extension: string
}

export interface ExportHeader {
  /** MITRE's notice, read out of the database's own `meta` (D-008). */
  notice: string
  /** Column names, in the order the rows arrive in. */
  columns: readonly string[]
  /** What the file is of, in one line — the report's title or the filter summary. */
  title: string
  /** The revision of the local copy the rows came from, so a file can be placed. */
  revision: number | null
  /** The SQL that produced the rows, and its bound values. */
  sql: string
  params: readonly (string | number)[]
  /** How many records matched, when it is known — not how many are in the file. */
  matches: number | null
  /** Set when the cap stopped the export short of `matches`. */
  truncated: boolean
}

function requireNotice(header: ExportHeader): string {
  const notice = stripControls(header.notice ?? '').trim()
  // D-008 is a condition of the grant rather than a nicety, so an export
  // without one is refused here rather than produced and apologised for. The
  // only way to reach this is a local copy whose `meta` lost its notice, which
  // is itself a corrupt copy.
  if (!notice)
    throw new Error('this copy carries no MITRE notice, so it cannot be exported (D-008)')
  return notice
}

/**
 * CSV, with the notice and the provenance in a comment block above the header.
 *
 * Leading `#` lines are not part of RFC 4180 and every spreadsheet will import
 * them as a one-column row, which is ugly but *visible* — and visible is the
 * requirement. The alternative, a trailing notice row, gets sorted into the
 * data the first time someone sorts the sheet.
 */
export function csvWriter(header: ExportHeader): ExportWriter {
  const notice = requireNotice(header)
  return {
    mime: 'text/csv;charset=utf-8',
    extension: 'csv',
    begin() {
      const lines = preamble(header, notice).map((line) => `# ${line}\r\n`)
      return `${lines.join('')}${csvRow(header.columns)}`
    },
    rows(batch) {
      let out = ''
      for (const row of batch) out += csvRow(row)
      return out
    },
    end() {
      return ''
    },
  }
}

/**
 * JSON, as one object with the notice beside the rows.
 *
 * Streamed rather than `JSON.stringify`d: the rows array is opened, batches are
 * appended with their own separators, and the object is closed — so this holds
 * a batch, exactly as the CSV writer does. Each row is an object rather than an
 * array, because a consumer that has to remember column order is a consumer
 * that will eventually get it wrong.
 */
export function jsonWriter(header: ExportHeader): ExportWriter {
  const notice = requireNotice(header)
  let wrote = 0
  return {
    mime: 'application/json;charset=utf-8',
    extension: 'json',
    begin() {
      const meta = {
        notice,
        title: jsonText(header.title),
        source: 'https://cve.meenan.dev/',
        revision: header.revision,
        matches: header.matches,
        truncated: header.truncated,
        limit: EXPORT_LIMIT,
        sql: header.sql,
        params: [...header.params],
        columns: [...header.columns],
      }
      // The metadata is stringified whole — it is a fixed handful of fields —
      // and only the row stream is incremental.
      return `${JSON.stringify(meta).slice(0, -1)},"rows":[`
    },
    rows(batch) {
      let out = ''
      for (const row of batch) {
        const object: Record<string, unknown> = {}
        header.columns.forEach((column, at) => {
          const value = row[at]
          object[column] = typeof value === 'string' ? jsonText(value) : (value ?? null)
        })
        out += `${wrote === 0 ? '' : ','}${JSON.stringify(object)}`
        wrote += 1
      }
      return out
    },
    end() {
      return ']}\n'
    },
  }
}

export function exportWriter(format: ExportFormat, header: ExportHeader): ExportWriter {
  return format === 'json' ? jsonWriter(header) : csvWriter(header)
}

/**
 * The provenance block, shared by both formats.
 *
 * The truncation line is the one that has to be there: a file that stops at the
 * cap and does not say so is indistinguishable from a complete one, and it will
 * be read as complete.
 */
function preamble(header: ExportHeader, notice: string): string[] {
  const lines = [
    stripControls(header.title || 'CVE export').trim(),
    `Exported from https://cve.meenan.dev/ — all querying happened in the browser.`,
    header.revision === null
      ? 'Local copy revision: unknown'
      : `Local copy at revision ${header.revision}`,
  ]
  if (header.matches !== null)
    lines.push(`Records matching: ${header.matches.toLocaleString('en-US')}`)
  if (header.truncated) {
    lines.push(
      `TRUNCATED: this file carries at most ${EXPORT_LIMIT.toLocaleString('en-US')} records, ` +
        `which is fewer than matched. It is not the whole answer.`
    )
  }
  lines.push(`Query: ${stripControls(header.sql)}`)
  if (header.params.length) {
    lines.push(
      `Bound values: ${header.params.map((value) => stripControls(String(value))).join(' | ')}`
    )
  }
  lines.push(notice)
  return lines
}

/**
 * A file name that is a file name.
 *
 * Built from the report's title, which the user typed — so it is reduced to
 * characters that cannot mean anything to a filesystem or to a
 * `Content-Disposition` parser, and bounded. A download name is one of the few
 * strings this app hands to the operating system.
 */
export function exportFilename(title: string, extension: string): string {
  const base =
    stripControls(title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'cve-export'
  return `${base}.${extension}`
}
