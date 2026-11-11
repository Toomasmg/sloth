import { test, expect } from './sloth'

test.describe('espacio dormido', () => {
  test.use({ seed: { workspaces: [{ id: 'ws-dormido', name: 'api-pagos', open: true }], asleep: ['ws-dormido'] } })

  test('muestra la tarjeta en lugar de la terminal', async ({ sloth: { page } }) => {
    await expect(page.getByText('Dormido para ahorrar memoria')).toBeVisible()
    await expect(page.getByText('La conversación no se perdió')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Despertar api-pagos' })).toBeEnabled()
    // Nada de terminal mientras duerme: no se abrió ningún proceso.
    await expect(page.locator('.xterm')).toHaveCount(0)
    // Un dormido no cuenta como terminal activa.
    await expect(page.getByText('Terminales activas: 0')).toBeVisible()
    await expect(page).toHaveScreenshot('espacio-dormido.png')
  })

  test('Despertar saca la tarjeta y abre la terminal', async ({ sloth: { page } }) => {
    await page.getByRole('button', { name: 'Despertar api-pagos' }).click()
    await expect(page.getByText('Dormido para ahorrar memoria')).toBeHidden()
    await expect(page.locator('.xterm')).toHaveCount(1)
  })
})
