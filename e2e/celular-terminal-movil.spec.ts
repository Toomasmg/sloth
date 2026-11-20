import { readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { chromium, devices, webkit, type BrowserContext, type Page } from '@playwright/test'
import { test, expect } from './sloth'
import { shellReady } from './terminal'
import { elegirIp } from '../src/main/features/celular-core'

/**
 * La terminal desde el celu, de punta a punta con celus simulados (sin capturas). El Galaxy va en Chromium y el
 * iPhone en WebKit: no son un teléfono real (no prueban el teclado virtual de verdad ni el rendimiento de un celu lento).
 */
test.use({ seed: { workspaces: [{ id: 'ws-web', name: 'web', open: true }] } })

const ip = elegirIp(networkInterfaces())

const CELUS = [
  { nombre: 'Galaxy S9+', motor: chromium, ficha: devices['Galaxy S9+'] },
  { nombre: 'iPhone 13', motor: webkit, ficha: devices['iPhone 13'] }
]

interface Registro {
  consola: string[]
  fallos: string[]
  /** Pedidos de /api/terminal que la propia página cortó: el «mirar» abierto al cerrar la terminal. */
  cortados: string[]
  estados: Record<string, number[]>
  mayor: number
}

function vigilar(p: Page): Registro {
  const r: Registro = { consola: [], fallos: [], cortados: [], estados: {}, mayor: 0 }
  p.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') r.consola.push(`${m.type()}: ${m.text()}`)
  })
  p.on('pageerror', (e) => r.consola.push(`pageerror: ${e.message}`))
  p.on('requestfailed', (q) => {
    if (q.url().includes('fonts.g')) return
    const motivo = `${q.url()} ${q.failure()?.errorText}`
    // Al cerrar la terminal la página corta el «mirar» que la PC tiene abierto: no es un fallo. Cualquier otro sí.
    if (new URL(q.url()).pathname === '/api/terminal' && /ERR_ABORTED|cancel/i.test(q.failure()?.errorText ?? '')) r.cortados.push(motivo)
    else r.fallos.push(motivo)
  })
  p.on('response', (s) => {
    const ruta = new URL(s.url()).pathname
    ;(r.estados[ruta] ??= []).push(s.status())
    if (ruta === '/api/terminal') void s.body().then((b) => (r.mayor = Math.max(r.mayor, b.length)), () => undefined)
  })
  return r
}

// Chromium no deja cambiar el tamaño de la ventana en emulación móvil con setViewportSize: se hace por el protocolo.
async function medida(ctx: BrowserContext, p: Page, motor: string, width: number, height: number): Promise<void> {
  if (motor !== 'chromium') return p.setViewportSize({ width, height })
  const cdp = await ctx.newCDPSession(p)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true })
}

