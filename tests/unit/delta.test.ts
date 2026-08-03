import { describe, expect, it } from 'vitest'

import { parseDelta } from '../../lib/delta'
import {
  assertDeltaEntry,
  assertUsable,
  chunkUrl,
  deltaUrl,
  planSync,
  snapshotRev,
  FORMAT_VERSION,
  SCHEMA_VERSION,
  type DeltaEntry,
  type Manifest,
} from '../../lib/protocol'

const NOTICE = 'CVE record content: Copyright © 1999-2026, The MITRE Corporation. …'

function entry(overrides: Partial<DeltaEntry> = {}): DeltaEntry {
  return { from: 1, to: 2, bytes: 512, raw_bytes: 2048, sha256: 'a'.repeat(64), ...overrides }
}

/** Untyped on purpose: these tests feed the validator things the types forbid. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: FORMAT_VERSION,
    schema: SCHEMA_VERSION,
    from: 1,
    to: 2,
    generated: 1_767_225_600,
    notice: NOTICE,
    lookups: {
      cna: [[1, 'acme-cna']],
      cwe: [[2, 'CWE-79', 'XSS']],
      vendor: [[1, 'acme']],
      product: [[1, 1, 'widget']],
      host: [[3, '']],
      url: [[4, 'javascript:alert(1)', 3]],
      vtype: [[1, 'semver']],
    },
    upsert: [
      {
        id: 7,
        cve: 'CVE-2026-1001',
        y: 2026,
        st: 1,
        cna: 1,
        pub: 1_767_000_000,
        upd: 1_767_100_000,
        cvss: [31, 7.5, 3, 'CVSS:3.1/AV:N/AC:L'],
        descr: 'Heap overflow in <script>alert(1)</script>',
        cwe: [2],
        prod: [1],
        ref: [4],
        ver: [[1, 1, '1.0', '2.0', null, 1]],
      },
    ],
    delete: ['CVE-2026-9999'],
    ...overrides,
  }
}

function record(overrides: Record<string, unknown>): Record<string, unknown> {
  const base = payload().upsert as Record<string, unknown>[]
  return payload({ upsert: [{ ...base[0], ...overrides }] })
}

describe('parseDelta', () => {
  it('accepts a delta the pipeline can produce, and keeps every column', () => {
    const parsed = parseDelta(payload(), entry())
    expect(parsed.from).toBe(1)
    expect(parsed.to).toBe(2)
    expect(parsed.lookups.url[0]).toEqual([4, 'javascript:alert(1)', 3])
    expect(parsed.upsert[0]!.cvss).toEqual([31, 7.5, 3, 'CVSS:3.1/AV:N/AC:L'])
    expect(parsed.upsert[0]!.ver).toEqual([[1, 1, '1.0', '2.0', null, 1]])
    expect(parsed.delete).toEqual(['CVE-2026-9999'])
  })

  it('leaves an omitted section omitted rather than inventing an empty one', () => {
    const sparse = record({
      descr: undefined,
      cwe: undefined,
      ref: undefined,
      ver: undefined,
      cvss: undefined,
      upd: undefined,
    })
    const parsed = parseDelta(sparse, entry())
    const first = parsed.upsert[0]!
    expect(first.descr).toBeUndefined()
    expect(first.cwe).toBeUndefined()
    expect(first.cvss).toBeUndefined()
    // Absent means absent: apply deletes the record's dependent rows and
    // inserts only what is here, so an invented [] and a missing key would
    // mean the same thing — but an invented "" description would not.
    expect(first.ver).toBeUndefined()
  })

  it('accepts explicit nulls for the columns the schema allows to be null', () => {
    const parsed = parseDelta(record({ cna: null, pub: null, upd: null, cvss: null }), entry())
    expect(parsed.upsert[0]!.cna).toBeUndefined()
    expect(parsed.upsert[0]!.pub).toBeUndefined()
  })

  it('carries a pre-1970 timestamp rather than clamping it', () => {
    const parsed = parseDelta(record({ pub: -86_400 }), entry())
    expect(parsed.upsert[0]!.pub).toBe(-86_400)
  })

  it('refuses a wire format it does not speak', () => {
    expect(() => parseDelta(payload({ format: 2 }), entry())).toThrow(/wire format/)
  })

  it('refuses a schema mismatch, since deltas cannot bridge one', () => {
    expect(() => parseDelta(payload({ schema: 2 }), entry())).toThrow(/re-download/)
  })

  it('refuses a delta that is not the one the manifest named', () => {
    expect(() => parseDelta(payload({ from: 4, to: 5 }), entry())).toThrow(/manifest's 1-2/)
  })

  it('refuses a copy of CVE data with no notice attached (D-008)', () => {
    expect(() => parseDelta(payload({ notice: '   ' }), entry())).toThrow(/D-008/)
  })

  it('refuses an unknown envelope key rather than ignoring it', () => {
    expect(() => parseDelta(payload({ rollup: true }), entry())).toThrow(/unexpected key "rollup"/)
  })

  it('refuses an unknown record key', () => {
    expect(() => parseDelta(record({ cpe: ['cpe:/a'] }), entry())).toThrow(/unexpected key "cpe"/)
  })

  it('refuses an empty description instead of writing an empty row', () => {
    expect(() => parseDelta(record({ descr: '' }), entry())).toThrow(/omit the key/)
  })

  it('refuses a row id that is not a positive integer', () => {
    expect(() => parseDelta(record({ id: 0 }), entry())).toThrow(/positive row id/)
    expect(() => parseDelta(record({ id: 1.5 }), entry())).toThrow(/expected an integer/)
    expect(() => parseDelta(record({ cwe: [1, '2'] }), entry())).toThrow(/upsert\[0\].cwe\[1\]/)
  })

  it('refuses a CVE ID that is empty or oversized', () => {
    expect(() => parseDelta(record({ cve: '' }), entry())).toThrow(/must not be empty/)
    expect(() => parseDelta(record({ cve: 'C'.repeat(65) }), entry())).toThrow(/over the 64/)
  })

  it('refuses a lookup tuple of the wrong arity or column type', () => {
    const lookups = payload().lookups as Record<string, unknown>
    expect(() => parseDelta(payload({ lookups: { ...lookups, cna: [[1]] } }), entry())).toThrow(
      /expected 2 columns/
    )
    expect(() =>
      parseDelta(payload({ lookups: { ...lookups, product: [[1, 'acme', 'widget']] } }), entry())
    ).toThrow(/lookups.product\[0\]\[1\]/)
  })

  it('refuses an unknown lookup table', () => {
    const lookups = payload().lookups as Record<string, unknown>
    expect(() => parseDelta(payload({ lookups: { ...lookups, cpe: [] } }), entry())).toThrow(
      /unexpected key "cpe"/
    )
  })

  it('treats a missing lookup table as empty but refuses an explicit null', () => {
    const lookups = payload().lookups as Record<string, unknown>
    const { cna: _dropped, ...withoutCna } = lookups
    expect(parseDelta(payload({ lookups: withoutCna }), entry()).lookups.cna).toEqual([])
    expect(() => parseDelta(payload({ lookups: { ...lookups, cna: null } }), entry())).toThrow(
      /lookups.cna: expected an array/
    )
  })

  it('refuses a malformed CVSS or version tuple', () => {
    expect(() => parseDelta(record({ cvss: [31, '7.5', 3, 'V'] }), entry())).toThrow(
      /finite number or null/
    )
    expect(() => parseDelta(record({ cvss: [31, 7.5, 3] }), entry())).toThrow(/expected 4 columns/)
    expect(() => parseDelta(record({ ver: [[1, 1, '1.0', null, null]] }), entry())).toThrow(
      /expected 6 columns/
    )
    expect(() => parseDelta(record({ ver: [[1, 1, 2, null, null, null]] }), entry())).toThrow(
      /expected a string/
    )
  })

  it('refuses a tombstone that is not a CVE ID', () => {
    expect(() => parseDelta(payload({ delete: [42] }), entry())).toThrow(/delete\[0\]/)
    expect(() => parseDelta(payload({ delete: {} }), entry())).toThrow(/expected an array/)
  })

  it('refuses a payload that is not an object at all', () => {
    expect(() => parseDelta('[]', entry())).toThrow(/expected an object/)
    expect(() => parseDelta(null, entry())).toThrow(/expected an object/)
    expect(() => parseDelta([payload()], entry())).toThrow(/expected an object/)
  })
})

describe('deltaUrl', () => {
  it('is built from the revision numbers, never from a name in the manifest', () => {
    expect(deltaUrl(entry())).toBe('/data/deltas/1-2.json.br')
    expect(deltaUrl(entry())).not.toContain('?')
  })

  it('refuses an entry whose numbers could not name a published file', () => {
    expect(() => deltaUrl(entry({ from: -1 }))).toThrow(/non-negative integers/)
    expect(() => deltaUrl(entry({ to: 1.5 }))).toThrow(/non-negative integers/)
    expect(() => deltaUrl(entry({ to: 1 }))).toThrow(/greater than from/)
    expect(() => deltaUrl(entry({ sha256: 'nope' }))).toThrow(/64 hex/)
  })
})

describe('assertDeltaEntry', () => {
  it('accepts what the pipeline writes', () => {
    expect(() => assertDeltaEntry(entry())).not.toThrow()
  })

  it('refuses byte counts that are not integers', () => {
    expect(() => assertDeltaEntry(entry({ bytes: -1 }))).toThrow(/byte counts/)
  })
})

describe('chunkUrl', () => {
  it('refuses a snapshot path or chunk name that could leave /data/', () => {
    // Deltas cannot carry a path segment because their URL is built from two
    // integers; chunks are named by strings out of the manifest, so the same
    // guarantee has to be a check.
    const escape = manifest([], 1)
    escape.snapshot.path = '../../etc'
    expect(() => chunkUrl(escape, escape.snapshot.chunks[0]!)).toThrow(/snapshot directory/)

    const ok = manifest([], 1)
    expect(() => chunkUrl(ok, { ...ok.snapshot.chunks[0]!, name: 'passwd?x=1' })).toThrow(
      /names a chunk/
    )
    expect(chunkUrl(ok, ok.snapshot.chunks[0]!)).toBe('/data/snapshot-1/000.br')
  })
})

describe('snapshotRev', () => {
  it('reads the snapshot revision the publisher wrote', () => {
    expect(snapshotRev(manifest([], 1, 7))).toBe(7)
  })

  it('names the real problem when the manifest predates the delta contract', () => {
    // The generation live today has no snapshot.rev. Without this the sync path
    // reported "local watermark undefined is not a revision" — blaming the
    // local database for a missing manifest field.
    const legacy = manifest([], 1)
    delete legacy.snapshot.rev
    expect(() => snapshotRev(legacy)).toThrow(/predates the delta contract/)
    // …and the download path is unaffected, which is the point of not gating
    // `assertUsable` on it.
    expect(() => assertUsable(legacy)).not.toThrow()
  })
})

function manifest(deltas: DeltaEntry[], rev: number, snapshotRevision = 1): Manifest {
  return {
    format: FORMAT_VERSION,
    schema: SCHEMA_VERSION,
    rev,
    generated: 1_767_225_600,
    notice: NOTICE,
    snapshot: {
      path: `snapshot-${snapshotRevision}`,
      rev: snapshotRevision,
      raw_bytes: 4096,
      chunk_bytes: 4096,
      chunks: [{ name: '000.br', offset: 0, raw_bytes: 4096, bytes: 512, sha256: 'a' }],
    },
    deltas,
  }
}

describe('planSync', () => {
  it('has nothing to do when the local copy is already at head', () => {
    expect(planSync(manifest([], 1), 1)).toEqual([])
  })

  it('walks consecutive daily deltas in apply order', () => {
    const daily = [entry({ from: 1, to: 2 }), entry({ from: 2, to: 3 }), entry({ from: 3, to: 4 })]
    const chain = planSync(manifest(daily, 4), 1)
    expect(chain?.map((d) => [d.from, d.to])).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
    ])
  })

  it('starts from the watermark, not from the snapshot', () => {
    const daily = [entry({ from: 1, to: 2 }), entry({ from: 2, to: 3 })]
    expect(planSync(manifest(daily, 3), 2)?.map((d) => d.to)).toEqual([3])
  })

  it('prefers the longest hop, so a rollup replaces the files it covers', () => {
    const mixed = [
      entry({ from: 1, to: 2 }),
      entry({ from: 1, to: 3 }),
      entry({ from: 2, to: 3 }),
      entry({ from: 3, to: 4 }),
    ]
    expect(planSync(manifest(mixed, 4), 1)?.map((d) => [d.from, d.to])).toEqual([
      [1, 3],
      [3, 4],
    ])
  })

  it('finds a chain even when the longest first hop dead-ends', () => {
    // Greedy longest-first took 1→3 and reported "re-download 63 MB" with a
    // two-file chain sitting right there.
    const awkward = [
      entry({ from: 1, to: 3 }),
      entry({ from: 1, to: 2 }),
      entry({ from: 2, to: 4 }),
    ]
    expect(planSync(manifest(awkward, 4), 1)?.map((d) => [d.from, d.to])).toEqual([
      [1, 2],
      [2, 4],
    ])
  })

  it('takes the fewest files when several chains reach head', () => {
    const many = [
      entry({ from: 1, to: 2 }),
      entry({ from: 2, to: 3 }),
      entry({ from: 3, to: 4 }),
      entry({ from: 1, to: 3 }),
    ]
    expect(planSync(manifest(many, 4), 1)?.map((d) => [d.from, d.to])).toEqual([
      [1, 3],
      [3, 4],
    ])
  })

  it('reports "nothing to do" before it inspects entries it will never fetch', () => {
    // The daily "anything new?" check is the common case, and it should not be
    // what surfaces a malformed entry for a revision this client is past.
    const broken = [entry({ from: 1, to: 2, sha256: 'not-a-hash' })]
    expect(planSync(manifest(broken, 2), 2)).toEqual([])
  })

  it('reports no chain — not a partial one — when the files do not tile', () => {
    const holed = [entry({ from: 1, to: 2 }), entry({ from: 3, to: 4 })]
    expect(planSync(manifest(holed, 4), 1)).toBeNull()
    expect(planSync(manifest([], 9), 1)).toBeNull()
  })

  it('refuses to guess when the origin is behind the local copy', () => {
    expect(() => planSync(manifest([], 2), 5)).toThrow(/ahead of the origin/)
  })

  it('refuses a manifest that contradicts itself', () => {
    expect(() => planSync(manifest([entry({ from: 1, to: 9 })], 2), 1)).toThrow(
      /above the head revision/
    )
    expect(() => planSync(manifest([entry({ from: 2, to: 2 })], 2), 1)).toThrow(/greater than from/)
  })
})
