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

  test('same-origin is enforced by the absence of CORS headers (D-034)', async ({ request }) => {
    const response = await request.get('/data/manifest.json', {
      headers: { Origin: 'https://not-this-origin.example' },
    })
    expect(response.headers()['access-control-allow-origin']).toBeUndefined()
  })
})
