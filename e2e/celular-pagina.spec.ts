import { chromium, devices, expect, test, webkit, type Browser, type BrowserContextOptions, type Page } from '@playwright/test'
import type { EstadoCelular, SesionCelular } from '../src/shared/celular'
import { crearFuenteWifi } from '../src/main/features/celular-servidor'
import { pedidoParaCelu } from '../src/main/features/celular-core'

/**
 * La página del celu sola, sin Sloth: el servidor del Wi-Fi con un estado armado a mano, abierto en un celu
 * simulado. Prueba qué queda a la vista y en qué orden; las capturas quedan en la salida del test para mirarlas.
 */

const CLAVE = Buffer.alloc(32, 5).toString('base64url')
const MIN = 60_000

let estado: EstadoCelular
const decisiones: string[] = []
const fuente = crearFuenteWifi({
  host: '127.0.0.1',
  puerto: 0,
  proveedor: {
    estado: async () => ({ ...estado, ahora: Date.now() }),
    decidir: (id, d) => {
      decisiones.push(`${id}:${d}`)
      estado = { ...estado, pedidos: estado.pedidos.filter((p) => p.id !== id) }
    },
    puedeAprobar: () => estado.aprobar,
    clave: () => CLAVE,
    icono: () => null,
    terminal: async () => ({ status: 403, error: 'apagada' }),
    xterm: () => null
  }
})

test.beforeAll(() => fuente.iniciar())
test.afterAll(() => fuente.detener())
test.beforeEach(() => {
  decisiones.length = 0
})

const url = (): string => `http://127.0.0.1:${fuente.puerto()}/#k=${CLAVE}`

const sesion = (id: string, estadoSesion: SesionCelular['estado'], over: Partial<SesionCelular> = {}): SesionCelular => ({
  id,
  nombre: id,
  cuentaId: 'a',
  estado: estadoSesion,
  desde: Date.now() - 3 * MIN,
  ...over
})

const cuenta = (id: string, nombre: string, pct5: number | null, pctSem: number | null): EstadoCelular['cuentas'][number] => ({
  id,
  nombre,
  cincoHoras: pct5 === null ? null : { pct: pct5, reiniciaEn: Date.now() + 94 * MIN },
  semana: pctSem === null ? null : { pct: pctSem, reiniciaEn: Date.now() + 3 * 24 * 60 * MIN },
  limitesLeidosEn: Date.now(),
  hoy: { tokens: 12_400_000, mensajes: 31 }
})

const BASE: EstadoCelular = { ahora: 0, aprobar: true, terminal: false, cuentas: [cuenta('a', 'Personal', 72, 31)], sesiones: [], pedidos: [] }

const pedido = (id: string, ses: string, command: string): EstadoCelular['pedidos'][number] => ({
  id,
  sesionId: ses,
  sesion: ses,
  ...pedidoParaCelu('Bash', { command }),
  desde: Date.now() - MIN,
  vence: Date.now() + 10 * MIN
})

const MENSAJE = 'Claude necesita que elijas: ¿migro la tabla de usuarios ahora o espero a que termine la importación de la noche? Respondé 1 o 2.'

const MOTORES = [
  { nombre: 'Galaxy', motor: chromium, ficha: { ...devices['Galaxy S9+'], viewport: { width: 360, height: 740 } } },
  { nombre: 'iPhone', motor: webkit, ficha: devices['iPhone 13'] }
]

async function abrir(navegador: Browser, ficha: BrowserContextOptions): Promise<{ page: Page; externos: string[] }> {
  const ctx = await navegador.newContext(ficha)
  const page = await ctx.newPage()
  const externos: string[] = []
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1')) externos.push(r.url())
  })
  const errores: string[] = []
  page.on('pageerror', (e) => errores.push(e.message))
  await page.goto(url())
  await expect(page.getByText('PC conectada')).toBeVisible()
  expect(errores).toEqual([])
  return { page, externos }
}

