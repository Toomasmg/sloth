import { test, expect } from './sloth'
import type { Locator } from '@playwright/test'

test.use({ seed: { workspaces: [{ id: 'ws-web', name: 'web', open: true }] } })

/** Lo que se ve en el centro del elemento es él mismo (o algo suyo), no una Vista o un panel que lo tapa. */
async function seVeArriba(loc: Locator): Promise<boolean> {
  return loc.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 40))
    return top !== null && el.contains(top)
  })
}

test('con una Vista abierta, Nuevo espacio y la paleta quedan por encima y con el foco', async ({ sloth: { page } }) => {
  await page.locator('.sl-rail [data-nav="tickets"]').click()
  await expect(page.locator('.ui-view')).toBeVisible()

  await page.keyboard.press('Control+N')
  const dlg = page.getByRole('dialog', { name: 'Nuevo espacio' })
  await expect(dlg).toBeVisible()
  expect(await seVeArriba(dlg)).toBe(true)
  expect(await dlg.evaluate((el) => el.contains(document.activeElement))).toBe(true)

  await page.keyboard.press('Escape')
  await expect(dlg).toBeHidden()
  await expect(page.locator('.ui-view')).toBeVisible()

  await page.keyboard.press('Control+K')
  await page.keyboard.type('Configuración')
  const pop = page.getByRole('dialog', { name: 'Resultados de la búsqueda' })
  await expect(pop).toBeVisible()
  expect(await seVeArriba(pop.getByRole('listbox'))).toBe(true)
  await expect(page.getByRole('combobox').first()).toBeFocused()
})

test('con dos Vistas apiladas, Esc cierra solo la de arriba', async ({ sloth: { page } }) => {
  await page.locator('.sl-rail [data-nav="ayuda"]').click()
  await expect(page.getByRole('dialog', { name: 'Ayuda y atajos' })).toBeVisible()
  await page.keyboard.press('Control+K')
  await page.keyboard.type('Primeros pasos')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Primeros pasos' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Primeros pasos' })).toBeHidden()
  await expect(page.getByRole('dialog', { name: 'Ayuda y atajos' })).toBeVisible()
})
