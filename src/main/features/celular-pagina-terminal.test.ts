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
  clientWidth = 400
  clientHeight = 300
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

interface Cuerpo {
  id: string
  desde: number
  escribir?: string
  tam?: unknown
  espera?: number
  soloEscribir?: boolean
  sesion?: string
  n?: number
}

interface Pedido {
  b: Cuerpo
  largo: number
  en: number
  abortado: boolean
  conSenal: boolean
}

type Contesta = { status: number; cuerpo: (iv: Buffer) => string }
type Resultado = Contesta | 'red' | 'colgar'
type Responder = (b: Cuerpo, n: number) => Resultado | Promise<Resultado>

const ok = (datos: object): Contesta => ({ status: 200, cuerpo: (iv: Buffer) => sellarRespuesta(claves, iv, JSON.stringify(datos)) })

/** Lo de siempre: a lo que se escribe y a la primera pantalla se les contesta ya, y después el mirar queda abierto sin novedades. */
const reposo: Responder = (b) => (b.soloEscribir || b.espera === 0 ? ok(SALIDA) : 'colgar')

interface Pagina {
  pedidos: Pedido[]
  mirar: Pedido[]
  escritos: Pedido[]
  salida: string[]
  aviso: () => string
  enviar: () => boolean
  botones: Nodo[]
  nodo: (id: string) => Nodo
  teclear: (texto: string) => void
  esperar: (hasta?: () => boolean) => Promise<void>
  avanzar: (ms: number) => Promise<void>
  ahora: () => number
  ocultar: () => void
  mostrar: () => void
  evento: (tipo: string) => void
  timersAbiertos: () => number
  slothSello: { abrirClave: (c: string) => unknown }
}

interface Opciones {
  estado?: EstadoCelular
  remoto?: boolean
  sinAbortController?: boolean
}

