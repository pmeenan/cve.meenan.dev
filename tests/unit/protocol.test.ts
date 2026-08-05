import { describe, expect, it } from 'vitest'

import {
  assertUsable,
  chunkUrl,
  FORMAT_VERSION,
  manifestUrl,
  SCHEMA_VERSION,
  type Manifest,
} from '../../lib/protocol'

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    format: FORMAT_VERSION,
    schema: SCHEMA_VERSION,
    rev: 1,
    generated: 1_754_000_000,
    notice: 'CVE® is a trademark of The MITRE Corporation.',
    snapshot: {
      path: 'snapshot-1',
      rev: 1,
      raw_bytes: 51_871_744,
      chunk_bytes: 33_554_432,
      chunks: [
        { name: '000.br', offset: 0, raw_bytes: 33_554_432, bytes: 6_353_289, sha256: 'a' },
        {
          name: '001.br',
          offset: 33_554_432,
          raw_bytes: 18_317_312,
          bytes: 3_591_063,
          sha256: 'b',
        },
      ],
    },
    deltas: [],
    ...overrides,
  }
}

describe('assertUsable', () => {
  it('accepts a manifest this build speaks', () => {
    expect(() => assertUsable(manifest())).not.toThrow()
  })

  it('refuses a newer wire format rather than guessing at it', () => {
    expect(() => assertUsable(manifest({ format: 99 }))).toThrow(/wire format/)
  })

  it('refuses a schema mismatch, since deltas cannot bridge one (D-025)', () => {
    // The message names both versions and the action, because a published
    // schema this build does not speak means the *app* is behind, and
    // re-downloading the same bytes would fail the same way (M3). The local
    // copy is untouched either way, which is the other half of what a user
    // needs to hear.
    expect(() => assertUsable(manifest({ schema: 2 }))).toThrow(/schema 2 .*schema 1/)
    expect(() => assertUsable(manifest({ schema: 2 }))).toThrow(/reload the page/)
    expect(() => assertUsable(manifest({ schema: 2 }))).toThrow(/local copy is untouched/)
  })

  it('takes the schema it speaks from the caller, so a bump can be rehearsed', () => {
    // `?schema=2` is how the announcement and the refusals get exercised before
    // the day a real bump puts every existing user through them at once.
    expect(() => assertUsable(manifest({ schema: 2 }), 2)).not.toThrow()
    expect(() => assertUsable(manifest(), 2)).toThrow(/schema 1 .*schema 2/)
  })

  it('refuses a manifest with no chunks', () => {
    const empty = manifest()
    empty.snapshot.chunks = []
    expect(() => assertUsable(empty)).toThrow(/no snapshot chunks/)
  })
})

describe('urls', () => {
  it('never carries a query parameter — the server learns nothing (D-032)', () => {
    const m = manifest()
    const urls = [manifestUrl(), ...m.snapshot.chunks.map((c) => chunkUrl(m, c))]
    for (const url of urls) {
      expect(url.startsWith('/data/')).toBe(true)
      expect(url).not.toContain('?')
    }
  })

  it('addresses chunks by name under the snapshot directory', () => {
    const m = manifest()
    expect(chunkUrl(m, m.snapshot.chunks[0]!)).toBe('/data/snapshot-1/000.br')
  })
})

describe('chunk layout', () => {
  it('tiles the database contiguously, which is what makes resume a bitmap', () => {
    const { chunks, raw_bytes } = manifest().snapshot
    let expected = 0
    for (const chunk of chunks) {
      expect(chunk.offset).toBe(expected)
      expected += chunk.raw_bytes
    }
    expect(expected).toBe(raw_bytes)
  })
})
