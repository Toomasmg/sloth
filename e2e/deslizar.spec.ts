import type { Page } from '@playwright/test'
import { test, expect } from './sloth'

/**
 * Vista de uno: deslizar con dos dedos de costado en el touchpad (eventos wheel con deltaX) pasa al panel
 * vecino y el que entra se desliza desde ese lado. Un gesto vertical sigue siendo el historial.
 */
const activa = (page: Page): Promise<string | null> => page.locator('.pane-tabs [role="tab"][aria-selected="true"]').getAttribute('data-tab-id')

async function deslizar(page: Page, dx: number, dy = 0): Promise<void> {
  for (let i = 0; i < 8; i++) await page.mouse.wheel(dx, dy)
  // Pausa: el próximo gesto empieza de cero.
  await page.waitForTimeout(400)
}

test.describe('deslizar entre paneles', () => {
  test.use({
    seed: {
      workspaces: [
        { id: 'ws-a', name: 'api', open: true },
        { id: 'ws-b', name: 'web', open: true }
      ]
    }
  })

  test('de costado cambia de panel con animación; vertical no', async ({ sloth: { page } }) => {
    await expect(page.locator('.xterm')).toHaveCount(2)
    await page.getByRole('button', { name: /^Uno/ }).first().click()
    await expect(page.locator('.panes-area > .pane:not(.hidden)')).toHaveCount(1)
    const caja = await page.locator('.panes-area').boundingBox()
    if (!caja) throw new Error('sin área de paneles')
    await page.mouse.move(caja.x + caja.width / 2, caja.y + caja.height / 2)

    const inicial = await activa(page)
    await deslizar(page, 0, 40)
    expect(await activa(page)).toBe(inicial)

    await deslizar(page, 20)
    const segunda = await activa(page)
    expect(segunda).not.toBe(inicial)
    await expect(page.locator(`.panes-area > .pane[data-pane-id="${segunda}"]`)).not.toHaveClass(/hidden/)

    // Un gesto largo (con inercia) cambia una sola vez: con dos paneles, uno más vuelve al primero.
    await deslizar(page, -20)
    expect(await activa(page)).toBe(inicial)
  })

  test('el panel que entra se desliza desde el costado', async ({ sloth: { page } }) => {
    await expect(page.locator('.xterm')).toHaveCount(2)
    await page.getByRole('button', { name: /^Uno/ }).first().click()
    const otra = page.locator('.pane-tabs [role="tab"][aria-selected="false"]').first()
    const id = await otra.getAttribute('data-tab-id')
    await otra.click()
    await expect(page.locator(`.panes-area > .pane[data-pane-id="${id}"]`)).toHaveClass(/slide-in-(next|prev)/)
    // Al terminar la animación se saca la clase.
    await expect(page.locator(`.panes-area > .pane[data-pane-id="${id}"]`)).not.toHaveClass(/slide-in/)
  })
})