/** Corre app.js con un DOM mínimo, un xterm de mentira y un reloj que se mueve solo cuando el test lo pide, y abre la terminal. */
async function abrir(responder: Responder, opciones: Opciones = {}): Promise<Pagina> {
  const nodos = new Map<string, Nodo>()
  const botones: Nodo[] = []
  const pedidos: Pedido[] = []
  const salida: string[] = []
  const esDocumento = new Map<string, () => void>()
  const esVentana = new Map<string, () => void>()
  let reloj = Date.now()
  let semilla = 0
  const timers = new Map<number, { f: () => void; en: number }>()
  const nodo = (id: string): Nodo => {
    let n = nodos.get(id)
    if (!n) nodos.set(id, (n = Object.assign(new Nodo(), { id, parentNode: new Nodo() })))
    return n
  }
  let alTeclear: (d: string) => void = () => undefined
  class TerminalFalsa {
    options = { fontSize: 12 }
    cols = 80
    rows = 24
    open(): void {}
    onData(f: (d: string) => void): void {
      alTeclear = f
    }
    write(d: string, cb?: () => void): void {
      salida.push(d)
      cb?.()
    }
    reset(): void {}
    resize(): void {}
    scrollToBottom(): void {}
  }
  const documento = {
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
    addEventListener: (tipo: string, f: () => void): void => {
      esDocumento.set(tipo, f)
    }
  }
  const estado = opciones.estado ?? ESTADO
  const FechaFalsa = new Proxy(Date, { get: (t, k) => (k === 'now' ? (): number => reloj : Reflect.get(t, k)) })
  const ventana: Record<string, unknown> = {
    document: documento,
    Date: FechaFalsa,
    localStorage: { getItem: (): null => null, setItem: (): void => undefined, removeItem: (): void => undefined },
    location: { hash: `#k=${CLAVE}`, pathname: '/' },
    history: { replaceState: (): void => undefined, pushState: (): void => undefined, back: (): void => undefined },
    crypto: webcrypto,
    navigator: { userAgent: 'Android', standalone: false },
    matchMedia: () => ({ matches: false }),
    addEventListener: (tipo: string, f: () => void): void => {
      esVentana.set(tipo, f)
    },
    Terminal: TerminalFalsa,
    fetch: (url: string, init: { body?: string; signal?: AbortSignal }) => {
      const ab = abrirPedido(claves, url, init.body ?? '')
      if (!ab) return Promise.resolve({ status: 401, ok: false, text: async () => '' })
      if (url === '/api/estado') return Promise.resolve({ status: 200, ok: true, text: async () => sellarRespuesta(claves, ab.iv, JSON.stringify(estado)) })
      const b = (JSON.parse(ab.json) as { b: Cuerpo }).b
      const reg: Pedido = { b, largo: (init.body ?? '').length, en: reloj, abortado: false, conSenal: !!init.signal }
      pedidos.push(reg)
      const r = responder(b, pedidos.length)
      return new Promise((resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reg.abortado = true
          reject(new Error('abortado'))
        })
        void Promise.resolve(r).then((v) => {
          if (v === 'colgar') return
          if (v === 'red') reject(new TypeError('Failed to fetch'))
          else resolve({ status: v.status, ok: v.status === 200, text: async () => v.cuerpo(ab.iv) })
        })
      })
    },
    setTimeout: (f: () => void, ms: number): number => {
      timers.set(++semilla, { f, en: reloj + (ms || 0) })
      return semilla
    },
    clearTimeout: (id: number): void => {
      timers.delete(id)
    },
    URLSearchParams,
    ...(opciones.sinAbortController ? {} : { AbortController })
  }
  ventana.window = ventana
  if (opciones.remoto) ventana.slothFetch = async () => ({ status: 200, ok: true, json: async () => estado })
  runInNewContext(PAGINA_JS, ventana)
  // Sellar y abrir con AES en JS puro tarda más con la PC ocupada: se espera a que se aquiete la cadena de promesas, no un tiempo fijo.
  const asentar = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r))
  }
  const esperar = async (hasta?: () => boolean): Promise<void> => {
    if (!hasta) return asentar()
    for (let i = 0; i < 3000 && !hasta(); i++) await new Promise((r) => setImmediate(r))
    assert.ok(hasta(), 'la condición nunca se dio')
    await asentar()
  }
  const avanzar = async (ms: number): Promise<void> => {
    const meta = reloj + ms
    await asentar()
    for (;;) {
      const proximo = [...timers].filter(([, t]) => t.en <= meta).sort((a, b) => a[1].en - b[1].en)[0]
      if (!proximo) break
      timers.delete(proximo[0])
      reloj = Math.max(reloj, proximo[1].en)
      proximo[1].f()
      await asentar()
    }
    reloj = meta
  }
  await asentar()
  const boton = botones.find((b) => b.className === 's-term')
  if (!opciones.remoto) {
    assert.ok(boton, 'la sesión tiene su botón «Terminal»')
    boton.escuchas.get('click')?.({ preventDefault: () => undefined })
    await esperar(() => pedidos.length > 0)
  }
  return {
    pedidos,
    get mirar() {
      return pedidos.filter((p) => !p.b.soloEscribir)
    },
    get escritos() {
      return pedidos.filter((p) => p.b.soloEscribir)
    },
    salida,
    aviso: () => nodo('term-aviso').textContent,
    enviar: () => nodo('term-enviar').disabled,
    botones: botones.filter((b) => b.className === 's-term'),
    nodo,
    teclear: (texto) => alTeclear(texto),
    esperar,
    avanzar,
    ahora: () => reloj,
    ocultar: () => {
      documento.hidden = true
      esDocumento.get('visibilitychange')?.()
    },
    mostrar: () => {
      documento.hidden = false
      esDocumento.get('visibilitychange')?.()
    },
    evento: (tipo) => esVentana.get(tipo)?.(),
    timersAbiertos: () => timers.size,
    slothSello: ventana.slothSello as Pagina['slothSello']
  }
}

test('una respuesta sellada más grande de lo que acepta la página dice qué pasó y deja de reintentar', async () => {
  const enorme = ok({ ...SALIDA, datos: 'x'.repeat(300_000) })
  const p = await abrir(() => enorme)
  await p.avanzar(5000)
  assert.match(p.aviso(), /demasiado grande/)
  assert.doesNotMatch(p.aviso(), /Sin conexión/)
  assert.match(p.aviso(), /abrí la terminal de nuevo/)
  assert.equal(p.mirar.length, 3, 'a la tercera falla igual no insiste')
  assert.equal(p.enviar(), true, 'no se puede mandar texto a una terminal parada')
})

