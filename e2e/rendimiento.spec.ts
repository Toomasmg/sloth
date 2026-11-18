import { test, expect } from './sloth'
import { shellReady, termText } from './terminal'

/**
 * «Rendimiento» pone un tope a las terminales con un Job Object de Windows. Se baja a 1 núcleo desde la
 * Configuración y se le pregunta a la PowerShell del panel su afinidad real; al volver a «Todos», se libera.
 */
test.describe('rendimiento', () => {
  test.use({ seed: { workspaces: [{ id: 'ws-rend', name: 'web', open: true }] } })

  test('el límite de núcleos llega a la terminal y se puede sacar', async ({ sloth: { page } }) => {
    await shellReady(page)
    const afinidad = async (marca: string): Promise<number> => {
      await page.locator('.terminal-host').first().click()
      await page.keyboard.type(`Write-Output ('${marca}=' + (Get-Process -Id $PID).ProcessorAffinity)`)
      await page.keyboard.press('Enter')
      let valor = -1
      await expect
        .poll(async () => {
          const m = new RegExp(`^${marca}=(\\d+)`, 'm').exec(await termText(page))
          valor = m ? Number(m[1]) : -1
          return valor
        })
        .toBeGreaterThan(0)
      return valor
    }
    const todos = await afinidad('antes')

    await page.getByRole('navigation', { name: 'Navegación' }).getByRole('button', { name: 'Configuración' }).click()
    await page.getByRole('button', { name: /^Rendimiento/ }).first().click()
    const nucleos = page.getByLabel('Núcleos', { exact: true })
    await nucleos.focus()
    await page.keyboard.press('Home')
    await expect(page.locator('output[for="f-rend-ac-cpu"]')).toHaveText(/^1 de \d+$/)
    await expect(page.getByText(/1 de \d+ núcleos · \d+ proceso/)).toBeVisible({ timeout: 30_000 })
    await page.keyboard.press('Escape')
    // Con la Configuración todavía cerrándose, el clic en la terminal no le llega.
    await expect(page.locator('.f-set-view')).toBeHidden()
    expect(await afinidad('uno')).toBe(1)

    await page.getByRole('navigation', { name: 'Navegación' }).getByRole('button', { name: 'Configuración' }).click()
    await page.getByRole('button', { name: /^Rendimiento/ }).first().click()
    await page.getByLabel('Núcleos', { exact: true }).focus()
    await page.keyboard.press('End')
    await expect(page.getByText(/todos los núcleos · \d+ proceso/)).toBeVisible({ timeout: 30_000 })
    await page.keyboard.press('Escape')
    // Con la Configuración todavía cerrándose, el clic en la terminal no le llega.
    await expect(page.locator('.f-set-view')).toBeHidden()
    expect(await afinidad('despues')).toBe(todos)
  })
})