test('Celular movil: la terminal anda en un Galaxy y un iPhone simulados, con salida grande y teclado virtual', async ({ sloth: { app, page } }) => {
  test.skip(!ip, 'Esta PC no tiene una red privada: no hay dónde abrir el servidor.')
  test.setTimeout(300_000)
  await shellReady(page)
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'))
  const clave = (JSON.parse(readFileSync(join(userData, 'perfiles', 'principal', 'features', 'celular.json'), 'utf8')) as { clave: string }).clave
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox').first().fill('Ver Sloth en el celular')
  await page.keyboard.press('Enter')
  const panel = page.getByRole('dialog', { name: 'Celular' })
  await panel.getByLabel('Puerto').fill('47391')
  await panel.getByRole('button', { name: 'Guardar' }).first().click()
  await panel.getByRole('switch', { name: 'Ver Sloth en el celu' }).click()
  await expect(panel.getByRole('img', { name: /Código QR/ })).toBeVisible()
  const url = `http://${ip}:47391/#k=${clave}`

  // Sin la terminal prendida no hay botón; al prenderla aparece sola.
  const navegadorSin = await chromium.launch()
  try {
    const celSin = await (await navegadorSin.newContext(devices['Galaxy S9+'])).newPage()
    await celSin.goto(url)
    await expect(celSin.getByText('web', { exact: true })).toBeVisible()
    await expect(celSin.getByRole('button', { name: /terminal de web/i })).toHaveCount(0)
    await panel.getByRole('switch', { name: 'Abrir las terminales desde el celu' }).click()
    await expect(celSin.getByRole('button', { name: 'Abrir la terminal de web' })).toBeVisible()
  } finally {
    await navegadorSin.close()
  }

  for (const celu of CELUS) {
    const navegador = await celu.motor.launch()
    try {
      const ctx = await navegador.newContext(celu.ficha)
      const cel = await ctx.newPage()
      const reg = vigilar(cel)
      await cel.goto(url)
      await expect(cel.getByText('web', { exact: true })).toBeVisible()
      await cel.getByRole('button', { name: 'Abrir la terminal de web' }).click()
      const term = cel.getByRole('dialog', { name: 'web' })
      await expect(term).toBeVisible()
      const pantalla = term.locator('.xterm-rows')
      await expect(pantalla).toContainText(/shell-lista|fin-grande/, { timeout: 15_000 })

      const escribir = async (texto: string): Promise<void> => {
        await term.getByLabel('Texto para la terminal').fill(texto)
        await term.getByRole('button', { name: 'Enviar' }).click()
      }
      const marca = `celu-escribe-${celu.nombre.length}`
      const veces = async (): Promise<number> => ((await pantalla.textContent()) ?? '').split(marca).length - 1
      await escribir(`Write-Output ('celu-' + 'escribe-' + '${celu.nombre.length}')`)
      await expect.poll(veces).toBe(1)

      // Las teclas llegan a la PC: ↑ trae el comando anterior y Enter lo corre; Ctrl C corta lo que está andando.
      await term.getByRole('button', { name: 'Flecha arriba' }).click()
      await term.getByRole('button', { name: 'Enter' }).click()
      await expect.poll(veces).toBe(2)
      await escribir('Start-Sleep 60')
      await term.getByRole('button', { name: 'Control C' }).click()
      await escribir("Write-Output ('tras-' + 'cc')")
      await expect(pantalla).toContainText('tras-cc', { timeout: 10_000 })
      for (const tecla of ['Tab', 'Esc', 'Flecha izquierda', 'Flecha derecha', 'Flecha abajo']) await term.getByRole('button', { name: tecla }).click()

      // Salida grande, como la de una sesión de Claude Code: un color distinto por letra, miles de ESC.
      await escribir("$e=[char]27; 1..2000 | % { -join (1..20 | % { \"$e[3$($_ % 7 + 1)mx\" }) }; Write-Output ('fin-' + 'grande')")
      await expect(pantalla).toContainText('fin-grande', { timeout: 30_000 })

      // Reabrir con ese historial: la foto inicial pesa lo que pesa el visor.
      await term.getByRole('button', { name: 'Volver a las sesiones' }).click()
      await expect(term).toBeHidden()
      await cel.getByRole('button', { name: 'Abrir la terminal de web' }).click()
      await expect(cel.getByRole('dialog', { name: 'web' }).locator('.xterm-rows')).toContainText('fin-grande', { timeout: 15_000 })
      await expect(cel.locator('#term-aviso')).toBeHidden()
      expect(reg.mayor, `la respuesta más grande que vio ${celu.nombre}`).toBeLessThan(200_000)
      test.info().annotations.push({ type: `respuesta mayor de ${celu.nombre}`, description: String(reg.mayor) })

      // Teclado virtual: la ventana visible se achica a la mitad; después, el celu acostado.
      const entrada = cel.getByRole('dialog', { name: 'web' }).getByLabel('Texto para la terminal')
      await medida(ctx, cel, celu.motor.name(), celu.ficha.viewport.width, Math.round(celu.ficha.viewport.height / 2))
      await expect(entrada).toBeVisible()
      await medida(ctx, cel, celu.motor.name(), celu.ficha.viewport.height, celu.ficha.viewport.width)
      await expect(entrada).toBeVisible()

      // «Ajustar al celu» y volver.
      await cel.getByRole('button', { name: 'Ajustar al celu' }).click()
      await expect(cel.getByRole('button', { name: 'Tamaño de la PC' })).toBeVisible()
      await cel.getByRole('button', { name: 'Volver a las sesiones' }).click()
      await expect(cel.getByRole('dialog', { name: 'web' })).toBeHidden()

      expect(reg.consola, `consola de ${celu.nombre}`).toEqual([])
      expect(reg.fallos, `pedidos fallidos de ${celu.nombre}`).toEqual([])
      expect(reg.cortados.length, `«mirar» cortados de ${celu.nombre}: uno por cada vez que se cerró la terminal`).toBeLessThanOrEqual(2)
      expect(reg.estados['/xterm.js']).toEqual([200])
      expect(reg.estados['/xterm.css']).toEqual([200])
      await ctx.close()
    } finally {
      await navegador.close()
    }
  }

  // Con «Desde cualquier red» (la página remota define slothFetch) el botón está pero apagado, y la nota dice cómo.
  const navegador = await chromium.launch()
  try {
    const ctx = await navegador.newContext(devices['Galaxy S9+'])
    await ctx.addInitScript(() => {
      const ahora = Date.now()
      ;(window as unknown as { slothFetch: () => Promise<unknown> }).slothFetch = () =>
        Promise.resolve({
          status: 200,
          ok: true,
          json: () => Promise.resolve({ ahora, aprobar: false, terminal: false, terminalEnWifi: true, cuentas: [], pedidos: [], sesiones: [{ id: 'ws-web', nombre: 'web', cuentaId: 'x', estado: 'idle', desde: ahora }] })
        })
    })
    const cel = await ctx.newPage()
    const reg = vigilar(cel)
    await cel.goto(url)
    await expect(cel.getByText('web', { exact: true })).toBeVisible()
    await expect(cel.getByRole('button', { name: /Terminal de web: escaneá el QR del Wi-Fi/ })).toBeDisabled()
    await expect(cel.locator('#term-nota')).toContainText('Escaneá el QR del Wi-Fi de casa')
    expect(reg.consola).toEqual([])
  } finally {
    await navegador.close()
  }
})
