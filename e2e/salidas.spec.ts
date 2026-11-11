import { test, expect } from './sloth'
import type { Locator, Page } from '@playwright/test'

/**
 * Toda pantalla que se abre encima del trabajo tiene que poder cerrarse sin teclado (botón visible)
 * y con Esc, y el foco tiene que volver a lo que la abrió.
 */

test.use({
  seed: {
    workspaces: [
      { id: 'ws-web', name: 'web', open: true },
      { id: 'ws-api', name: 'api-pagos', open: true }
    ],
    extraAccounts: ['Segunda']
  }
})

interface Pantalla {
  nombre: string
  /** Abre la pantalla y devuelve lo que la abrió (donde tiene que volver el foco). */
  abrir(page: Page): Promise<Locator>
  /** El contenedor que se tiene que ver mientras está abierta. */
  contenedor(page: Page): Locator
  /** El botón visible que la cierra. */
  salida(page: Page): Locator
}

async function desdeMenuApp(page: Page, item: string): Promise<Locator> {
  const trigger = page.getByRole('button', { name: 'Menú de Sloth' })
  await trigger.click()
  await page.getByRole('menuitem', { name: item }).click()
  return trigger
}

async function desdeMenuPanel(page: Page, item: string): Promise<Locator> {
  const trigger = page.getByRole('button', { name: 'Más acciones de web' })
  await trigger.click()
  await page.getByRole('menuitem', { name: item }).click()
  return trigger
}

async function desdeBoton(page: Page, nombre: string): Promise<Locator> {
  const b = page.getByRole('button', { name: nombre, exact: true }).first()
  await b.click()
  return b
}

const dialogo = (nombre: string | RegExp) => (page: Page): Locator => page.getByRole('dialog', { name: nombre })
const botonCerrar = (page: Page): Locator => page.getByRole('dialog').getByRole('button', { name: /^Cerrar/ }).first()
const volver = (page: Page): Locator => page.getByRole('dialog').getByRole('button', { name: '‹ Espacios' })
const pagina = (page: Page): Locator => page.locator('.page-shell')

const PANTALLAS: Pantalla[] = [
  {
    nombre: 'Nuevo espacio',
    abrir: async (page) => {
      const b = page.locator('.sl-newbtn')
      await b.click()
      return b
    },
    contenedor: dialogo('Nuevo espacio'),
    salida: botonCerrar
  },
  {
    nombre: 'Enviar a varios espacios',
    abrir: (page) => desdeBoton(page, 'Enviar a varios espacios'),
    contenedor: dialogo('Enviar a varios espacios'),
    salida: botonCerrar
  },
  {
    nombre: 'Quitar espacio',
    abrir: async (page) => {
      const b = page.getByRole('button', { name: 'Quitar espacio web' })
      await b.click()
      return b
    },
    contenedor: dialogo(/¿Quitar el espacio/),
    salida: (page) => page.getByRole('dialog').getByRole('button', { name: 'Cancelar' })
  },
  {
    nombre: 'Mover a otra cuenta',
    abrir: (page) => desdeMenuPanel(page, 'Mover a otra cuenta'),
    contenedor: dialogo('Mover espacio a otra cuenta'),
    salida: botonCerrar
  },
  {
    nombre: 'Git del espacio',
    abrir: (page) => desdeMenuPanel(page, 'Ver cambios (Git)'),
    contenedor: dialogo(/^Git de web/),
    salida: botonCerrar
  },
  {
    nombre: 'Acerca de Sloth (actualizaciones)',
    abrir: (page) => desdeMenuApp(page, 'Buscar actualizaciones'),
    contenedor: dialogo('Acerca de Sloth'),
    salida: botonCerrar
  },
  {
    nombre: 'Reportar un problema',
    abrir: (page) => desdeMenuApp(page, 'Reportar un problema'),
    contenedor: dialogo('Reportar un problema'),
    salida: volver
  },
  {
    nombre: 'Exportar configuración',
    abrir: (page) => desdeMenuApp(page, 'Exportar configuración…'),
    contenedor: pagina,
    salida: volver
  },
  {
    nombre: 'Historial de sesiones',
    abrir: (page) => desdeBoton(page, 'Historial de sesiones'),
    contenedor: pagina,
    salida: volver
  },
  {
    nombre: 'Ramas aparte',
    abrir: (page) => desdeBoton(page, 'Ramas aparte'),
    contenedor: pagina,
    salida: (page) => pagina(page).getByRole('button', { name: /Espacios/ }).first()
  }
]

for (const p of PANTALLAS) {
  test(`${p.nombre}: se cierra con el botón y vuelve el foco`, async ({ sloth: { page } }) => {
    const opener = await p.abrir(page)
    await expect(p.contenedor(page)).toBeVisible()
    await p.salida(page).click()
    await expect(p.contenedor(page)).toBeHidden()
    await expect(opener).toBeFocused()
  })

  test(`${p.nombre}: se cierra con Esc y vuelve el foco`, async ({ sloth: { page } }) => {
    const opener = await p.abrir(page)
    await expect(p.contenedor(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(p.contenedor(page)).toBeHidden()
    await expect(opener).toBeFocused()
  })
}

test('Quitar espacio: Cancelar no lo quita y confirmar sí', async ({ sloth: { page } }) => {
  await page.getByRole('button', { name: 'Quitar espacio web' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancelar' }).click()
  await expect(page.getByRole('button', { name: 'Quitar espacio web' })).toBeVisible()
  await page.getByRole('button', { name: 'Quitar espacio web' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Quitar espacio', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Quitar espacio web' })).toHaveCount(0)
})

test('Reportar: con texto escrito, Esc y «‹ Espacios» preguntan antes de descartar', async ({ sloth: { page } }) => {
  const opener = await desdeMenuApp(page, 'Reportar un problema')
  await page.getByLabel(/^Título/).fill('Se cuelga al abrir')
  await page.keyboard.press('Escape')
  const alerta = page.getByRole('alertdialog', { name: '¿Descartar lo que escribiste?' })
  await expect(alerta).toBeVisible()
  await expect(page.getByRole('button', { name: 'Seguir editando' })).toBeFocused()
  await page.getByRole('button', { name: 'Seguir editando' }).click()
  await expect(alerta).toBeHidden()
  await page.getByRole('button', { name: '‹ Espacios' }).click()
  await expect(alerta).toBeVisible()
  await page.getByRole('button', { name: 'Descartar', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Reportar un problema' })).toBeHidden()
  await expect(opener).toBeFocused()
})

test('Nuevo espacio: con la ruta escrita, Esc pregunta antes de descartar', async ({ sloth: { page } }) => {
  await page.locator('.sl-newbtn').click()
  await page.getByPlaceholder('Ruta de la carpeta').fill('C:\\repos\\algo')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('alertdialog', { name: '¿Descartar lo que escribiste?' })).toBeVisible()
})
