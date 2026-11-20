import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import type { EstadoCelular } from '../../shared/celular'
import { PAGINA_JS } from './celular-pagina'
import { MAX_SOBRE_BYTES, abrirPedido, derivarClaves, sellarRespuesta, type Claves } from './celular-sello'
import { pesoJson } from './celular-terminal-core'

const CLAVE = Buffer.alloc(32, 9).toString('base64url')
const claves = derivarClaves(CLAVE) as Claves

const ESTADO: EstadoCelular = {
  ahora: 1,
  aprobar: false,
  terminal: true,
  cuentas: [{ id: 'a', nombre: 'A', cincoHoras: null, semana: null, limitesLeidosEn: null, hoy: null }],
  sesiones: [{ id: 'ws-1', nombre: 'web', cuentaId: 'a', estado: 'idle', desde: 1 }],
  pedidos: []
}
const SALIDA = { reinicio: false, datos: '', hasta: 0, mas: false, viva: true, cols: 80, rows: 24, ajustado: false }

type Escucha = (ev: { preventDefault(): void }) => void

class Nodo {
  id = ''
  className = ''
  textContent = ''
  hidden = false
  disabled = false
  value = ''
  type = ''
  parentNode: Nodo | null = null
  style: Record<string, string> = {}
  atributos = new Map<string, string>()
  escuchas = new Map<string, Escucha>()
  classList = { toggle: (): void => undefined, add: (): void => undefined, remove: (): void => undefined }
  setAttribute(k: string, v: string): void {
    this.atributos.set(k, v)
  }
  addEventListener(tipo: string, f: Escucha): void {
    this.escuchas.set(tipo, f)
  }
  appendChild(n: Nodo): Nodo {
    n.parentNode = this
    return n
  }
  querySelector(): null {
    return null
  }
}

interface Pedido {
  desde: number
  escribir?: string
  largo: number
}

interface Pagina {
  pedidosTerminal: Pedido[]
  aviso: () => string
  enviar: () => boolean
  botones: Nodo[]
  escribirEnLaPagina: (texto: string) => void
  esperar: () => Promise<void>
}

type Responder = (p: { desde: number; escribir?: string }, n: number) => { status: number; cuerpo: (iv: Buffer) => string } | 'red'

const ok = (datos: object) => ({ status: 200, cuerpo: (iv: Buffer) => sellarRespuesta(claves, iv, JSON.stringify(datos)) })

/** Corre app.js con un DOM mínimo y un xterm de mentira, abre la terminal de la primera sesión y deja que sondee. */
async function abrir(responder: Responder, opciones: { estado?: EstadoCelular; remoto?: boolean } = {}): Promise<Pagina> {
  const nodos = new Map<string, Nodo>()
  const botones: Nodo[] = []
  const pedidosTerminal: Pedido[] = []
  let timers = 30
  const nodo = (id: string): Nodo => {
    let n = nodos.get(id)
    if (!n) nodos.set(id, (n = Object.assign(new Nodo(), { id, parentNode: new Nodo() })))
    return n
  }
  class TerminalFalsa {
    options = { fontSize: 12 }
    cols = 80
    rows = 24
    open(): void {}
    onData(f: (d: string) => void): void {
      terminalOnData = f
    }
    write(_d: string, cb?: () => void): void {
      cb?.()
    }
    reset(): void {}
    resize(): void {}
    scrollToBottom(): void {}
  }
  let terminalOnData: (d: string) => void = () => undefined
  const estado = opciones.estado ?? ESTADO
  const ventana: Record<string, unknown> = {
    document: {
      hidden: false,
      fullscreenElement: null,
      documentElement: {},
      head: { appendChild: (): void => undefined },
      getElementById: nodo,
      createElement: (): Nodo => {
        const n = new Nodo()
        botones.push(n)
        return n
      },
      createElementNS: (): Nodo => new Nodo(),
      addEventListener: (): void => undefined
    },
    localStorage: { getItem: (): null => null, setItem: (): void => undefined, removeItem: (): void => undefined },
    location: { hash: `#k=${CLAVE}`, pathname: '/' },
    history: { replaceState: (): void => undefined, pushState: (): void => undefined, back: (): void => undefined },
    crypto: webcrypto,
    navigator: { userAgent: 'Android', standalone: false },
    matchMedia: () => ({ matches: false }),
    addEventListener: (): void => undefined,
    Terminal: TerminalFalsa,
    fetch: async (url: string, init: { body?: string }) => {
      const ab = abrirPedido(claves, url, init.body ?? '')
      if (!ab) return { status: 401, ok: false, text: async () => '' }
      if (url === '/api/estado') return { status: 200, ok: true, text: async () => sellarRespuesta(claves, ab.iv, JSON.stringify(estado)) }
      const b = (JSON.parse(ab.json) as { b: { desde: number; escribir?: string } }).b
      pedidosTerminal.push({ desde: b.desde, escribir: b.escribir, largo: (init.body ?? '').length })
      const r = responder(b, pedidosTerminal.length)
      if (r === 'red') throw new TypeError('Failed to fetch')
      return { status: r.status, ok: r.status === 200, text: async () => r.cuerpo(ab.iv) }
    },
    setTimeout: (f: () => void, ms: number): number => {
      // Los sondeos de reposo (estado cada 1,5 s, terminal cada 0,35 s) no hacen falta: solo corren los reintentos y los pedidos seguidos.
      if (ms !== 1500 && ms !== 350 && timers-- > 0) setImmediate(f)
      return 0
    },
    clearTimeout: (): void => undefined,
    URLSearchParams
  }
  ventana.window = ventana
  if (opciones.remoto) ventana.slothFetch = async () => ({ status: 200, ok: true, json: async () => estado })
  runInNewContext(PAGINA_JS, ventana)
  // Sellar y abrir con AES en JS puro tarda más con la PC ocupada: se espera a que dejen de llegar pedidos, no un tiempo fijo.
  const esperar = async (): Promise<void> => {
    let visto = -1
    let quietos = 0
    for (let i = 0; i < 250 && quietos < 3; i++) {
      await new Promise((r) => setTimeout(r, 20))
      quietos = pedidosTerminal.length === visto ? quietos + 1 : 0
      visto = pedidosTerminal.length
    }
  }
  await esperar()
  const boton = botones.find((b) => b.className === 's-term')
  if (!opciones.remoto) {
    assert.ok(boton, 'la sesión tiene su botón «Terminal»')
    boton.escuchas.get('click')?.({ preventDefault: () => undefined })
    await esperar()
  }
  return {
    pedidosTerminal,
    aviso: () => nodo('term-aviso').textContent,
    enviar: () => nodo('term-enviar').disabled,
    botones: botones.filter((b) => b.className === 's-term'),
    escribirEnLaPagina: (texto) => {
      terminalOnData(texto)
    },
    esperar
  }
}

