import { join } from 'node:path'
import { test, expect } from './sloth'
import { shellReady, termText } from './terminal'

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

test.describe('dictado con Whisper', () => {
  // Micrófono falso: Chromium lee este .wav (voz en español) como si fuera el micrófono.
  test.use({
    seed: {
      workspaces: [{ id: 'ws-dictado', name: 'api-pagos', open: true }],
      chromiumArgs: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${join(__dirname, 'fixtures', 'dictado-es.wav')}%noloop`
      ]
    }
  })

  test('lo dictado aparece en la terminal sin mandarse', async ({ sloth: { page } }) => {
    test.skip(process.platform !== 'win32', 'whisper-cli se empaqueta solo para Windows')
    await shellReady(page)
    const mic = page.getByRole('button', { name: 'Dictar con el micrófono' })
    await mic.click()
    await expect(page.getByText('Escuchando…')).toBeVisible()
    // El audio dura ~8 s.
    await page.waitForTimeout(9000)
    await page.getByRole('button', { name: 'Terminar de dictar' }).click()
    await expect(page.getByText('Transcribiendo…')).toBeVisible()
    await expect.poll(() => termText(page), { timeout: 60_000 }).toMatch(/pull.?request/i)
    await expect(page.getByText('Transcribiendo…')).toBeHidden()
    // Sin Enter: el texto quedó en la línea, PowerShell no lo ejecutó (no hay error de comando).
    expect(await termText(page)).not.toMatch(/no se reconoce|is not recognized|CommandNotFound/i)
  })
})
