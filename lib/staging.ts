/**
 * Staged replacement: the local half of a download that must never destroy the
 * copy the user already has (M2).
 *
 * M1's import truncated the live database and wrote chunks into it, so a failed
 * download left nothing behind. Here the bytes land in a *staging* file that is
 * a different OPFS entry from the live one, and the live database is neither
 * closed nor touched until the staged copy has been verified end to end.
 *
 * Two files, alternating. The live database is `cve-a.sqlite` or
 * `cve-b.sqlite`, whichever was promoted last, and a download always stages
 * into the other — so the footprint is bounded at two generations rather than
 * growing with every re-download, and "keep the previous copy until the new one
 * verifies" costs no copying at the end.
 *
 * **Which file is live is recorded in the database, not beside it.** A promoted
 * database carries a non-zero `PRAGMA user_version` — a 32-bit header field the
 * pipeline never writes, so every published artifact arrives at 0 — and the
 * higher value is the newer promotion. That makes promotion a single SQLite
 * transaction, atomic and durable by SQLite's own guarantees, instead of a
 * small-file write we would have to make crash-safe ourselves. The record in
 * this file is therefore *advisory*: losing it costs a restarted download and
 * can never cost the live copy (D-061).
 *
 * Everything here is pure so it can be tested without a browser; the OPFS calls
 * live in the Worker.
 */
import { chunkUrl, isRevision, type ChunkEntry, type Manifest } from './protocol'
import { SEARCH_INDEXES } from './search'

/** Bumped when the record's own shape changes; an older record is discarded. */
export const STAGING_RECORD_VERSION = 1

/** Where the resume record lives in OPFS. */
export const STAGING_RECORD_FILE = 'staging.json'

/**
 * The name M1 imported to. A copy under this name is still a usable database,
 * so it is adopted as live rather than discarded (D-013 would permit discarding
 * it, but that would charge every existing visitor a 63 MB re-download for a
 * rename). It is swept away by the first promotion.
 */
export const LEGACY_DB_FILE = 'cve.sqlite'

/** The two slots a staged download alternates between. */
export const SLOT_FILES = ['cve-a.sqlite', 'cve-b.sqlite'] as const

export type SlotFile = (typeof SLOT_FILES)[number]

/** Every OPFS entry the `opfs` VFS path owns, live or not. */
export const DB_FILES: readonly string[] = [LEGACY_DB_FILE, ...SLOT_FILES]

/**
 * True for an entry this app created on the `opfs` path — the databases, the
 * rollback journals SQLite writes beside them, and the resume record.
 *
 * Used by "Clear local copy", which has to remove the staged copy too: a clear
 * that leaves 441 MB of half-downloaded database behind has not cleared
 * anything the user cares about.
 */
export function isOurEntry(name: string): boolean {
  if (name === STAGING_RECORD_FILE) return true
  return DB_FILES.some((file) => name === file || isSidecarOf(name, file))
}

/**
 * True for a SQLite sidecar belonging to `file` — its rollback journal, WAL,
 * shared-memory file, or superjournal.
 *
 * Staging into a slot has to remove these before overwriting the main file. A
 * journal left behind by an aborted index build describes the *previous*
 * generation's pages, and SQLite will replay it into whatever main file it
 * finds next — mixing two generations into a database whose bytes we verified
 * moments earlier. SQLite calls this out by name as a corruption path
 * (https://sqlite.org/howtocorrupt.html#_mispairing_database_files_and_hot_journals,
 * read 2026-08-04), and it is reproducible: see D-061.
 */
export function isSidecarOf(name: string, file: string): boolean {
  return name.startsWith(`${file}-`) && SIDECAR.test(name.slice(file.length + 1))
}

/**
 * The sidecars SQLite writes beside a database, as an allowlist rather than
 * "anything with the right prefix".
 *
 * Both callers of `isOurEntry` delete, and one of them runs on the *read* path,
 * so an open-ended prefix rule is a standing offer to delete a future feature's
 * file that happens to sort under one of our names — M8 puts multi-gigabyte
 * model weights in this same origin. Rollback journal, WAL, shared-memory, and
 * the superjournal (`-mjHHHHHHHH`) are the complete set for a database this
 * client opens.
 */
const SIDECAR = /^(journal|wal|shm|mj[0-9a-f]{8})$/

