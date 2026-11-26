import { test, expect } from './sloth'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'

/**
 * Medidas, no capturas de referencia: a 900×560 (el mínimo de la ventana) y a 1280×800 el panel lateral
 * no le quita sitio a las terminales, el commit de Git queda a la vista y las páginas dejan filas de lista.
 * Con SLOTH_SHOTS=<carpeta> además guarda capturas sueltas (para comparar antes/después a mano).
 */

const TAMANOS = [
  { w: 900, h: 560 },
  { w: 1280, h: 800 }
]

async function tamano(app: ElectronApplication, page: Page, w: number, h: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [ancho, alto]) => BrowserWindow.getAllWindows()[0].setContentSize(ancho, alto), [w, h])
  await expect.poll(() => page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`)).toBe(`${w}x${h}`)
  await page.waitForTimeout(300)
}

async function foto(page: Page, nombre: string): Promise<void> {
  const dir = process.env.SLOTH_SHOTS
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(dir, `${nombre}.png`) })
}

const riel = (page: Page, destino: string) => page.locator(`.sl-rail [data-nav="${destino}"]`)

test.describe('paneles y panel lateral', () => {
  test.use({
    seed: {
      workspaces: [
        { id: 'ws-a', name: 'api-pagos', open: true },
        { id: 'ws-b', name: 'web', open: true }
      ]
    }
  })

  test('a 900 px el panel lateral arranca plegado y cada terminal pasa de ~50 columnas', async ({ sloth: { app, page } }) => {
    await tamano(app, page, 900, 560)
    await foto(page, 'paneles-900x560')
    await expect(page.locator('.sl-side')).toBeHidden()
    const anchos = await page.locator('.panes-area > .pane:visible').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width))
    expect(anchos).toHaveLength(2)
    for (const a of anchos) expect(a).toBeGreaterThanOrEqual(400)
  })

  test('a 900 px abrir el panel lateral deja un solo panel a la vista, sin pisar la preferencia', async ({ sloth: { app, page } }) => {
    await tamano(app, page, 900, 560)
    await page.getByRole('button', { name: /barra lateral/ }).first().click()
    await expect(page.locator('.sl-side')).toBeVisible()
    await foto(page, 'paneles-900x560-con-lateral')
    await expect(page.locator('.panes-area > .pane:visible')).toHaveCount(1)
    await tamano(app, page, 1280, 800)
    await expect(page.locator('.sl-side')).toBeVisible()
    await expect(page.locator('.panes-area > .pane:visible')).toHaveCount(2)
  })

  test('a 1280 px sigue todo como antes: panel lateral y dos paneles', async ({ sloth: { app, page } }) => {
    await tamano(app, page, 1280, 800)
    await expect(page.locator('.sl-side')).toBeVisible()
    await foto(page, 'paneles-1280x800')
    await expect(page.locator('.panes-area > .pane:visible')).toHaveCount(2)
  })
})

test.describe('cajón de Git', () => {
  test.use({ seed: { workspaces: [{ id: 'ws-git', name: 'api-pagos', open: true }] } })

  for (const { w, h } of TAMANOS) {
    test(`a ${w}×${h} el commit queda a la vista y el diff tiene altura`, async ({ sloth: { app, page } }) => {
      const userData = await app.evaluate(({ app: a }) => a.getPath('userData'))
      const repo = join(userData, 'repos', 'ws-git')
      const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
      git('init', '-q')
      git('config', 'user.email', 'e2e@example.com')
      git('config', 'user.name', 'e2e')
      writeFileSync(join(repo, 'a.txt'), Array.from({ length: 60 }, (_, i) => `linea ${i}`).join('\n') + '\n')
      writeFileSync(join(repo, 'b.txt'), 'uno\n')
      git('add', '.')
      git('commit', '-q', '-m', 'inicial')
      writeFileSync(join(repo, 'a.txt'), Array.from({ length: 60 }, (_, i) => `linea ${i} cambiada`).join('\n') + '\n')
      writeFileSync(join(repo, 'b.txt'), 'dos\n')
      writeFileSync(join(repo, 'c.txt'), 'nuevo\n')

      await tamano(app, page, w, h)
      await page.getByRole('button', { name: /^Más acciones de api-pagos/ }).first().click()
      await page.getByRole('menuitem', { name: /Ver cambios/ }).click()
      await expect(page.locator('.g-commit')).toBeVisible()
      await expect(page.locator('.g-diffbox')).toBeVisible()
      await foto(page, `git-${w}x${h}`)

      const m = await page.evaluate(() => {
        const r = (s: string): DOMRect => document.querySelector(s)!.getBoundingClientRect()
        return { commit: r('.g-commit'), guardar: r('.g-commit-actions'), diff: r('.g-diffscroll'), zona: r('.g-scroll'), ventana: window.innerHeight, panel: r('.ui-side') }
      })
      expect(m.guardar.bottom).toBeLessThanOrEqual(m.ventana)
      expect(m.commit.bottom).toBeLessThanOrEqual(m.ventana)
      // Lo que se ve del diff dentro de la zona que scrollea (arriba de la caja del commit).
      const visible = Math.min(m.diff.bottom, m.zona.bottom) - Math.max(m.diff.top, m.zona.top)
      expect(visible).toBeGreaterThanOrEqual(w === 900 ? 100 : 240)
      expect(m.panel.left).toBeGreaterThanOrEqual(0)
    })
  }
})

test.describe('cabeceras y filtros', () => {
  for (const { w, h } of TAMANOS) {
    test(`Ayuda a ${w}×${h}: el título grande solo sobra con poca altura`, async ({ sloth: { app, page } }) => {
      await tamano(app, page, w, h)
      await riel(page, 'ayuda').click()
      await expect(page.locator('.ui-view')).toBeVisible()
      await foto(page, `ayuda-${w}x${h}`)
      await expect(page.locator('.ay-head h1')).toHaveCount(1)
      const alto = await page.locator('.ay-head').evaluate((e) => e.getBoundingClientRect().height)
      // Con poca altura queda un punto de 1 px (el lector de pantalla lo sigue leyendo).
      if (h < 680) expect(alto).toBeLessThanOrEqual(1)
      else expect(alto).toBeGreaterThan(20)
    })

    test(`Tickets a ${w}×${h}: filtros compactos`, async ({ sloth: { app, page } }) => {
      await tamano(app, page, w, h)
      await inyectarTickets(app, page)
      await riel(page, 'tickets').click()
      await expect(page.locator('.f-tickets-filters')).toBeVisible()
      await foto(page, `tickets-${w}x${h}`)
      const m = await page.evaluate(() => {
        const top = (s: string): number => document.querySelector(s)!.getBoundingClientRect().top
        const caja = document.querySelector('.f-tickets-filters')!.getBoundingClientRect()
        return { busca: top('.f-tickets-search'), chips: top('.f-tickets-chips'), prio: top('.f-tickets-prio-field'), alto: caja.height }
      })
      // Con la lista a ancho completo (900) todo va en una fila; con la lista a media pantalla, en dos como mucho.
      if (w === 900) {
        expect(Math.abs(m.busca - m.prio)).toBeLessThan(16)
        expect(Math.abs(m.busca - m.chips)).toBeLessThan(16)
        expect(m.alto).toBeLessThan(80)
      } else {
        expect(m.alto).toBeLessThan(120)
      }
    })
  }
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
      { id: 'TCK-212', titulo: 'Reintentos en el webhook de pagos', estado: 'doing', prioridad: 'Alta', proyecto: 'api-pagos', responsable: 'Tomás', responsableId: 'u1' },
      { id: 'TCK-219', titulo: 'Checkout: el botón Pagar queda deshabilitado', estado: 'todo', prioridad: 'Crítica', proyecto: 'web', responsable: 'Tomás', responsableId: 'u1' },
      { id: 'TCK-220', titulo: 'Migrar el envío de mails a la cola nueva', estado: 'review', prioridad: 'Media', proyecto: 'api-pagos', responsable: 'Tomás', responsableId: 'u1' }
    ]
  }
  await app.evaluate(({ BrowserWindow }, snap) => BrowserWindow.getAllWindows()[0]!.webContents.send('feat:tickets:changed', snap), fake)
}
