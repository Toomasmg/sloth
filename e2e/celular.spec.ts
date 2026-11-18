import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './sloth'
import { elegirIp } from '../src/main/features/celular-core'
import { abrirRespuesta, derivarClaves, sellarPedido } from '../src/main/features/celular-sello'

test.use({ seed: { workspaces: [{ id: 'ws-web', name: 'web', open: true }] } })

const ip = elegirIp(networkInterfaces())

test('Celular: prende el servidor del Wi-Fi, muestra el QR y la API solo habla con la clave del QR', async ({ sloth: { app, page } }) => {
  test.skip(!ip, 'Esta PC no tiene una red privada: no hay dónde abrir el servidor.')
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'))
  const clave = (): string => (JSON.parse(readFileSync(join(userData, 'perfiles', 'principal', 'features', 'celular.json'), 'utf8')) as { clave: string }).clave

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
  const llamar = async (ruta: string, laClave: string, cuerpo?: unknown): Promise<{ status: number; datos: unknown }> => {
    const claves = derivarClaves(laClave)
    if (!claves) throw new Error('clave inválida')
    const iv = randomBytes(16)
    const r = await fetch(`${base}${ruta}`, { method: 'POST', body: sellarPedido(claves, ruta, JSON.stringify({ t: Date.now(), b: cuerpo }), iv) })
    const texto = await r.text()
    const json = texto ? abrirRespuesta(claves, iv, texto) : null
    return { status: r.status, datos: json ? JSON.parse(json) : null }
  }

  expect((await fetch(`${base}/api/estado`)).status).toBe(401)
  expect((await fetch(`${base}/api/estado`, { method: 'POST', body: 'no-sellado' })).status).toBe(401)
  const viejo = clave()
  const con = await llamar('/api/estado', viejo)
  expect(con.status).toBe(200)
  const estado = con.datos as { aprobar: boolean; cuentas: { id: string; cincoHoras: unknown }[] }
  expect(estado.aprobar).toBe(false)
  expect(estado.cuentas.map((c) => c.id)).toContain('acc-e2e')
  expect(estado.cuentas[0].cincoHoras).toBeNull()

  expect((await llamar('/api/permiso', viejo, { id: 'x', decision: 'allow' })).status).toBe(403)

  await panel.getByRole('button', { name: 'Regenerar código…' }).click()
  await panel.getByRole('button', { name: 'Regenerar código', exact: true }).click()
  await expect.poll(() => clave()).not.toBe(viejo)
  const claves = derivarClaves(viejo)
  if (!claves) throw new Error('clave inválida')
  expect((await fetch(`${base}/api/estado`, { method: 'POST', body: sellarPedido(claves, '/api/estado', JSON.stringify({ t: Date.now() })) })).status).toBe(401)
  expect((await llamar('/api/estado', clave())).status).toBe(200)

  await panel.getByRole('switch', { name: 'Ver Sloth en el celu' }).click()
  await expect(panel.getByRole('img', { name: /Código QR/ })).toBeHidden()
  await expect(fetch(`${base}/api/estado`, { method: 'POST' })).rejects.toThrow()

  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
})
