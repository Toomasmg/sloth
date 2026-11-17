import { test, expect } from './sloth'

test.use({ seed: { workspaces: [{ id: 'ws-web', name: 'web', open: true }, { id: 'ws-api', name: 'api-pagos', open: true }] } })

test('Tab sale de la paleta', async ({ sloth: { page } }) => {
  const combo = page.getByRole('combobox', { name: 'Buscar espacio, acción o persona' })
  await combo.focus()
  await expect(combo).toBeFocused()
  for (let i = 0; i < 6; i++) await page.keyboard.press('Tab')
  await expect(combo).not.toBeFocused()
})

test('F6 recorre las zonas', async ({ sloth: { page } }) => {
  const zona = (): Promise<string | null> =>
    page.evaluate(() => {
      const z = document.activeElement?.closest('.sl-top, .sl-rail, .sl-side, .sl-main')
      return z ? z.className : null
    })
  const vistas: (string | null)[] = []
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('F6')
    vistas.push(await zona())
  }
  expect(vistas.every((z) => z !== null)).toBe(true)
  expect(new Set(vistas).size).toBe(4)
  await page.keyboard.press('F6')
  expect(await zona()).toBe(vistas[0])

  await page.locator('.pane.focused').first().click()
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('.sl-main')))).toBe(true)
  await page.keyboard.press('F6')
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('.sl-main')))).toBe(false)
})

test('un solo main y un h1', async ({ sloth: { page } }) => {
  await expect(page.locator('main')).toHaveCount(1)
  expect(await page.getByRole('heading', { level: 1 }).count()).toBeGreaterThan(0)
})
