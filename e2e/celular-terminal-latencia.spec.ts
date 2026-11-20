import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { chromium, devices, webkit, type BrowserContext, type ElectronApplication, type Page } from '@playwright/test'
import { test, expect } from './sloth'
import { shellReady } from './terminal'
import { elegirIp } from '../src/main/features/celular-core'

/**
 * Banco de latencia de la terminal desde el celu (sin capturas). Mide en celus simulados: sirve para comparar antes y
 * después de un cambio en la misma PC, no como número absoluto de un teléfono real.
 *   SLOTH_BANCO=base: solo escribe test-results/banco-celu.json. Sin ella, además asierta METAS.
 *
 * Línea base (rama sin cambios de rendimiento, Galaxy S9+ en Chromium / iPhone 13 en WebKit, esta PC):
 *   eco p50/p95 (ms), CPU x1:           Galaxy 177 / 190      iPhone 190 / 210
 *   eco p50/p95 (ms), CPU x4 + 20 ms:   Galaxy 237 / 276
 *   primera pantalla (2000 líneas, ms): Galaxy 114.5 (abrirRespuesta 27.6)   iPhone 256 (abrirRespuesta 43)
 *   reposo 60 s:                        166 pedidos/min y ~33 KB/min en los dos
 *   sello en Node (scripts/bench-sello.mjs), p50 ms: sellarPedido 0.06; abrirRespuesta 1 KB 0.38, 20 KB 7.4, 120 KB 45
 */
test.use({ seed: { workspaces: [{ id: 'ws-web', name: 'web', open: true }] } })

export const METAS = { ecoP50: 100, ecoP95: 250, ecoP50Cpu4: 160, primeraPantallaVsBase: 0.7, reposoPedidosMin: 4, reposoBytesMin: 2048 }

// Primera pantalla de la base en ms, medida en esta PC con el mismo escenario; la meta es METAS.primeraPantallaVsBase de esto.
const PRIMERA_PANTALLA_BASE_MS: Record<string, number> = { 'Galaxy S9+': 114.5, 'iPhone 13': 256 }

const SOLO_BASE = process.env.SLOTH_BANCO === 'base'
const ip = elegirIp(networkInterfaces())
const PUERTO = '47392'

const CELUS = [
  { nombre: 'Galaxy S9+', motor: chromium, ficha: devices['Galaxy S9+'] },
  { nombre: 'iPhone 13', motor: webkit, ficha: devices['iPhone 13'] }
]

// 30 caracteres distintos y raros en un prompt, para saber cuándo aparece cada uno sin depender de lo que ya hubiera en pantalla.
const TECLAS = '!#%&*+,=?@^~QZXJKWVqzxjkwv<>|()'

export function percentil(xs: number[], p: number): number {
  const o = [...xs].sort((a, b) => a - b)
  return o[Math.max(0, Math.min(o.length - 1, Math.ceil(p * o.length) - 1))]
}

const redondear = (n: number): number => Math.round(n * 10) / 10

