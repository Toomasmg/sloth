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

test('con la terminal enfocada, Ctrl+Shift+M abre el chat y la tecla no llega a la shell', async ({ sloth: { page } }) => {
  await page.locator('.pane.focused .xterm-helper-textarea').first().focus()
  await page.keyboard.press('Control+Shift+M')
  await expect(page.getByRole('button', { name: /^Chat del equipo/ })).toHaveAttribute('aria-expanded', 'true')
  expect(await page.evaluate(() => document.activeElement?.closest('.terminal-host') === null)).toBe(true)
})

test('cambiar de vista con Ctrl+Shift+N no deja el foco en la terminal oculta', async ({ sloth: { page } }) => {
  await page.locator('.pane.focused .xterm-helper-textarea').first().focus()
  await page.keyboard.press('Control+Shift+2')
  await page.keyboard.press('Control+Shift+3')
  const enVista = (): Promise<boolean> => page.evaluate(() => !!document.activeElement?.closest('.ui-view:not(.is-closing)'))
  await expect.poll(enVista).toBe(true)
  await page.waitForTimeout(400)
  expect(await enVista()).toBe(true)
})
