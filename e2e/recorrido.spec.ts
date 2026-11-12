import { test, expect } from './sloth'
import type { Page, ElectronApplication } from '@playwright/test'

/**
 * Recorrido por las pantallas principales (tema oscuro, 1280×800). Es la red de seguridad del rediseño:
 * cada captura de referencia se regenera a propósito y con explicación, nunca para que un test pase.
 * Lo de adentro de las terminales cambia de PC a PC: se tapa.
 */

test.use({ seed: { settings: { theme: 'oscuro' } } })

let n = 0
async function shot(page: Page, name: string): Promise<void> {
  n++
  await page.waitForTimeout(450)
  await expect.soft(page).toHaveScreenshot(`${String(n).padStart(2, '0')}-${name}.png`, { mask: [page.locator('.terminal-host')] })
}

async function esc(page: Page, veces = 3): Promise<void> {
  for (let i = 0; i < veces; i++) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(120)
  }
}

const boton = (page: Page, name: string | RegExp) => page.getByRole('button', { name, exact: typeof name === 'string' }).first()

test.beforeEach(() => {
  n = 0
})

test.describe('primer uso', () => {
  test.use({ seed: { settings: { theme: 'oscuro' }, onboarding: true } })

  test('asistente y sin cuentas', async ({ sloth: { page } }) => {
    await shot(page, 'primer-uso-asistente')
    await page.getByRole('button', { name: /Siguiente|Empezar|Continuar/ }).first().click()
    await shot(page, 'primer-uso-asistente-paso2')
    await esc(page)
    await shot(page, 'primer-uso-sin-cuentas')
  })
})

test.describe('inicio vacío', () => {
  test.use({ seed: { settings: { theme: 'oscuro' }, workspaces: [{ id: 'ws-web', name: 'web' }, { id: 'ws-api', name: 'api-pagos' }] } })

  test('espacios sin abrir', async ({ sloth: { page } }) => {
    await shot(page, 'inicio-vacio')
  })
})

const USO_REAL = {
  settings: { theme: 'oscuro' },
  extraAccounts: ['Trabajo'],
  workspaces: [
    { id: 'ws-web', name: 'web', open: true, branch: 'feat/checkout' },
    { id: 'ws-api', name: 'api-pagos', open: true, ticket: 'TCK-212' },
    { id: 'ws-docs', name: 'docs' },
    { id: 'ws-infra', name: 'infra', accountId: 'acc-extra-0' }
  ]
}

test.describe('uso real', () => {
  test.use({ seed: USO_REAL })

  test('paneles, menús y diálogos', async ({ sloth: { page } }) => {
    await expect(page.locator('.xterm')).toHaveCount(2)
    await page.waitForTimeout(1200)
    await shot(page, 'principal-dos-paneles')
    await page.locator('.sl-side').getByText('docs', { exact: true }).first().click()
    await expect(page.locator('.xterm')).toHaveCount(3)
    await page.waitForTimeout(800)
    await shot(page, 'principal-tres-paneles')
    await page.getByRole('button', { name: /^Uno/ }).first().click()
    await shot(page, 'principal-uno-con-pestanas')
    await page.getByRole('button', { name: /^Tres/ }).first().click()
    await page.keyboard.press('Control+K')
    await shot(page, 'paleta')
    await page.keyboard.type('plan')
    await shot(page, 'paleta-busqueda')
    await esc(page)
    await page.getByRole('button', { name: 'Menú de Sloth' }).click()
    await shot(page, 'menu-app')
    await esc(page)
    await page.getByRole('button', { name: /^Más acciones de web/ }).first().click()
    await shot(page, 'menu-panel')
    await esc(page)
    await page.locator('.sl-side').getByText('docs', { exact: true }).first().click({ button: 'right' })
    await shot(page, 'menu-espacio-lateral')
    await esc(page)
    await page.locator('.sl-crumb button').first().click()
    await shot(page, 'menu-migas')
    await esc(page)
    await page.locator('.sl-foot').getByRole('button', { name: /Nuevo espacio/ }).click()
    await shot(page, 'nuevo-espacio')
    await esc(page)
  })

  test('ajustes', async ({ sloth: { page } }) => {
    await page.keyboard.press('Control+,')
    const items = page.locator('.f-set-item')
    await expect(items.first()).toBeVisible()
    const total = await items.count()
    for (let i = 0; i < total; i++) {
      const etiqueta = (await items.nth(i).innerText()).split('\n')[0]!.trim().toLowerCase().replace(/[^a-záéíóúñ]+/g, '-')
      await items.nth(i).click()
      await shot(page, `ajustes-${i}-${etiqueta}`)
    }
  })

  test('herramientas, chat y menú de Sloth', async ({ sloth: { page } }) => {
    await page.locator('.tools-row').first().click()
    await shot(page, 'tickets-sin-conector')
    await esc(page)
    const herramientas: [string, string][] = [
      ['Historial de sesiones', 'historial'],
      ['Plantillas', 'plantillas'],
      ['Ramas aparte', 'ramas'],
      ['Enviar a varios espacios', 'enviar-a-varios'],
      ['Limpiar ramas que ya no se usan', 'limpiar-ramas'],
      ['Ver equipo', 'equipo']
    ]
    for (const [b, name] of herramientas) {
      await boton(page, b).click()
      await shot(page, name)
      await esc(page)
    }
    await boton(page, /^Chat del equipo/).click()
    await shot(page, 'chat')
    await esc(page)
    const menu: [string, string][] = [
      ['Ayuda y atajos', 'ayuda'],
      ['Novedades', 'novedades'],
      ['Invitar a un compañero', 'invitar'],
      ['Reportar un problema', 'reportar'],
      ['Exportar configuración…', 'exportar'],
      ['Asistente de bienvenida', 'asistente']
    ]
    for (const [label, name] of menu) {
      await page.getByRole('button', { name: 'Menú de Sloth' }).click()
      await page.getByRole('menuitem', { name: label }).click()
      await shot(page, name)
      await esc(page)
    }
    await page.getByRole('button', { name: /^Más acciones de web/ }).first().click()
    await page.getByRole('menuitem', { name: /Ver cambios/ }).click()
    await shot(page, 'git-cambios')
  })

  test('tickets con conector', async ({ sloth: { app, page } }) => {
    await inyectarTickets(app, page)
    await page.locator('.tools-row').first().click()
    await shot(page, 'tickets-con-conector')
    await page.getByText('Reintentos en el webhook', { exact: false }).first().click()
    await shot(page, 'tickets-detalle')
  })
})

