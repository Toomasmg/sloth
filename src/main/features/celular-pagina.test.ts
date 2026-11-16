import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import type { EstadoCelular } from '../../shared/celular'
import { PAGINA_JS } from './celular-pagina'

const ESTADO: EstadoCelular = { ahora: 1, aprobar: false, cuentas: [], sesiones: [], pedidos: [] }

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
  init: { headers?: Record<string, string> } | undefined
}

/** Corre app.js en un contexto aparte con un DOM mínimo, como un Android (con requestFullscreen). */
async function correrPagina(slothFetch?: (url: string, init?: unknown) => Promise<unknown>): Promise<{ fetchs: Pedido[]; pantallaCompleta: number; hoy: string | undefined }> {
  const fetchs: Pedido[] = []
  const nodos = new Map<string, Nodo>()
  let pantallaCompleta = 0
  const respuesta = { status: 200, ok: true, json: async () => ESTADO }
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
    location: { search: '?t=tok' },
    navigator: { userAgent: 'Android', standalone: false },
    matchMedia: () => ({ matches: false }),
    fetch: async (url: string, init: Pedido['init']) => {
      fetchs.push({ url, init })
      return respuesta
    },
    setTimeout: (): number => 0,
    clearTimeout: (): void => undefined,
    URLSearchParams
  }
  ventana.window = ventana
  if (slothFetch) ventana.slothFetch = slothFetch
  runInNewContext(PAGINA_JS, ventana)
  await new Promise((r) => setImmediate(r))
  return { fetchs, pantallaCompleta, hoy: nodos.get('hoy')?.textContent }
}

test('en el Wi-Fi la página pide /api/estado con fetch y su token, sin pedir pantalla completa', async () => {
  const { fetchs, pantallaCompleta, hoy } = await correrPagina()
  assert.equal(fetchs.length, 1)
  assert.equal(fetchs[0].url, '/api/estado')
  assert.equal(fetchs[0].init?.headers?.['x-sloth-token'], 'tok')
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