function guardar(clave: string, valor: unknown): void {
  const ruta = join('test-results', 'banco-celu.json')
  let todo: Record<string, unknown> = {}
  try {
    todo = JSON.parse(readFileSync(ruta, 'utf8')) as Record<string, unknown>
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  todo[clave] = valor
  mkdirSync(dirname(ruta), { recursive: true })
  writeFileSync(ruta, JSON.stringify(todo, null, 2))
}

async function prepararPC(app: ElectronApplication, page: Page): Promise<string> {
  await shellReady(page)
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'))
  const clave = (JSON.parse(readFileSync(join(userData, 'perfiles', 'principal', 'features', 'celular.json'), 'utf8')) as { clave: string }).clave
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox').first().fill('Ver Sloth en el celular')
  await page.keyboard.press('Enter')
  const panel = page.getByRole('dialog', { name: 'Celular' })
  await panel.getByLabel('Puerto').fill(PUERTO)
  await panel.getByRole('button', { name: 'Guardar' }).first().click()
  await panel.getByRole('switch', { name: 'Ver Sloth en el celu' }).click()
  await expect(panel.getByRole('img', { name: /Código QR/ })).toBeVisible()
  await panel.getByRole('switch', { name: 'Abrir las terminales desde el celu' }).click()
  return `http://${ip}:${PUERTO}/#k=${clave}`
}

interface Sello {
  llamadas: number
  ms: number
  mayor: number
}

// Envuelve window.slothSello.abrirRespuesta apenas la página lo define, para sumar lo que tarda abrir cada respuesta.
async function medirSello(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(() => {
    const w = window as unknown as { __sello: Sello; slothSello?: { abrirRespuesta: (...a: unknown[]) => unknown } }
    w.__sello = { llamadas: 0, ms: 0, mayor: 0 }
    let real: typeof w.slothSello
    Object.defineProperty(window, 'slothSello', {
      configurable: true,
      get: () => real,
      set: (v: typeof w.slothSello) => {
        if (v && typeof v.abrirRespuesta === 'function') {
          const orig = v.abrirRespuesta
          v.abrirRespuesta = (...a: unknown[]) => {
            const t = performance.now()
            const r = orig.apply(v, a)
            const dt = performance.now() - t
            w.__sello.llamadas++
            w.__sello.ms += dt
            w.__sello.mayor = Math.max(w.__sello.mayor, dt)
            return r
          }
        }
        real = v
      }
    })
  })
}

interface Abierto {
  ctx: BrowserContext
  cel: Page
  term: ReturnType<Page['getByRole']>
  pantalla: ReturnType<Page['locator']>
  cerrar: () => Promise<void>
}

async function abrirCelu(url: string, celu: (typeof CELUS)[number], conSello = false): Promise<Abierto> {
  const navegador = await celu.motor.launch()
  const ctx = await navegador.newContext(celu.ficha)
  if (conSello) await medirSello(ctx)
  const cel = await ctx.newPage()
  await cel.goto(url)
  await expect(cel.getByText('web', { exact: true })).toBeVisible()
  await cel.getByRole('button', { name: 'Abrir la terminal de web' }).click()
  const term = cel.getByRole('dialog', { name: 'web' })
  await expect(term).toBeVisible()
  const pantalla = term.locator('.xterm-rows')
  await expect(pantalla).toContainText(/shell-lista|fin-grande/, { timeout: 15_000 })
  return { ctx, cel, term, pantalla, cerrar: () => navegador.close() }
}

interface Eco {
  enviadas: number
  perdidas: number
  p50: number
  p95: number
  max: number
}

async function medirEco(cel: Page): Promise<Eco> {
  await cel.evaluate(() => {
    const filas = document.querySelector('.xterm-rows')
    if (!filas) throw new Error('sin .xterm-rows')
    const cuenta = (t: string, c: string): number => t.split(c).length - 1
    const est = { base: {} as Record<string, number>, pend: [] as { c: string; t: number }[], lat: [] as number[], enviadas: 0 }
    ;(window as unknown as { __eco: typeof est }).__eco = est
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key.length !== 1) return
        est.base[e.key] = cuenta(filas.textContent ?? '', e.key)
        est.pend.push({ c: e.key, t: performance.now() })
        est.enviadas++
      },
      true
    )
    new MutationObserver(() => {
      const ahora = performance.now()
      const txt = filas.textContent ?? ''
      est.pend = est.pend.filter((p) => {
        if (cuenta(txt, p.c) <= est.base[p.c]) return true
        est.lat.push(ahora - p.t)
        return false
      })
    }).observe(filas, { subtree: true, childList: true, characterData: true })
  })
  await cel.locator('.xterm-helper-textarea').focus()
  for (const c of TECLAS) {
    await cel.keyboard.type(c)
    await cel.waitForTimeout(120)
  }
  const sinPendientes = (): Promise<number> => cel.evaluate(() => (window as unknown as { __eco: { pend: unknown[] } }).__eco.pend.length)
  await expect.poll(sinPendientes, { timeout: 8_000 }).toBe(0).catch(() => undefined)
  const { lat, enviadas, pend } = await cel.evaluate(() => {
    const e = (window as unknown as { __eco: { lat: number[]; enviadas: number; pend: unknown[] } }).__eco
    return { lat: e.lat, enviadas: e.enviadas, pend: e.pend.length }
  })
  expect(enviadas, 'teclas que vio la página').toBeGreaterThanOrEqual(TECLAS.length - 2)
  expect(lat.length, 'ecos medidos').toBeGreaterThan(0)
  return { enviadas, perdidas: pend, p50: redondear(percentil(lat, 0.5)), p95: redondear(percentil(lat, 0.95)), max: redondear(Math.max(...lat)) }
}