const arriba = async (page: Page, sel: string): Promise<number> => (await page.locator(sel).boundingBox())?.y ?? Infinity

for (const m of MOTORES) {
  test(`Celu (${m.nombre}): una pregunta de Claude sin permiso va arriba con el mensaje entero, sin «Nada te espera»`, async () => {
    estado = { ...BASE, sesiones: [sesion('api', 'waiting', { detalle: MENSAJE }), sesion('web', 'working'), sesion('docs', 'done')] }
    const navegador = await m.motor.launch()
    try {
      const { page, externos } = await abrir(navegador, m.ficha)
      const tarjeta = page.locator('#esperan li')
      await expect(tarjeta).toHaveCount(1)
      await expect(tarjeta).toContainText(MENSAJE)
      await expect(tarjeta).toContainText('Respondé en la PC.')
      await expect(page.getByText('Nada te espera')).toBeHidden()
      await expect(page.locator('#n-espera')).toHaveText('1')
      // Lo que espera tiene que verse sin bajar, antes que los límites.
      const caja = await tarjeta.boundingBox()
      const alto = page.viewportSize()?.height ?? 0
      expect(caja && caja.y + caja.height).toBeLessThan(alto)
      expect(await arriba(page, '#esperan')).toBeLessThan(await arriba(page, '#limites'))
      await page.screenshot({ path: test.info().outputPath('pregunta.png') })
      expect(externos, 'sin hosts de afuera').toEqual([])
    } finally {
      await navegador.close()
    }
  })
}

test('Celu: el pedido de permiso queda en la primera pantalla de 360×740, con los botones a la vista', async () => {
  estado = {
    ...BASE,
    sesiones: Array.from({ length: 18 }, (_, i) => sesion(`espacio-${i}`, i === 0 ? 'waiting' : i % 3 ? 'working' : 'idle')),
    pedidos: [pedido('p1', 'espacio-0', 'npm test')]
  }
  const navegador = await chromium.launch()
  try {
    const { page } = await abrir(navegador, MOTORES[0].ficha)
    const aprobar = page.getByRole('button', { name: 'Aprobar' })
    await expect(aprobar).toBeInViewport({ ratio: 1 })
    await expect(page.getByRole('button', { name: 'Rechazar' })).toBeInViewport({ ratio: 1 })
    await expect(page.locator('#esperan li')).toHaveCount(0)
    await aprobar.click()
    await expect.poll(() => decisiones).toEqual(['p1:allow'])
    await expect(page.locator('#pedidos li')).toHaveCount(0)
    await expect(page.locator('#respondidos')).toContainText(/✓ Aprobaste a las \d\d:\d\d · espacio-0 · npm test/)
  } finally {
    await navegador.close()
  }
})