test('una respuesta sellada más grande de lo que acepta la página dice qué pasó y deja de reintentar', async () => {
  const enorme = ok({ ...SALIDA, datos: 'x'.repeat(300_000) })
  const p = await abrir(() => enorme)
  assert.match(p.aviso(), /demasiado grande/)
  assert.doesNotMatch(p.aviso(), /Sin conexión/)
  assert.match(p.aviso(), /abrí la terminal de nuevo/)
  assert.equal(p.pedidosTerminal.length, 3, 'a la tercera falla igual no insiste')
  assert.equal(p.enviar(), true, 'no se puede mandar texto a una terminal parada')
})

test('una respuesta que no se puede leer no se confunde con falta de conexión', async () => {
  const p = await abrir(() => ({ status: 200, cuerpo: () => sellarRespuesta(claves, Buffer.alloc(16, 5), JSON.stringify(SALIDA)) }))
  assert.match(p.aviso(), /No pude leer la respuesta de la PC/)
  assert.equal(p.pedidosTerminal.length, 3)
})

test('sin red sí es «Sin conexión», y sigue reintentando', async () => {
  const p = await abrir(() => 'red')
  assert.match(p.aviso(), /Sin conexión con la PC/)
  assert.ok(p.pedidosTerminal.length > 3)
})

test('si la respuesta viene por partes (mas), la página pide la siguiente sin esperar y sigue desde donde quedó', async () => {
  const p = await abrir((_p, n) => ok({ ...SALIDA, datos: `parte${n}`, hasta: n * 10, mas: n < 3 }))
  assert.deepEqual(p.pedidosTerminal.map((x) => x.desde), [-1, 10, 20])
})

test('lo que se pega se parte en pedidos que la PC acepta, aunque sean puros ESC', async () => {
  const p = await abrir(() => ok(SALIDA))
  const pegado = '\x1b'.repeat(2500) + 'ñ'.repeat(1000) + '😀'.repeat(300)
  p.escribirEnLaPagina(pegado)
  await p.esperar()
  const enviados = p.pedidosTerminal.filter((x) => x.escribir !== undefined)
  assert.ok(enviados.length >= 3, JSON.stringify(p.pedidosTerminal.map((x) => [x.desde, x.escribir?.length, x.largo])) + p.aviso())
  for (const e of enviados) {
    assert.ok(e.largo <= MAX_SOBRE_BYTES, `un pedido sellado de ${e.largo}`)
    assert.ok(pesoJson(e.escribir as string) <= 3000)
    assert.ok(!/[\ud800-\udbff]$/.test(e.escribir as string), 'no corta un emoji')
  }
  assert.equal(enviados.map((x) => x.escribir).join(''), pegado)
})

test('si la PC contestó pero la página no pudo leerlo, lo que se había escrito no se manda dos veces', async () => {
  const enorme = ok({ ...SALIDA, datos: 'x'.repeat(300_000) })
  const p = await abrir((pedido) => (pedido.escribir === 'ls' ? enorme : ok(SALIDA)))
  p.escribirEnLaPagina('ls')
  await p.esperar()
  assert.equal(p.pedidosTerminal.filter((x) => x.escribir === 'ls').length, 1)
})

test('en «Desde cualquier red» la sesión muestra «Terminal» apagado, y con la terminal apagada en la PC no muestra nada', async () => {
  const remoto = await abrir(() => ok(SALIDA), { remoto: true, estado: { ...ESTADO, terminal: false, terminalEnWifi: true } })
  assert.equal(remoto.botones.length, 1)
  assert.equal(remoto.botones[0].disabled, true)
  assert.match(remoto.botones[0].atributos.get('aria-label') ?? '', /QR del Wi-Fi de casa/)
  const sin = await abrir(() => ok(SALIDA), { remoto: true, estado: { ...ESTADO, terminal: false, terminalEnWifi: false } })
  assert.equal(sin.botones.length, 0)
})