/** One chunk's identity, as the record remembers it. */
export interface StagedChunk {
  name: string
  offset: number
  rawBytes: number
  sha256: string
}

/**
 * What a download is aimed at, taken from the manifest and checked before any
 * of it is acted on.
 */
export interface StagingPlan {
  /** `manifest.snapshot.path`, which identifies the generation. */
  path: string
  /**
   * `manifest.snapshot.rev` when the origin declares one (D-055), else null.
   * Only cross-checked against the database's own `meta.rev`: the watermark is
   * read from the database, never from the manifest.
   */
  rev: number | null
  /** The database's decompressed length — what the staging file is truncated to. */
  rawBytes: number
  chunks: StagedChunk[]
}

/** The persisted resume record: a plan plus which of its chunks have landed. */
export interface StagingRecord extends StagingPlan {
  v: number
  file: SlotFile
  /**
   * The completion bitmap, one entry per chunk in plan order. Written as
   * booleans rather than packed bits because there are twelve of them and a
   * record a human can read in a diagnostics panel is worth more than the
   * bytes.
   */
  done: boolean[]
}

/**
 * Read a manifest's snapshot into a plan, or refuse it.
 *
 * `chunkUrl` does the path-shape checking (no manifest string ever reaches a
 * request path, D-032/D-055); the rest is arithmetic the M1 path never did and
 * staged replacement cannot skip: **the chunks must cover the byte range
 * exactly, and their names must be distinct.** ("Cover", not "tile": D-055 and
 * D-060 already use tiling for the *delta revision space*, which is an unrelated
 * invariant.)
 * Per-chunk SHA-256 proves the bytes of each chunk, and nothing else proves the
 * bytes *between* them — a manifest that omitted a chunk would produce a
 * database with a zero-filled hole that every hash in the manifest agreed with,
 * and promotion would then bless it.
 */
export function stagingPlan(manifest: Manifest): StagingPlan {
  const snapshot = manifest.snapshot
  const rawBytes = snapshot?.raw_bytes
  if (!isRevision(rawBytes) || rawBytes === 0) {
    throw new Error(`manifest declares an unusable snapshot length: ${rawBytes}`)
  }

  const chunks: StagedChunk[] = (snapshot.chunks ?? []).map((chunk) => {
    // Throws unless both the snapshot directory and the chunk name match the
    // shapes publish.py writes.
    chunkUrl(manifest, chunk)
    if (!isRevision(chunk.offset) || !isRevision(chunk.raw_bytes) || chunk.raw_bytes === 0) {
      throw new Error(`manifest chunk ${chunk.name} has an unusable offset or length`)
    }
    if (typeof chunk.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(chunk.sha256)) {
      throw new Error(`manifest chunk ${chunk.name}: sha256 must be 64 hex characters`)
    }
    return {
      name: chunk.name,
      offset: chunk.offset,
      rawBytes: chunk.raw_bytes,
      sha256: chunk.sha256,
    }
  })

  // Names must be distinct, and this is not pedantry about manifests. Every
  // step after this one is keyed by name — `pendingChunks` builds a name→entry
  // map, the writer builds a name→index map — so two chunks sharing a name
  // collapse into one, and the byte range belonging to the loser is never
  // fetched at all. The offsets would still tile perfectly.
  const names = new Set(chunks.map((chunk) => chunk.name))
  if (names.size !== chunks.length) {
    throw new Error('manifest lists the same chunk name twice')
  }

  // File order, not manifest order: the tiling check below is about coverage of
  // the byte range, and a manifest that listed its chunks out of order would
  // still describe a complete file.
  const ordered = [...chunks].sort((a, b) => a.offset - b.offset)
  let at = 0
  for (const chunk of ordered) {
    if (chunk.offset !== at) {
      throw new Error(
        `manifest chunks do not cover the snapshot: expected a chunk at byte ${at}, ` +
          `${chunk.name} starts at ${chunk.offset}`
      )
    }
    at += chunk.rawBytes
  }
  if (at !== rawBytes) {
    throw new Error(`manifest chunks cover ${at} bytes of a ${rawBytes}-byte snapshot`)
  }

  return {
    path: snapshot.path,
    rev: isRevision(snapshot.rev) ? snapshot.rev : null,
    rawBytes,
    chunks: ordered,
  }
}

