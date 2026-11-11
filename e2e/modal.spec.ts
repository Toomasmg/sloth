import { test, expect } from './sloth'

test.use({ seed: { workspaces: [{ id: 'ws-web', name: 'web', open: true }, { id: 'ws-api', name: 'api-pagos', open: true }] } })

async function abrir(page: import('@playwright/test').Page): Promise<import('@playwright/test').Locator> {
  const opener = page.getByRole('button', { name: 'Enviar a varios espacios', exact: true }).first()
  await opener.click()
  await expect(page.getByRole('dialog', { name: 'Enviar a varios espacios' })).toBeVisible()
  return opener
}

test('el diálogo de Enviar toma el foco, lo atrapa y lo devuelve al cerrar', async ({ sloth: { page } }) => {
  const opener = await abrir(page)
  const dlg = page.getByRole('dialog', { name: 'Enviar a varios espacios' })
  expect(await dlg.evaluate((el) => el.contains(document.activeElement))).toBe(true)

  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab')
    expect(await dlg.evaluate((el) => el.contains(document.activeElement)), `Tab ${i}`).toBe(true)
  }
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Shift+Tab')
    expect(await dlg.evaluate((el) => el.contains(document.activeElement)), `Shift+Tab ${i}`).toBe(true)
  }

  await page.keyboard.press('Escape')
  await expect(dlg).toBeHidden()
  await expect(opener).toBeFocused()
})

test('la X cierra el diálogo y devuelve el foco', async ({ sloth: { page } }) => {
  const opener = await abrir(page)
  await page.getByRole('dialog').getByRole('button', { name: 'Cerrar' }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(opener).toBeFocused()
})

test('con texto escrito, Esc pregunta antes de descartar', async ({ sloth: { page } }) => {
  await abrir(page)
  await page.getByRole('dialog').getByRole('textbox').first().fill('Corré los tests')
  await page.keyboard.press('Escape')
  const alerta = page.getByRole('alertdialog', { name: '¿Descartar lo que escribiste?' })
  await expect(alerta).toBeVisible()
  await expect(page.getByRole('button', { name: 'Seguir editando' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(alerta).toBeHidden()
  await expect(page.getByRole('dialog', { name: 'Enviar a varios espacios' })).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Cerrar' }).click()
  await page.getByRole('button', { name: 'Descartar', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
})
