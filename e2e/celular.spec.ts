import { readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './sloth'
import { elegirIp } from '../src/main/features/celular-core'

test.use({ seed: { workspaces: [{ id: 'ws-web', name: 'web', open: true }] } })

const ip = elegirIp(networkInterfaces())

test('Celular: prende el servidor del Wi-Fi, muestra el QR y la API pide el token', async ({ sloth: { app, page } }) => {
  test.skip(!ip, 'Esta PC no tiene una red privada: no hay dónde abrir el servidor.')
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'))
  const token = (): string => (JSON.parse(readFileSync(join(userData, 'features', 'celular.json'), 'utf8')) as { token: string }).token

  await page.keyboard.press('Control+k')
  await page.getByRole('combobox').first().fill('Ver Sloth en el celular')
  await page.keyboard.press('Enter')
  const panel = page.getByRole('dialog', { name: 'Celular' })
  await expect(panel).toBeVisible()
  await expect(panel.getByText('Apagado: nada se abre en la red')).toBeVisible()

  const puerto = panel.getByLabel('Puerto')
  await puerto.fill('47388')
  await panel.getByRole('button', { name: 'Guardar' }).first().click()
  await panel.getByRole('switch', { name: 'Ver Sloth en el celu' }).click()
  await expect(panel.getByRole('img', { name: /Código QR/ })).toBeVisible()
  await expect(panel.getByText(`${ip}:47388`)).toBeVisible()

  const base = `http://${ip}:47388`
  const sin = await fetch(`${base}/api/estado`)
  expect(sin.status).toBe(401)
  const viejo = token()
  const con = await fetch(`${base}/api/estado`, { headers: { 'x-sloth-token': viejo } })
  expect(con.status).toBe(200)
  const estado = (await con.json()) as { aprobar: boolean; cuentas: { id: string; cincoHoras: unknown }[] }
  expect(estado.aprobar).toBe(false)
  expect(estado.cuentas.map((c) => c.id)).toContain('acc-e2e')
  expect(estado.cuentas[0].cincoHoras).toBeNull()

  const aprobar = await fetch(`${base}/api/permiso`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sloth-token': viejo }, body: '{"id":"x","decision":"allow"}' })
  expect(aprobar.status).toBe(403)

  await panel.getByRole('button', { name: 'Regenerar código…' }).click()
  await panel.getByRole('button', { name: 'Regenerar código', exact: true }).click()
  await expect.poll(() => token()).not.toBe(viejo)
  expect((await fetch(`${base}/api/estado`, { headers: { 'x-sloth-token': viejo } })).status).toBe(401)
  expect((await fetch(`${base}/api/estado`, { headers: { 'x-sloth-token': token() } })).status).toBe(200)

  await panel.getByRole('switch', { name: 'Ver Sloth en el celu' }).click()
  await expect(panel.getByRole('img', { name: /Código QR/ })).toBeHidden()
  await expect(fetch(`${base}/api/estado`)).rejects.toThrow()

  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
})