/**
 * The slot to stage into: the one that is not live.
 *
 * A live copy under the legacy name occupies neither slot, so the first staged
 * download after an upgrade takes slot `a` and the legacy file is swept when it
 * is promoted.
 */
export function chooseStagingFile(live: string | null): SlotFile {
  return SLOT_FILES.find((slot) => slot !== live) ?? SLOT_FILES[0]
}

/** A fresh record with nothing downloaded yet. */
export function newRecord(plan: StagingPlan, file: SlotFile): StagingRecord {
  return { ...plan, v: STAGING_RECORD_VERSION, file, done: plan.chunks.map(() => false) }
}

/**
 * Whether a record describes exactly this download, so its completed chunks can
 * be trusted and skipped.
 *
 * Deliberately *not* bound to the manifest's head revision: a delta published
 * while a download was interrupted advances the head without changing a single
 * snapshot byte, and throwing away 40 MB of correct chunks over that would make
 * resume useless on exactly the days it matters. It is bound to everything that
 * decides what the bytes are — the generation, its length, and every chunk's
 * offset, length and hash — so a rotated snapshot never resumes into a mix of
 * two generations (D-061).
 */
export function bindsTo(record: StagingRecord, plan: StagingPlan, file: SlotFile): boolean {
  if (record.v !== STAGING_RECORD_VERSION) return false
  if (record.file !== file) return false
  if (record.path !== plan.path) return false
  if (record.rev !== plan.rev) return false
  if (record.rawBytes !== plan.rawBytes) return false
  if (record.chunks.length !== plan.chunks.length) return false
  if (record.done.length !== plan.chunks.length) return false
  return record.chunks.every((chunk, index) => {
    const wanted = plan.chunks[index]!
    return (
      chunk.name === wanted.name &&
      chunk.offset === wanted.offset &&
      chunk.rawBytes === wanted.rawBytes &&
      chunk.sha256 === wanted.sha256
    )
  })
}

/** How many chunks of this record have already landed and been flushed. */
export function completed(record: StagingRecord): number {
  return record.done.filter(Boolean).length
}

/** Every chunk still to fetch, as the manifest entries the loader wants. */
export function pendingChunks(record: StagingRecord, manifest: Manifest): ChunkEntry[] {
  const byName = new Map(manifest.snapshot.chunks.map((chunk) => [chunk.name, chunk]))
  const pending: ChunkEntry[] = []
  record.chunks.forEach((chunk, index) => {
    if (record.done[index]) return
    const entry = byName.get(chunk.name)
    // `bindsTo` has already established the record and the manifest agree, so a
    // miss here means they were not checked — fail rather than silently leaving
    // a hole in the file.
    if (!entry) throw new Error(`staging record names a chunk the manifest does not: ${chunk.name}`)
    pending.push(entry)
  })
  return pending
}

/**
 * What the promotion gate reads out of a staged database, as plain values.
 *
 * The gate lives here rather than in the Worker so it can be tested without a
 * browser — it is the one decision in this design that replaces a database the
 * user is relying on, and every one of its refusals was dead code as long as
 * the only way to reach it was a real 377 MB import of a known-good artifact.
 */
export interface StagedMeta {
  /** `meta.schema` as stored, or whatever was there instead. */
  schema: unknown
  /** `meta.rev` — the watermark the sync path will start from. */
  rev: unknown
  /** `meta.notice` — MITRE's, required to travel with every copy (D-008). */
  notice: unknown
  /**
   * How many records the caller counted. The gate only ever distinguishes zero
   * from non-zero, so a caller that needs no more than that may supply the
   * result of a `LIMIT 1` probe — which discovery does, because a true
   * `count(*)` over 372k rows costs ~1.1 s and discovery runs on every page
   * load (D-061).
   */
  records: unknown
  /**
   * `PRAGMA user_version` — the promotion counter, which a *published* artifact
   * has never had set (D-061).
   */
  promoted: unknown
}

/**
 * What a candidate slot turns out to be.
 *
 * `unreadable` is the one that matters: the entry exists and we could not
 * establish what it is, which must never be reported as "nothing here" — the
 * caller turns that into deletions. `unusable` is a file we *did* read and
 * would not serve, which is reclaimable.
 */
export type Candidate =
  | { kind: 'absent' }
  | { kind: 'unreadable' }
  | { kind: 'unusable' }
  | { kind: 'database'; generation: number }