test('Celu: con varias cuentas los límites de todas se ven juntos y la cuenta y los contadores filtran la lista', async () => {
  estado = {
    ...BASE,
    cuentas: [cuenta('a', 'Personal', 72, 31), cuenta('b', 'Trabajo', 94, 55), cuenta('c', 'Proyectos-Personales-Largos', null, null)],
    sesiones: [
      sesion('api', 'waiting', { cuentaId: 'b', detalle: '¿Sigo?' }),
      sesion('web', 'working', { cuentaId: 'a' }),
      sesion('docs', 'done', { cuentaId: 'a' }),
      sesion('infra', 'working', { cuentaId: 'b' })
    ]
  }
  const navegador = await chromium.launch()
  try {
    const { page } = await abrir(navegador, MOTORES[0].ficha)
    const cuentas = page.getByRole('group', { name: 'Cuenta' })
    await expect(cuentas.getByRole('button', { name: 'Todas' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('#limites .lim')).toHaveCount(3)
    await expect(page.getByRole('img', { name: /^Trabajo\. Límite de 5 horas: 94 % usado/ })).toBeVisible()
    await expect(page.locator('#lista li')).toHaveCount(4)
    await expect(page.locator('#lista li').filter({ hasText: 'web' })).toContainText('Personal')
    await page.screenshot({ path: test.info().outputPath('todas.png'), fullPage: true })

    await cuentas.getByRole('button', { name: 'Personal', exact: true }).click()
    await expect(page.locator('#lista li')).toHaveCount(2)
    await expect(page.locator('#lista li').filter({ hasText: 'web' })).not.toContainText('Personal')
    await expect(page.locator('#limites .lim')).toHaveCount(1)
    await expect(page.locator('#limites .lim-pie')).toContainText(/5 h reinicia en 1 h 3\d min/)
    await expect(page.locator('#n-espera')).toHaveText('0')
    await expect(page.locator('#resumen')).toHaveText('2 de 4 abiertas')
    // Lo urgente no se filtra: la pregunta de la otra cuenta sigue arriba, con el nombre de su cuenta.
    await expect(page.locator('#esperan li')).toContainText('Trabajo')

    await cuentas.getByRole('button', { name: 'Todas' }).click()
    const trabajando = page.getByRole('button', { name: /Trabajando/ })
    await trabajando.click()
    await expect(trabajando).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('#lista li')).toHaveCount(2)
    await expect(page.locator('#resumen')).toHaveText('2 de 4 abiertas')
    await trabajando.click()
    await expect(trabajando).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('#lista li')).toHaveCount(4)

    await cuentas.getByRole('button', { name: 'Personal', exact: true }).click()
    await page.getByRole('button', { name: /Te necesita/ }).click()
    await expect(page.locator('#lista li')).toHaveText(['Ninguna sesión en «Te necesita» en esta cuenta.'])
  } finally {
    await navegador.close()
  }
})

test('Celu: acostado vuelven los relojes (de la cuenta más cerca del límite) y lo que espera queda en el medio', async () => {
  estado = {
    ...BASE,
    cuentas: [cuenta('a', 'Personal', 31, 20), cuenta('b', 'Trabajo', 88, 55)],
    sesiones: [sesion('api', 'waiting', { cuentaId: 'b', detalle: MENSAJE }), sesion('web', 'working'), sesion('docs', 'done')]
  }
  const navegador = await chromium.launch()
  try {
    const { page } = await abrir(navegador, devices['Galaxy S9+ landscape'])
    await expect(page.locator('#limites')).toBeHidden()
    await expect(page.locator('#g5 svg')).toBeVisible()
    await expect(page.locator('#g5 .pie')).toContainText('Trabajo · Reinicia en')
    await expect(page.locator('#esperan li')).toBeInViewport({ ratio: 1 })
    // El rótulo del reloj queda debajo del porcentaje, fuera del recorrido de la aguja.
    const rotulo = await page.locator('#g5 svg text').first().boundingBox()
    const pct = await page.locator('#g5 svg text').nth(1).boundingBox()
    expect(rotulo && pct && rotulo.y).toBeGreaterThan((pct?.y ?? 0) + (pct?.height ?? 0) - 4)
    await page.screenshot({ path: test.info().outputPath('acostado.png') })
  } finally {
    await navegador.close()
  }
})

test('Celu: varios pedidos se ven todos y se responde cualquiera, no solo el primero', async () => {
  estado = {
    ...BASE,
    sesiones: ['a', 'b', 'c', 'd', 'e'].map((x) => sesion(`ws-${x}`, 'waiting')),
    pedidos: ['a', 'b', 'c', 'd', 'e'].map((x, i) => pedido(`p-${x}`, `ws-${x}`, `npm run tarea-${i}`))
  }
  const navegador = await chromium.launch()
  try {
    const { page } = await abrir(navegador, MOTORES[0].ficha)
    const tarjetas = page.locator('#pedidos li')
    await expect(tarjetas).toHaveCount(5)
    await expect(tarjetas.nth(2)).toContainText('3 de 5')
    await expect(page.locator('#aviso-nuevo')).toHaveText('5 pedidos de permiso nuevos.')
    await tarjetas.nth(2).getByRole('button', { name: 'Rechazar' }).click()
    await expect.poll(() => decisiones).toEqual(['p-c:deny'])
    await expect(tarjetas).toHaveCount(4)
    await expect(page.locator('#respondidos li')).toHaveText([/✕ Rechazaste a las .* · ws-c · npm run tarea-2/])
    await page.screenshot({ path: test.info().outputPath('varios.png'), fullPage: true })
  } finally {
    await navegador.close()
  }
})

