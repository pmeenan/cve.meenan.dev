import { expect, test } from '@playwright/test'

/**
 * `scripts/serve.mjs` exists so browser measurements run against production's
 * headers. That only means something if the two are actually checked against
 * each other — the last two production-only failures (RE-012, RE-013) were both
 * cases where the local server was quietly more permissive than nginx.
 *
 * These assert the policies the decision log commits to, against whatever server
 * the suite is pointed at. Run against the deployed origin they check nginx;
 * run locally they check that serve.mjs still tells the truth.
 */
test.describe('served cache and isolation policy', () => {
  test('the SQLite distribution revalidates (D-054)', async ({ request }) => {
    // Unversioned files that must upgrade as a set: a stale one against fresh
    // others is a silent mixed-version failure, and RE-013 means the user
    // cannot clear it themselves.
    for (const path of ['/sqlite/index.mjs', '/sqlite/sqlite3.wasm']) {
      const response = await request.get(path)
      expect(response.status(), path).toBe(200)
      expect(response.headers()['cache-control'], path).toBe('no-cache')
    }
  })

  test('the module the Worker imports is served as JavaScript (RE-012)', async ({ request }) => {
    // Served as anything else, the browser refuses the module and the database
    // never opens — which is exactly how the first deploy failed.
    const response = await request.get('/sqlite/index.mjs')
    expect(response.headers()['content-type']).toMatch(/javascript/)
  })

  test('the data plane is immutable except the manifest (D-034, D-041)', async ({ request }) => {
    const manifest = await request.get('/data/manifest.json')
    expect(manifest.status()).toBe(200)
    expect(manifest.headers()['cache-control']).toBe('no-cache')

    const { snapshot } = (await manifest.json()) as {
      snapshot: { path: string; chunks: { name: string }[] }
    }
    const chunk = await request.get(`/data/${snapshot.path}/${snapshot.chunks[0]!.name}`)
    expect(chunk.status()).toBe(200)
    expect(chunk.headers()['cache-control']).toContain('immutable')
    // The client decompresses these itself; a Content-Encoding here would mean
    // the transport already did, and the brotli decoder would choke (D-040).
    expect(chunk.headers()['content-encoding']).toBeUndefined()
  })

  test('the KEV catalog revalidates and is never immutable (D-076)', async ({ request }) => {
    // The plane's *second* mutable file, and the one whose cache policy is the
    // easiest to get catastrophically wrong: under the general `^~ /data/` rule
    // it would be pinned for a year at the edge and in every browser that
    // fetched it, at an unversioned URL — a frozen known-exploited set shown
    // beside a freshness claim. The first fetch through Cloudflare pins
    // whatever policy is in place, so this has to be true before the first
    // catalog is published, not after.
    const response = await request.get('/data/kev.json')
    expect(response.status()).toBe(200)
    expect(response.headers()['cache-control']).toBe('no-cache')
    // Self-describing, which is why it is outside the manifest (D-076 §2). This
    // does **not** check verbatimness — nothing here has upstream's bytes to
    // compare against; `pipeline/tests/test_kev.py` asserts that where it can.
    const catalog = (await response.json()) as { catalogVersion: string; count: number }
    expect(typeof catalog.catalogVersion).toBe('string')
    expect(catalog.count).toBeGreaterThan(0)
    // The notice CC0 does not require, checked as absent so a later change that
    // "helpfully" adds one is caught (D-076 §1).
    expect(Object.keys(catalog)).not.toContain('notice')
  })

  test('a 404 under /data/ is not cacheable for a year (M5)', async ({ request }) => {
    // Delta and catalog URLs are predictable, so an `immutable` 404 is a cheap
    // remote sync-DoS: request tomorrow's URL today and poison it at the edge
    // for a year.
    //
    // **This only means something against the real origin.** The failure is
    // nginx's `always` flag on the `Cache-Control` line, and `scripts/serve.mjs`
    // has no equivalent — its 404 branch sends `content-type` and nothing else,
    // so run locally this test cannot fail. It earns its place under
    // `BASE_URL=https://cve.meenan.dev pnpm e2e headers`, which is how the M5
    // finding was found and how this one has to be confirmed. Saying so here
    // rather than letting a green local run imply coverage is the RE-024
    // lesson.
    const response = await request.get('/data/no-such-file-6f1a.json')
    expect(response.status()).toBe(404)
    expect(response.headers()['cache-control'] ?? '').not.toContain('immutable')
  })

  test('same-origin is enforced by the absence of CORS headers (D-034)', async ({ request }) => {
    const response = await request.get('/data/manifest.json', {
      headers: { Origin: 'https://not-this-origin.example' },
    })
    expect(response.headers()['access-control-allow-origin']).toBeUndefined()
  })
})
