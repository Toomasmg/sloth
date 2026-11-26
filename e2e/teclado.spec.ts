import { test, expect } from './sloth'
import { recordInput, recorded } from './terminal'

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

test('Ctrl+N y Ctrl+Shift+Enter con la terminal enfocada: el primero es de la shell, el segundo lo atiende la app', async ({ sloth: { page } }) => {
  await recordInput(page)
  await page.locator('.terminal-host .xterm-helper-textarea').first().focus()
  await page.keyboard.press('Control+n')
  await expect(page.getByRole('dialog', { name: /Nuevo espacio/ })).toHaveCount(0)
  await page.keyboard.press('Control+Shift+Enter')
  await expect(page.getByRole('dialog', { name: /Enviar a varios/ })).toBeVisible()
  const { sent } = await recorded(page)
  // Los avisos de foco de xterm (CSI I y CSI O) no son teclas.
  expect(sent.map((x) => x.data).filter((d) => d !== '[I' && d !== '[O')).toEqual([''])
})

test('al encadenar vistas desde la terminal, el foco queda en la vista nueva y no en la terminal oculta', async ({ sloth: { page } }) => {
  await page.locator('.pane.focused .xterm-helper-textarea').first().focus()
  await page.keyboard.press('Control+Shift+2')
  await expect(page.locator('.ui-view')).toBeVisible()
  await page.keyboard.press('Control+Shift+3')
  await page.waitForTimeout(600)
  await expect(page.locator('.ui-view:not(.is-closing)')).toHaveCount(1)
  expect(await page.evaluate(() => !!document.activeElement?.closest('.ui-view'))).toBe(true)
})
