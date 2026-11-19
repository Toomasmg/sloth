import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import type { EstadoCelular } from '../../shared/celular'
import { PAGINA_JS } from './celular-pagina'
import { abrirPedido, derivarClaves, sellarRespuesta, type Claves } from './celular-sello'

const ESTADO: EstadoCelular = { ahora: 1, aprobar: false, terminal: false, cuentas: [], sesiones: [], pedidos: [] }
const CLAVE = Buffer.alloc(32, 9).toString('base64url')
const claves = derivarClaves(CLAVE) as Claves

class Nodo {
  id = ''
  textContent = ''
  hidden = false
  disabled = false
  type = ''
  parentNode: Nodo | null = null
  style: Record<string, string> = {}
  classList = { toggle: (): void => undefined, add: (): void => undefined, remove: (): void => undefined }
  setAttribute(): void {}
  addEventListener(): void {}
  appendChild(n: Nodo): Nodo {
    n.parentNode = this
    return n
  }
}

interface Pedido {
  url: string
  init: { method?: string; headers?: Record<string, string>; body?: string } | undefined
}

/** Corre app.js en un contexto aparte con un DOM mínimo, como un Android (con requestFullscreen). */
async function correrPagina(slothFetch?: (url: string, init?: unknown) => Promise<unknown>, hash = `#k=${CLAVE}`, responder?: (ab: { iv: Buffer }) => { status: number; cuerpo: string }): Promise<{ fetchs: Pedido[]; pantallaCompleta: number; hoy: string | undefined; conexion: string | undefined; sinClave: boolean; sinClaveTexto: string | undefined; almacen: Map<string, string>; url: string }> {
  const fetchs: Pedido[] = []
  const nodos = new Map<string, Nodo>()
  let pantallaCompleta = 0
  let url = ''
  const almacen = new Map<string, string>()
  const ventana: Record<string, unknown> = {
    document: {
      hidden: false,
      fullscreenElement: null,
      documentElement: {
        requestFullscreen: () => {
          pantallaCompleta++
          return Promise.reject(new Error('sin gesto'))
        }
      },
      getElementById: (id: string): Nodo => {
        let n = nodos.get(id)
        if (!n) nodos.set(id, (n = Object.assign(new Nodo(), { id, parentNode: new Nodo() })))
        return n
      },
      createElement: (): Nodo => new Nodo(),
      createElementNS: (): Nodo => new Nodo(),
      addEventListener: (): void => undefined
    },
    localStorage: {
      getItem: (k: string) => almacen.get(k) ?? null,
      setItem: (k: string, v: string) => void almacen.set(k, v),
      removeItem: (k: string) => void almacen.delete(k)
    },
    location: { hash, pathname: '/' },
    history: { replaceState: (_a: unknown, _b: string, u: string): void => void (url = u) },
    crypto: webcrypto,
    navigator: { userAgent: 'Android', standalone: false },
    matchMedia: () => ({ matches: false }),
    fetch: async (url: string, init: Pedido['init']) => {
      fetchs.push({ url, init })
      const ab = abrirPedido(claves, url, init?.body ?? '')
      if (!ab) return { status: 401, ok: false, text: async () => '' }
      if (responder) {
        const { status, cuerpo } = responder(ab)
        return { status, ok: status === 200, text: async () => cuerpo }
      }
      return { status: 200, ok: true, text: async () => sellarRespuesta(claves, ab.iv, JSON.stringify(ESTADO)) }
    },
    setTimeout: (): number => 0,
    clearTimeout: (): void => undefined,
    URLSearchParams
  }
  ventana.window = ventana
  if (slothFetch) ventana.slothFetch = slothFetch
  runInNewContext(PAGINA_JS, ventana)
  await new Promise((r) => setImmediate(r))
  return { fetchs, pantallaCompleta, hoy: nodos.get('hoy')?.textContent, conexion: nodos.get('conexion-texto')?.textContent, sinClave: nodos.get('sin-token')?.hidden === false, sinClaveTexto: nodos.get('sin-token-texto')?.textContent, almacen, url }
}

test('en el Wi-Fi la página pide /api/estado sellado con la clave del hash, sin pedir pantalla completa', async () => {
  const { fetchs, pantallaCompleta, hoy, almacen, url } = await correrPagina()
  assert.equal(fetchs.length, 1)
  assert.equal(fetchs[0].url, '/api/estado')
  assert.equal(fetchs[0].init?.method, 'POST')
  assert.equal(fetchs[0].init?.headers?.['x-sloth-token'], undefined)
  assert.ok(!(fetchs[0].init?.body ?? '').includes('estado'))
  assert.equal(almacen.get('sloth-clave'), CLAVE)
  assert.equal(url, '/', 'sacó la clave de la barra')
  assert.equal(pantallaCompleta, 0)
  assert.equal(hoy, 'Hoy: sin datos', 'pintó el estado que recibió')
})

test('en la versión remota la página pide por window.slothFetch y no toca fetch', async () => {
  const remotos: string[] = []
  const { fetchs, pantallaCompleta, hoy } = await correrPagina(async (url) => {
    remotos.push(url)
    return { status: 200, ok: true, json: async () => ESTADO }
  })
  assert.deepEqual(remotos, ['/api/estado'])
  assert.equal(fetchs.length, 0)
  assert.equal(pantallaCompleta, 0)
  assert.equal(hoy, 'Hoy: sin datos')
})

test('sin clave en el enlace ni guardada, avisa que hay que emparejar y no pide nada', async () => {
  const { fetchs, sinClave } = await correrPagina(undefined, '')
  assert.equal(fetchs.length, 0)
  assert.equal(sinClave, true)
})

test('una respuesta de 409 «reloj» avisa de la hora del celu y no borra la clave', async () => {
  const r = await correrPagina(undefined, `#k=${CLAVE}`, (ab) => ({ status: 409, cuerpo: sellarRespuesta(claves, ab.iv, JSON.stringify({ error: 'reloj' })) }))
  assert.match(r.conexion ?? '', /hora del celu/)
  assert.equal(r.sinClave, false)
  assert.equal(r.almacen.get('sloth-clave'), CLAVE)
})

test('un 401 sin sellar (clave inválida) sí desempareja', async () => {
  const r = await correrPagina(undefined, `#k=${CLAVE}`, () => ({ status: 401, cuerpo: '' }))
  assert.equal(r.sinClave, true)
  assert.equal(r.almacen.get('sloth-clave'), undefined)
})

test('un estado grande (30 sesiones) llega entero a la página', async () => {
  const sesiones = Array.from({ length: 30 }, (_, i) => ({ id: 's' + i, detalle: 'x'.repeat(200) }))
  const grande = { ...ESTADO, ahora: 5, sesiones }
  const r = await correrPagina(undefined, `#k=${CLAVE}`, (ab) => ({ status: 200, cuerpo: sellarRespuesta(claves, ab.iv, JSON.stringify(grande)) }))
  assert.ok(sellarRespuesta(claves, Buffer.alloc(16), JSON.stringify(grande)).length > 8192)
  assert.match(r.conexion ?? '', /PC conectada/)
})

test('un #k= truncado no se guarda y dice que el QR no se leyó bien', async () => {
  const r = await correrPagina(undefined, '#k=abc')
  assert.equal(r.almacen.get('sloth-clave'), undefined)
  assert.equal(r.sinClave, true)
  assert.match(r.sinClaveTexto ?? '', /no se leyó bien/)
})
