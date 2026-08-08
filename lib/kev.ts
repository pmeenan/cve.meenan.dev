/**
 * The CISA KEV overlay, client side (M6, D-010, D-076).
 *
 * **A client-built table, not part of the artifact.** Like the full-text
 * indexes (D-035): created and populated by the browser, destroyed by a
 * replacement and rebuilt by refetching, absent from the promotion gate's
 * checks. That is what lets the overlay ship without a schema bump — D-068
 * makes a bump a 63 MB re-download for every user, and D-070 spent that budget
 * before launch precisely so overlays like this one would not have to — and it
 * is what keeps KEV freshness (CISA's ~business-daily cadence) decoupled from
 * corpus freshness.
 *
 * **The catalog is stranger input, twice over.** It arrives over the network
 * and it is written by a third party, so it is *validated*, not cast: bounded
 * before it is parsed, checked field by field, and refused whole rather than
 * partially applied. Half a known-exploited list read as a whole one is worse
 * than yesterday's, which is why `parseCatalog` throws instead of skipping bad
 * entries.
 *
 * **"Not in KEV" is a real value, not an absence band.** Unlike an SSVC point
 * nobody assessed, absence from the catalog is the finding — *not
 * known-exploited, per CISA* — so the complement is an ordinary categorical
 * bucket carrying its provenance, never the off-ramp neutral D-073 reserves for
 * "nobody looked".
 */

/** Where the catalog is served from. No parameters, like every other fetch (D-032). */
export const KEV_URL = '/data/kev.json'

/**
 * Bounds applied before anything is parsed.
 *
 * The live catalog is 1,662 entries and 1.58 MB (measured 2026-08-08); each of
 * these is ~20x that, so ordinary growth never trips them and a response that
 * is something else entirely is refused before `JSON.parse` sees it. The
 * pipeline applies the same bounds on the way out (`pipeline/kev.py`), and both
 * ends check because either could be the one that is bypassed.
 */
export const MAX_KEV_BYTES = 32 * 1024 * 1024
export const MAX_KEV_ENTRIES = 100_000
export const MAX_KEV_FIELD_CHARS = 20_000
export const MAX_KEV_CWES = 32

/**
 * The three top-level strings are bounded separately, and more tightly.
 *
 * They are the only catalog values that reach the DOM on *every* session: the
 * freshness line, the diagnostics panel and the preamble of every export read
 * them back out of `meta`. Unbounded, a hostile catalog wedges a multi-megabyte
 * string into the front page of the app for good — it survives a reload, works
 * offline, and only a successful refresh clears it. `MAX_KEV_FIELD_CHARS`
 * covers the per-entry fields and never covered these.
 */
export const MAX_KEV_HEADER_CHARS = 200

/**
 * How far ahead of this browser's clock a `dateReleased` may be.
 *
 * The same ceiling `pipeline/kev.py` applies, for the same reason and one layer
 * later: it is what stops the ordering guard below from being poisonable. A
 * catalog stamped in the future is otherwise applied once and then *defended*
 * against every real one that follows — and `describeFreshness` clamps a future
 * stamp to zero, so it would render as "less than an hour old" forever.
 *
 * Two days is slack for clock skew and for a release stamped ahead of when we
 * see it. It is deliberately generous in the direction that costs a refusal
 * rather than in the direction that costs a lie.
 */
export const MAX_KEV_FUTURE_SECONDS = 2 * 86_400

/**
 * `kev.ransomware`, as stored — CISA's `knownRansomwareCampaignUse`.
 *
 * NULL is a fourth state and means **upstream said something this build does
 * not recognise**. It is deliberately not folded into `Unknown`: "Unknown"
 * is CISA having looked and not knowing, and inventing that from an
 * unrecognised value would be manufacturing a finding. `pipeline/kev.py`
 * makes the same call from the other side — it reports the distribution rather
 * than enforcing an enum, so a new value reaches an operator instead of
 * wedging the cron.
 */
export const RANSOMWARE_UNKNOWN = 0
export const RANSOMWARE_KNOWN = 1
/** Not a stored value: the bucket a record with no catalog entry falls into. */
export const RANSOMWARE_NOT_LISTED = 2

/** `kev` membership, as the dimension and the filter spell it. */
export const KEV_NOT_LISTED = 0
export const KEV_LISTED = 1

export interface KevEntry {
  cve: string
  vendor: string
  product: string
  name: string
  descr: string
  action: string
  /** `YYYY-MM-DD`, verbatim as CISA published it. */
  added: string
  /** The same day as unix seconds at UTC midnight, so date ranges compare. */
  addedAt: number
  due: string
  dueAt: number
  ransomware: number | null
  notes: string
  cwes: string[]
}

