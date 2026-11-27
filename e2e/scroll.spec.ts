import type { Page } from '@playwright/test'
import { test, expect } from './sloth'

/**
 * Scroll del historial: un poco de touchpad sube unas líneas, no cientos, y la inercia de un
 * deslizamiento rápido no se acumula.
 */
type Host = HTMLElement & { __xterm?: { write(s: string, cb?: () => void): void; buffer: { active: { viewportY: number; baseY: number } } } }

const llenar = (page: Page): Promise<void> =>
  page.locator('.terminal-host').first().evaluate((el) => new Promise<void>((ok) => {
    const t = (el as Host).__xterm
    if (!t) throw new Error('sin xterm')
    t.write(Array.from({ length: 800 }, (_, i) => `linea ${i}`).join('\r\n') + '\r\n', ok)
  }))

const posicion = (page: Page): Promise<{ y: number; base: number }> =>
  page.locator('.terminal-host').first().evaluate((el) => {
    const b = (el as Host).__xterm!.buffer.active
    return { y: b.viewportY, base: b.baseY }
  })

test.use({ seed: { workspaces: [{ id: 'ws-a', name: 'api', open: true }] } })

test('un poco de touchpad sube unas líneas y la inercia no vuela', async ({ sloth: { page } }) => {
  await expect(page.locator('.xterm')).toHaveCount(1)
  await llenar(page)
  const caja = await page.locator('.xterm-screen').first().boundingBox()
  if (!caja) throw new Error('sin terminal')
  await page.mouse.move(caja.x + caja.width / 2, caja.y + caja.height / 2)

  const { base } = await posicion(page)
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -5)
  await expect.poll(async () => base - (await posicion(page)).y).toBeGreaterThan(0)
  expect(base - (await posicion(page)).y).toBeLessThanOrEqual(4)

  // Deslizamiento rápido con su inercia: sin tope por evento serían más de 300 líneas.
  const antes = (await posicion(page)).y
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -400 * 0.9 ** i)
  await page.waitForTimeout(200)
  expect(antes - (await posicion(page)).y).toBeLessThanOrEqual(40 * 3)
})
