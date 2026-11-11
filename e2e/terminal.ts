import type { Page } from '@playwright/test'

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
