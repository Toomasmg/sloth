import { defineConfig } from '@playwright/test'

/** Graba la demo del README (`npm run readme:demo`). Aparte de `e2e/`: la CI no la corre. */
export default defineConfig({
  testDir: 'scripts/readme',
  globalTeardown: './e2e/global-teardown.ts',
  workers: 1,
  timeout: 120_000,
  reporter: [['list']]
})