test('una respuesta que no se puede leer no se confunde con falta de conexión', async () => {
  const p = await abrir(() => ({ status: 200, cuerpo: () => sellarRespuesta(claves, Buffer.alloc(16, 5), JSON.stringify(SALIDA)) }))
  await p.avanzar(5000)
  assert.match(p.aviso(), /No pude leer la respuesta de la PC/)
  assert.equal(p.mirar.length, 3)
})

test('sin red sí es «Sin conexión» (desde la segunda falla), y reintenta con backoff de 250 ms que duplica hasta 4 s', async () => {
  const p = await abrir(() => 'red')
  assert.doesNotMatch(p.aviso(), /Sin conexión/, 'una falla sola no asusta')
  await p.avanzar(60_000)
  assert.match(p.aviso(), /Sin conexión con la PC/)
  const gaps = p.mirar.slice(0, 8).map((x, i, l) => (i ? x.en - l[i - 1].en : 0)).slice(1)
  assert.deepEqual(gaps, [250, 500, 1000, 2000, 4000, 4000, 4000])
})

test('un 429 (la PC pide calma) se trata como falla de red con backoff, no como terminal cerrada', async () => {
  const p = await abrir(() => ({ status: 429, cuerpo: () => '' }))
  await p.avanzar(2000)
  const gaps = p.mirar.map((x, i, l) => (i ? x.en - l[i - 1].en : 0)).slice(1)
  assert.deepEqual(gaps.slice(0, 3), [250, 500, 1000])
  assert.doesNotMatch(p.aviso(), /cerrada/)
  assert.equal(p.enviar(), false)
})

test('si la respuesta viene por partes (mas), la página pide la siguiente sin esperar y sigue desde donde quedó', async () => {
  const p = await abrir((b, n) => (b.soloEscribir ? ok(SALIDA) : n <= 3 ? ok({ ...SALIDA, datos: `parte${n}`, hasta: n * 10, mas: n < 3 }) : 'colgar'))
  await p.esperar(() => p.mirar.length >= 4)
  assert.deepEqual(p.mirar.map((x) => x.b.desde), [-1, 10, 20, 30])
  assert.deepEqual(p.mirar.map((x) => x.b.espera), [0, 0, 0, 20000], 'con más por mandar no se espera; al quedar al día, sí')
  assert.deepEqual(p.salida, ['parte1', 'parte2', 'parte3'])
})

test('mirar: el primero pide la pantalla ya; los siguientes dejan 20 s abierto, no llevan escribir y llevan la sesión', async () => {
  const p = await abrir((b, n) => (b.soloEscribir ? ok(SALIDA) : n === 1 ? ok({ ...SALIDA, datos: 'hola', hasta: 7 }) : 'colgar'))
  await p.esperar(() => p.mirar.length >= 2)
  assert.deepEqual(p.mirar[0].b, { id: 'ws-1', desde: -1, espera: 0, sesion: p.mirar[0].b.sesion })
  assert.match(p.mirar[0].b.sesion ?? '', /^[A-Za-z0-9]{16}$/)
  assert.equal(p.mirar[1].b.desde, 7)
  assert.equal(p.mirar[1].b.espera, 20000)
  assert.equal(p.mirar[1].b.escribir, undefined)
  assert.equal(p.mirar[1].b.sesion, p.mirar[0].b.sesion)
  assert.equal(p.mirar[1].conSenal, true, 'se puede cortar')
})

test('en reposo no hay pedidos: el mirar sigue abierto y no se reabre a los 350 ms', async () => {
  const p = await abrir(reposo)
  await p.esperar(() => p.mirar.length >= 2)
  const antes = p.pedidos.length
  await p.avanzar(27_000)
  assert.equal(p.pedidos.length, antes, 'ni un pedido más: el mirar sigue abierto')
  assert.equal(p.mirar[1].abortado, false)
})

test('una tecla sale ya, en su propio pedido soloEscribir con número, sin espera y sin pedir salida', async () => {
  const p = await abrir(reposo)
  const t0 = p.ahora()
  p.teclear('a')
  await p.esperar(() => p.escritos.length >= 1)
  const e = p.escritos[0]
  assert.equal(p.ahora(), t0, 'sin esperar ningún timer')
  assert.deepEqual(e.b, { id: 'ws-1', desde: 0, soloEscribir: true, sesion: p.mirar[0].b.sesion, n: 1, escribir: 'a' })
})

