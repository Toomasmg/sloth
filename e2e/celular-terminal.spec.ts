import { readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './sloth'
import { shellReady } from './terminal'
import { elegirIp } from '../src/main/features/celular-core'

test.use({ seed: { workspaces: [{ id: 'ws-web', name: 'web', open: true }] } })

const ip = elegirIp(networkInterfaces())

test('Celular: la terminal del espacio se abre desde el celu, se escribe y vuelve al tamaño de la PC', async ({ sloth: { app, page } }) => {
  test.skip(!ip, 'Esta PC no tiene una red privada: no hay dónde abrir el servidor.')
  test.setTimeout(150_000)
  await shellReady(page)
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'))
  const clave = (JSON.parse(readFileSync(join(userData, 'perfiles', 'principal', 'features', 'celular.json'), 'utf8')) as { clave: string }).clave

  await page.keyboard.press('Control+k')
  await page.getByRole('combobox').first().fill('Ver Sloth en el celular')
  await page.keyboard.press('Enter')
  const panel = page.getByRole('dialog', { name: 'Celular' })
  await panel.getByLabel('Puerto').fill('47389')
  await panel.getByRole('button', { name: 'Guardar' }).first().click()
  await panel.getByRole('switch', { name: 'Ver Sloth en el celu' }).click()
  await expect(panel.getByRole('img', { name: /Código QR/ })).toBeVisible()

  // Una ventana con tamaño de teléfono que abre el enlace del QR, como el celu.
  const ventana = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }, url) => {
    const w = new BrowserWindow({ width: 390, height: 780, show: true, webPreferences: { sandbox: true, contextIsolation: true } })
    void w.loadURL(url)
  }, `http://${ip}:47389/#k=${clave}`)
  const celu = await ventana
  await expect(celu.getByText('web', { exact: true })).toBeVisible()
  // Apagada en la PC, el celu no ofrece la terminal.
  await expect(celu.getByRole('button', { name: 'Abrir la terminal de web' })).toHaveCount(0)

  await panel.getByRole('switch', { name: 'Abrir las terminales desde el celu' }).click()
  await celu.getByRole('button', { name: 'Abrir la terminal de web' }).click()
  const term = celu.getByRole('dialog', { name: 'web' })
  await expect(term).toBeVisible()
  const pantalla = term.locator('.xterm-rows')
  await expect(pantalla).toContainText('shell-lista', { timeout: 15_000 })

  const escribir = async (texto: string): Promise<void> => {
    await term.getByLabel('Texto para la terminal').fill(texto)
    await term.getByRole('button', { name: 'Enviar' }).click()
  }
  await escribir("Write-Output ('celu-' + 'escribe')")
  await expect(pantalla).toContainText('celu-escribe')

  await term.getByRole('button', { name: 'Ajustar al celu' }).click()
  await expect(term.getByRole('button', { name: 'Tamaño de la PC' })).toBeVisible()
  await escribir("Write-Output ('ancho-' + $Host.UI.RawUI.WindowSize.Width)")
  await expect.poll(async () => Number(/ancho-(\d+)/.exec((await pantalla.textContent()) ?? '')?.[1] ?? 0)).toBeLessThan(60)

  // Al volver, la terminal recupera el tamaño que tenía en la PC.
  await term.getByRole('button', { name: 'Volver a las sesiones' }).click()
  await expect(term).toBeHidden()
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await page.locator('.terminal-host').first().click()
  await page.keyboard.type("Write-Output ('pc-' + $Host.UI.RawUI.WindowSize.Width)")
  await page.keyboard.press('Enter')
  const pcCols = await page.locator('.terminal-host').first().evaluate((el) => (el as HTMLElement & { __xterm?: { cols: number } }).__xterm?.cols ?? 0)
  await expect(page.locator('.terminal-host').first()).toContainText(`pc-${pcCols}`)

  // Apagarla en la PC corta al celu en el momento.
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox').first().fill('Ver Sloth en el celular')
  await page.keyboard.press('Enter')
  await panel.getByRole('switch', { name: 'Abrir las terminales desde el celu' }).click()
  await celu.getByRole('button', { name: 'Abrir la terminal de web' }).waitFor({ state: 'detached' })
})