for (const celu of CELUS) {
  test(`Latencia ${celu.nombre}: eco de lo que se escribe, CPU x1`, async ({ sloth: { app, page } }) => {
    test.skip(!ip, 'Esta PC no tiene una red privada: no hay dónde abrir el servidor.')
    test.setTimeout(240_000)
    const url = await prepararPC(app, page)
    const abierto = await abrirCelu(url, celu)
    try {
      const eco = await medirEco(abierto.cel)
      guardar(`${celu.nombre} eco x1`, eco)
      await test.info().attach('banco', { body: JSON.stringify(eco, null, 2), contentType: 'application/json' })
      if (!SOLO_BASE) {
        expect(eco.p50, 'eco p50 ms').toBeLessThanOrEqual(METAS.ecoP50)
        expect(eco.p95, 'eco p95 ms').toBeLessThanOrEqual(METAS.ecoP95)
      }
    } finally {
      await abierto.cerrar()
    }
  })
}

test('Latencia Galaxy S9+: eco con CPU x4 y red con 20 ms de latencia', async ({ sloth: { app, page } }) => {
  test.skip(!ip, 'Esta PC no tiene una red privada: no hay dónde abrir el servidor.')
  test.setTimeout(240_000)
  const url = await prepararPC(app, page)
  const abierto = await abrirCelu(url, CELUS[0])
  try {
    const cdp = await abierto.ctx.newCDPSession(abierto.cel)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: -1, uploadThroughput: -1 })
    const eco = await medirEco(abierto.cel)
    guardar('Galaxy S9+ eco cpu4 red20', eco)
    await test.info().attach('banco', { body: JSON.stringify(eco, null, 2), contentType: 'application/json' })
    if (!SOLO_BASE) expect(eco.p50, 'eco p50 ms con CPU x4').toBeLessThanOrEqual(METAS.ecoP50Cpu4)
  } finally {
    await abierto.cerrar()
  }
})