export interface KevCatalog {
  version: string
  released: string
  /** `released` as unix seconds. Never null — `parseCatalog` refuses a
   * `dateReleased` that is not a timestamp, because it is rendered and its age
   * is computed. */
  releasedAt: number
  entries: KevEntry[]
}

/**
 * What the local copy knows about its catalog — the freshness line's input, and
 * the diagnostics panel's.
 *
 * Read back out of `meta` rather than remembered by the page, for the same
 * reason D-008's notice is: it is a property of the copy on disk, and a
 * returning visitor's page never saw the fetch that wrote it.
 */
export interface KevStatus {
  version: string
  released: string
  /**
   * `released` as unix seconds, read back out of `meta`. Nullable here and not
   * in `KevCatalog`: this is what a *stored* copy carries, and an older build's
   * row may hold something this one cannot read. The freshness line renders no
   * age rather than a wrong one.
   */
  releasedAt: number | null
  /** When *this browser* fetched it, unix seconds. Distinct from `releasedAt`. */
  fetched: number
  entries: number
  /**
   * Entries whose CVE this copy does not hold. Kept by string rather than
   * dropped (D-076) — a KEV entry for a record the corpus lacks is a fact about
   * the two datasets disagreeing, and silently discarding it would make the
   * catalog look complete.
   */
  unmatched: number
}

/** The `meta` keys the catalog's own state lives under. */
export const KEV_META = {
  version: 'kev_version',
  released: 'kev_released',
  releasedAt: 'kev_released_at',
  fetched: 'kev_fetched',
  entries: 'kev_entries',
  unmatched: 'kev_unmatched',
} as const

/**
 * The table, created by the apply that fills it.
 *
 * Deliberately **not** created when the database is opened. Its existence is
 * the signal that a catalog was loaded, and creating it on open would need a
 * write on the read path — where M5's staged replacement has spent a lot of
 * effort making sure nothing writes — in exchange for turning "no catalog" into
 * "CISA lists nothing", which is a different and much worse answer.
 *
 * `cve_id` is nullable on purpose: an entry naming a CVE this copy does not
 * hold keeps its row and is counted, rather than being dropped as if CISA had
 * not listed it.
 */
export const KEV_DDL = [
  `CREATE TABLE IF NOT EXISTS kev(
     cve        TEXT PRIMARY KEY,
     cve_id     INTEGER,
     vendor     TEXT,
     product    TEXT,
     name       TEXT,
     descr      TEXT,
     action     TEXT,
     added      TEXT,
     added_at   INTEGER,
     due        TEXT,
     due_at     INTEGER,
     ransomware INTEGER,
     notes      TEXT,
     cwes       TEXT
   )`,
  // Every KEV predicate and the KEV dimensions correlate on `cve_id`, so this
  // is the access path rather than a nicety.
  'CREATE INDEX IF NOT EXISTS i_kev_cve ON kev(cve_id)',
] as const

export const KEV_INSERT =
  'INSERT INTO kev(cve, cve_id, vendor, product, name, descr, action, added, added_at, ' +
  'due, due_at, ransomware, notes, cwes) ' +
  'VALUES(?, (SELECT id FROM cve WHERE cve_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'

/** The values for `KEV_INSERT`, in its column order. */
export function insertParams(entry: KevEntry): (string | number | null)[] {
  return [
    entry.cve,
    entry.cve,
    entry.vendor,
    entry.product,
    entry.name,
    entry.descr,
    entry.action,
    entry.added,
    entry.addedAt,
    entry.due,
    entry.dueAt,
    entry.ransomware,
    entry.notes,
    // Verbatim strings, so a CWE identifier upstream spells oddly survives the
    // round trip rather than being normalized into something CISA did not say.
    JSON.stringify(entry.cwes),
  ]
}

/**
 * Read back what `insertParams` wrote into `kev.cwes`.
 *
 * Here rather than in the Worker so the writer and the reader sit in one file:
 * they are two halves of one format, and a round trip nothing tests is a format
 * that drifts. Defensive rather than trusting — this build wrote it, but the
 * database is a file on disk that other builds have also written to, and a
 * `JSON.parse` that throws would take the whole detail view down for one field.
 * A value that is not an array of strings reads as no CWEs rather than as an
 * error, because the CWE list is the least load-bearing thing on that surface.
 */
