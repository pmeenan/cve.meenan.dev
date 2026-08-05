import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { brotliDecompressSync } from 'node:zlib'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { parseDelta } from '../../lib/delta'
import {
  assertUsable,
  chunkUrl,
  DATA_ROOT,
  deltaUrl,
  LOOKUP_ORDER,
  planSync,
  snapshotRev,
  type DeltaEntry,
  type Manifest,
} from '../../lib/protocol'
import { indexSql, SEARCH_INDEXES } from '../../lib/search'
import { applyDelta, type SyncDb } from '../../lib/sync'

/**
 * The cross-language contract test (D-055).
 *
 * The Python pipeline publishes a tiny but complete data plane — snapshot,
 * manifest, and the delta that carries a client from the snapshot to head —
 * and this validates it with the same code the browser uses. A fixture written
 * in TypeScript would only ever prove that the types agree with themselves;
 * this fails when the two sides drift, which is the whole point of having a
 * contract.
 *
 * It runs the pipeline for real, so it needs `python3` and `brotli` — the same
 * two things `pnpm test:pipeline` and a publish already need.
 */
let root: string
let manifest: Manifest
let rotated: Manifest
let published: {
  delta: { from: number; to: number }
  next_db: string
  hostile_text: string
  rotated: {
    pub: string
    snapshot_rev: number
    deltas_kept: number
    retired: { generations: string[]; deltas: string[] }
    previous_generation: string
  }
}

/** Where the local static server would serve a `/data/...` URL from. */
function dataFile(url: string, pub = join(root, 'pub')): string {
  expect(url.startsWith(`${DATA_ROOT}/`)).toBe(true)
  return join(pub, url.slice(DATA_ROOT.length + 1))
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cve-contract-'))
  const run = spawnSync('python3', ['pipeline/tests/fixture_pub.py', root], {
    encoding: 'utf-8',
    timeout: 120_000,
  })
  expect(run.status, `fixture_pub.py failed:\n${run.stderr}`).toBe(0)
  published = JSON.parse(run.stdout)
  manifest = JSON.parse(readFileSync(join(root, 'pub', 'manifest.json'), 'utf-8')) as Manifest
  rotated = JSON.parse(
    readFileSync(join(published.rotated.pub, 'manifest.json'), 'utf-8')
  ) as Manifest
}, 120_000)

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('a manifest the pipeline wrote', () => {
  it('is one this build can consume', () => {
    expect(() => assertUsable(manifest)).not.toThrow()
  })

  it('separates the snapshot revision from the head revision', () => {
    // Equal until the first delta lands, and this manifest has one — so a
    // client that only read `rev` would think its fresh snapshot was current.
    expect(snapshotRev(manifest)).toBe(1)
    expect(manifest.rev).toBe(2)
  })

  it('addresses the snapshot and the delta without a parameter (D-032)', () => {
    const urls = [
      ...manifest.snapshot.chunks.map((chunk) => chunkUrl(manifest, chunk)),
      ...manifest.deltas.map(deltaUrl),
    ]
    for (const url of urls) {
      expect(url.startsWith(`${DATA_ROOT}/`)).toBe(true)
      expect(url).not.toContain('?')
    }
  })

  it('names delta files at exactly the URL the client derives', () => {
    for (const entry of manifest.deltas) {
      expect(() => readFileSync(dataFile(deltaUrl(entry)))).not.toThrow()
    }
    expect(deltaUrl(manifest.deltas[0]!)).toBe('/data/deltas/1-2.json.br')
  })
})

