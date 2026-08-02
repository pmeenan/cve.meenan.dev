import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright is where every browser-side measurement lands: OPFS, SQLite/WASM,
 * and the import path (Q-003, Q-004). It serves the real static export rather
 * than a dev server, because the export is what ships.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  // A stall detector, not a latency budget (D-052). Generous because the
  // full-corpus path legitimately runs for minutes; import.spec sets its own
  // when it is pointed at the full artifact.
  timeout: 120_000,
  use: {
    baseURL: 'http://127.0.0.1:4747',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node scripts/serve.mjs',
    url: 'http://127.0.0.1:4747/',
    // Never reuse someone else's server for a measurement run: `pnpm measure`
    // passes SERVE_DATA_ROOT to select the full artifact, and a server already
    // listening on this port was started with a different one — which would
    // silently measure the development slice and publish it as full scale.
    reuseExistingServer: !process.env.CI && process.env.MEASURE !== '1',
    timeout: 60_000,
  },
})
