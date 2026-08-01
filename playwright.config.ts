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
  timeout: 120_000,
  use: {
    baseURL: 'http://127.0.0.1:4747',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node scripts/serve.mjs',
    url: 'http://127.0.0.1:4747/',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