test('lo que se teclea mientras viaja otra tecla se junta en el pedido siguiente, y el orden se mantiene', async () => {
  let soltarPrimera: (r: Resultado) => void = () => undefined
  const p = await abrir((b, n) => {
    if (!b.soloEscribir) return 'colgar'
    return b.escribir === 'a' ? new Promise<Resultado>((r) => (soltarPrimera = r)) : ok(SALIDA)
  })
  p.teclear('a')
  await p.esperar(() => p.escritos.length >= 1)
  p.teclear('b')
  p.teclear('c')
  await p.esperar()
  assert.equal(p.escritos.length, 1, 'uno por vez')
  soltarPrimera(ok(SALIDA))
  await p.esperar(() => p.escritos.length >= 2)
  assert.deepEqual(p.escritos.map((x) => [x.b.escribir, x.b.n]), [['a', 1], ['bc', 2]])
})

test('el formulario manda el texto y el Enter en pedidos aparte y en orden', async () => {
  const p = await abrir(reposo)
  p.nodo('term-texto').value = 'ls -la'
  p.nodo('term-form').escuchas.get('submit')?.({ preventDefault: () => undefined })
  await p.esperar(() => p.escritos.length >= 2)
  assert.deepEqual(p.escritos.map((x) => x.b.escribir), ['ls -la', '\r'])
})

test('lo que se pega se parte en pedidos que la PC acepta, aunque sean puros ESC', async () => {
  const p = await abrir(reposo)
  const pegado = '\x1b'.repeat(2500) + 'ñ'.repeat(1000) + '😀'.repeat(300)
  p.teclear(pegado)
  await p.esperar(() => p.escritos.map((x) => x.b.escribir).join('') === pegado)
  assert.ok(p.escritos.length >= 3, JSON.stringify(p.escritos.map((x) => [x.b.escribir?.length, x.largo])) + p.aviso())
  for (const e of p.escritos) {
    assert.ok(e.largo <= MAX_SOBRE_BYTES, `un pedido sellado de ${e.largo}`)
    assert.ok(pesoJson(e.b.escribir as string) <= 3000)
    assert.ok(!/[\ud800-\udbff]$/.test(e.b.escribir as string), 'no corta un emoji')
  }
  assert.deepEqual(p.escritos.map((x) => x.b.n), p.escritos.map((_, i) => i + 1), 'numerados sin huecos')
})

test('si la PC contestó pero la página no pudo leerlo, lo que se había escrito no se manda dos veces y avisa que puede no haber llegado', async () => {
  const enorme = ok({ ...SALIDA, datos: 'x'.repeat(300_000) })
  const p = await abrir((b) => (b.soloEscribir ? (b.escribir === 'ls' ? enorme : ok(SALIDA)) : 'colgar'))
  p.teclear('ls')
  await p.esperar(() => p.escritos.length >= 1)
  await p.avanzar(10_000)
  assert.equal(p.escritos.filter((x) => x.b.escribir === 'ls').length, 1)
  assert.match(p.aviso(), /puede que lo último que escribiste no haya llegado/)
})

test('red que cae con una escritura: se reenvía con el MISMO número, y lo que se teclee después va aparte y después', async () => {
  let intentos = 0
  const p = await abrir((b) => {
    if (!b.soloEscribir) return 'colgar'
    return b.escribir === 'x' && ++intentos === 1 ? 'red' : ok(SALIDA)
  })
  p.teclear('x')
  await p.esperar(() => p.escritos.length >= 1)
  p.teclear('y')
  await p.esperar()
  assert.equal(p.escritos.length, 1, 'espera el backoff antes de reintentar')
  await p.avanzar(250)
  await p.esperar(() => p.escritos.length >= 3)
  assert.deepEqual(p.escritos.map((x) => [x.b.escribir, x.b.n]), [['x', 1], ['x', 1], ['y', 2]])
})

