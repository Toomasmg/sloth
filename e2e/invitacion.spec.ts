import { test, expect } from './sloth'

test.use({ seed: { workspaces: [{ id: 'ws-web', name: 'web', open: true }] } })

const token = (body: object): string => `sloth-invitacion:v1.${Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')}`
const CODE = '0123456789abcdef'

async function abrir(page: import('@playwright/test').Page): Promise<import('@playwright/test').Locator> {
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox').first().fill('Unirme con una invitación')
  await page.keyboard.press('Enter')
  const dlg = page.getByRole('dialog', { name: 'Unirme con una invitación' })
  await expect(dlg).toBeVisible()
  return dlg
}

test('una invitación válida muestra el servidor y pide confirmar antes de conectar', async ({ sloth: { page } }) => {
  const dlg = await abrir(page)
  const texto = `Sumate al chat:\n\n${token({ url: 'https://equipo-prueba.supabase.co', key: 'sb_publishable_abcdefgh12345', code: CODE, team: 'Núcleo' })}`
  await dlg.getByRole('textbox', { name: 'Invitación' }).fill(texto)
  await dlg.getByRole('button', { name: 'Continuar' }).click()
  await expect(dlg.getByText('equipo-prueba.supabase.co', { exact: true })).toBeVisible()
  await expect(dlg.getByText('«Núcleo»', { exact: false })).toBeVisible()
  await expect(dlg.getByRole('button', { name: 'Conectar y entrar' })).toBeVisible()
  await dlg.getByRole('button', { name: 'Volver' }).click()
  await expect(dlg.getByRole('textbox', { name: 'Invitación' })).toHaveValue(texto)
})

test('una invitación con la clave secreta se rechaza con su motivo', async ({ sloth: { page } }) => {
  const dlg = await abrir(page)
  await dlg.getByRole('textbox', { name: 'Invitación' }).fill(token({ url: 'https://equipo-prueba.supabase.co', key: 'sb_secret_abcdefgh12345', code: CODE }))
  await dlg.getByRole('button', { name: 'Continuar' }).click()
  await expect(dlg.getByText(/service_role \/ secret key/)).toBeVisible()
  await expect(dlg.getByRole('button', { name: 'Conectar y entrar' })).toHaveCount(0)
})
