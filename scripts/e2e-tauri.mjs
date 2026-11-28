// Corre Playwright contra el ejecutable de Tauri (SLOTH_E2E_RUNTIME=tauri). Los argumentos pasan tal cual:
// `node scripts/e2e-tauri.mjs e2e/cierre.spec.ts`.
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
const playwright = join(raiz, 'node_modules', '@playwright', 'test', 'cli.js')
execFileSync(process.execPath, [playwright, 'test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: raiz,
  env: { ...process.env, SLOTH_E2E_RUNTIME: 'tauri' }
})
