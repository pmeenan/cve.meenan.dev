/**
 * Turning a downloaded delta file into a `Delta` — or refusing it.
 *
 * The types in `protocol.ts` are erased at runtime, so they cannot be what
 * decides whether a delta is applicable; this is. It runs before any of the
 * payload reaches SQL, and it is deliberately strict: an unexpected key, a
 * tuple of the wrong arity, or a string where an id belongs means the pipeline
 * and the client have drifted, and the honest response to drift is a loud
 * failure rather than a partially applied sync (D-055).
 *
 * Strictness has a versioning consequence worth stating: adding a field to the
 * wire format is a `FORMAT_VERSION` bump, because an existing client refuses
 * the unknown key rather than ignoring it. That is the trade this file makes on
 * purpose — the alternative is a client that applies half of a format it does
 * not understand.
 *
 * Record text is attacker-influenced (AGENTS.md rule 5), so nothing here is
 * interpolated into SQL or HTML; the values are checked and handed on as data.
 */
import {
  assertDeltaEntry,
  FORMAT_VERSION,
  LOOKUP_ORDER,
  SCHEMA_VERSION,
  type Delta,
  type DeltaCvss,
  type DeltaEntry,
  type DeltaLookups,
  type DeltaRecord,
  type DeltaVersion,
  type LookupTable,
} from './protocol'

const ENVELOPE_KEYS = [
  'format',
  'schema',
  'from',
  'to',
  'generated',
  'notice',
  'lookups',
  'upsert',
  'delete',
] as const

const RECORD_KEYS = [
  'id',
  'cve',
  'y',
  'st',
  'cna',
  'pub',
  'upd',
  'cvss',
  'descr',
  'cwe',
  'prod',
  'ref',
  'ver',
] as const

/**
 * Column types per lookup table, positionally — the same order as
 * `pipeline/schema.sql` declares them, which is what lets apply insert the
 * tuple as it stands.
 */
const LOOKUP_SHAPE: Record<LookupTable, readonly ('id' | 'text')[]> = {
  cna: ['id', 'text'],
  cwe: ['id', 'text', 'text'],
  vendor: ['id', 'text'],
  product: ['id', 'id', 'text'],
  host: ['id', 'text'],
  url: ['id', 'text', 'id'],
  vtype: ['id', 'text'],
}

/**
 * How many columns each lookup tuple carries, derived from the shape above so
 * the two cannot disagree.
 *
 * Exported for `lib/sync.ts`, which binds those tuples into an INSERT with a
 * named column list: the arity is what ties the wire shape to that list, and a
 * mismatch there would bind values into the wrong columns rather than fail.
 */
export const LOOKUP_ARITY: Record<LookupTable, number> = Object.fromEntries(
  LOOKUP_ORDER.map((table) => [table, LOOKUP_SHAPE[table].length])
) as Record<LookupTable, number>

/**
 * A bound, not a format check. The canonical CVE ID is publisher-supplied text
 * that our normalization passes through, so the client treats it as data — but
 * nothing legitimate is anywhere near this long, and an unbounded string here
 * would be a payload rather than an identifier.
 */
const MAX_CVE_ID = 64

function bad(where: string, why: string): never {
  throw new Error(`delta ${where}: ${why}`)
}

function fields(
  value: unknown,
  where: string,
  allowed: readonly string[]
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    bad(where, 'expected an object')
  }
  const out = value as Record<string, unknown>
  for (const key of Object.keys(out)) {
    if (!allowed.includes(key)) bad(where, `unexpected key "${key}"`)
  }
  return out
}

function integer(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    bad(where, `expected an integer, got ${typeof value}`)
  }
  return value
}

/** A row id out of the server-owned space: interning starts at 1. */
function id(value: unknown, where: string): number {
  const n = integer(value, where)
  if (n < 1) bad(where, `expected a positive row id, got ${n}`)
  return n
}

function counter(value: unknown, where: string): number {
  const n = integer(value, where)
  if (n < 0) bad(where, `must not be negative, got ${n}`)
  return n
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string') bad(where, `expected a string, got ${typeof value}`)
  return value
}

function nullableText(value: unknown, where: string): string | null {
  return value === null ? null : text(value, where)
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) bad(where, `expected an array, got ${typeof value}`)
  return value
}

function tuple(value: unknown, where: string, arity: number): unknown[] {
  const row = list(value, where)
  if (row.length !== arity) bad(where, `expected ${arity} columns, got ${row.length}`)
  return row
}

function cveId(value: unknown, where: string): string {
  const out = text(value, where)
  if (!out) bad(where, 'must not be empty')
  if (out.length > MAX_CVE_ID) bad(where, `is ${out.length} characters, over the ${MAX_CVE_ID} cap`)
  return out
}

function ids(value: unknown, where: string): number[] {
  return list(value, where).map((entry, index) => id(entry, `${where}[${index}]`))
}

function parseLookups(value: unknown): DeltaLookups {
  const raw = fields(value, 'lookups', LOOKUP_ORDER)
  const out: Record<string, unknown[][]> = {}
  for (const table of LOOKUP_ORDER) {
    const shape = LOOKUP_SHAPE[table]
    // A table with no new rows may be omitted or empty — those mean the same
    // thing. An *unknown* table does not, and `fields` has already refused it;
    // an explicit `null` does not either, and `list` refuses that.
    const rows = raw[table] === undefined ? [] : list(raw[table], `lookups.${table}`)
    out[table] = rows.map((row, index) => {
      const where = `lookups.${table}[${index}]`
      const columns = tuple(row, where, shape.length)
      return shape.map((kind, column) =>
        kind === 'id'
          ? id(columns[column], `${where}[${column}]`)
          : text(columns[column], `${where}[${column}]`)
      )
    })
  }
  // Every column was checked positionally against LOOKUP_SHAPE just above;
  // this cast is where that runtime check becomes the static tuple types.
  return out as unknown as DeltaLookups
}

