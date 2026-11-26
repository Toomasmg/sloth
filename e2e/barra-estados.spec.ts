import { test, expect } from './sloth'

const ANCHOS = [900, 1280, 1920]

// Los estados reales dependen de las terminales; acá se arma la misma marca de la barra con los cuatro chips.
const CHIPS = [
  { cls: 'is-waiting', n: 6, texto: 'piden permiso' },
  { cls: 'is-waiting', n: 12, texto: 'te esperan' },
  { cls: 'is-working', n: 8, texto: 'trabajando' },
  { cls: 'is-done', n: 23, texto: 'terminaron' }
]

test.describe('barra superior: chips de estado', () => {
  test.use({ seed: { workspaces: [{ id: 'ws-barra', name: 'api-pagos', open: true }] } })

  for (const ancho of ANCHOS) {
    test(`los 4 chips se ven completos a ${ancho} px`, async ({ sloth: { app, page } }) => {
      await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setContentSize(w, 700), ancho)
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(ancho)
      await page.evaluate((chips) => {
        const caja = document.querySelector('.sl-top-status')
        if (!caja) throw new Error('falta .sl-top-status')
        for (const c of chips) {
          const b = document.createElement('button')
          b.type = 'button'
          b.className = `sl-sum ${c.cls}`
          b.setAttribute('aria-label', `${c.n} ${c.texto}`)
          b.title = `${c.n} ${c.texto}`
          b.innerHTML = `<span>${c.n}</span><span class="sl-sum-t">${c.texto}</span>`
          caja.appendChild(b)
        }
      }, CHIPS)

      const medidas = await page.evaluate(() => {
        const caja = document.querySelector<HTMLElement>('.sl-top-status')!
        const buscador = document.querySelector<HTMLElement>('.sl-top-search')!
        const rect = (e: Element): DOMRect => e.getBoundingClientRect()
        return {
          caja: { w: rect(caja).width, sw: caja.scrollWidth, cw: caja.clientWidth },
          buscador: rect(buscador).width,
          top: document.querySelector('.sl-top')!.scrollWidth - document.querySelector('.sl-top')!.clientWidth,
          chips: [...caja.querySelectorAll<HTMLElement>('.sl-sum')].map((c) => ({
            w: rect(c).width,
            sw: c.scrollWidth,
            cw: c.clientWidth,
            derecha: rect(c).right,
            ariaLabel: c.getAttribute('aria-label'),
            title: c.title
          })),
          ventana: window.innerWidth
        }
      })

      expect(medidas.caja.w).toBeGreaterThan(0)
      expect(medidas.caja.sw).toBeLessThanOrEqual(medidas.caja.cw)
      expect(medidas.top).toBeLessThanOrEqual(0)
      expect(medidas.buscador).toBeGreaterThanOrEqual(200)
      expect(medidas.buscador).toBeLessThanOrEqual(520)
      expect(medidas.chips).toHaveLength(4)
      for (const c of medidas.chips) {
        expect(c.w).toBeGreaterThan(0)
        expect(c.sw).toBeLessThanOrEqual(c.cw)
        expect(c.derecha).toBeLessThanOrEqual(medidas.ventana)
        expect(c.ariaLabel).toBeTruthy()
        expect(c.title).toBeTruthy()
      }
      // Entre 1100 y más entra el texto; por debajo quedan ícono + número.
      const textoVisible = await page.locator('.sl-top-status .sl-sum-t').first().isVisible()
      expect(textoVisible).toBe(ancho >= 1100)

      // Captura nueva (no toca las de referencia existentes): evidencia visual del estado de la barra.
      await expect(page.locator('.sl-top')).toHaveScreenshot(`barra-estados-${ancho}.png`)
    })
  }
})
