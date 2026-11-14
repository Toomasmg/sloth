import { test, expect } from './sloth'

const snapshot = (unreadTotal: number) => ({
  auth: { status: 'signedOut' },
  connection: 'off',
  teams: [],
  threads: [],
  invites: [],
  unreadTotal
})

test('el botón del chat muestra el total de no leídos y se va al leer', async ({ sloth: { app, page } }) => {
  const send = (n: number): Promise<void> =>
    app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('feat:chat:snapshot', s), snapshot(n))
  const boton = page.locator('.sl-chat')

  await send(3)
  await expect(boton).toHaveAccessibleName('Chat, 3 mensajes sin leer')
  await expect(boton.locator('.ui-badge')).toHaveText('3')

  await send(150)
  await expect(boton.locator('.ui-badge')).toHaveText('99+')

  await send(0)
  await expect(boton.locator('.ui-badge')).toHaveCount(0)
  await expect(boton).toHaveAccessibleName('Chat del equipo')
})

test('los sonidos del chat se apagan en Configuración y se quedan apagados', async ({ sloth: { page } }) => {
  await page.getByRole('navigation', { name: 'Navegación' }).getByRole('button', { name: 'Configuración' }).click()
  await page.getByRole('button', { name: /^Notificaciones/ }).first().click()

  const recibir = page.getByRole('switch', { name: /Sonido al recibir mensajes/ })
  const enviar = page.getByRole('switch', { name: /Sonido al enviar mensajes/ })
  await expect(recibir).toBeChecked()
  await expect(enviar).toBeChecked()

  await recibir.click()
  await enviar.click()
  await expect(recibir).not.toBeChecked()
  await expect(enviar).not.toBeChecked()
  await expect(page.getByText('Guardado', { exact: true })).toBeVisible()

  await page.reload()
  await page.getByRole('navigation', { name: 'Navegación' }).getByRole('button', { name: 'Configuración' }).click()
  await page.getByRole('button', { name: /^Notificaciones/ }).first().click()
  await expect(page.getByRole('switch', { name: /Sonido al recibir mensajes/ })).not.toBeChecked()
  await expect(page.getByRole('switch', { name: /Sonido al enviar mensajes/ })).not.toBeChecked()
})
