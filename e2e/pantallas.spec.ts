import { test, expect } from './sloth'
import type { Page } from '@playwright/test'

/**
 * Capturas de las pantallas principales con datos de prueba (una cuenta sin sesión y dos espacios).
 * Cada una espera una señal de «terminó de cargar» antes de capturar, así la captura no depende del tiempo.
 */

test.use({ seed: { workspaces: [{ id: 'ws-web', name: 'web' }, { id: 'ws-api', name: 'api-pagos' }] } })

type Abrir = (page: Page) => Promise<void>
const riel = (nombre: string): Abrir => (page) => page.getByRole('navigation', { name: 'Navegación' }).getByRole('button', { name: nombre, exact: true }).click()
const paleta = (titulo: string): Abrir => async (page) => {
  await page.keyboard.press('Control+K')
  await page.keyboard.type(titulo)
  await page.keyboard.press('Enter')
}

/** Cada pantalla, abierta desde su lugar canónico: el riel, la paleta o su atajo. */
const PANTALLAS: { nombre: string; abrir: Abrir; lista: string; captura: string }[] = [
  { nombre: 'Tickets', abrir: riel('Tickets'), lista: 'Conectá tus tickets', captura: 'tickets.png' },
  { nombre: 'Historial de sesiones', abrir: riel('Historial'), lista: 'Todavía no hay sesiones guardadas', captura: 'historial.png' },
  { nombre: 'Plantillas', abrir: paleta('Nueva plantilla'), lista: 'Todavía no hay plantillas.', captura: 'plantillas.png' },
  { nombre: 'Ramas aparte', abrir: riel('Ramas aparte'), lista: 'Ningún espacio apunta a un repo git.', captura: 'ramas.png' },
  { nombre: 'Enviar a varios espacios', abrir: (page) => page.keyboard.press('Control+Shift+B'), lista: 'No hay espacios con la terminal abierta.', captura: 'enviar.png' }
]

for (const p of PANTALLAS) {
  test(`${p.nombre}`, async ({ sloth: { page } }) => {
    await p.abrir(page)
    await expect(page.getByText(p.lista, { exact: false })).toBeVisible()
    await expect(page).toHaveScreenshot(p.captura)
  })
}

test('inicio sin espacios abiertos', async ({ sloth: { page } }) => {
  await expect(page.getByText('No hay espacios abiertos')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Nuevo espacio', exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('inicio.png')
})

test.describe('dos espacios abiertos', () => {
  test.use({ seed: { workspaces: [{ id: 'ws-web', name: 'web', open: true }, { id: 'ws-api', name: 'api-pagos', open: true }] } })

  test('se ven lado a lado con su terminal', async ({ sloth: { page } }) => {
    await expect(page.locator('.xterm')).toHaveCount(2)
    await expect(page.getByText('Terminales activas: 2')).toBeVisible()
    // Lo de adentro de la terminal (versión de PowerShell, ruta, usuario) cambia de PC a PC: se tapa.
    await expect(page).toHaveScreenshot('dos-espacios.png', { mask: [page.locator('.terminal-host')] })
  })
})
