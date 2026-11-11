import type { Page } from '@playwright/test'
import { test, expect } from './sloth'

/**
 * Claude Code dibuja su propio cursor. El de xterm (que ConPTY muestra a mitad de cada redibujo
 * y salta por la pantalla) queda oculto mientras Claude está abierto: Claude avisa al arrancar
 * con ?2031h y al salir con ?2031l. En la shell sola el cursor se ve como siempre.
 */
const cursor = (page: Page) => page.locator('.xterm-rows .xterm-cursor')

/** Escribe en la PowerShell del panel una secuencia de escape, como la mandaría Claude. */
async function emit(page: Page, seq: string): Promise<void> {
  await page.locator('.xterm').click()
  await page.keyboard.type(`Write-Host -NoNewline "$([char]27)${seq}"`)
  await page.keyboard.press('Enter')
}

test.describe('cursor de la terminal', () => {
  test.use({ seed: { workspaces: [{ id: 'ws-cursor', name: 'web', open: true }] } })

  test('se oculta mientras Claude está abierto y vuelve en la shell', async ({ sloth: { page } }) => {
    await expect(page.locator('.xterm-rows')).toContainText('PS ', { timeout: 30_000 })
    await expect(cursor(page)).toHaveCount(1)

    await emit(page, '[?2031h')
    await expect(cursor(page)).toHaveCount(0)
    // ConPTY vuelve a pedir el cursor en cada cuadro: con Claude abierto se ignora.
    await emit(page, '[?25h')
    await page.waitForTimeout(500)
    await expect(cursor(page)).toHaveCount(0)

    await emit(page, '[?2031l')
    await expect(cursor(page)).toHaveCount(1)
  })
})
