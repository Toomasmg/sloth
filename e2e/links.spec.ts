import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './sloth'
import { shellReady, termText } from './terminal'

/**
 * Los links de la terminal se abren en el navegador del sistema: los OSC 8 que arma Claude Code y las URLs
 * sueltas. Antes el handler por defecto de xterm abría una ventana en blanco, el main la rechazaba y no pasaba nada.
 */

type Host = HTMLElement & {
  __xterm?: {
    cols: number
    rows: number
    buffer: { active: { viewportY: number; length: number; getLine(i: number): { translateToString(trim: boolean): string } | undefined } }
  }
}

/** Reemplaza shell.openExternal por un registro, así la prueba no abre el navegador. */
async function espiarNavegador(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as { __abiertos?: string[] }
    g.__abiertos = []
    shell.openExternal = async (u: string) => {
      g.__abiertos?.push(u)
    }
  })
}

const abiertos = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => (globalThis as { __abiertos?: string[] }).__abiertos ?? [])

/** Clic en el centro del texto dado, en la última línea de la terminal que lo muestra. */
async function clicEnTexto(page: Page, texto: string): Promise<void> {
  const pos = await page.locator('.terminal-host').first().evaluate((el, t) => {
    const x = (el as Host).__xterm
    const screen = el.querySelector('.xterm-screen')
    if (!x || !screen) return null
    const b = x.buffer.active
    for (let i = b.length - 1; i >= 0; i--) {
      const col = b.getLine(i)?.translateToString(true).indexOf(t) ?? -1
      if (col < 0) continue
      const r = screen.getBoundingClientRect()
      const w = r.width / x.cols
      const h = r.height / x.rows
      return { x: r.left + (col + t.length / 2) * w, y: r.top + (i - b.viewportY + 0.5) * h }
    }
    return null
  }, texto)
  if (!pos) throw new Error(`No está en la terminal: ${texto}`)
  await page.mouse.move(pos.x, pos.y)
  // xterm busca el link al pasar el mouse; el clic recién lo activa después.
  await page.waitForTimeout(300)
  await page.mouse.click(pos.x, pos.y)
}

test.describe('links de la terminal', () => {
  test.use({ seed: { workspaces: [{ id: 'ws-links', name: 'web', open: true }] } })

  test('un link OSC 8 y una URL suelta se abren en el navegador', async ({ sloth: { app, page } }) => {
    await shellReady(page)
    await espiarNavegador(app)

    const e = '$([char]27)'
    await page.keyboard.type(`Write-Host "${e}]8;;https://example.com/osc8${e}\\abrir-el-repo${e}]8;;${e}\\"`)
    await page.keyboard.press('Enter')
    await page.keyboard.type(`Write-Output ('https://example.com/' + 'suelta')`)
    await page.keyboard.press('Enter')
    await expect.poll(() => termText(page)).toMatch(/^abrir-el-repo/m)
    await expect.poll(() => termText(page)).toMatch(/^https:\/\/example\.com\/suelta/m)

    await clicEnTexto(page, 'abrir-el-repo')
    await expect.poll(() => abiertos(app)).toEqual(['https://example.com/osc8'])

    await clicEnTexto(page, 'https://example.com/suelta')
    await expect.poll(() => abiertos(app)).toEqual(['https://example.com/osc8', 'https://example.com/suelta'])
  })
})