export function parseCwes(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

/**
 * Validate a fetched catalog, or refuse it by name.
 *
 * The same checks `pipeline/kev.py` makes, deliberately repeated here rather
 * than trusted: the pipeline is what *should* have refused a bad catalog, and
 * this is the boundary that decides what goes into the user's database. A
 * client that trusted the server's validation would be trusting a check it
 * cannot see, and the file is served from a mutable URL that a cache sits in
 * front of.
 *
 * @param bytes the response's byte length, checked before this is called; taken
 * as an argument so the message can name it.
 */
export function parseCatalog(value: unknown, bytes?: number, now = Date.now()): KevCatalog {
  if (typeof bytes === 'number' && bytes > MAX_KEV_BYTES) {
    throw new Error(`the KEV catalog is ${bytes} bytes, over this build's ${MAX_KEV_BYTES} limit`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('the KEV catalog is not a JSON object')
  }
  const raw = value as Record<string, unknown>

  const version = header(raw.catalogVersion, 'catalogVersion')
  const released = header(raw.dateReleased, 'dateReleased')
  // Must be a *timestamp*, not merely a non-empty string. It is what the
  // freshness line renders as "released …" and what its age is computed from,
  // so an unparseable value would put "Invalid Date" on screen beside a
  // known-exploited list. `pipeline/kev.py` refuses the same thing; this
  // repeats it because the client does not trust the server's validation
  // (D-076 §2 — the file is short-cached with a proxy in front of it).
  const releasedAt = releasedSeconds(released)
  if (releasedAt === null) {
    throw new Error(`the KEV catalog's dateReleased is not a timestamp: ${json(released)}`)
  }
  if (releasedAt > Math.floor(now / 1000) + MAX_KEV_FUTURE_SECONDS) {
    throw new Error(
      `the KEV catalog says it was released ${json(released)}, which is more than ` +
        `${MAX_KEV_FUTURE_SECONDS / 86_400} days from now — refusing it rather than letting it ` +
        'displace a real catalog and then render as fresh forever'
    )
  }

  const list = raw.vulnerabilities
  if (!Array.isArray(list)) throw new Error('the KEV catalog lists no vulnerabilities array')
  if (list.length === 0) throw new Error('the KEV catalog carries no entries')
  if (list.length > MAX_KEV_ENTRIES) {
    throw new Error(`the KEV catalog carries ${list.length} entries, over ${MAX_KEV_ENTRIES}`)
  }
  // Upstream's own statement of how many entries it meant to send — the one
  // check that catches a body truncated somewhere it still parses.
  if (typeof raw.count === 'number' && raw.count !== list.length) {
    throw new Error(`the KEV catalog says ${raw.count} entries and carries ${list.length}`)
  }

  const seen = new Set<string>()
  const entries: KevEntry[] = []
  for (const [at, item] of list.entries()) {
    entries.push(parseEntry(item, at, seen))
  }
  return { version, released, releasedAt, entries }
}

/** A stranger's string in an error message: bounded, and never echoed whole. */
function json(value: string): string {
  return JSON.stringify(value.slice(0, 60))
}

function parseEntry(value: unknown, at: number, seen: Set<string>): KevEntry {
  const where = `KEV entry ${at}`
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} is not an object`)
  }
  const raw = value as Record<string, unknown>

  const cve = field(raw.cveID, `${where}: cveID`)
  if (!/^CVE-\d{4}-\d{4,12}$/.test(cve)) {
    throw new Error(`${where}: ${JSON.stringify(cve.slice(0, 40))} is not a canonical CVE id`)
  }
  // One entry per CVE is what makes the join to `cve` 1:1, and with it every
  // KEV count DISTINCT-safe without a DISTINCT. A duplicate would double a
  // record in exactly the aggregates this overlay exists to produce — and it
  // would also collide on the table's primary key, so refusing here is what
  // turns a constraint failure mid-transaction into a message.
  if (seen.has(cve)) throw new Error(`${where}: ${cve} appears twice in the catalog`)
  seen.add(cve)

  const added = field(raw.dateAdded, `${where}: dateAdded`)
  const due = field(raw.dueDate, `${where}: dueDate`)
  const addedAt = daySeconds(added)
  const dueAt = daySeconds(due)
  // `json`, not `JSON.stringify`: these values are bounded at
  // `MAX_KEV_FIELD_CHARS`, and a refusal is rendered on the front page and in
  // the diagnostics panel — so echoing one whole puts up to 20,000 characters
  // of attacker-authored prose in the app's own voice. React escapes it, so it
  // is not injection; it is the app appearing to say something it did not.
  if (addedAt === null) throw new Error(`${where}: dateAdded ${json(added)} is not a day`)
  if (dueAt === null) throw new Error(`${where}: dueDate ${json(due)} is not a day`)

  const cwes = raw.cwes
  if (!Array.isArray(cwes)) throw new Error(`${where}: cwes is missing or not a list`)
  if (cwes.length > MAX_KEV_CWES) {
    throw new Error(`${where}: cwes carries ${cwes.length} values, over ${MAX_KEV_CWES}`)
  }

  return {
    cve,
    vendor: field(raw.vendorProject, `${where}: vendorProject`),
    product: field(raw.product, `${where}: product`),
    name: field(raw.vulnerabilityName, `${where}: vulnerabilityName`),
    descr: field(raw.shortDescription, `${where}: shortDescription`),
    action: field(raw.requiredAction, `${where}: requiredAction`),
    added,
    addedAt,
    due,
    dueAt,
    // Named for the upstream key, not for our column: a refusal a reader has to
    // translate before they can look at the catalog is a refusal that costs
    // them the lookup.
    ransomware: ransomwareCode(
      field(raw.knownRansomwareCampaignUse, `${where}: knownRansomwareCampaignUse`)
    ),
    notes: field(raw.notes, `${where}: notes`),
    cwes: cwes.map((item, index) => field(item, `${where}: cwes[${index}]`)),
  }
}

/**
 * One of the three top-level strings: non-empty, bounded, and trimmed.
 *
 * Separate from `field` because the bound is different and the reason is: these
 * are what the UI renders on every session, `field` covers what one record
 * carries.
 */
function header(value: unknown, name: string): string {
  const trimmed = text(value)
  if (!trimmed) throw new Error(`the KEV catalog carries no ${name}`)
  if (trimmed.length > MAX_KEV_HEADER_CHARS) {
    throw new Error(
      `the KEV catalog's ${name} is ${trimmed.length} characters, over ${MAX_KEV_HEADER_CHARS}`
    )
  }
  return trimmed
}

