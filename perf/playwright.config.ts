import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  workers: 1,
  globalTeardown: '../e2e/global-teardown.ts',
  timeout: 300_000,
  reporter: [['list']],
  outputDir: 'resultados'
})
