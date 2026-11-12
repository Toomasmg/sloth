import { test, expect } from './sloth'

test('General muestra «Preguntar antes de cerrar» y «Dormir espacios inactivos»', async ({ sloth: { page } }) => {
  await page.getByRole('navigation', { name: 'Navegación' }).getByRole('button', { name: 'Configuración' }).click()
  await page.getByRole('button', { name: /^General/ }).first().click()

  await expect(page.getByText('Preguntar antes de cerrar Sloth')).toBeVisible()
  const sleep = page.getByLabel('Dormir espacios inactivos')
  await expect(sleep).toHaveValue('0')
  await expect(sleep.locator('option')).toHaveText(['Nunca', 'Tras 15 minutos', 'Tras 30 minutos', 'Tras 1 hora', 'Tras 2 horas'])

  await sleep.selectOption('30')
  await expect(sleep).toHaveValue('30')
  await expect(page.getByText('Guardado', { exact: true })).toBeVisible()
  // Se tapa lo que cambia de PC a PC (la carpeta de proyectos) y el aviso «Guardado», que se va solo.
  await expect(page).toHaveScreenshot('configuracion-general.png', {
    mask: [page.locator('.mono').filter({ hasText: /^[A-Za-z]:\\/ }), page.getByText('Guardado', { exact: true })]
  })
})