/** A required string, bounded. Bounded so one entry cannot become the largest
 * thing this database stores. */
function field(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`${where} is missing or not a string`)
  if (value.length > MAX_KEV_FIELD_CHARS) {
    throw new Error(`${where} is ${value.length} characters, over ${MAX_KEV_FIELD_CHARS}`)
  }
  return value
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * `Known` / `Unknown` as stored codes; anything else is NULL.
 *
 * Case-insensitive because the value is a word rather than an identifier, and a
 * capitalisation change upstream is not a new finding. Anything genuinely
 * different becomes NULL and gets its own visible bucket, because folding it
 * into `Unknown` would be asserting CISA looked when we do not know that.
 */
export function ransomwareCode(value: string): number | null {
  const word = value.trim().toLowerCase()
  if (word === 'known') return RANSOMWARE_KNOWN
  if (word === 'unknown') return RANSOMWARE_UNKNOWN
  return null
}

/** `YYYY-MM-DD` as unix seconds at UTC midnight, or null.
 *
 * UTC rather than local, for the reason `lib/draft.ts` gives about date inputs:
 * the corpus stores UTC timestamps, and reading a bare calendar day as local
 * time moves every boundary by the reader's offset. */
export function daySeconds(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const at = Date.parse(`${day}T00:00:00Z`)
  return Number.isNaN(at) ? null : Math.floor(at / 1000)
}

/** `dateReleased` as unix seconds, or null when it is not a timestamp. */
export function releasedSeconds(released: string): number | null {
  const at = Date.parse(released)
  return Number.isNaN(at) ? null : Math.floor(at / 1000)
}

/** The earliest plausible `catalogVersion` year. KEV began in November 2021;
 * 1999 is the CVE program's own epoch and is deliberately looser than needed. */
const MIN_KEV_VERSION_YEAR = 1999

/**
 * `2026.08.07` as a comparable tuple, or null when it is not a dated version.
 *
 * The leading component must be a plausible year, which is what stops
 * `20260.08.09` — one fat-finger from real — outranking every genuine catalog
 * until the year 20260. A version that fails this is not refused; it stops
 * being an ordering basis and `dateReleased` orders it instead, so a change of
 * version scheme upstream is not a wedge. `pipeline/kev.py` makes the identical
 * call from the other side.
 */
function versionKey(version: string, thisYear: number): number[] | null {
  const text = version.trim()
  if (!/^\d+(\.\d+)*$/.test(text)) return null
  const parts = text.split('.')
  if (parts.some((part) => part.length > 8)) return null
  const numbers = parts.map((part) => Number(part))
  const year = numbers[0]!
  if (year < MIN_KEV_VERSION_YEAR || year > thisYear + 1) return null
  return numbers
}