test('Celu: un pedido destructivo se marca y se aprueba con dos toques; uno largo se mira entero antes', async () => {
  const largo = 'npm ci && ' + 'echo paso-intermedio && '.repeat(20) + 'git push --force origin main'
  estado = { ...BASE, sesiones: [sesion('api', 'waiting'), sesion('web', 'waiting')], pedidos: [pedido('p1', 'api', 'rm -rf node_modules'), pedido('p2', 'web', largo)] }
  const navegador = await chromium.launch()
  try {
    const { page } = await abrir(navegador, MOTORES[0].ficha)
    const rm = page.locator('#pedidos li').first()
    await expect(rm.getByText(/^Destructivo: /)).toBeVisible()
    await expect(rm.locator('pre')).toHaveText('rm -rf node_modules')
    await rm.getByRole('button', { name: 'Aprobar' }).click()
    await expect(rm.getByRole('button', { name: 'Tocá de nuevo para aprobar' })).toBeVisible()
    await page.waitForTimeout(500)
    expect(decisiones, 'el primer toque no aprueba').toEqual([])
    await page.screenshot({ path: test.info().outputPath('destructivo.png') })
    await rm.getByRole('button', { name: 'Tocá de nuevo para aprobar' }).click()
    await expect.poll(() => decisiones).toEqual(['p1:allow'])

    const push = page.locator('#pedidos li').first()
    await expect(push).toContainText('web')
    await expect(push.getByText(/^Destructivo: /)).toBeVisible()
    await expect(push.getByRole('button', { name: 'Aprobar' })).toBeDisabled()
    await expect(push.locator('pre')).toHaveText(largo)
    await expect(push.locator('pre')).toHaveClass(/corto/)
    await push.getByRole('button', { name: /Ver todo/ }).click()
    await expect(push.locator('pre')).not.toHaveClass(/corto/)
    await expect(push.getByText('git push --force origin main', { exact: false })).toBeInViewport()
    await expect(push.getByRole('button', { name: 'Aprobar' })).toBeEnabled()
    // A los 5 s sin el segundo toque vuelve a «Aprobar».
    await push.getByRole('button', { name: 'Aprobar' }).click()
    await expect(push.getByRole('button', { name: 'Tocá de nuevo para aprobar' })).toBeVisible()
    await expect(push.getByRole('button', { name: 'Aprobar', exact: true })).toBeVisible({ timeout: 7000 })
    expect(decisiones).toEqual(['p1:allow'])
  } finally {
    await navegador.close()
  }
})

test('Celu: con «Aprobar desde el celu» apagado, los pedidos se ven sin botones y con la nota una sola vez', async () => {
  estado = { ...BASE, aprobar: false, sesiones: [sesion('api', 'waiting'), sesion('web', 'waiting')], pedidos: [pedido('p1', 'api', 'ls'), pedido('p2', 'web', 'pwd')] }
  const navegador = await chromium.launch()
  try {
    const { page } = await abrir(navegador, MOTORES[0].ficha)
    await expect(page.locator('#pedidos li')).toHaveCount(2)
    await expect(page.getByRole('button', { name: 'Aprobar' })).toHaveCount(0)
    await expect(page.getByText('Respondelo en la PC.', { exact: false })).toHaveCount(1)
  } finally {
    await navegador.close()
  }
})