test('una escritura que cuelga se corta a los 10 s y se reintenta con el mismo número', async () => {
  let intentos = 0
  const p = await abrir((b) => (!b.soloEscribir ? 'colgar' : ++intentos === 1 ? 'colgar' : ok(SALIDA)))
  p.teclear('z')
  await p.esperar(() => p.escritos.length >= 1)
  await p.avanzar(9999)
  assert.equal(p.escritos[0].abortado, false)
  await p.avanzar(1)
  assert.equal(p.escritos[0].abortado, true)
  await p.avanzar(250)
  await p.esperar(() => p.escritos.length >= 2)
  assert.deepEqual(p.escritos.map((x) => [x.b.escribir, x.b.n]), [['z', 1], ['z', 1]])
})

test('«Ajustar al celu» y volver al tamaño de la PC viajan como escrituras numeradas, sin salida', async () => {
  const p = await abrir((b) => (b.soloEscribir ? ok({ ...SALIDA, cols: 48, rows: 18, ajustado: !!b.tam && b.tam !== 'pc' }) : 'colgar'))
  p.nodo('term-ajustar').escuchas.get('click')?.({ preventDefault: () => undefined })
  await p.esperar(() => p.escritos.length >= 1)
  const t = p.escritos[0].b.tam as { cols: number; rows: number }
  assert.ok(Number.isInteger(t.cols) && Number.isInteger(t.rows))
  assert.equal(p.escritos[0].b.soloEscribir, true)
  assert.equal(p.nodo('term-ajustar').textContent, 'Tamaño de la PC')
  p.nodo('term-ajustar').escuchas.get('click')?.({ preventDefault: () => undefined })
  await p.esperar(() => p.escritos.length >= 2)
  assert.equal(p.escritos[1].b.tam, 'pc')
  assert.deepEqual(p.escritos.map((x) => x.b.n), [1, 2])
})

test('una respuesta de una escritura aplica tamaño y estado, nunca salida', async () => {
  const p = await abrir((b) => (b.soloEscribir ? ok({ ...SALIDA, datos: 'no-debería', hasta: 99, viva: false }) : 'colgar'))
  p.teclear('a')
  await p.esperar(() => p.escritos.length >= 1)
  assert.deepEqual(p.salida, [])
  assert.match(p.aviso(), /cerrada en la PC/)
  assert.equal(p.mirar[0].b.desde, -1)
})

test('oculta la página: el mirar se corta y no hay pedidos; al volver hay uno enseguida desde el mismo punto', async () => {
  const p = await abrir((b, n) => (b.soloEscribir ? ok(SALIDA) : n === 1 ? ok({ ...SALIDA, hasta: 5 }) : 'colgar'))
  await p.esperar(() => p.mirar.length >= 2)
  const abierto = p.mirar[1]
  p.ocultar()
  assert.equal(abierto.abortado, true)
  const antes = p.pedidos.length
  await p.avanzar(120_000)
  assert.equal(p.pedidos.length, antes, 'oculta: ni un pedido de terminal')
  p.mostrar()
  await p.esperar(() => p.mirar.length >= 3)
  assert.equal(p.mirar[2].b.desde, 5)
  assert.equal(p.mirar[2].b.espera, 20000)
})

test('la respuesta de un mirar viejo (la página se ocultó y volvió) se ignora y no mueve el punto', async () => {
  let soltar: (r: Resultado) => void = () => undefined
  const p = await abrir(
    (b, n) => (b.soloEscribir ? ok(SALIDA) : n === 1 ? ok({ ...SALIDA, hasta: 5 }) : n === 2 ? new Promise<Resultado>((r) => (soltar = r)) : 'colgar'),
    { sinAbortController: true }
  )
  await p.esperar(() => p.mirar.length >= 2)
  p.ocultar()
  p.mostrar()
  await p.esperar(() => p.mirar.length >= 3)
  soltar(ok({ ...SALIDA, datos: 'viejo', hasta: 99 }))
  await p.esperar()
  assert.deepEqual(p.salida, [])
  assert.deepEqual(p.mirar.map((x) => x.b.desde), [-1, 5, 5])
  assert.equal(p.mirar[1].conSenal, false, 'sin AbortController también anda')
})