function compareTuples(left: number[], right: number[]): number {
  for (let at = 0; at < Math.max(left.length, right.length); at += 1) {
    const difference = (left[at] ?? 0) - (right[at] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Whether `incoming` is at or above the catalog this copy already holds.
 *
 * **The client needs its own guard, not just the pipeline's.** This file's own
 * premise is that the server's validation is a check we cannot see, through a
 * mutable URL with a cache in front of it — and the half that defends against
 * exactly that is the ordering half. Without it, one poisoned response replaces
 * a current catalog with a 2019 one, and because "Not in KEV" is a *real value*
 * in this design rather than an absence, the app then positively asserts *not
 * known-exploited, per CISA* for every CVE listed since. It persists in OPFS,
 * survives a reload, reads correctly offline, and agrees across tabs.
 *
 * Equal is accepted: CISA corrects entries in place, and the client re-resolves
 * `cve_id` on every apply anyway. `null` means the two cannot be ordered, which
 * after `parseCatalog` can only be true of the *stored* side — an older build's
 * row — and the caller treats that as no floor rather than as a refusal, or a
 * bad stored value would be defended forever.
 */
export function isNewerCatalog(
  incoming: { version: string; releasedAt: number },
  stored: { version: string; releasedAt: number | null },
  now = Date.now()
): boolean | null {
  const thisYear = new Date(now).getUTCFullYear()
  const left = versionKey(incoming.version, thisYear)
  const right = versionKey(stored.version, thisYear)
  if (left && right) return compareTuples(left, right) >= 0
  // Different bases, or one of them not a dated version: fall back to the
  // release timestamps, which both sides have if the stored one came from this
  // build. Never compare a version tuple with a unix second — that is not an
  // ordering, it is a coincidence that happens to be a number.
  if (stored.releasedAt === null) return null
  return incoming.releasedAt >= stored.releasedAt
}

/**
 * The `notes` string split into the parts a reader can act on.
 *
 * CISA writes `notes` as a `;`-separated run of labelled URLs — up to 724
 * characters of them, measured against the live catalog. Rendering it as one
 * blob would bury the links; turning the whole string into one anchor would be
 * worse. So it is split, and each part's first `http(s)` token is offered to
 * the component, which puts it through `safeUrl` like any reference (rule 4).
 *
 * Nothing here decides a URL is safe — that is `lib/sanitize.ts`'s job, and
 * this deliberately does not pre-filter by scheme: a `javascript:` token in a
 * note has to reach `safeUrl` to be *refused by name* rather than silently
 * dropped, which is the same treatment the reference list gives.
 */
export interface KevNote {
  /** The whole part, as written. Rendered as a text node. */
  text: string
  /** The first URL-shaped token in it, if any. Not yet checked. */
  url: string | null
}

/** How many note parts are rendered before the list stops being readable. */
export const MAX_KEV_NOTES = 24

/**
 * How long one part may be before it is truncated for display.
 *
 * The whole `notes` field is bounded at `MAX_KEV_FIELD_CHARS`, which leaves one
 * part able to be 20,000 characters — and the scan below is superlinear in the
 * part length, so a single hostile entry made its detail view cost ~0.3 s of
 * main thread *per render*. Bounding the part is cheaper and more honest than
 * making the pattern cleverer: the longest real note part is under 200
 * characters, and a truncated one is marked rather than silently cut.
 */
export const MAX_KEV_NOTE_CHARS = 512

/**
 * Split on `;`, and find each part's URL by *splitting on whitespace* rather
 * than by a pattern with two alternating quantifiers.
 *
 * The pattern that was here — `scheme://\S+|scheme:[^\s;]+` — backtracks
 * quadratically on a long run with no match, which is exactly what a hostile
 * `notes` value is. Tokenising first makes the work linear and the rule easier
 * to state: a token is a candidate if it looks like `scheme:…`, and `safeUrl`
 * is still the only thing allowed to conclude it is a URL.
 */
export function splitNotes(notes: string): KevNote[] {
  const parts: KevNote[] = []
  for (const raw of notes.split(';')) {
    const part = raw.trim().slice(0, MAX_KEV_NOTE_CHARS)
    if (!part) continue
    let url: string | null = null
    for (const token of part.split(/\s+/)) {
      // `http(s)` first so a `Note:see https://…` part links the real URL
      // rather than stopping at the first colon-shaped word. A token with some
      // other scheme is still offered, because a refusal has to name it rather
      // than drop it silently (rule 4).
      if (/^https?:\/\//i.test(token)) {
        url = token
        break
      }
      if (url === null && /^[a-zA-Z][a-zA-Z0-9+.-]*:\S/.test(token)) url = token
    }
    parts.push({ text: part, url })
    if (parts.length >= MAX_KEV_NOTES) break
  }
  return parts
}
