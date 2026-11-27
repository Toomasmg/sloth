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
  // El QR solo deja pedir entrar: el celu muestra un código y la PC, el mismo, hasta que alguien lo deja entrar.
  await expect(celu.getByRole('heading', { name: 'Confirmá en la PC' })).toBeVisible()
  const codigo = (await celu.locator('#par-codigo').textContent()) ?? ''
  expect(codigo).toMatch(/^\d{4}$/)
  await expect(celu.getByText('web', { exact: true })).toBeHidden()
  const pedido = panel.getByRole('group', { name: /Pedido para entrar/ })
  await expect(pedido).toContainText(codigo)
  await pedido.getByRole('button', { name: 'Dejar entrar' }).click()
  await expect(celu.getByText('web', { exact: true })).toBeVisible()
  await expect(panel.getByRole('list', { name: 'Celus con acceso' }).getByRole('listitem')).toHaveCount(1)
  // Con la clave del QR sola no se ve nada: la página ya usa la suya y el QR quedó solo para pedir entrar.
  const qr = (JSON.parse(readFileSync(join(userData, 'perfiles', 'principal', 'features', 'celular.json'), 'utf8')) as { clave: string; celus: { clave: string }[] })
  expect(qr.celus).toHaveLength(1)
  expect(qr.celus[0].clave).not.toBe(clave)
  // Apagada en la PC, el celu no ofrece la terminal.
  await expect(celu.getByRole('button', { name: 'Abrir la terminal de web' })).toHaveCount(0)

  await panel.getByRole('switch', { name: 'Abrir las terminales desde el celu' }).click()
  await celu.getByRole('button', { name: 'Abrir la terminal de web' }).click()
  const term = celu.getByRole('dialog', { name: 'web' })
  await expect(term).toBeVisible()
  const pantalla = term.locator('.xterm-rows')
  await expect(pantalla).toContainText('shell-lista', { timeout: 15_000 })

  // Se escribe en la propia terminal: el toque enfoca el textarea de xterm y lo tipeado sale por onData.
  const escribir = async (texto: string): Promise<void> => {
    await term.locator('.xterm-screen').click()
    await celu.keyboard.insertText(texto)
    await celu.keyboard.press('Enter')
  }
  await escribir("Write-Output ('celu-' + 'escribe')")
  await expect(pantalla).toContainText('celu-escribe')

  // El celu nunca cambia el tamaño de la PC: la terminal mide lo mismo antes y después de cambiar de vista.
  const pcCols = await page.locator('.terminal-host').first().evaluate((el) => (el as HTMLElement & { __xterm?: { cols: number } }).__xterm?.cols ?? 0)
  const anchoEnPc = async (marca: string): Promise<number> => {
    await escribir(`Write-Output ('${marca}-' + $Host.UI.RawUI.WindowSize.Width)`)
    await expect.poll(async () => new RegExp(`${marca}-(\\d+)`).test((await pantalla.textContent()) ?? '')).toBe(true)
    return Number(new RegExp(`${marca}-(\\d+)`).exec((await pantalla.textContent()) ?? '')?.[1])
  }
  expect(await anchoEnPc('antes')).toBe(pcCols)
  await term.getByRole('button', { name: /^Vista PC/ }).click()
  await expect(term.getByRole('button', { name: /^Vista celu/ })).toBeVisible()
  expect(await anchoEnPc('despues')).toBe(pcCols)

  await term.getByRole('button', { name: 'Volver a las sesiones' }).click()
  await expect(term).toBeHidden()
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await page.locator('.terminal-host').first().click()
  // Al cerrar el panel la terminal de la PC puede cambiar de ancho por su cuenta: se lee de nuevo.
  const colsPc = (): Promise<number> => page.locator('.terminal-host').first().evaluate((el) => (el as HTMLElement & { __xterm?: { cols: number } }).__xterm?.cols ?? 0)
  let previo = -1
  await expect
    .poll(async () => {
      const c = await colsPc()
      const quieto = c === previo
      previo = c
      return quieto
    }, { intervals: [250] })
    .toBe(true)
  const pcFinal = await colsPc()
  await page.keyboard.type("Write-Output ('pc-' + $Host.UI.RawUI.WindowSize.Width)")
  await page.keyboard.press('Enter')
  await expect(page.locator('.terminal-host').first()).toContainText(`pc-${pcFinal}`)

  // Apagarla en la PC corta al celu en el momento.
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox').first().fill('Ver Sloth en el celular')
  await page.keyboard.press('Enter')
  await panel.getByRole('switch', { name: 'Abrir las terminales desde el celu' }).click()
  await celu.getByRole('button', { name: 'Abrir la terminal de web' }).waitFor({ state: 'detached' })
})
