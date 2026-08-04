/**
 * The full-text indexes the client builds for itself (D-035), and the
 * arithmetic behind the progress it reports while building them.
 *
 * Here rather than in the Worker for the reason `lib/staging.ts` is here:
 * reaching this code from there costs a full import, so anything decided in it
 * would otherwise ship unexercised. What lives here is the part that can be
 * wrong quietly — the rowid ranges, and the SQL they are bound into. A range
 * this file drops is a set of records that can never be found by search, with
 * no error anywhere.
 */

export interface SearchIndex {
  /** The fts5 table this build creates. */
  fts: string
  /** Its external content table, and the rowid and column it indexes. */
  content: string
  rowid: string
  column: string
  /** What the progress display calls the rows going in. */
  label: string
  /**
   * Bytes of indexed text in the full artifact, measured 2026-08-04 against the
   * live snapshot at rev 2 (372,322 records).
   *
   * A **display weight only**: it splits the progress bar between the three
   * indexes, and nothing else reads it. Descriptions are 98% of the indexed
   * text and, measured separately, 96% of the time — so a weight that drifts
   * costs a bar that jumps near the end, never a wrong index. Row counts would
   * be the obvious alternative and are the wrong unit: descriptions are 77% of
   * the rows and 98% of the work.
   */
  textBytes: number
}

/**
 * In build order. Descriptions first, so the long part of the wait is the part
 * with fine-grained progress and the last two percent finishes quickly.
 *
 * References are indexed in no form at all — not URLs, not names: fts5's
 * tokenizer shreds a URL into hosts, vendor slugs, ticket ids and file names,
 * which would put all of that in the same term space as the prose (D-035).
 */
export const SEARCH_INDEXES: readonly SearchIndex[] = [
  {
    fts: 'fts',
    content: 'cve_text',
    rowid: 'cve_id',
    column: 'descr',
    label: 'descriptions',
    textBytes: 122_554_315,
  },
  {
    fts: 'fts_vendor',
    content: 'vendor',
    rowid: 'id',
    column: 'name',
    label: 'vendor names',
    textBytes: 276_820,
  },
  {
    fts: 'fts_product',
    content: 'product',
    rowid: 'id',
    column: 'name',
    label: 'product names',
    textBytes: 2_122_160,
  },
]

/**
 * How many progress updates the whole build is worth. At full scale the build
 * is ~65 s, so this is one about every 0.7 s — often enough that a stalled
 * index build is distinguishable from a slow one (D-052), rare enough that the
 * reporting is not itself the work.
 */
export const INDEX_BATCHES = 96

/** Each index paired with its share of the progress bar, in build order. */
export function indexPlan(
  indexes: readonly SearchIndex[] = SEARCH_INDEXES
): { index: SearchIndex; share: number }[] {
  const total = indexes.reduce((sum, index) => sum + index.textBytes, 0)
  if (!(total > 0)) throw new Error('search indexes carry no measured weight')
  return indexes.map((index) => ({ index, share: index.textBytes / total }))
}

/**
 * How many batches an index carrying `share` of the bar is built in. An index
 * worth a fifth of a percent does not need 96 statements to report itself.
 */
export function indexBatches(share: number, batches = INDEX_BATCHES): number {
  return Math.max(1, Math.round(batches * share))
}

/**
 * Half-open `[from, to)` rowid ranges covering `[lo, hi]` exactly.
 *
 * Exactly is the whole contract: contiguous, in order, the first starting at
 * `lo` and the last ending at `hi + 1`. A gap here is records that are in the
 * database and not in the index, which no later check would catch — the fts5
 * table exists, the row counts are right, and the search is simply missing
 * things.
 */
export function batchRanges(lo: number, hi: number, batches: number): [number, number][] {
  if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) {
    throw new Error(`rowid bounds ${lo}..${hi} are not integers`)
  }
  if (hi < lo) throw new Error(`rowid bounds ${lo}..${hi} are inverted`)
  if (!Number.isSafeInteger(batches) || batches < 1) {
    throw new Error(`batch count ${batches} must be a positive integer`)
  }
  const span = hi - lo + 1
  const step = Math.ceil(span / batches)
  const ranges: [number, number][] = []
  for (let at = lo; at <= hi; at += step) {
    // Clamped rather than allowed to overshoot: the last range's end is what
    // the fraction is computed from, and an overshoot would report progress
    // past 1 before the batch that finishes the job has run.
    ranges.push([at, Math.min(at + step, hi + 1)])
  }
  return ranges
}

/**
 * The statements one index is built with. Table and column names come from
 * `SEARCH_INDEXES` and never from record content, so interpolating them is not
 * the concatenation rule 4 forbids; the rowid bounds are bound parameters.
 */
export function indexSql(index: SearchIndex): {
  drop: string
  create: string
  min: string
  max: string
  insert: string
} {
  return {
    drop: `DROP TABLE IF EXISTS ${index.fts}`,
    create:
      `CREATE VIRTUAL TABLE ${index.fts} USING fts5(` +
      `${index.column}, content='${index.content}', content_rowid='${index.rowid}')`,
    min: `SELECT min(${index.rowid}) FROM ${index.content}`,
    max: `SELECT max(${index.rowid}) FROM ${index.content}`,
    // The external-content form: fts5 stores no copy of the text, so the
    // rowid and the column value both have to be supplied here, exactly as its
    // own `'rebuild'` command would have read them out of the content table.
    insert:
      `INSERT INTO ${index.fts}(rowid, ${index.column}) ` +
      `SELECT ${index.rowid}, ${index.column} FROM ${index.content} ` +
      `WHERE ${index.rowid} >= ? AND ${index.rowid} < ?`,
  }
}