for (const celu of CELUS) {
  test(`Latencia ${celu.nombre}: primera pantalla con 2000 líneas coloreadas`, async ({ sloth: { app, page } }) => {
    test.skip(!ip, 'Esta PC no tiene una red privada: no hay dónde abrir el servidor.')
    test.setTimeout(240_000)
    const url = await prepararPC(app, page)
    const abierto = await abrirCelu(url, celu, true)
    try {
      const { cel, term, pantalla } = abierto
      await term.getByLabel('Texto para la terminal').fill("$e=[char]27; 1..2000 | % { -join (1..20 | % { \"$e[3$($_ % 7 + 1)mx\" }) }; Write-Output ('fin-' + 'grande')")
      await term.getByRole('button', { name: 'Enviar' }).click()
      await expect(pantalla).toContainText('fin-grande', { timeout: 60_000 })
      await term.getByRole('button', { name: 'Volver a las sesiones' }).click()
      await expect(term).toBeHidden()

      // Página nueva: xterm sin historial viejo, como cuando se abre la terminal por primera vez desde el celu.
      await cel.reload()
      await expect(cel.getByRole('button', { name: 'Abrir la terminal de web' })).toBeVisible()
      await cel.evaluate(() => {
        const est = { t0: 0, t1: 0 }
        ;(window as unknown as { __pp: typeof est }).__pp = est
        document.addEventListener('click', () => (est.t0 = performance.now()), true)
        const mirar = (): void => {
          const filas = document.querySelector('.xterm-rows')
          if (filas?.textContent?.includes('fin-grande') && !est.t1) est.t1 = performance.now()
        }
        new MutationObserver(mirar).observe(document.body, { subtree: true, childList: true, characterData: true })
      })
      const pedidos: Promise<number>[] = []
      cel.on('response', (r) => {
        if (new URL(r.url()).pathname === '/api/terminal') pedidos.push(r.body().then((b) => b.length, () => 0))
      })
      await cel.evaluate(() => ((window as unknown as { __sello: { llamadas: number; ms: number; mayor: number } }).__sello = { llamadas: 0, ms: 0, mayor: 0 }))
      await cel.getByRole('button', { name: 'Abrir la terminal de web' }).click()
      await expect(cel.getByRole('dialog', { name: 'web' }).locator('.xterm-rows')).toContainText('fin-grande', { timeout: 30_000 })
      const { t0, t1 } = await cel.evaluate(() => (window as unknown as { __pp: { t0: number; t1: number } }).__pp)
      const sello = await cel.evaluate(() => (window as unknown as { __sello: { llamadas: number; ms: number; mayor: number } }).__sello)
      const bytes = await Promise.all(pedidos)
      const res = {
        primeraPantallaMs: redondear(t1 - t0),
        abrirRespuesta: { llamadas: sello.llamadas, totalMs: redondear(sello.ms), mayorMs: redondear(sello.mayor) },
        pedidosTerminal: bytes.length,
        bytesTerminal: bytes.reduce((a, b) => a + b, 0)
      }
      guardar(`${celu.nombre} primera pantalla`, res)
      await test.info().attach('banco', { body: JSON.stringify(res, null, 2), contentType: 'application/json' })
      const base = PRIMERA_PANTALLA_BASE_MS[celu.nombre]
      if (!SOLO_BASE && base) expect(res.primeraPantallaMs, 'primera pantalla ms').toBeLessThanOrEqual(base * METAS.primeraPantallaVsBase)
    } finally {
      await abierto.cerrar()
    }
  })
}

for (const celu of CELUS) {
  test(`Latencia ${celu.nombre}: reposo de 60 s con la terminal abierta`, async ({ sloth: { app, page } }) => {
    test.skip(!ip, 'Esta PC no tiene una red privada: no hay dónde abrir el servidor.')
    test.setTimeout(240_000)
    const url = await prepararPC(app, page)
    const abierto = await abrirCelu(url, celu)
    try {
      const { cel } = abierto
      await cel.waitForTimeout(3_000)
      let pedidos = 0
      const bytes: Promise<number>[] = []
      cel.on('request', (q) => {
        if (new URL(q.url()).pathname === '/api/terminal') pedidos++
      })
      cel.on('response', (r) => {
        if (new URL(r.url()).pathname === '/api/terminal') bytes.push(r.body().then((b) => b.length, () => 0))
      })
      const MS = 60_000
      await cel.waitForTimeout(MS)
      const total = (await Promise.all(bytes)).reduce((a, b) => a + b, 0)
      const minutos = MS / 60_000
      const res = { pedidosMin: redondear(pedidos / minutos), bytesMin: Math.round(total / minutos) }
      guardar(`${celu.nombre} reposo`, res)
      await test.info().attach('banco', { body: JSON.stringify(res, null, 2), contentType: 'application/json' })
      if (!SOLO_BASE) {
        expect(res.pedidosMin, 'pedidos por minuto en reposo').toBeLessThanOrEqual(METAS.reposoPedidosMin)
        expect(res.bytesMin, 'bytes por minuto en reposo').toBeLessThanOrEqual(METAS.reposoBytesMin)
      }
    } finally {
      await abierto.cerrar()
    }
  })
}