/** The reads `classifyCandidate` needs. Any of them may throw. */
export interface CandidateReader {
  /** `PRAGMA user_version`, or null if it did not come back as a number. */
  counter(): number | null
  /** How many of `REQUIRED_TABLES` the database actually has. */
  tablesPresent(): unknown
  /** The gate's inputs. Only called once the tables are known to be present. */
  meta(generation: number): StagedMeta
}

/**
 * Decide what an open candidate is, keeping *read failures* and *validation
 * failures* apart.
 *
 * A read that fails tells us nothing about the file — a transient I/O or BUSY
 * error is not evidence that the file is disposable — so it yields `unreadable`
 * and blocks the sweep. Only values we successfully read and then judged
 * unacceptable yield `unusable`. That is why table presence is established by
 * counting `sqlite_schema` rows rather than by letting "no such table: meta"
 * surface as an exception indistinguishable from a disk error (D-061).
 */
export function classifyCandidate(read: CandidateReader, schemaVersion: number): Candidate {
  let generation: number | null
  let tables: unknown
  let meta: StagedMeta | null = null
  try {
    generation = read.counter()
    tables = read.tablesPresent()
    if (tables === REQUIRED_TABLES.length) meta = read.meta(generation ?? 0)
  } catch {
    return { kind: 'unreadable' }
  }
  if (generation === null) return { kind: 'unreadable' }

  try {
    // A counter is not evidence on its own — only that *something* wrote one.
    // Discovery acts on it by retiring the other slot, so the file behind it
    // has to be a corpus this build would serve *and* one our own promotion
    // finished writing.
    assertPromotionCompleted(tables)
    if (!meta) throw new Error('tables present but meta was not read')
    assertLocallyUsable(meta, schemaVersion)
  } catch {
    return { kind: 'unusable' }
  }
  return { kind: 'database', generation }
}

/**
 * The tables a promoted local database must have: the published schema's, plus
 * the three full-text tables **the client builds for itself** after a download
 * (D-035).
 *
 * The FTS tables are the load-bearing half. A promotion counter says a counter
 * was written; these say *our* promotion ran to completion, because nothing but
 * `buildSearchIndexes` creates them and it runs immediately before the counter.
 * Without them, a published artifact that ever arrived carrying a non-zero
 * counter — publisher drift, which nothing upstream forbids — would be adopted
 * straight out of a staging file, retiring the real copy and leaving a database
 * that cannot be searched (D-061).
 *
 * Read out of `SEARCH_INDEXES` rather than repeated: a fourth index added there
 * and forgotten here would leave the completion check silently not covering it,
 * which is a gap that reports nothing.
 */
export const REQUIRED_TABLES: readonly string[] = [
  'meta',
  'cve',
  ...SEARCH_INDEXES.map((index) => index.fts),
]

/**
 * Refuse a database whose promotion cannot be shown to have completed.
 *
 * Separate from `assertLocallyUsable` because it is a *discovery*-only check:
 * the promotion gate runs before the indexes are built, so requiring them there
 * would refuse every download.
 */
export function assertPromotionCompleted(tablesPresent: unknown): void {
  if (tablesPresent !== REQUIRED_TABLES.length) {
    throw new Error(
      `copy has ${tablesPresent} of the ${REQUIRED_TABLES.length} tables a promoted ` +
        'database carries — its promotion did not complete (D-061)'
    )
  }
}

/**
 * Refuse a database this build must not serve, or return.
 *
 * The half of the promotion gate that needs no manifest, so **discovery can
 * apply it too**. A non-zero promotion counter says only that something wrote a
 * counter; on its own it is not evidence that the file behind it ever passed a
 * gate, and discovery acts on that evidence by retiring the other slot. Anything
 * that opens but is not a corpus this build can serve — no `meta`, a schema from
 * another version, no notice, no records — must therefore lose, not win.
 */
