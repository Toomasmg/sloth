import { test, expect } from './sloth'

test.describe('dictado', () => {
  test.use({ seed: { workspaces: [{ id: 'ws-dictado', name: 'api-pagos', open: true }] } })

  test('cada terminal tiene su micrófono', async ({ sloth: { page } }) => {
    await expect(page.locator('.xterm')).toHaveCount(1)
    const mic = page.getByRole('button', { name: 'Dictar con el micrófono' })
    await expect(mic).toBeVisible()
    await expect(mic).toHaveAttribute('aria-pressed', 'false')
  })

  test('la terminal no se corre de costado (el dictado de Windows la desplazaba)', async ({ sloth: { page } }) => {
    await expect(page.locator('.xterm')).toHaveCount(1)
    const corridos = await page.evaluate(async () => {
      const els = [document.querySelector('.pane'), document.querySelector('.terminal-host'), ...document.querySelectorAll('.terminal-host *')]
      for (const el of els) if (el instanceof HTMLElement) el.scrollLeft = 200
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      return els.filter((el) => el instanceof HTMLElement && el.scrollLeft !== 0).length
    })
    expect(corridos).toBe(0)
  })
})
