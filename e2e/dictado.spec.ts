import { join } from 'node:path'
import { test, expect } from './sloth'
import { shellReady, termText } from './terminal'

test.describe('dictado', () => {
  test.use({ seed: { workspaces: [{ id: 'ws-dictado', name: 'api-pagos', open: true }] } })

  test('el micrófono está en la cabecera del panel y no tapa la terminal', async ({ sloth: { page } }) => {
    await expect(page.locator('.xterm')).toHaveCount(1)
    const mic = page.locator('.pane-head').getByRole('button', { name: 'Dictar', exact: true })
    await expect(mic).toBeVisible()
    const caja = await mic.boundingBox()
    expect(caja && caja.width >= 32 && caja.height >= 32).toBe(true)
    // Ningún elemento del dictado flota sobre la terminal.
    const encima = await page.evaluate(() => {
      const term = document.querySelector('.terminal-host')?.getBoundingClientRect()
      const btn = document.querySelector('.pane-head [aria-label="Dictar"]')?.getBoundingClientRect()
      if (!term || !btn) return null
      return btn.bottom > term.top && btn.top < term.bottom
    })
    expect(encima).toBe(false)
    await expect(page.locator('.terminal-host button, .terminal-host .dictado')).toHaveCount(0)
  })

  test('el micrófono está en el menú del espacio y en la paleta', async ({ sloth: { page } }) => {
    await expect(page.locator('.xterm')).toHaveCount(1)
    await page.keyboard.press('Control+k')
    await page.getByRole('combobox').fill('dictar')
    await expect(page.getByRole('option', { name: /Dictar con la voz/ }).first()).toBeVisible()
  })

  test('la primera vez avisa que hay dictado, en un solo panel, hasta cerrarlo', async ({ sloth: { page } }) => {
    await expect(page.locator('.xterm')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Nuevo', exact: true })).toHaveCount(1)
    await page.getByRole('button', { name: 'Nuevo', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Nuevo', exact: true })).toHaveCount(0)
    await page.reload()
    await expect(page.locator('.xterm')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Nuevo', exact: true })).toHaveCount(0)
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

test.describe('dictado: mouse y atajo', () => {
  // Micrófono falso (un pitido): solo se mira que arranque y se corte, sin transcribir.
  test.use({
    seed: {
      workspaces: [{ id: 'ws-dictado', name: 'api-pagos', open: true }],
      chromiumArgs: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
    }
  })

  test('se activa con el mouse', async ({ sloth: { page } }) => {
    await expect(page.locator('.xterm')).toHaveCount(1)
    await page.locator('.pane-head').getByRole('button', { name: 'Dictar', exact: true }).click()
    await expect(page.locator('.pane-head').getByText('Escuchando…')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Detener dictado' })).toBeVisible()
  })

  test('se activa con Ctrl+Shift+D aunque la terminal tenga el foco', async ({ sloth: { page } }) => {
    await shellReady(page)
    await page.locator('.xterm').click()
    await page.keyboard.press('Control+Shift+D')
    await expect(page.locator('.pane-head').getByText('Escuchando…')).toBeVisible()
    // xterm no se comió la tecla: no se escribió nada en el prompt.
    expect(await termText(page)).not.toMatch(/^D/)
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
    const mic = page.getByRole('button', { name: 'Dictar', exact: true })
    await mic.click()
    await expect(page.locator('.dictado-estado', { hasText: 'Escuchando…' })).toBeVisible()
    // El audio dura ~8 s.
    await page.waitForTimeout(9000)
    await page.getByRole('button', { name: 'Detener dictado' }).click()
    await expect(page.locator('.dictado-estado', { hasText: 'Transcribiendo…' })).toBeVisible()
    await expect.poll(() => termText(page), { timeout: 60_000 }).toMatch(/pull.?request/i)
    await expect(page.locator('.dictado-estado', { hasText: 'Transcribiendo…' })).toBeHidden()
    // Sin Enter: el texto quedó en la línea, PowerShell no lo ejecutó (no hay error de comando).
    expect(await termText(page)).not.toMatch(/no se reconoce|is not recognized|CommandNotFound/i)
  })
})
