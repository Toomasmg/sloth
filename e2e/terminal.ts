import { expect, type Page } from '@playwright/test'

/**
 * TerminalView deja la instancia de xterm en
 * el host cuando corre bajo Playwright (`navigator.webdriver`): de ahí se lee el buffer y el cursor.
 */
type Host = HTMLElement & {
  __xterm?: {
    buffer: { active: { length: number; getLine(i: number): { translateToString(trim: boolean): string } | undefined } }
    _core: { coreService: { isCursorHidden: boolean } }
  }
}

/** Texto visible y del historial de la primera terminal. */
export const termText = (page: Page): Promise<string> =>
  page.locator('.terminal-host').first().evaluate((el) => {
    const t = (el as Host).__xterm
    if (!t) return ''
    const b = t.buffer.active
    const out: string[] = []
    for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '')
    return out.join('\n')
  })

/** Si xterm tiene el cursor oculto (?25l). Es interno de xterm: solo para pruebas. */
export const cursorHidden = (page: Page): Promise<boolean> =>
  page.locator('.terminal-host').first().evaluate((el) => (el as Host).__xterm?._core.coreService.isCursorHidden ?? false)

/**
 * Espera a que la PowerShell del panel ejecute comandos. No se busca el prompt («PS »): con un perfil
 * que lo cambia (oh-my-posh, starship) no aparece nunca. Se manda un comando cuya salida no es el texto
 * tecleado y se espera esa salida; si PSReadLine todavía no cargó y se comió las teclas, se reintenta.
 */
export async function shellReady(page: Page): Promise<void> {
  await expect.poll(() => termText(page), { timeout: 30_000 }).not.toMatch(/^\s*$/)
  const deadline = Date.now() + 45_000
  for (let i = 0; Date.now() < deadline; i++) {
    await page.locator('.terminal-host').first().click()
    // Esc limpia lo que haya quedado a medio escribir en la línea.
    await page.keyboard.press('Escape')
    await page.keyboard.type(`Write-Output ('shell-' + 'lista-${i}')`)
    await page.keyboard.press('Enter')
    try {
      await expect.poll(() => termText(page), { timeout: 8_000 }).toMatch(/shell-lista-\d/)
      return
    } catch {
      // Sin salida todavía: la shell sigue cargando el perfil.
    }
  }
  throw new Error('La PowerShell de la terminal no respondió en 45 s')
}

type Recorder = { sent: { at: number; data: string }[]; keyAt: number }
type XtermLive = HTMLElement & {
  __xterm?: { onData(cb: (d: string) => void): unknown; selectAll(): void; hasSelection(): boolean }
}

/**
 * Desde ahora anota lo que la terminal le manda a la shell (con su hora) y la hora de la próxima tecla.
 * Así se mide lo que tarda Sloth, sin contar lo que tarda la shell en mostrarlo.
 */
export const recordInput = (page: Page): Promise<void> =>
  page.locator('.terminal-host').first().evaluate((el) => {
    const rec: Recorder = { sent: [], keyAt: 0 }
    ;(window as unknown as { __rec: Recorder }).__rec = rec
    window.addEventListener('keydown', () => (rec.keyAt = performance.now()), { capture: true, once: true })
    ;(el as XtermLive).__xterm?.onData((data) => rec.sent.push({ at: performance.now(), data }))
  })

export const recorded = (page: Page): Promise<Recorder> => page.evaluate(() => (window as unknown as { __rec: Recorder }).__rec)

export const selectAll = (page: Page): Promise<void> =>
  page.locator('.terminal-host').first().evaluate((el) => (el as XtermLive).__xterm?.selectAll())

export const hasSelection = (page: Page): Promise<boolean> =>
  page.locator('.terminal-host').first().evaluate((el) => (el as XtermLive).__xterm?.hasSelection() ?? false)
