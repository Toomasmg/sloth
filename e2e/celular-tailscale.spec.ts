import { networkInterfaces } from 'node:os'
import { test, expect } from './sloth'
import { claveQr, emparejar } from './celular-celu'
import { elegirIp, ipTailscale } from '../src/main/features/celular-core'

test.use({ seed: { workspaces: [{ id: 'ws-web', name: 'web', open: true }] } })

const ip = elegirIp(networkInterfaces())

test('Celular por Tailscale: apagado por defecto; prendido, sirve en 127.0.0.1 (para tailscale serve) y arma el QR https', async ({ sloth: { app, page } }) => {
  test.skip(!ip, 'Esta PC no tiene una red privada: no hay dónde abrir el servidor.')
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox').first().fill('Ver Sloth en el celular')
  await page.keyboard.press('Enter')
  const panel = page.getByRole('dialog', { name: 'Celular' })
  await panel.getByLabel('Puerto').fill('47395')
  await panel.getByRole('button', { name: 'Guardar' }).first().click()
  await expect(panel.getByRole('heading', { name: 'Fuera de casa, con Tailscale' })).toBeHidden()
  await panel.getByRole('switch', { name: 'Ver Sloth en el celu' }).click()
  await expect(panel.getByRole('img', { name: /Código QR/ })).toHaveCount(1)

  const local = 'http://127.0.0.1:47395'
  const tailscale = panel.getByRole('switch', { name: 'También por Tailscale' })
  await expect(tailscale).not.toBeChecked()
  await expect(fetch(`${local}/`), 'apagado, nada escucha en 127.0.0.1').rejects.toThrow()

  await tailscale.click()
  await expect(tailscale).toBeChecked()
  await expect.poll(async () => (await fetch(`${local}/`).catch(() => null))?.status).toBe(200)
  if (ipTailscale(networkInterfaces())) await expect(panel.getByText(/^Escaneá este QR con el celu conectado a Tailscale/)).toBeVisible()
  else await expect(panel.getByText(/No encontré Tailscale conectado/)).toBeVisible()

  // Lo que llega por `tailscale serve` (desde 127.0.0.1) igual tiene que pedir entrar: el QR solo no alcanza.
  const celu = await emparejar(panel, local, await claveQr(app))
  expect(celu).toHaveLength(43)

  const campo = panel.getByLabel('Dirección', { exact: true })
  await campo.fill('https://mi-pc.evil.com')
  await campo.press('Enter')
  await expect(panel.getByText(/Tiene que ser la dirección que da Tailscale/)).toBeVisible()
  await campo.fill('https://Mi-PC.tailnet-e2e.ts.net/')
  await campo.press('Enter')
  await expect(campo).toHaveValue('https://mi-pc.tailnet-e2e.ts.net')
  await expect(panel.getByText(/«Instalar app»/)).toBeVisible()
  await expect(panel.getByRole('img', { name: /Código QR/ })).toHaveCount(ipTailscale(networkInterfaces()) ? 3 : 2)

  await tailscale.click()
  await expect(tailscale).not.toBeChecked()
  await expect.poll(async () => (await fetch(`${local}/`).catch(() => null))?.status ?? 'cerrado').toBe('cerrado')
})
