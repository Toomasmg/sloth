import { test, expect } from './sloth'
import { shellReady } from './terminal'

const ESC = String.fromCharCode(27)

test.describe('barra de desplazamiento', () => {
  test.use({ seed: { workspaces: [{ id: 'ws-barra', name: 'api-pagos', open: true }] } })

  test('se esconde cuando un programa desplaza por su cuenta y vuelve en la shell', async ({ sloth: { page } }) => {
    await shellReady(page)
    const host = page.locator('.terminal-host').first()
    const enviar = async (seq: string): Promise<void> => {
      await host.click()
      await page.keyboard.type(`Write-Host -NoNewline "$([char]27)[${seq}"`)
      await page.keyboard.press('Enter')
    }
    await expect(host).not.toHaveClass(/sin-barra/)
    // Pantalla alternativa (vim, nano).
    await enviar('?1049h')
    await expect(host).toHaveClass(/sin-barra/)
    await enviar('?1049l')
    await expect(host).not.toHaveClass(/sin-barra/)
    // Reporte del mouse: el programa maneja la ruedita (Claude Code con su propio scroll). ConPTY no
    // deja pasar ?1000h desde un Write-Host (solo a programas con entrada VT): se escribe directo en xterm.
    const xterm = (seq: string): Promise<void> =>
      host.evaluate(
        (el, data) => {
          const t = (el as HTMLElement & { __xterm?: { write(d: string): void } }).__xterm
          t?.write(data)
        },
        `${ESC}[${seq}`
      )
    await xterm('?1000h')
    await expect(host).toHaveClass(/sin-barra/)
    await xterm('?1000l')
    await expect(host).not.toHaveClass(/sin-barra/)
  })
})
