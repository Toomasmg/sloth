import { test, expect } from './sloth'
import type { Page, Locator } from '@playwright/test'

test.use({ seed: { workspaces: [{ id: 'ws-web', name: 'web', open: true }] } })

interface Pantalla {
  nombre: string
  /** Abre la pantalla; devuelve el botón que la abrió si queda en pantalla (el foco tiene que volver ahí). */
  abrir: (page: Page) => Promise<Locator | null>
  dialogo: string | RegExp
  /** Nombre accesible del botón de salida. */
  salida: string | RegExp
}

async function porPaleta(page: Page, texto: string): Promise<null> {
  await page.keyboard.press('Control+k')
  const caja = page.getByRole('combobox').first()
  await caja.fill(texto)
  await page.keyboard.press('Enter')
  return null
}

const PANTALLAS: Pantalla[] = [
  {
    nombre: 'Configuración',
    abrir: async (page) => {
      const b = page.getByRole('button', { name: 'Configuración', exact: true })
      await b.click()
      return b
    },
    dialogo: /.+/,
    salida: 'Volver a los espacios'
  },
  { nombre: 'Plantillas', abrir: (p) => porPaleta(p, 'Nueva plantilla'), dialogo: 'Plantillas de espacio', salida: 'Cerrar' },
  { nombre: 'Acerca de Sloth (actualizaciones)', abrir: (p) => porPaleta(p, 'Buscar actualizaciones'), dialogo: 'Acerca de Sloth', salida: 'Cerrar' },
  { nombre: 'Reportar un problema', abrir: (p) => porPaleta(p, 'Reportar un problema'), dialogo: 'Reportar un problema', salida: 'Volver a los espacios' },
  { nombre: 'Exportar configuración', abrir: (p) => porPaleta(p, 'Exportar configuración'), dialogo: /Exportar/, salida: 'Volver a Configuración' },
  { nombre: 'Decisiones', abrir: (p) => porPaleta(p, 'Decisiones de permisos'), dialogo: 'Decisiones', salida: 'Cerrar' },
  { nombre: 'Pedidos de permiso', abrir: (p) => porPaleta(p, 'Revisar pedidos de permiso'), dialogo: 'Pedidos de permiso', salida: 'Cerrar' },
  { nombre: 'Ayuda', abrir: (p) => porPaleta(p, 'Ayuda y atajos'), dialogo: /Ayuda/, salida: 'Volver a los espacios' },
  { nombre: 'Novedades', abrir: (p) => porPaleta(p, 'Novedades'), dialogo: 'Novedades', salida: 'Cerrar' },
  { nombre: 'Invitar', abrir: (p) => porPaleta(p, 'Invitar a un compañero'), dialogo: 'Invitar a un compañero', salida: 'Cerrar' },
  { nombre: 'Primeros pasos', abrir: (p) => porPaleta(p, 'Primeros pasos'), dialogo: 'Primeros pasos', salida: 'Volver a los espacios' },
  { nombre: 'Exportar equipo', abrir: (p) => porPaleta(p, 'Exportar mi configuración como configuración del equipo'), dialogo: 'Exportar como configuración del equipo', salida: 'Cerrar' },
  {
    nombre: 'Chat',
    abrir: async (page) => {
      const b = page.getByRole('button', { name: /^Chat/ })
      await b.click()
      return b
    },
    dialogo: 'Chat del equipo',
    salida: /Cerrar/
  }
]

async function adentro(dlg: Locator): Promise<boolean> {
  return dlg.evaluate((el) => el.contains(document.activeElement))
}

for (const p of PANTALLAS) {
  for (const via of ['botón', 'Esc'] as const) {
    test(`${p.nombre}: se cierra con ${via} y el foco vuelve`, async ({ sloth: { page } }) => {
      const opener = await p.abrir(page)
      const dlg = page.getByRole('dialog', { name: p.dialogo }).first()
      await expect(dlg).toBeVisible()
      expect(await adentro(dlg), 'el foco entra al diálogo').toBe(true)

      if (via === 'Esc') await page.keyboard.press('Escape')
      else await dlg.getByRole('button', { name: p.salida }).first().click()

      await expect(dlg).toBeHidden()
      if (opener) await expect(opener).toBeFocused()
      else await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false), { message: 'el foco vuelve a la terminal' }).toBe(true)
    })
  }
}