// No hay conector real en datos aislados: se le inyecta a la UI una foto falsa del estado con tickets.
async function inyectarTickets(app: ElectronApplication, page: Page): Promise<void> {
  type Estado = { conectores?: { id?: string; nombre?: string }[]; conector?: Record<string, unknown>; config?: Record<string, unknown> }
  const s = (await page.evaluate(() => window.sloth.feat.invoke('feat:tickets:state'))) as Estado
  const c = s.conectores?.find((x) => /github/i.test(x.id ?? x.nombre ?? '')) ?? s.conectores?.[0]
  const estados = [
    { clave: 'todo', nombre: 'Por hacer', categoria: 'pendiente' },
    { clave: 'doing', nombre: 'En curso', categoria: 'curso' },
    { clave: 'review', nombre: 'En revisión', categoria: 'revision' },
    { clave: 'done', nombre: 'Hecho', categoria: 'hecho' }
  ]
  const fake = {
    ...s,
    conector: { ...s.conector, id: c?.id ?? 'github', nombre: c?.nombre ?? 'GitHub Issues', disponible: true, verificado: true, estados, acciones: s.conector?.acciones ?? [] },
    config: { ...s.config, conectorId: c?.id ?? 'github' },
    estados,
    me: { id: 'u1', nombre: 'Tomás' },
    fetchedAt: Date.now() - 4 * 60_000,
    running: false,
    tickets: [
      { id: 'TCK-212', titulo: 'Reintentos en el webhook de pagos cuando Mercado Pago devuelve 502', estado: 'doing', prioridad: 'Alta', proyecto: 'api-pagos', responsable: 'Tomás', responsableId: 'u1' },
      { id: 'TCK-219', titulo: 'Checkout: el botón Pagar queda deshabilitado tras volver atrás', estado: 'todo', prioridad: 'Crítica', proyecto: 'web', responsable: 'Tomás', responsableId: 'u1' },
      { id: 'TCK-220', titulo: 'Migrar el envío de mails a la cola nueva', estado: 'review', prioridad: 'Media', proyecto: 'api-pagos', responsable: 'Tomás', responsableId: 'u1' },
      { id: 'TCK-198', titulo: 'Dark mode en el panel de admin', estado: 'todo', prioridad: 'Baja', proyecto: 'web', responsable: 'Ana', responsableId: 'u2' },
      { id: 'TCK-205', titulo: 'Logs estructurados en el worker de facturas', estado: 'doing', prioridad: 'Media', proyecto: 'infra', responsable: 'Pablo', responsableId: 'u3' },
      { id: 'TCK-230', titulo: 'Rate limit por cliente en la API pública', estado: 'todo', prioridad: 'Alta', proyecto: 'api-pagos' }
    ]
  }
  await app.evaluate(({ BrowserWindow }, snap) => BrowserWindow.getAllWindows()[0]!.webContents.send('feat:tickets:changed', snap), fake)
}