describe('the delta the pipeline emitted', () => {
  it('is the file the manifest describes, byte for byte', () => {
    const entry = manifest.deltas[0]!
    const compressed = readFileSync(dataFile(deltaUrl(entry)))
    expect(compressed.length).toBe(entry.bytes)
    expect(createHash('sha256').update(compressed).digest('hex')).toBe(entry.sha256)
    expect(brotliDecompressSync(compressed).length).toBe(entry.raw_bytes)
  })

  it('validates against the types this build speaks', () => {
    const entry = manifest.deltas[0]!
    const raw = JSON.parse(brotliDecompressSync(readFileSync(dataFile(deltaUrl(entry)))).toString())
    const delta = parseDelta(raw, entry)

    expect(delta.from).toBe(1)
    expect(delta.to).toBe(2)
    expect(delta.notice).toContain('The MITRE Corporation')
    expect(delta.upsert.length).toBeGreaterThan(0)
    expect(delta.upsert.map((record) => record.cve)).toContain('CVE-2026-1001')
  })

  it('carries every section of a record across, with the values the fixture built', () => {
    // Asserting the envelope alone let record-level drift through: an emitter
    // that dropped `cvss`, `ref` and `ver` entirely, and shifted every row id,
    // passed this file untouched — because all of those are legitimately
    // optional. These are the concrete values `pipeline/tests/fixtures.py`
    // builds for CVE-2026-1003.
    const entry = manifest.deltas[0]!
    const delta = parseDelta(
      JSON.parse(brotliDecompressSync(readFileSync(dataFile(deltaUrl(entry)))).toString()),
      entry
    )
    const record = delta.upsert.find((candidate) => candidate.cve === 'CVE-2026-1003')
    expect(record).toBeDefined()
    expect(Object.keys(record!).sort()).toEqual([
      'cna',
      'cve',
      'cvss',
      'cwe',
      'descr',
      'id',
      'prod',
      'pub',
      'ref',
      'st',
      'upd',
      'ver',
      'y',
    ])
    expect(record!.id).toBe(3)
    expect(record!.st).toBe(1)
    expect(record!.y).toBe(2026)
    // v4.0 stores as 4 and CRITICAL as 4 — codes, never compared numerically.
    expect(record!.cvss).toEqual([4, 9.1, 4, 'CVSS:4.0/AV:N'])
    expect(record!.ver).toEqual([[4, 1, '0', null, '4.2', 2]])
    expect(record!.ref).toEqual([3])
    expect(record!.prod).toEqual([4])

    // The lookup rows those ids point at ship in the same file, since the
    // client's snapshot predates them.
    expect(delta.lookups.product).toContainEqual([4, 2, 'sprocket'])
    expect(delta.lookups.url).toContainEqual([3, 'https://newhost.example.org/x', 3])
    expect(delta.lookups.vtype).toContainEqual([2, 'custom'])
  })

  it('carries a tombstone as a canonical CVE ID', () => {
    const entry = manifest.deltas[0]!
    const delta = parseDelta(
      JSON.parse(brotliDecompressSync(readFileSync(dataFile(deltaUrl(entry)))).toString()),
      entry
    )
    expect(delta.delete).toEqual(['CVE-2026-9999'])
  })

  it('orders lookups so apply can insert them as they come', () => {
    const entry = manifest.deltas[0]!
    const raw = JSON.parse(
      brotliDecompressSync(readFileSync(dataFile(deltaUrl(entry)))).toString()
    ) as { lookups: Record<string, unknown> }
    // Serialization order, not just membership: `vendor` before `product` and
    // `host` before `url` is what makes a single positional pass safe.
    expect(Object.keys(raw.lookups)).toEqual([...LOOKUP_ORDER])
  })

  it('carries hostile record text across the language boundary unchanged', () => {
    // Markup, quotes, a NUL, control characters and non-ASCII — Python wrote
    // it, JSON.parse read it, and neither end sanitized it. Escaping belongs
    // where it renders, not on the wire (AGENTS.md rule 5).
    const entry = manifest.deltas[0]!
    const delta = parseDelta(
      JSON.parse(brotliDecompressSync(readFileSync(dataFile(deltaUrl(entry)))).toString()),
      entry
    )
    const record = delta.upsert.find((candidate) => candidate.cve === 'CVE-2026-1001')
    expect(record?.descr).toBe(published.hostile_text)
    expect(record?.descr).toContain('<script>')
    expect(record?.descr).toContain('\u0000')
    expect(record?.descr).toContain('中文')
  })

  it('is refused when it does not match the entry that named it', () => {
    const entry = manifest.deltas[0]!
    const raw = JSON.parse(brotliDecompressSync(readFileSync(dataFile(deltaUrl(entry)))).toString())
    expect(() => parseDelta(raw, { ...entry, from: 5, to: 6 })).toThrow(/manifest's 5-6/)
  })
})

describe('planning a sync against it', () => {
  it('takes a freshly imported snapshot to head in one hop', () => {
    const chain = planSync(manifest, snapshotRev(manifest))
    expect(chain?.map((entry) => [entry.from, entry.to])).toEqual([[1, 2]])
  })

  it('has nothing left to do once that hop is applied', () => {
    expect(planSync(manifest, manifest.rev)).toEqual([])
  })

  it('reports that the published delta is the one it planned for', () => {
    expect(published.delta.from).toBe(1)
    expect(published.delta.to).toBe(2)
  })
})

/**
 * The other half of D-055's sufficiency claim, made against the code the
 * browser runs.
 *
 * `pipeline/tests/apply.py` already proves the *wire format* carries enough:
 * snapshot N plus a delta reconstructs snapshot N+1. This proves the same thing
 * about `lib/sync.ts`, and it starts from the client's own bytes — the database
 * is reassembled from the published chunks the way the Worker assembles it,
 * indexed the way the Worker indexes it, and brought forward by the delta the
 * Worker would have fetched.
 *
 * If the two appliers ever disagree, this is where it surfaces: the pipeline
 * built rev 2 from the corpus, and the client built it from rev 1 and a 200-byte
 * file.
 */
describe('a client that syncs instead of re-downloading', () => {
  /** The published snapshot, decompressed and reassembled as the Worker does. */
  function reassemble(): DatabaseSync {
    const bytes = Buffer.alloc(manifest.snapshot.raw_bytes)
    for (const chunk of manifest.snapshot.chunks) {
      const expanded = brotliDecompressSync(readFileSync(dataFile(chunkUrl(manifest, chunk))))
      expect(expanded.length).toBe(chunk.raw_bytes)
      expanded.copy(bytes, chunk.offset)
    }
    const path = join(root, 'synced.sqlite')
    writeFileSync(path, bytes)
    const db = new DatabaseSync(path)
    // What the client builds for itself after a download (D-035), and what
    // apply then has to maintain.
    for (const index of SEARCH_INDEXES) {
      const sql = indexSql(index)
      db.exec(sql.drop)
      db.exec(sql.create)
      db.exec(`INSERT INTO ${index.fts}(${index.fts}) VALUES('rebuild')`)
    }
    return db
  }

  function adapt(db: DatabaseSync): SyncDb {
    return {
      run: (sql, params) => void db.prepare(sql).run(...((params ?? []) as never[])),
      row: (sql, params) => {
        const found = db.prepare(sql).get(...((params ?? []) as never[]))
        return found === undefined ? null : Object.values(found)
      },
      column: (sql, params) =>
        db
          .prepare(sql)
          .all(...((params ?? []) as never[]))
          .map((found) => Object.values(found)[0]),
    }
  }

  function rows(db: DatabaseSync, table: string, order: string): unknown[][] {
    return db
      .prepare(`SELECT * FROM ${table} ORDER BY ${order}`)
      .all()
      .map((row) => Object.values(row))
  }

  /** Fetch-and-verify, minus the fetch: exactly what `loadDelta` does. */
  function readDelta(entry: DeltaEntry) {
    const compressed = readFileSync(dataFile(deltaUrl(entry)))
    expect(compressed.length).toBe(entry.bytes)
    expect(createHash('sha256').update(compressed).digest('hex')).toBe(entry.sha256)
    const expanded = brotliDecompressSync(compressed)
    expect(expanded.length).toBe(entry.raw_bytes)
    return parseDelta(JSON.parse(expanded.toString()), entry)
  }

  it('reconstructs the next generation the pipeline built, record for record', () => {
    const synced = reassemble()
    const chain = planSync(manifest, snapshotRev(manifest))!
    expect(chain.length).toBeGreaterThan(0)
    for (const entry of chain) applyDelta(adapt(synced), readDelta(entry))

    const rebuilt = new DatabaseSync(published.next_db, { readOnly: true })
    // The record tables, exactly. This is the claim: a synced copy and a rebuilt
    // one hold the same corpus.
    for (const [table, order] of [
      ['cve', 'id'],
      ['cve_text', 'cve_id'],
      ['cve_cwe', 'cve_id, cwe_id'],
      ['cve_prod', 'cve_id, product_id'],
      ['cve_ref', 'cve_id, url_id'],
      ['cve_ver', 'cve_id, product_id, version'],
    ] as const) {
      expect(rows(synced, table, order), `${table} differs`).toEqual(rows(rebuilt, table, order))
    }

    // Lookups are a *superset*, by design: a value the corpus stopped using
    // loses its row in a rebuild but keeps its id reserved forever, and a delta
    // has no way to say "this id is retired" — nor any need to, since the id is
    // never reissued (D-056).
    for (const table of LOOKUP_ORDER) {
      const local = new Map(rows(synced, table, 'id').map((row) => [row[0], row]))
      for (const row of rows(rebuilt, table, 'id')) {
        expect(local.get(row[0]), `${table} row ${String(row[0])}`).toEqual(row)
      }
    }

    // And the watermark landed on the revision the rebuild carries.
    const rev = (db: DatabaseSync) =>
      Object.values(db.prepare("SELECT v FROM meta WHERE k = 'rev'").get()!)[0]
    expect(rev(synced)).toBe(rev(rebuilt))
    expect(rev(synced)).toBe(manifest.rev)

    // The indexes agree with the content they now describe — the one form of
    // the check that reads the external content table (RE-005).
    for (const index of SEARCH_INDEXES) {
      expect(() =>
        synced.exec(`INSERT INTO ${index.fts}(${index.fts}, rank) VALUES('integrity-check', 1)`)
      ).not.toThrow()
    }
    // And the indexes hold what the delta introduced, which is the half a
    // row-by-row table comparison cannot see: the pipeline publishes no fts5
    // tables, so nothing above would notice a sync that maintained none.
    // `CVE-2026-1002` had no English description at rev 1 and gains one here,
    // so this row is *only* in the index if apply put it there.
    const found = (fts: string, term: string) =>
      synced
        .prepare(`SELECT rowid FROM ${fts} WHERE ${fts} MATCH ?`)
        .all(term)
        .map((row) => Number((row as { rowid: number }).rowid))
    const gained = Object.values(
      synced.prepare("SELECT id FROM cve WHERE cve_id = 'CVE-2026-1002'").get()!
    )[0]
    expect(found('fts', 'rejected')).toEqual([gained])
    // A product interned by the delta, indexed under its new id.
    expect(found('fts_product', 'sprocket')).toEqual([4])

    synced.close()
    rebuilt.close()
  })
})

/**
 * The monthly rotation (D-060), validated by the client's own code. The
 * pipeline's tests can prove the manifest is internally consistent; only this
 * can prove the browser still finds a chain through it — and the shape is new,
 * because every retained delta starts *below* the snapshot's revision, which
 * the manifest writer refused before this milestone.
 */
describe('a data plane that has rotated twice', () => {
  it('is one this build can consume', () => {
    expect(() => assertUsable(rotated)).not.toThrow()
    expect(snapshotRev(rotated)).toBe(published.rotated.snapshot_rev)
    expect(rotated.rev).toBe(snapshotRev(rotated))
  })

  it('keeps deltas that start below the generation being served', () => {
    // The shape the manifest writer refused before D-060: after a rotation the
    // retained deltas chain *into* the snapshot from underneath it.
    expect(rotated.deltas.length).toBe(published.rotated.deltas_kept)
    expect(rotated.deltas.length).toBeGreaterThan(0)
    for (const entry of rotated.deltas) {
      expect(entry.from).toBeLessThan(snapshotRev(rotated))
      expect(() => readFileSync(dataFile(deltaUrl(entry), published.rotated.pub))).not.toThrow()
    }
  })

  it('lets a client one generation behind catch up instead of re-downloading', () => {
    // This client downloaded the generation the rotation replaced, and its
    // chunks are still served — which is what retention buys (D-042).
    const behind = Math.min(...rotated.deltas.map((entry) => entry.from))
    const chain = planSync(rotated, behind)
    expect(chain?.map((entry) => [entry.from, entry.to])).toEqual(
      rotated.deltas.map((entry) => [entry.from, entry.to])
    )
    const previous = join(published.rotated.pub, published.rotated.previous_generation)
    expect(readdirSync(previous).some((name) => name.endsWith('.br'))).toBe(true)
  })

  it('tells a client below the retention floor to re-download, rather than a chain', () => {
    // The other half of retention, and the half only a *twice*-rotated plane
    // has: this generation is gone (its directory was deleted), so `planSync`
    // must return null rather than half a path.
    expect(published.rotated.retired.generations.length).toBeGreaterThan(0)
    const gone = Number(published.rotated.retired.generations[0]!.split('-')[1])
    expect(planSync(rotated, gone)).toBeNull()
  })

  it('tells a freshly downloaded client it is already current', () => {
    expect(planSync(rotated, snapshotRev(rotated))).toEqual([])
  })

  it('serves the rotated generation at the URLs the client derives', () => {
    for (const chunk of rotated.snapshot.chunks) {
      const url = chunkUrl(rotated, chunk)
      expect(url).toContain(`/snapshot-${snapshotRev(rotated)}/`)
      expect(() => readFileSync(dataFile(url, published.rotated.pub))).not.toThrow()
    }
  })
})
