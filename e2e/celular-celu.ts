import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { abrirRespuesta, derivarClaves, sellarPedido } from '../src/main/features/celular-sello'

/** La clave del QR (solo sirve para pedir entrar). */
export async function claveQr(app: ElectronApplication): Promise<string> {
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'))
  return (JSON.parse(readFileSync(join(userData, 'perfiles', 'principal', 'features', 'celular.json'), 'utf8')) as { clave: string }).clave
}

/**
 * Hace lo que hace la página con el QR: pide entrar con una clave propia y, en el panel abierto, deja entrar al
 * pedido con el mismo código. Devuelve la clave del celu, que abre la página sin volver a pedir (#k=<clave>).
 */
export async function emparejar(panel: Locator, base: string, qr: string): Promise<string> {
  const propia = randomBytes(32).toString('base64url')
  const claves = derivarClaves(qr)
  if (!claves) throw new Error('clave del QR inválida')
  const iv = randomBytes(16)
  const r = await fetch(`${base}/api/emparejar`, { method: 'POST', body: sellarPedido(claves, '/api/emparejar', JSON.stringify({ t: Date.now(), b: { clave: propia } }), iv) })
  expect(r.status).toBe(200)
  const { codigo } = JSON.parse(abrirRespuesta(claves, iv, await r.text()) ?? '{}') as { codigo: string }
  const pedido = panel.getByRole('group', { name: /Pedido para entrar/ }).filter({ hasText: codigo })
  await pedido.getByRole('button', { name: 'Dejar entrar' }).click()
  await expect(pedido).toHaveCount(0)
  return propia
}

/** Prende «Ver Sloth en el celu» y la terminal desde el celu en el puerto dado; devuelve el enlace del QR. */
export async function prenderCelular(app: ElectronApplication, page: Page, ip: string, puerto: number): Promise<string> {
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox').first().fill('Ver Sloth en el celular')
  await page.keyboard.press('Enter')
  const panel = page.getByRole('dialog', { name: 'Celular' })
  await panel.getByLabel('Puerto').fill(String(puerto))
  await panel.getByRole('button', { name: 'Guardar' }).first().click()
  await panel.getByRole('switch', { name: 'Ver Sloth en el celu' }).click()
  await expect(panel.getByRole('img', { name: /Código QR/ })).toBeVisible()
  await panel.getByRole('switch', { name: 'Abrir las terminales desde el celu' }).click()
  const clave = await emparejar(panel, `http://${ip}:${puerto}`, await claveQr(app))
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  return `http://${ip}:${puerto}/#k=${clave}`
}
