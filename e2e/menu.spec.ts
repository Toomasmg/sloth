import { test, expect } from './sloth'

/**
 * Riel de navegación y menú único del espacio. El menú del logo ya no existe: lo global vive en el
 * riel (Ayuda, Configuración) y en la paleta; lo de cada espacio, en un solo menú que se abre igual
 * desde el «…» del panel, el clic derecho de la barra lateral y el de la pestaña.
 */

test.use({ seed: { workspaces: [{ id: 'ws-web', name: 'web', open: true }, { id: 'ws-api', name: 'api-pagos' }] } })

test('el menú del panel se despliega debajo del «…» y Esc devuelve el foco', async ({ sloth: { page } }) => {
  const trigger = page.getByRole('button', { name: 'Más acciones de web' })
  await trigger.click()
  const menu = page.getByRole('menu', { name: 'Acciones de web' })
  await expect(menu).toBeVisible()
  const t = (await trigger.boundingBox())!
  const m = (await menu.boundingBox())!
  expect(m.y, 'el menú arranca debajo del botón').toBeGreaterThanOrEqual(t.y + t.height)
  expect(Math.abs(m.x + m.width - (t.x + t.width)), 'alineado con el borde derecho del botón').toBeLessThan(2)
  await expect(menu.getByRole('menuitem').first(), 'el foco entra al primer ítem').toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(trigger).toBeFocused()
})

test('el «…», el clic derecho de la barra lateral y el de la pestaña muestran el mismo menú', async ({ sloth: { page } }) => {
  const items = async (): Promise<string[]> => {
    const menu = page.getByRole('menu', { name: 'Acciones de web' })
    await expect(menu).toBeVisible()
    const labels = await menu.getByRole('menuitem').evaluateAll((els) => els.map((e) => e.querySelector('.ui-menu-label')?.textContent ?? ''))
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    return labels
  }
  await page.getByRole('button', { name: 'Más acciones de web' }).click()
  const delPanel = await items()
  await page.locator('[data-ws-btn="ws-web"]').click({ button: 'right' })
  const deLaBarra = await items()
  await page.getByRole('tab', { name: /^web,/ }).click({ button: 'right' })
  const deLaPestana = await items()
  expect(deLaBarra).toEqual(delPanel)
  expect(deLaPestana).toEqual(delPanel)
  for (const esperado of ['Renombrar', 'Ver cambios (Git)', 'Historial de este espacio', 'Guardar como plantilla', 'Ocultar panel', 'Cerrar panel', 'Quitar espacio']) {
    expect(delPanel).toContain(esperado)
  }
})

test('un espacio sin abrir no ofrece ocultar ni cerrar su panel', async ({ sloth: { page } }) => {
  await page.locator('[data-ws-btn="ws-api"]').click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Acciones de api-pagos' })
  await expect(menu.getByRole('menuitem', { name: /^Renombrar/ })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /^Ocultar panel/ })).toHaveCount(0)
  await expect(menu.getByRole('menuitem', { name: /^Cerrar panel/ })).toHaveCount(0)
})

test('Ctrl+Shift+1…5 navega por el riel aunque el foco esté en la terminal', async ({ sloth: { page } }) => {
  await page.locator('.terminal-host').first().click()
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false)).toBe(true)
  await page.keyboard.press('Control+Shift+2')
  await expect(page.getByRole('dialog', { name: /Tickets/ })).toBeVisible()
  await expect(page.locator('.sl-rail [data-nav="tickets"]')).toHaveAttribute('aria-current', 'page')
  await page.keyboard.press('Control+Shift+4')
  await expect(page.getByRole('dialog', { name: /Historial/ })).toBeVisible()
  await expect(page.getByRole('dialog', { name: /Tickets/ }), 'una Vista a la vez').toHaveCount(0)
  await page.keyboard.press('Control+Shift+1')
  await expect(page.locator('.ui-view')).toHaveCount(0)
  await expect(page.locator('.sl-rail [data-nav="espacios"]')).toHaveAttribute('aria-current', 'page')
})

test('Ctrl+1 sigue siendo «ir al panel 1» y no abre ningún destino', async ({ sloth: { page } }) => {
  await page.keyboard.press('Control+1')
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false)).toBe(true)
  await expect(page.locator('.ui-view')).toHaveCount(0)
})

test('el riel marca el destino y el menú del logo ya no existe', async ({ sloth: { page } }) => {
  await expect(page.getByRole('button', { name: 'Menú de Sloth' })).toHaveCount(0)
  const rail = page.getByRole('navigation', { name: 'Navegación' })
  await expect(rail.getByRole('button')).toHaveCount(7)
  await rail.getByRole('button', { name: 'Configuración' }).click()
  await expect(rail.getByRole('button', { name: 'Configuración' })).toHaveAttribute('aria-current', 'page')
  await expect(page).toHaveScreenshot('riel-configuracion.png')
})
