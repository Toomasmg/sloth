import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type ElectronApplication, type Page } from '@playwright/test'

/** Prende «Ver Sloth en el celu» y la terminal desde el celu en el puerto dado; devuelve el enlace del QR. */
export async function prenderCelular(app: ElectronApplication, page: Page, ip: string, puerto: number): Promise<string> {
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'))
  const clave = (JSON.parse(readFileSync(join(userData, 'perfiles', 'principal', 'features', 'celular.json'), 'utf8')) as { clave: string }).clave
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox').first().fill('Ver Sloth en el celular')
  await page.keyboard.press('Enter')
  const panel = page.getByRole('dialog', { name: 'Celular' })
  await panel.getByLabel('Puerto').fill(String(puerto))
  await panel.getByRole('button', { name: 'Guardar' }).first().click()
  await panel.getByRole('switch', { name: 'Ver Sloth en el celu' }).click()
  await expect(panel.getByRole('img', { name: /Código QR/ })).toBeVisible()
  await panel.getByRole('switch', { name: 'Abrir las terminales desde el celu' }).click()
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  return `http://${ip}:${puerto}/#k=${clave}`
}
