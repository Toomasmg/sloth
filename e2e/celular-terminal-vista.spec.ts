import { networkInterfaces } from 'node:os'
import { chromium, devices, webkit, type BrowserContext, type Page } from '@playwright/test'
import { test, expect } from './sloth'
import { shellReady } from './terminal'
import { elegirIp } from '../src/main/features/celular-core'
import { prenderCelular } from './celular-celu'

/**
 * La terminal desde el celu con una terminal de PC ancha (sin capturas de referencia): el celu nunca cambia el tamaño
 * del PTY, se escribe directo en la terminal, la vista PC/celu se recalcula al girar y el teclado virtual no tapa nada.
 * Las capturas que saca van a test-results, solo para mirarlas.
 */
test.use({ seed: { workspaces: [{ id: 'ws-web', name: 'web', open: true }] } })

const ip = elegirIp(networkInterfaces())

const CELUS = [
  { nombre: 'Galaxy S9+', motor: chromium, ficha: devices['Galaxy S9+'] },
  { nombre: 'iPhone 13', motor: webkit, ficha: devices['iPhone 13'] }
]

type Xt = HTMLElement & { __xterm?: { cols: number; rows: number } }

const tamPc = (page: Page): Promise<{ cols: number; rows: number }> =>
  page.locator('.terminal-host').first().evaluate((el) => {
    const t = (el as Xt).__xterm
    return { cols: t?.cols ?? 0, rows: t?.rows ?? 0 }
  })

// Chromium no deja cambiar el tamaño de la ventana en emulación móvil con setViewportSize: se hace por el protocolo.
async function medida(ctx: BrowserContext, p: Page, motor: string, width: number, height: number): Promise<void> {
  if (motor !== 'chromium') return p.setViewportSize({ width, height })
  const cdp = await ctx.newCDPSession(p)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true })
}

/** Un visualViewport de mentira que se controla desde el test: en un teléfono el teclado achica la ventana visible, no la página. */
const TECLADO_FALSO = (): void => {
  const vv = new EventTarget()
  let alto: number | null = null
  Object.defineProperties(vv, {
    width: { get: () => window.innerWidth },
    height: { get: () => alto ?? window.innerHeight },
    offsetTop: { value: 0 },
    offsetLeft: { value: 0 },
    scale: { value: 1 }
  })
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true })
  ;(window as unknown as { __teclado: (a: number | null) => void }).__teclado = (a) => {
    alto = a
    vv.dispatchEvent(new Event('resize'))
  }
}

interface Caja {
  top: number
  bottom: number
  left: number
  right: number
}

const caja = (p: Page, sel: string): Promise<Caja> =>
  p.locator(sel).first().evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }
  })

