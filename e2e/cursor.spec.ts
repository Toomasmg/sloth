import type { Page } from '@playwright/test'
import { test, expect } from './sloth'
import { cursorHidden, shellReady } from './terminal'

/**
 * Claude Code dibuja su propio cursor. El de xterm (que ConPTY muestra a mitad de cada redibujo
 * y salta por la pantalla) queda oculto mientras Claude está abierto: Claude avisa al arrancar
 * con ?2031h y al salir con ?2031l. En la shell sola el cursor se ve como siempre.
 */

/** Escribe en la PowerShell del panel una secuencia de escape, como la mandaría Claude. */
async function emit(page: Page, seq: string): Promise<void> {
  await page.locator('.terminal-host').click()
  await page.keyboard.type(`Write-Host -NoNewline "$([char]27)${seq}"`)
  await page.keyboard.press('Enter')
}

test.describe('cursor de la terminal', () => {
  test.use({ seed: { workspaces: [{ id: 'ws-cursor', name: 'web', open: true }] } })

  test('se oculta mientras Claude está abierto y vuelve en la shell', async ({ sloth: { page } }) => {
    await shellReady(page)
    expect(await cursorHidden(page)).toBe(false)

    await emit(page, '[?2031h')
    await expect.poll(() => cursorHidden(page)).toBe(true)
    // ConPTY vuelve a pedir el cursor en cada cuadro: con Claude abierto se ignora.
    await emit(page, '[?25h')
    await page.waitForTimeout(500)
    expect(await cursorHidden(page)).toBe(true)

    await emit(page, '[?2031l')
    await expect.poll(() => cursorHidden(page)).toBe(false)
  })

  test('en la pantalla alternativa (vim, nvim) el cursor queda como lo pide el programa', async ({ sloth: { page } }) => {
    await shellReady(page)
    await emit(page, '[?1049h')
    // nvim activa 2031 dentro de la pantalla alternativa: no es Claude.
    await emit(page, '[?2031h')
    await emit(page, '[?25h')
    await page.waitForTimeout(500)
    expect(await cursorHidden(page)).toBe(false)
    await emit(page, '[?1049l')
  })
})
