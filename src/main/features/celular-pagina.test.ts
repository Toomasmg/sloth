import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import type { EstadoCelular } from '../../shared/celular'
import { PAGINA_JS } from './celular-pagina'
import { abrirPedido, derivarClaves, sellarRespuesta, type Claves } from './celular-sello'

const ESTADO: EstadoCelular = { ahora: 1, aprobar: false, cuentas: [], sesiones: [], pedidos: [] }
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
async function correrPagina(slothFetch?: (url: string, init?: unknown) => Promise<unknown>, hash = `#k=${CLAVE}`): Promise<{ fetchs: Pedido[]; pantallaCompleta: number; hoy: string | undefined; sinClave: boolean; almacen: Map<string, string>; url: string }> {
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
  return { fetchs, pantallaCompleta, hoy: nodos.get('hoy')?.textContent, sinClave: nodos.get('sin-token')?.hidden === false, almacen, url }
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