test('Celular: terminal de PC ancha en Galaxy e iPhone, vertical y horizontal; la PC no cambia de tamaño', async ({ sloth: { app, page } }) => {
  test.skip(!ip, 'Esta PC no tiene una red privada: no hay dónde abrir el servidor.')
  test.setTimeout(420_000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(2300, 900))
  await shellReady(page)
  await expect.poll(async () => (await tamPc(page)).cols, { timeout: 10_000 }).toBeGreaterThan(150)
  const url = await prenderCelular(app, page, ip as string, 47394)
  const pc0 = await tamPc(page)
  test.info().annotations.push({ type: 'terminal de la PC', description: `${pc0.cols}x${pc0.rows}` })

  for (const { celu, horiz } of CELUS.flatMap((c) => [{ celu: c, horiz: false }, { celu: c, horiz: true }])) {
    const navegador = await celu.motor.launch()
    try {
      const ctx = await navegador.newContext(horiz ? devices[`${celu.nombre} landscape`] : celu.ficha)
      await ctx.addInitScript(TECLADO_FALSO)
      const cel = await ctx.newPage()
      const consola: string[] = []
      cel.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && consola.push(m.text()))
      cel.on('pageerror', (e) => consola.push(e.message))
      await cel.goto(url)
      await expect(cel.getByText('web', { exact: true })).toBeVisible()
      await cel.getByRole('button', { name: 'Abrir la terminal de web' }).click()
      const term = cel.getByRole('dialog', { name: 'web' })
      const pantalla = term.locator('.xterm-rows')
      await expect(pantalla).toContainText(/❯/, { timeout: 15_000 })
      const foto = (n: string): Promise<Buffer> => cel.screenshot({ path: test.info().outputPath(`${celu.nombre.replace(/\W/g, '')}-${horiz ? 'horizontal' : 'vertical'}-${n}.png`) })

      const escribir = async (texto: string): Promise<void> => {
        await term.locator('.xterm-screen').click()
        await cel.keyboard.insertText(texto)
        await cel.keyboard.press('Enter')
      }
      // Lo que mide la PowerShell de verdad (el PTY), no lo que cree el xterm de la PC.
      let n = 0
      const ptyReal = async (): Promise<{ cols: number; rows: number }> => {
        const marca = `m${++n}${celu.nombre.length}`
        await escribir(`$s=$Host.UI.RawUI.WindowSize; Write-Output ("${marca}-{0}x{1}-f" -f $s.Width,$s.Height)`)
        const re = new RegExp(`${marca}-(\\d+)x(\\d+)-f`)
        await expect.poll(async () => re.test((await pantalla.textContent()) ?? '')).toBe(true)
        const m = re.exec((await pantalla.textContent()) ?? '') as RegExpExecArray
        return { cols: Number(m[1]), rows: Number(m[2]) }
      }
      const igualAPc = async (donde: string): Promise<void> => {
        expect(await tamPc(page), `xterm de la PC ${donde} (${celu.nombre})`).toEqual(pc0)
        expect(await ptyReal(), `PTY ${donde} (${celu.nombre})`).toEqual(pc0)
      }

      await igualAPc('al abrir')
      // Se escribe en la propia terminal: letras, borrar y pegar.
      await term.locator('.xterm-screen').click()
      await cel.keyboard.type("Write-Output ('tipeo-' + 'XYQ")
      await cel.keyboard.press('Backspace')
      await cel.keyboard.type("')")
      await cel.keyboard.press('Enter')
      await expect(pantalla).toContainText('tipeo-XY')
      await cel.evaluate(() => {
        const ta = document.querySelector('.xterm-helper-textarea')
        const dt = new DataTransfer()
        dt.setData('text/plain', "Write-Output ('pega-' + 'do')")
        ta?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      })
      await cel.keyboard.press('Enter')
      await expect(pantalla).toContainText('pega-do')

      // Vertical, vista PC: entra todo el ancho con la letra más chica que permite el piso, o se desliza de costado.
      const medidas = async (): Promise<{ colPx: number; desliza: boolean }> =>
        cel.locator('#term-pantalla').evaluate((p, cols) => {
          const sc = p.querySelector('.xterm-screen') as HTMLElement
          return { colPx: sc.offsetWidth / cols, desliza: p.scrollWidth > p.clientWidth + 1 }
        }, pc0.cols)
      const vertical = await medidas()
            expect(vertical.colPx, 'ancho de una columna en vista PC').toBeGreaterThanOrEqual(4.2)
      await foto('1-vista-pc')
      const vistaPc = await caja(cel, '.term')
      const alto = await cel.evaluate(() => window.innerHeight)
      expect(vistaPc.top).toBeGreaterThanOrEqual(0)
      expect(vistaPc.bottom).toBeLessThanOrEqual(alto + 1)

      // Vista celu: letra grande y se recorre la pantalla de la PC, siguiendo el cursor.
      await term.getByRole('button', { name: /^Vista PC/ }).click()
      await expect(term.getByRole('button', { name: /^Vista celu/ })).toBeVisible()
      const celuVista = await medidas()
      expect(celuVista.colPx, 'ancho de una columna en vista celu').toBeGreaterThanOrEqual(7)
      expect(celuVista.desliza, 'con 200 columnas a letra grande hay scroll de costado').toBe(true)
      await escribir('Write-Output ("cursor-" + "visible")')
      const cursorVisible = async (alto: number): Promise<void> => {
        await expect
          .poll(async () => {
            const c = await cel.locator('.xterm-cursor').first().evaluate((el, limite) => {
              const r = el.getBoundingClientRect()
              const p = document.getElementById('term-pantalla') as HTMLElement
              const pr = p.getBoundingClientRect()
              return { dentro: r.left >= pr.left - 1 && r.right <= pr.right + 1 && r.top >= pr.top - 1 && r.bottom <= pr.bottom + 1, abajo: r.bottom <= limite + 1 }
            }, alto)
            return c.dentro && c.abajo
          })
          .toBe(true)
      }
      await cursorVisible(alto)
      await foto('2-vista-celu')
      await igualAPc('con vista celu')

      // Teclado virtual (ventana visible a la mitad): la terminal y la botonera quedan arriba del teclado, con el cursor a la vista.
      await cel.evaluate((h) => (window as unknown as { __teclado: (a: number) => void }).__teclado(h), Math.round(alto / 2))
      await expect.poll(async () => (await caja(cel, '.term')).bottom).toBeLessThanOrEqual(alto / 2 + 1)
      expect((await caja(cel, '[data-tecla="ctrlc"]')).bottom).toBeLessThanOrEqual(alto / 2 + 1)
      expect((await caja(cel, '#term-volver')).top).toBeGreaterThanOrEqual(0)
      await cursorVisible(alto / 2)
      await foto('3-teclado')
      await cel.evaluate(() => (window as unknown as { __teclado: (a: number | null) => void }).__teclado(null))
      await expect.poll(async () => (await caja(cel, '.term')).bottom).toBeGreaterThanOrEqual(alto - 1)

      if (horiz) {
        expect(await caja(cel, '.term'), 'acostado, la terminal ocupa la ventana').toMatchObject({ top: 0, left: 0 })
        await igualAPc('acostado')
      } else {
        // Girar el celu con la terminal abierta: la vista se recalcula sola y se recuerda por orientación (acostado arranca en vista PC).
        await medida(ctx, cel, celu.motor.name(), celu.ficha.viewport.height, celu.ficha.viewport.width)
        await expect(term.getByRole('button', { name: /^Vista PC/ })).toBeVisible()
        const girado = await medidas()
        expect(girado.colPx, 'acostado entra con letra igual o más grande').toBeGreaterThanOrEqual(vertical.colPx - 0.01)
        const ancho = await cel.evaluate(() => window.innerWidth)
        expect((await caja(cel, '.term')).right).toBeLessThanOrEqual(ancho + 1)
        await medida(ctx, cel, celu.motor.name(), celu.ficha.viewport.width, celu.ficha.viewport.height)
        await expect(term.getByRole('button', { name: /^Vista celu/ })).toBeVisible()
        await term.getByRole('button', { name: 'Volver a las sesiones' }).click()
        await expect(term).toBeHidden()
        await cel.getByRole('button', { name: 'Abrir la terminal de web' }).click()
        await expect(pantalla).toContainText('cursor-visible', { timeout: 15_000 })
        await igualAPc('al reabrir')
      }
      expect(consola, `consola de ${celu.nombre}`).toEqual([])
      await ctx.close()
    } finally {
      await navegador.close()
    }
  }
  expect(await tamPc(page), 'la terminal de la PC al final').toEqual(pc0)
})
