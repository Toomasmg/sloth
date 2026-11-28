import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchSloth, closeSloth } from './sloth'

/**
 * Aviso al cerrar con la X. El diálogo es nativo (Playwright no lo ve): se reemplaza
 * `dialog.showMessageBox` en main para leer qué pregunta Sloth y contestar como la persona.
 * En Tauri el aviso es de Rust (src-tauri/src/handlers/tray.rs): con SLOTH_E2E no abre el diálogo, contesta lo que
 * se le fija con `e2e:dialogos:responder` y anota lo que habría mostrado.
 */

interface Answer {
  response: number
  checkboxChecked?: boolean
}

const enTauri = process.env.SLOTH_E2E_RUNTIME === 'tauri'

async function invocarRust(app: ElectronApplication, canal: string, ...args: unknown[]): Promise<unknown> {
  const page = await app.firstWindow()
  return page.evaluate(
    ([c, a]) => (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, p: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke('ipc_invoke', { channel: c, args: a }),
    [canal, args] as [string, unknown[]]
  )
}

async function stubDialog(app: ElectronApplication, answer: Answer): Promise<void> {
  if (enTauri) {
    await invocarRust(app, 'e2e:dialogos:responder', answer)
    return
  }
  await app.evaluate(({ dialog }, a) => {
    const g = globalThis as unknown as { __dialogs: unknown[] }
    g.__dialogs = []
    dialog.showMessageBox = (async (...args: unknown[]) => {
      g.__dialogs.push(args.find((x) => x && typeof x === 'object' && 'message' in (x as object)))
      return { response: a.response, checkboxChecked: a.checkboxChecked ?? false }
    }) as typeof dialog.showMessageBox
  }, answer)
}

type Shown = { message: string; detail: string; buttons: string[]; type: string; checkboxLabel: string }
const shownDialogs = (app: ElectronApplication): Promise<Shown[]> =>
  enTauri
    ? (invocarRust(app, 'e2e:dialogos:vistos') as Promise<Shown[]>)
    : app.evaluate(() => (globalThis as unknown as { __dialogs: Shown[] }).__dialogs)

/** Toca la X de la ventana (lo mismo que hace Windows). */
const clickX = (app: ElectronApplication): Promise<void> =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())

const windowState = (app: ElectronApplication): Promise<{ count: number; visible: boolean }> =>
  app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()
    return { count: w.length, visible: w[0]?.isVisible() ?? false }
  })

/** Espera a que la terminal del espacio esté corriendo. */
async function terminalRunning(page: Page): Promise<void> {
  await expect(page.locator('.xterm')).toHaveCount(1)
  await expect(page.getByText('Terminales activas: 1')).toBeVisible()
}

const conTerminal = { workspaces: [{ id: 'ws-cierre', name: 'web', open: true }] }

test.describe('con una terminal abierta', () => {
  test.use({ seed: conTerminal })

  test('pregunta antes de cerrar y Cancelar deja Sloth abierto', async ({ sloth: { app, page } }) => {
    await terminalRunning(page)
    await stubDialog(app, { response: 2 })
    await clickX(app)

    await expect.poll(async () => (await shownDialogs(app)).length).toBe(1)
    const [d] = await shownDialogs(app)
    expect(d.message).toBe('¿Cerrar Sloth?')
    expect(d.detail).toContain('Tenés 1 terminal abierta.')
    expect(d.detail).toContain('Siguen corriendo en segundo plano')
    expect(d.buttons).toEqual(['Cerrar Sloth', 'Ocultar en la bandeja', 'Cancelar'])
    expect(d.checkboxLabel).toBe('No volver a preguntar')

    expect(await windowState(app)).toEqual({ count: 1, visible: true })
  })

  test('Ocultar en la bandeja esconde la ventana sin cerrar', async ({ sloth: { app, page } }) => {
    await terminalRunning(page)
    await stubDialog(app, { response: 1 })
    await clickX(app)
    await expect.poll(() => windowState(app)).toEqual({ count: 1, visible: false })
  })

  test('Cerrar Sloth cierra la app', async ({ sloth: { app, page } }) => {
    await terminalRunning(page)
    await stubDialog(app, { response: 0 })
    const exited = new Promise<void>((r) => app.process().once('exit', () => r()))
    await clickX(app)
    await exited
  })
})

test('«No volver a preguntar» + Cerrar apaga el aviso en Configuración', async () => {
  const { app, page, userData } = await launchSloth(conTerminal)
  try {
    await terminalRunning(page)
    await stubDialog(app, { response: 0, checkboxChecked: true })
    const exited = new Promise<void>((r) => app.process().once('exit', () => r()))
    await clickX(app)
    await exited
    const saved = JSON.parse(readFileSync(join(userData, 'perfiles', 'principal', 'features', 'settings.json'), 'utf8')) as { confirmQuit?: boolean }
    expect(saved.confirmQuit).toBe(false)
  } finally {
    await closeSloth(app, userData)
  }
})

test.describe('con «Dejar las terminales vivas» apagado', () => {
  test.use({ seed: { ...conTerminal, settings: { keepTerminalsAlive: false } } })

  test('avisa que las terminales se cortan', async ({ sloth: { app, page } }) => {
    await terminalRunning(page)
    await stubDialog(app, { response: 2 })
    await clickX(app)
    await expect.poll(async () => (await shownDialogs(app)).length).toBe(1)
    const [d] = await shownDialogs(app)
    expect(d.type).toBe('warning')
    expect(d.detail).toContain('Se van a cerrar junto con el Claude de cada una')
  })
})

test.describe('sin terminales abiertas', () => {
  test('cierra directo, sin preguntar', async ({ sloth: { app } }) => {
    await stubDialog(app, { response: 2 })
    const exited = new Promise<void>((r) => app.process().once('exit', () => r()))
    await clickX(app)
    // Si hubiera preguntado, la respuesta «Cancelar» lo habría dejado abierto.
    await exited
  })
})

test.describe('con «Preguntar antes de cerrar» apagado', () => {
  test.use({ seed: { ...conTerminal, settings: { confirmQuit: false } } })

  test('cierra directo aunque haya terminales', async ({ sloth: { app, page } }) => {
    await terminalRunning(page)
    await stubDialog(app, { response: 2 })
    const exited = new Promise<void>((r) => app.process().once('exit', () => r()))
    await clickX(app)
    await exited
  })
})
