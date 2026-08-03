import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  type Manifest,
} from '../../lib/protocol'

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
let published: { delta: { from: number; to: number }; hostile_text: string }

/** Where the local static server would serve a `/data/...` URL from. */
function dataFile(url: string): string {
  expect(url.startsWith(`${DATA_ROOT}/`)).toBe(true)
  return join(root, 'pub', url.slice(DATA_ROOT.length + 1))
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
