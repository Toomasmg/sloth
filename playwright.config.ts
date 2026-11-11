import { defineConfig } from '@playwright/test'

/**
 * Pruebas visuales de Sloth (Electron) con Playwright. Prueban el build de `out/`:
 * `npm run test:e2e` compila y corre; `npm run test:e2e:update` rehace las capturas de referencia.
 */
export default defineConfig({
  testDir: 'e2e',
  // Una app a la vez: cada test abre su propio Sloth y su ventana.
  workers: 1,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    // Margen chico para el suavizado de letras; un cambio de diseño real lo supera de lejos.
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled', caret: 'hide' }
  },
  snapshotPathTemplate: '{testDir}/capturas/{testFileName}/{arg}{ext}',
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' }
})
