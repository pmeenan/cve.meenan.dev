import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    // Pinned, and deliberately *not* UTC: every date boundary in this app is
    // UTC by rule (lib/draft.ts, lib/dates.ts), and a suite running in UTC
    // cannot tell a correct implementation from one that reads local time.
    // The author's machine happens to be here; a CI box would not be.
    env: { TZ: 'America/New_York' },
    coverage: { provider: 'v8', reportsDirectory: 'coverage' },
  },
})
