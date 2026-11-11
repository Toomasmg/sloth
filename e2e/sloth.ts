import { test as base, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Sloth de verdad (el build de `out/`), aislado de los datos reales:
 * - carpeta de datos temporal (SLOTH_USER_DATA): otro lock, sin cuentas reales, se borra al final;
 * - terminales dentro del proceso (SLOTH_INPROCESS): no se levanta ni se toca ningún daemon;
 * - escala 1 y tamaño fijo: las capturas salen iguales en cualquier PC.
 */

export interface Seed {
  /** Espacios de prueba (con su cuenta). Las carpetas se crean solas. */
  workspaces?: { id: string; name: string; open?: boolean }[]
  /** Espacios que arrancan dormidos. */
  asleep?: string[]
  /** Parche de Configuración (features/settings.json). */
  settings?: Record<string, unknown>
}

export const ACCOUNT_ID = 'acc-e2e'
/** Prefijo de las carpetas de datos de prueba (global-teardown barre las que queden). */
export const USERDATA_PREFIX = 'sloth-e2e-'
/** El proceso de cada app, guardado al abrirla: después de que se cierra sola, Playwright ya no lo da. */
const procs = new WeakMap<ElectronApplication, ReturnType<ElectronApplication['process']>>()

function seedUserData(dir: string, seed: Seed): void {
  const features = join(dir, 'features')
  mkdirSync(features, { recursive: true })
  // Sin asistente de bienvenida: se prueba la app ya usada.
  writeFileSync(join(features, 'onboarding.json'), JSON.stringify({ version: 1, completed: true, step: 0, updatedAt: 1 }))
  // Sin «Novedades» al abrir: la versión actual ya se vio.
  const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
  writeFileSync(join(features, 'help.json'), JSON.stringify({ lastSeen: version }))
  if (seed.settings) writeFileSync(join(features, 'settings.json'), JSON.stringify(seed.settings))
  if (seed.asleep?.length) writeFileSync(join(features, 'sleep.json'), JSON.stringify({ asleep: seed.asleep }))
  const ws = seed.workspaces ?? []
  if (!ws.length) return
  const configDir = join(dir, 'accounts', ACCOUNT_ID)
  mkdirSync(configDir, { recursive: true })
  const workspaces = ws.map((w, i) => {
    const cwd = join(dir, 'repos', w.id)
    mkdirSync(cwd, { recursive: true })
    return { id: w.id, name: w.name, repoPath: cwd, cwd, accountId: ACCOUNT_ID, autoStartClaude: false, createdAt: 1_700_000_000_000 + i }
  })
  const state = {
    version: 1,
    accounts: [{ id: ACCOUNT_ID, label: 'Prueba', configDir, createdAt: 1_700_000_000_000 }],
    workspaces,
    openPanes: ws.filter((w) => w.open).map((w) => w.id)
  }
  writeFileSync(join(dir, 'sloth-state.json'), JSON.stringify(state))
}

export async function launchSloth(seed: Seed = {}): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const userData = mkdtempSync(join(tmpdir(), USERDATA_PREFIX))
  seedUserData(userData, seed)
  const app = await electron.launch({
    args: ['--force-device-scale-factor=1', '.'],
    env: { ...process.env, SLOTH_USER_DATA: userData, SLOTH_INPROCESS: '1', ELECTRON_RENDERER_URL: '' }
  })
  procs.set(app, app.process())
  const page = await app.firstWindow()
  // La ventana arranca oculta y se muestra al terminar de dibujarse (ready-to-show).
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)).toBe(true)
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.unmaximize()
    w.setSize(1280, 800)
  })
  await page.waitForLoadState('domcontentloaded')
  // Las fuentes son parte de la captura: se espera a que carguen.
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  return { app, page, userData }
}

/** Cierra Sloth sin preguntas (el aviso de la X es nativo y frenaría el cierre) y borra sus datos de prueba. */
export async function closeSloth(app: ElectronApplication, userData: string): Promise<void> {
  const proc = procs.get(app)
  if (proc && proc.exitCode === null) {
    const closed = new Promise<void>((r) => proc.once('exit', () => r()))
    await app.evaluate(({ app: a }) => a.exit(0)).catch(() => undefined)
    // Si no cierra en 5 s, se mata.
    await Promise.race([closed, new Promise((r) => setTimeout(r, 5000))])
    if (proc.exitCode === null) proc.kill()
  }
  // Los procesos hijos de Chromium tardan un poco más en soltar sus archivos. Lo que quede, lo barre global-teardown.
  await new Promise((r) => setTimeout(r, 300))
  try {
    rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  } catch {
    /* lo borra global-teardown */
  }
}

export const test = base.extend<{ seed: Seed; sloth: { app: ElectronApplication; page: Page } }>({
  seed: [{}, { option: true }],
  sloth: async ({ seed }, use) => {
    const { app, page, userData } = await launchSloth(seed)
    await use({ app, page })
    await closeSloth(app, userData)
  }
})

export { expect }