test('con la página oculta una escritura en vuelo termina, pero la siguiente espera a que vuelva', async () => {
  let soltarPrimera: (r: Resultado) => void = () => undefined
  const p = await abrir((b) => (!b.soloEscribir ? 'colgar' : b.escribir === 'a' ? new Promise<Resultado>((r) => (soltarPrimera = r)) : ok(SALIDA)))
  p.teclear('a')
  await p.esperar(() => p.escritos.length >= 1)
  p.teclear('b')
  p.ocultar()
  assert.equal(p.escritos[0].abortado, false, 'la escritura no se corta')
  soltarPrimera(ok(SALIDA))
  await p.avanzar(5000)
  assert.equal(p.escritos.length, 1)
  p.mostrar()
  await p.esperar(() => p.escritos.length >= 2)
  assert.deepEqual(p.escritos.map((x) => x.b.escribir), ['a', 'b'])
})

test('volver la red (online) corta el pedido colgado y abre uno nuevo', async () => {
  const p = await abrir(reposo)
  await p.esperar(() => p.mirar.length >= 2)
  const colgado = p.mirar[p.mirar.length - 1]
  const n = p.mirar.length
  p.evento('online')
  assert.equal(colgado.abortado, true)
  await p.esperar(() => p.mirar.length >= n + 1)
})

test('un mirar que no contesta en 28 s se corta, cuenta como falla y se reintenta con backoff', async () => {
  const p = await abrir((b, n) => (b.soloEscribir ? ok(SALIDA) : n === 1 ? ok({ ...SALIDA, hasta: 3 }) : 'colgar'))
  await p.esperar(() => p.mirar.length >= 2)
  const colgado = p.mirar[1]
  await p.avanzar(27_999)
  assert.equal(colgado.abortado, false)
  await p.avanzar(1)
  assert.equal(colgado.abortado, true)
  assert.equal(p.mirar.length, 2)
  await p.avanzar(250)
  await p.esperar(() => p.mirar.length >= 3)
  assert.equal(p.mirar[2].b.desde, 3, 'sigue desde el mismo punto: ni hueco ni repetido')
})

test('una respuesta vacía enseguida (la PC soltó la espera) no vuelve el mirar un lazo apretado', async () => {
  const p = await abrir((b) => (b.soloEscribir ? ok(SALIDA) : ok(SALIDA)))
  await p.esperar(() => p.mirar.length >= 2)
  assert.equal(p.mirar.length, 2)
  await p.avanzar(499)
  assert.equal(p.mirar.length, 2)
  await p.avanzar(1)
  await p.esperar(() => p.mirar.length >= 3)
})

test('con la terminal cerrada en la PC se mira de a poco (cada 2 s) y se vuelve a abrir sola', async () => {
  const p = await abrir((b) => (b.soloEscribir ? ok(SALIDA) : ok({ ...SALIDA, viva: false })))
  await p.esperar(() => p.mirar.length >= 1)
  await p.avanzar(1999)
  assert.equal(p.mirar.length, 1)
  await p.avanzar(1)
  await p.esperar(() => p.mirar.length >= 2)
  assert.match(p.aviso(), /cerrada en la PC/)
})

test('al cerrar la terminal se corta el pedido abierto y no queda ningún pedido más', async () => {
  const p = await abrir(reposo)
  await p.esperar(() => p.mirar.length >= 1)
  const colgado = p.mirar[p.mirar.length - 1]
  p.nodo('term-volver').escuchas.get('click')?.({ preventDefault: () => undefined })
  assert.equal(colgado.abortado, true)
  const antes = p.pedidos.length
  await p.avanzar(120_000)
  assert.equal(p.pedidos.length, antes)
})

test('una escritura rechazada por la PC (apagada, hora corrida) vacía la cola y no reintenta', async () => {
  const p = await abrir((b) => (b.soloEscribir ? { status: 403, cuerpo: (iv) => sellarRespuesta(claves, iv, JSON.stringify({ error: 'La terminal desde el celu está apagada en Sloth.' })) } : 'colgar'))
  p.teclear('a')
  p.teclear('b')
  await p.esperar(() => p.escritos.length >= 1)
  await p.avanzar(10_000)
  assert.equal(p.escritos.length, 1)
  assert.match(p.aviso(), /apagada en Sloth/)
  assert.equal(p.enviar(), true)
})