export function assertLocallyUsable(
  meta: StagedMeta,
  schemaVersion: number
): asserts meta is StagedMeta & { rev: number } {
  if (meta.schema !== schemaVersion) {
    throw new Error(
      `copy carries schema ${meta.schema}, but this build speaks ${schemaVersion} — ` +
        'the local copy is unchanged'
    )
  }
  if (!isRevision(meta.rev)) {
    throw new Error(`copy carries no usable revision (meta.rev = ${meta.rev})`)
  }
  // D-008 is a condition of the grant, not a nicety: a copy of CVE data with no
  // notice attached is one we are not licensed to have made.
  if (typeof meta.notice !== 'string' || !meta.notice.trim()) {
    throw new Error('copy carries no MITRE notice (D-008)')
  }
  if (typeof meta.records !== 'number' || meta.records < 1) {
    throw new Error(`copy holds no records (count = ${meta.records})`)
  }
}

/**
 * Refuse a staged copy that must not replace the local database, or return.
 *
 * The bytes are already proven when this runs: every chunk matched its
 * published SHA-256, `stagingPlan` established that the chunks cover the file
 * exactly, and the caller has checked the bitmap is complete. So this is
 * deliberately *not* a second integrity check — `PRAGMA integrity_check` over
 * 377 MB would re-read the whole database to learn what the hashes already
 * said, on every import. What it checks is that the published artifact is one
 * this build can use and is the one the manifest promised.
 *
 * @param head `manifest.rev`, the newest revision the data plane can reach.
 */
export function assertPromotable(
  meta: StagedMeta,
  head: unknown,
  plan: StagingPlan,
  schemaVersion: number
): void {
  assertLocallyUsable(meta, schemaVersion)
  // Only when the origin declares one: the generation published before D-055
  // has no `snapshot.rev`, and the database's own `meta.rev` is the watermark
  // either way. When both exist they must agree, or the publish was
  // inconsistent and the client would sync from the wrong place.
  if (plan.rev !== null && plan.rev !== meta.rev) {
    throw new Error(
      `manifest promised snapshot rev ${plan.rev}, the staged copy carries ${meta.rev}`
    )
  }
  if (isRevision(head) && meta.rev > head) {
    throw new Error(`staged copy is at rev ${meta.rev}, above the manifest's head ${head}`)
  }
  // The invariant the whole design rests on, re-checked rather than trusted.
  // Which slot is live is decided by this counter being non-zero, and that is
  // only sound while published artifacts arrive at zero — a survey of the
  // pipeline says they do, but nothing upstream *enforces* it, and the day one
  // starts setting it a half-written staging file would begin winning
  // discovery. Cheaper to check here than to find out that way.
  if (meta.promoted !== 0) {
    throw new Error(
      `staged copy already carries promotion counter ${meta.promoted} — a published ` +
        'artifact must arrive at 0 (D-061)'
    )
  }
}

/**
 * Parse a persisted record, or `null` for anything that is not exactly one.
 *
 * Returning null rather than throwing is the point: this record is an
 * optimization, and the correct response to a corrupt or truncated one is to
 * download the snapshot again — not to fail a download the user asked for.
 */
export function parseStagingRecord(value: unknown): StagingRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.v !== STAGING_RECORD_VERSION) return null
  if (typeof raw.file !== 'string' || !SLOT_FILES.includes(raw.file as SlotFile)) return null
  if (typeof raw.path !== 'string') return null
  if (raw.rev !== null && !isRevision(raw.rev)) return null
  if (!isRevision(raw.rawBytes) || raw.rawBytes === 0) return null
  if (!Array.isArray(raw.chunks) || !Array.isArray(raw.done)) return null
  if (raw.chunks.length !== raw.done.length || raw.chunks.length === 0) return null
  if (!raw.done.every((entry) => typeof entry === 'boolean')) return null

  const chunks: StagedChunk[] = []
  for (const entry of raw.chunks) {
    if (typeof entry !== 'object' || entry === null) return null
    const chunk = entry as Record<string, unknown>
    if (typeof chunk.name !== 'string' || !/^\d+\.br$/.test(chunk.name)) return null
    if (!isRevision(chunk.offset)) return null
    if (!isRevision(chunk.rawBytes) || chunk.rawBytes === 0) return null
    if (typeof chunk.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(chunk.sha256)) return null
    chunks.push({
      name: chunk.name,
      offset: chunk.offset,
      rawBytes: chunk.rawBytes,
      sha256: chunk.sha256,
    })
  }

  return {
    v: STAGING_RECORD_VERSION,
    file: raw.file as SlotFile,
    path: raw.path,
    rev: raw.rev as number | null,
    rawBytes: raw.rawBytes,
    chunks,
    done: raw.done as boolean[],
  }
}
