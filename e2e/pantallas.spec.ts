import { test, expect } from './sloth'

/**
 * Capturas de las pantallas principales con datos de prueba (una cuenta sin sesión y dos espacios).
 * Cada una espera una señal de «terminó de cargar» antes de capturar, así la captura no depende del tiempo.
 */

test.use({ seed: { workspaces: [{ id: 'ws-web', name: 'web' }, { id: 'ws-api', name: 'api-pagos' }] } })

const PANTALLAS: { herramienta: string; lista: string; captura: string }[] = [
  { herramienta: 'Tickets', lista: 'Conectá tus tickets', captura: 'tickets.png' },
  { herramienta: 'Historial de sesiones', lista: 'Todavía no hay sesiones guardadas', captura: 'historial.png' },
  { herramienta: 'Plantillas', lista: 'Todavía no hay plantillas.', captura: 'plantillas.png' },
  { herramienta: 'Ramas aparte', lista: 'Ningún espacio apunta a un repo git.', captura: 'ramas.png' },
  { herramienta: 'Enviar a varios espacios', lista: 'No hay espacios con la terminal abierta.', captura: 'enviar.png' }
]

for (const p of PANTALLAS) {
  test(`${p.herramienta}`, async ({ sloth: { page } }) => {
    await page.getByRole('button', { name: p.herramienta, exact: true }).first().click()
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
