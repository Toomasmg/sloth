import { test, expect } from './sloth'

test('el menú de Sloth se despliega hacia abajo desde el logo', async ({ sloth: { page } }) => {
  const trigger = page.getByRole('button', { name: 'Menú de Sloth' })
  await trigger.click()
  const menu = page.getByRole('menu', { name: 'Menú de Sloth' })
  await expect(menu).toBeVisible()
  // Que termine la animación antes de medir.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'))

  const t = (await trigger.boundingBox())!
  const m = (await menu.boundingBox())!
  expect(m.y, 'el menú arranca debajo del botón').toBeGreaterThanOrEqual(t.y + t.height)
  expect(Math.abs(m.x - t.x), 'alineado con el borde izquierdo del botón').toBeLessThan(2)

  // La animación de entrada es vertical: nunca se corre de costado.
  const anim = await menu.evaluate((el) => getComputedStyle(el).animationName)
  expect(anim).toBe('menu-in')

  await expect(page).toHaveScreenshot('menu-abierto.png')
})

test('Escape cierra el menú y devuelve el foco al botón', async ({ sloth: { page } }) => {
  const trigger = page.getByRole('button', { name: 'Menú de Sloth' })
  await trigger.click()
  await expect(page.getByRole('menu', { name: 'Menú de Sloth' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu', { name: 'Menú de Sloth' })).toBeHidden()
  await expect(trigger).toBeFocused()
})