function parseCvss(value: unknown, where: string): DeltaCvss {
  const columns = tuple(value, where, 4)
  const version = counter(columns[0], `${where}[0]`)
  const score = columns[1]
  if (score !== null && (typeof score !== 'number' || !Number.isFinite(score))) {
    bad(`${where}[1]`, 'expected a finite number or null')
  }
  const severity = columns[2] === null ? null : counter(columns[2], `${where}[2]`)
  return [version, score as number | null, severity, text(columns[3], `${where}[3]`)]
}

function parseVersion(value: unknown, where: string): DeltaVersion {
  const columns = tuple(value, where, 6)
  return [
    id(columns[0], `${where}[0]`),
    counter(columns[1], `${where}[1]`),
    nullableText(columns[2], `${where}[2]`),
    nullableText(columns[3], `${where}[3]`),
    nullableText(columns[4], `${where}[4]`),
    columns[5] === null ? null : id(columns[5], `${where}[5]`),
  ]
}

function parseRecord(value: unknown, index: number): DeltaRecord {
  const where = `upsert[${index}]`
  const raw = fields(value, where, RECORD_KEYS)

  const out: DeltaRecord = {
    id: id(raw.id, `${where}.id`),
    cve: cveId(raw.cve, `${where}.cve`),
    y: counter(raw.y, `${where}.y`),
    st: counter(raw.st, `${where}.st`),
  }

  if (raw.cna !== undefined && raw.cna !== null) out.cna = id(raw.cna, `${where}.cna`)
  // Timestamps are signed: a record can carry a date before 1970, and clamping
  // one at emit time would be inventing data.
  if (raw.pub !== undefined && raw.pub !== null) out.pub = integer(raw.pub, `${where}.pub`)
  if (raw.upd !== undefined && raw.upd !== null) out.upd = integer(raw.upd, `${where}.upd`)
  if (raw.cvss !== undefined && raw.cvss !== null) out.cvss = parseCvss(raw.cvss, `${where}.cvss`)

  if (raw.descr !== undefined) {
    const descr = text(raw.descr, `${where}.descr`)
    // A record with no English description has no `cve_text` row at all
    // (D-023), which the emitter expresses by omitting the key. An empty
    // string would insert a row that says something different.
    if (!descr) bad(`${where}.descr`, 'is empty — omit the key instead')
    out.descr = descr
  }

  if (raw.cwe !== undefined) out.cwe = ids(raw.cwe, `${where}.cwe`)
  if (raw.prod !== undefined) out.prod = ids(raw.prod, `${where}.prod`)
  if (raw.ref !== undefined) out.ref = ids(raw.ref, `${where}.ref`)
  if (raw.ver !== undefined) {
    out.ver = list(raw.ver, `${where}.ver`).map((row, position) =>
      parseVersion(row, `${where}.ver[${position}]`)
    )
  }

  return out
}

/**
 * Validate a decompressed delta against the manifest entry that named it.
 *
 * The entry is passed in rather than trusted from the payload: `from`/`to` are
 * how the client knows which file it asked for, so a delta whose envelope
 * disagrees with the manifest is refused even though both are internally
 * consistent.
 */
export function parseDelta(value: unknown, entry: DeltaEntry): Delta {
  assertDeltaEntry(entry)
  const raw = fields(value, 'envelope', ENVELOPE_KEYS)

  const format = integer(raw.format, 'format')
  if (format !== FORMAT_VERSION) {
    throw new Error(`delta: unsupported wire format ${format} (expected ${FORMAT_VERSION})`)
  }
  const schema = integer(raw.schema, 'schema')
  if (schema !== SCHEMA_VERSION) {
    throw new Error(
      `delta: schema ${schema} needs a full re-download (this build speaks ${SCHEMA_VERSION})`
    )
  }

  const from = counter(raw.from, 'from')
  const to = counter(raw.to, 'to')
  if (from !== entry.from || to !== entry.to) {
    throw new Error(`delta ${from}-${to} is not the manifest's ${entry.from}-${entry.to}`)
  }

  const notice = text(raw.notice, 'notice')
  // D-008 is a condition of the grant, not a nicety: a copy of CVE data with
  // no notice attached is one we are not licensed to have made.
  if (!notice.trim()) throw new Error('delta carries no MITRE notice (D-008)')

  const generated = counter(raw.generated, 'generated')
  // Envelope, then lookups, then records — apply order, and it means a
  // malformed lookup tuple is reported without first walking hundreds of
  // kilobytes of description text.
  const lookups = parseLookups(raw.lookups)
  const upsert = list(raw.upsert, 'upsert').map(parseRecord)
  const remove = list(raw.delete, 'delete').map((entryValue, index) =>
    cveId(entryValue, `delete[${index}]`)
  )

  // What this deliberately does *not* check: that every lookup id an upsert
  // references is either shipped here or already local. The client cannot know
  // the second half, so the guarantee is the emitter's (`_check_closure` in
  // pipeline/delta.py) and apply's — which is where a dangling reference, a
  // duplicate id, or a CVE in both `upsert` and `delete` has to be caught.
  return { format, schema, from, to, generated, notice, lookups, upsert, delete: remove }
}