test('en «Desde cualquier red» la sesión muestra «Terminal» apagado, y con la terminal apagada en la PC no muestra nada', async () => {
  const remoto = await abrir(() => ok(SALIDA), { remoto: true, estado: { ...ESTADO, terminal: false, terminalEnWifi: true } })
  assert.equal(remoto.botones.length, 1)
  assert.equal(remoto.botones[0].disabled, true)
  assert.match(remoto.botones[0].atributos.get('aria-label') ?? '', /QR del Wi-Fi de casa/)
  const sin = await abrir(() => ok(SALIDA), { remoto: true, estado: { ...ESTADO, terminal: false, terminalEnWifi: false } })
  assert.equal(sin.botones.length, 0)
})

test('un «Ajustar» pedido con teclas sin confirmar no las pasa de largo: lo ya numerado se reenvía primero', async () => {
  let intentos = 0
  const p = await abrir((b) => {
    if (!b.soloEscribir) return 'colgar'
    return b.escribir === 'git push' && ++intentos === 1 ? 'red' : ok(SALIDA)
  })
  p.teclear('git push')
  await p.esperar(() => p.escritos.length >= 1)
  p.nodo('term-ajustar').escuchas.get('click')?.({ preventDefault: () => undefined })
  await p.esperar()
  assert.equal(p.escritos.length, 1, 'el backoff manda')
  await p.avanzar(250)
  await p.esperar(() => p.escritos.length >= 3)
  assert.deepEqual(p.escritos.map((x) => [x.b.escribir ?? 'tam', x.b.n]), [['git push', 1], ['git push', 1], ['tam', 2]], 'números crecientes en el orden en que llegan a la PC')
})

test('lo que no se confirmó en 2 minutos no se reenvía (la PC olvida a los 10): se descarta y avisa', async () => {
  let intentos = 0
  const p = await abrir((b) => (b.soloEscribir && b.escribir === 'rm -rf dist' && ++intentos === 1 ? 'red' : b.soloEscribir ? ok(SALIDA) : 'colgar'))
  p.teclear('rm -rf dist')
  await p.esperar(() => p.escritos.length >= 1)
  p.ocultar()
  await p.avanzar(3 * 60_000)
  p.mostrar()
  await p.esperar()
  assert.equal(p.escritos.filter((x) => x.b.escribir === 'rm -rf dist').length, 1, 'ni un reintento')
  assert.match(p.aviso(), /No sé si llegó lo último que escribiste/)
  p.teclear('ls')
  await p.esperar(() => p.escritos.some((x) => x.b.escribir === 'ls'))
  assert.equal(p.escritos[p.escritos.length - 1].b.n, 2, 'lo siguiente sigue con el número que viene')
  assert.match(p.aviso(), /^$/, 'confirmada la nueva, el aviso se va')
})

test('pasado un rato corto el reintento sí sale, con el mismo número', async () => {
  let intentos = 0
  const p = await abrir((b) => (b.soloEscribir && b.escribir === 'ls' && ++intentos === 1 ? 'red' : b.soloEscribir ? ok(SALIDA) : 'colgar'))
  p.teclear('ls')
  await p.esperar(() => p.escritos.length >= 1)
  p.ocultar()
  await p.avanzar(110_000)
  p.mostrar()
  await p.esperar(() => p.escritos.length >= 2)
  assert.deepEqual(p.escritos.map((x) => x.b.n), [1, 1])
})

test('un 429 dice que la PC está ocupada, no que no hay conexión', async () => {
  const p = await abrir(() => ({ status: 429, cuerpo: () => '' }))
  await p.avanzar(2000)
  assert.match(p.aviso(), /La PC está ocupada/)
  assert.doesNotMatch(p.aviso(), /Sin conexión/)
})

test('la clave del sello se deriva una vez, no en cada pedido', async () => {
  const p = await abrir(reposo)
  const real = p.slothSello.abrirClave
  let llamadas = 0
  p.slothSello.abrirClave = (c: string) => {
    llamadas++
    return real(c)
  }
  p.teclear('a')
  await p.esperar(() => p.escritos.length >= 1)
  p.teclear('b')
  await p.esperar(() => p.escritos.length >= 2)
  await p.avanzar(5000)
  assert.equal(llamadas, 0)
})
