import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import type { EstadoCelular } from '../../shared/celular'
import { crearFuenteWifi, type OpcionesWifi, type ProveedorDeEstado } from './celular-servidor'
import { abrirRespuesta, derivarClaves, sellarPedido, type Claves } from './celular-sello'

const CLAVE = Buffer.alloc(32, 7).toString('base64url')
const ESTADO: EstadoCelular = { ahora: 1, aprobar: false, terminal: false, cuentas: [], sesiones: [], pedidos: [] }

const claves = derivarClaves(CLAVE) as Claves
const clavesQr = claves

async function conServidor(over: Partial<ProveedorDeEstado>, fn: (base: string, decisiones: string[]) => Promise<void>, opciones: Partial<OpcionesWifi> = {}): Promise<void> {
  const decisiones: string[] = []
  const proveedor: ProveedorDeEstado = {
    estado: async () => ESTADO,
    decidir: (id, d) => {
      decisiones.push(`${id}:${d}`)
    },
    puedeAprobar: () => false,
    clave: () => CLAVE,
    icono: () => null,
    terminal: async () => ({ status: 403, error: 'La terminal desde el celu está apagada en Sloth.' }),
    xterm: () => null,
    ...over
  }
  const f = crearFuenteWifi({ host: '127.0.0.1', puerto: 0, proveedor, ...opciones })
  await f.iniciar()
  try {
    await fn(`http://127.0.0.1:${f.puerto()}`, decisiones)
  } finally {
    await f.detener()
  }
}

const enviarSobre = (base: string, ruta: string, sobre: string): Promise<Response> => fetch(base + ruta, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: sobre })

interface Opciones {
  t?: number
  rutaSellada?: string
  /** Otra clave que la del QR de siempre (la de un celu con acceso). */
  con?: string
}

/** Manda un pedido sellado como lo hace la página y abre la respuesta; la hora y la ruta sellada se pueden falsear. */
async function postSellado(base: string, ruta: string, obj: unknown, o: Opciones = {}): Promise<{ status: number; cuerpo: unknown; texto: string }> {
  const iv = randomBytes(16)
  const claves = o.con ? (derivarClaves(o.con) as Claves) : clavesQr
  const sobre = sellarPedido(claves, o.rutaSellada ?? ruta, JSON.stringify({ t: o.t ?? Date.now(), b: obj }), iv)
  const r = await enviarSobre(base, ruta, sobre)
  const texto = await r.text()
  const plano = r.status === 401 || texto === '' ? null : abrirRespuesta(claves, iv, texto)
  return { status: r.status, cuerpo: plano === null ? null : JSON.parse(plano), texto }
}

test('sin cuerpo, con el MAC roto o con otra ruta: 401 sin cuerpo', async () => {
  await conServidor({}, async (base) => {
    const sin = await enviarSobre(base, '/api/estado', '')
    assert.equal(sin.status, 401)
    assert.equal(await sin.text(), '')
    const sobre = sellarPedido(claves, '/api/estado', JSON.stringify({ t: Date.now(), b: {} }))
    const roto = await enviarSobre(base, '/api/estado', sobre.slice(0, -2) + (sobre.endsWith('AA') ? 'BB' : 'AA'))
    assert.equal(roto.status, 401)
    assert.equal(await roto.text(), '')
    const otraRuta = await postSellado(base, '/api/permiso', { id: 'p', decision: 'allow' }, { rutaSellada: '/api/estado' })
    assert.equal(otraRuta.status, 401)
    assert.equal(otraRuta.texto, '')
  })
})

test('la PC sabe quién pidió (IP y navegador) solo cuando la clave es buena', async () => {
  const vistos: unknown[] = []
  await conServidor(
    {
      estado: async (q) => {
        vistos.push(['estado', q])
        return ESTADO
      },
      puedeAprobar: () => true,
      decidir: (id, d, q) => void vistos.push(['decidir', id, d, q])
    },
    async (base) => {
      const ua = 'Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile'
      const iv = randomBytes(16)
      await fetch(base + '/api/estado', { method: 'POST', headers: { 'user-agent': ua }, body: sellarPedido(claves, '/api/estado', JSON.stringify({ t: Date.now(), b: {} }), iv) })
      await fetch(base + '/api/estado', { method: 'POST', headers: { 'user-agent': ua }, body: 'roto' })
      await postSellado(base, '/api/permiso', { id: 'p1', decision: 'deny' })
      assert.equal(vistos.length, 2, 'el pedido con la clave mala no llega a la PC')
      assert.deepEqual(vistos[0], ['estado', { ip: '127.0.0.1', ua }])
      const [tipo, id, d, q] = vistos[1] as [string, string, string, { ip: string; ua: string }]
      assert.deepEqual([tipo, id, d, q.ip], ['decidir', 'p1', 'deny', '127.0.0.1'])
    }
  )
})

test('con el sobre bien sellado devuelve el estado sellado, sin caché', async () => {
  await conServidor({}, async (base) => {
    const iv = randomBytes(16)
    const sobre = sellarPedido(claves, '/api/estado', JSON.stringify({ t: Date.now(), b: {} }), iv)
    const r = await enviarSobre(base, '/api/estado', sobre)
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('cache-control'), 'no-store')
    const texto = await r.text()
    assert.ok(!texto.includes('cuentas'))
    assert.deepEqual(JSON.parse(abrirRespuesta(claves, iv, texto) ?? 'null'), ESTADO)
  })
})

test('la respuesta de un pedido no abre con el iv de otro', async () => {
  await conServidor({}, async (base) => {
    const r = await enviarSobre(base, '/api/estado', sellarPedido(claves, '/api/estado', JSON.stringify({ t: Date.now(), b: {} })))
    assert.equal(abrirRespuesta(claves, randomBytes(16), await r.text()), null)
  })
})

test('el mismo sobre dos veces: la segunda es un 409 sellado «repetido», no un 401', async () => {
  await conServidor({}, async (base) => {
    const sobre = sellarPedido(claves, '/api/estado', JSON.stringify({ t: Date.now(), b: {} }))
    assert.equal((await enviarSobre(base, '/api/estado', sobre)).status, 200)
    const otra = await enviarSobre(base, '/api/estado', sobre)
    assert.equal(otra.status, 409)
    assert.notEqual(await otra.text(), '')
  })
})

test('un pedido con la hora a 10 minutos de la PC: 409 sellado «reloj», no 401', async () => {
  await conServidor({}, async (base) => {
    for (const t of [Date.now() - 10 * 60_000, Date.now() + 10 * 60_000]) {
      const r = await postSellado(base, '/api/estado', {}, { t })
      assert.equal(r.status, 409)
      assert.deepEqual(r.cuerpo, { error: 'reloj' })
    }
  })
})

test('GET a las rutas de datos: 401 (para que una página vieja pida re-escanear); el viejo x-sloth-token con la clave no sirve', async () => {
  await conServidor({}, async (base) => {
    const g = await fetch(`${base}/api/estado`)
    assert.equal(g.status, 401)
    assert.equal(await g.text(), '')
    assert.equal((await fetch(`${base}/api/estado`, { method: 'PUT' })).status, 405)
    const viejo = await fetch(`${base}/api/estado`, { method: 'POST', headers: { 'x-sloth-token': CLAVE }, body: '{}' })
    assert.equal(viejo.status, 401)
    assert.equal(await viejo.text(), '')
  })
})

test('aprobar desde el celu apagado: 403 sellado y no decide nada', async () => {
  await conServidor({}, async (base, decisiones) => {
    const r = await postSellado(base, '/api/permiso', { id: 'p1', decision: 'allow' })
    assert.equal(r.status, 403)
    assert.deepEqual(r.cuerpo, { error: 'Aprobar desde el celu está apagado en Sloth.' })
    assert.deepEqual(decisiones, [])
  })
})

test('aprobar prendido: valida el pedido y pasa la decisión', async () => {
  await conServidor({ puedeAprobar: () => true }, async (base, decisiones) => {
    assert.equal((await postSellado(base, '/api/permiso', { id: 'p1', decision: 'allow' })).status, 200)
    assert.equal((await postSellado(base, '/api/permiso', { id: 'p2', decision: 'allowAlways' })).status, 400)
    assert.equal((await postSellado(base, '/api/permiso', { id: 'p'.repeat(200), decision: 'deny' })).status, 400)
    assert.equal((await postSellado(base, '/api/permiso', 'suelto')).status, 400)
    assert.deepEqual(decisiones, ['p1:allow'])
  })
})

test('si el pedido ya no está, el celu recibe el motivo sellado', async () => {
  const decidir = (): void => {
    throw new Error('Ese permiso ya no está pendiente.')
  }
  await conServidor({ puedeAprobar: () => true, decidir }, async (base) => {
    const r = await postSellado(base, '/api/permiso', { id: 'p1', decision: 'deny' })
    assert.equal(r.status, 409)
    assert.deepEqual(r.cuerpo, { error: 'Ese permiso ya no está pendiente.' })
  })
})

test('los archivos de la página se revalidan con ETag: si el celu ya los tiene, 304 sin cuerpo', async () => {
  await conServidor({ icono: () => Buffer.from('png') }, async (base) => {
    for (const ruta of ['/app.js', '/app.css', '/icono.png']) {
      const r = await fetch(base + ruta)
      assert.equal(r.status, 200)
      assert.equal(r.headers.get('cache-control'), 'no-cache')
      const etag = r.headers.get('etag') ?? ''
      assert.match(etag, /^"[\w-]+"$/)
      await r.arrayBuffer()
      const otra = await fetch(base + ruta, { headers: { 'if-none-match': etag } })
      assert.equal(otra.status, 304, ruta)
      assert.equal(await otra.text(), '')
      assert.equal((await fetch(base + ruta, { headers: { 'if-none-match': '"viejo"' } })).status, 200)
    }
  })
})

test('la página se sirve sin clave, con CSP y sin referer; lo desconocido es 404', async () => {
  await conServidor({}, async (base) => {
    const r = await fetch(`${base}/`)
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-security-policy') ?? '', /script-src 'self'/)
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer')
    const html = await r.text()
    assert.ok(!html.includes(CLAVE))
    // Sin hosts de afuera: sin internet (o con un portal cautivo) la página no queda en blanco esperándolos.
    assert.doesNotMatch(html, /(?:href|src)="https?:/)
    assert.doesNotMatch(r.headers.get('content-security-policy') ?? '', /https?:/)
    assert.equal(r.headers.get('cache-control'), 'no-store')
    const js = await fetch(`${base}/app.js`)
    assert.equal(js.status, 200)
    assert.ok((await js.text()).includes('slothSello'))
    assert.equal((await fetch(`${base}/icono.png`)).status, 404)
    assert.equal((await fetch(`${base}/.env`)).status, 404)
  })
})

test('terminal: sin sello no hay nada; con el pedido mal armado, 400; apagada, 403 sellado', async () => {
  const pedidos: unknown[] = []
  const terminal: ProveedorDeEstado['terminal'] = async (p) => {
    pedidos.push(p)
    return { status: 403, error: 'La terminal desde el celu está apagada en Sloth.' }
  }
  await conServidor({ terminal }, async (base) => {
    const sin = await enviarSobre(base, '/api/terminal', '')
    assert.equal(sin.status, 401)
    assert.equal(await sin.text(), '')
    assert.equal((await postSellado(base, '/api/terminal', { id: 'ws', desde: 0, escribir: 'x'.repeat(5000) })).status, 400)
    assert.equal((await postSellado(base, '/api/terminal', { id: 'login:a', desde: 0 })).status, 400)
    const r = await postSellado(base, '/api/terminal', { id: 'ws-1', desde: -1, escribir: 'ls\r' })
    assert.equal(r.status, 403)
    assert.deepEqual(r.cuerpo, { error: 'La terminal desde el celu está apagada en Sloth.' })
    assert.deepEqual(pedidos, [{ id: 'ws-1', desde: -1, escribir: 'ls\r' }])
  })
})

test('terminal prendida: la salida vuelve sellada (nada en claro en la red)', async () => {
  const terminal: ProveedorDeEstado['terminal'] = async () => ({ reinicio: true, datos: 'secreto-de-la-terminal', hasta: 3, mas: false, viva: true, cols: 80, rows: 24, ajustado: false })
  await conServidor({ terminal }, async (base) => {
    const r = await postSellado(base, '/api/terminal', { id: 'ws-1', desde: -1 })
    assert.equal(r.status, 200)
    assert.ok(!r.texto.includes('secreto'))
    assert.equal((r.cuerpo as { datos: string }).datos, 'secreto-de-la-terminal')
  })
})

test('xterm se sirve solo si está; sin él, 404', async () => {
  await conServidor({}, async (base) => {
    assert.equal((await fetch(`${base}/xterm.js`)).status, 404)
  })
  await conServidor({ xterm: () => ({ js: 'var x', css: '.x{}' }) }, async (base) => {
    const js = await fetch(`${base}/xterm.js`)
    assert.equal(js.status, 200)
    assert.match(js.headers.get('content-type') ?? '', /javascript/)
    assert.equal(await (await fetch(`${base}/xterm.css`)).text(), '.x{}')
  })
})

const SIN_SALIDA = { reinicio: false, datos: '', hasta: 0, mas: false, viva: true, cols: 80, rows: 24, ajustado: false }

test('terminal: lleva los campos nuevos al proveedor y rechaza las mezclas que no valen sin llegar a él', async () => {
  const pedidos: unknown[] = []
  const terminal: ProveedorDeEstado['terminal'] = async (p) => {
    pedidos.push(p)
    return SIN_SALIDA
  }
  await conServidor({ terminal }, async (base) => {
    assert.equal((await postSellado(base, '/api/terminal', { id: 'ws', desde: 4, espera: 20000, sesion: 'sesion-abc' })).status, 200)
    assert.equal((await postSellado(base, '/api/terminal', { id: 'ws', desde: 4, soloEscribir: true, escribir: 'a', sesion: 'sesion-abc', n: 3 })).status, 200)
    assert.equal((await postSellado(base, '/api/terminal', { id: 'ws', desde: 4, espera: 20000, escribir: 'a' })).status, 400)
    assert.equal((await postSellado(base, '/api/terminal', { id: 'ws', desde: 4, espera: 99999 })).status, 400)
    assert.equal((await postSellado(base, '/api/terminal', { id: 'ws', desde: 4, soloEscribir: true })).status, 400)
    assert.deepEqual(pedidos, [
      { id: 'ws', desde: 4, espera: 20000, sesion: 'sesion-abc' },
      { id: 'ws', desde: 4, escribir: 'a', soloEscribir: true, sesion: 'sesion-abc', n: 3 }
    ])
  })
})

test('terminal: pasados 200 pedidos en 5 s, 429 sin cuerpo; los que no pasan el MAC no gastan el cupo', async () => {
  let llegaron = 0
  const terminal: ProveedorDeEstado['terminal'] = async () => {
    llegaron++
    return SIN_SALIDA
  }
  await conServidor({ terminal }, async (base) => {
    for (let i = 0; i < 300; i++) assert.equal((await enviarSobre(base, '/api/terminal', 'basura' + i)).status, 401)
    for (let i = 0; i < 200; i++) assert.equal((await postSellado(base, '/api/terminal', { id: 'ws', desde: 0 })).status, 200, `pedido ${i}`)
    const iv = randomBytes(16)
    const sobre = sellarPedido(claves, '/api/terminal', JSON.stringify({ t: Date.now(), b: { id: 'ws', desde: 0 } }), iv)
    const r = await enviarSobre(base, '/api/terminal', sobre)
    assert.equal(r.status, 429)
    assert.equal(await r.text(), '')
    assert.equal(llegaron, 200)
    const otraRuta = await postSellado(base, '/api/estado', {})
    assert.equal(otraRuta.status, 200, 'el límite es solo de la terminal')
  })
})

test('terminal: un 429 del proveedor (demasiadas esperas) vuelve sellado', async () => {
  const terminal: ProveedorDeEstado['terminal'] = async () => ({ status: 429, error: 'La PC tiene demasiadas terminales abiertas desde el celu.' })
  await conServidor({ terminal }, async (base) => {
    const r = await postSellado(base, '/api/terminal', { id: 'ws', desde: 1, espera: 1000 })
    assert.equal(r.status, 429)
    assert.deepEqual(r.cuerpo, { error: 'La PC tiene demasiadas terminales abiertas desde el celu.' })
  })
})

function proveedorColgado(): { terminal: ProveedorDeEstado['terminal']; llego: Promise<void>; señal: () => AbortSignal | null; terminaron: () => number } {
  let señal: AbortSignal | null = null
  let terminaron = 0
  let avisarLlegada: () => void = () => undefined
  const llego = new Promise<void>((r) => {
    avisarLlegada = r
  })
  const terminal: ProveedorDeEstado['terminal'] = (_p, cancelar) =>
    new Promise((resolve) => {
      señal = cancelar ?? null
      avisarLlegada()
      cancelar?.addEventListener('abort', () => {
        terminaron++
        resolve(SIN_SALIDA)
      })
    })
  return { terminal, llego, señal: () => señal, terminaron: () => terminaron }
}

test('terminal: si el celu corta la conexión con el pedido abierto, el proveedor recibe la señal y no queda nada colgado', async () => {
  const c = proveedorColgado()
  await conServidor({ terminal: c.terminal }, async (base) => {
    const ctl = new AbortController()
    const iv = randomBytes(16)
    const sobre = sellarPedido(claves, '/api/terminal', JSON.stringify({ t: Date.now(), b: { id: 'ws', desde: 3, espera: 20000 } }), iv)
    const abierto = fetch(`${base}/api/terminal`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: sobre, signal: ctl.signal })
    await c.llego
    assert.equal(c.señal()?.aborted, false)
    ctl.abort()
    await assert.rejects(abierto)
    for (let i = 0; i < 100 && !c.señal()?.aborted; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(c.señal()?.aborted, true)
    for (let i = 0; i < 100 && c.terminaron() === 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(c.terminaron(), 1)
    assert.equal((await postSellado(base, '/api/estado', {})).status, 200, 'el servidor sigue atendiendo')
  })
})

test('terminal: detener() con un pedido abierto corta la conexión, suelta la espera y no se cuelga', async () => {
  const c = proveedorColgado()
  const f = crearFuenteWifi({
    host: '127.0.0.1',
    puerto: 0,
    proveedor: { estado: async () => ESTADO, decidir: () => undefined, puedeAprobar: () => false, clave: () => CLAVE, icono: () => null, terminal: c.terminal, xterm: () => null }
  })
  await f.iniciar()
  const sobre = sellarPedido(claves, '/api/terminal', JSON.stringify({ t: Date.now(), b: { id: 'ws', desde: 3, espera: 20000 } }))
  const abierto = fetch(`http://127.0.0.1:${f.puerto()}/api/terminal`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: sobre })
  const rechazo = assert.rejects(abierto)
  await c.llego
  const limite = new Promise<string>((r) => setTimeout(() => r('colgado'), 3000))
  assert.equal(await Promise.race([f.detener().then(() => 'detenido'), limite]), 'detenido')
  await rechazo
  for (let i = 0; i < 100 && c.terminaron() === 0; i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(c.señal()?.aborted, true)
  assert.equal(c.terminaron(), 1)
})

const puertoDe = (base: string): number => Number(new URL(base).port)

function socketDesde(origen: string, puerto: number): Promise<{ socket: Socket; cerrado: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: puerto, localAddress: origen })
    const cerrado = new Promise<void>((r) => socket.once('close', () => r()))
    socket.once('error', reject)
    socket.once('connect', () => resolve({ socket: socket.on('error', () => undefined), cerrado }))
  })
}

test('conexiones: un equipo que llena su cupo con sockets ociosos no deja sin servicio a otro', async () => {
  await conServidor(
    {},
    async (base) => {
      const malos = await Promise.all([1, 2, 3].map(() => socketDesde('127.0.0.2', puertoDe(base))))
      const de_mas = await socketDesde('127.0.0.2', puertoDe(base))
      await de_mas.cerrado
      assert.equal(de_mas.socket.destroyed, true, 'el cuarto del mismo equipo se corta')
      assert.equal(malos.every((m) => !m.socket.destroyed), true, 'los tres primeros siguen')
      assert.equal((await postSellado(base, '/api/estado', {})).status, 200, 'el celu, desde otra dirección, sigue andando')
      malos[0].socket.destroy()
      await malos[0].cerrado
      const vuelve = await socketDesde('127.0.0.2', puertoDe(base))
      assert.equal(vuelve.socket.destroyed, false, 'al cerrarse una vuelve el lugar')
      for (const m of [...malos, vuelve]) m.socket.destroy()
    },
    { maxConexionesPorIp: 3 }
  )
})

test('conexiones: una que no manda nada se corta sola', async () => {
  await conServidor(
    {},
    async (base) => {
      const callado = await socketDesde('127.0.0.1', puertoDe(base))
      await callado.cerrado
      assert.equal(callado.socket.destroyed, true)
      assert.equal((await postSellado(base, '/api/estado', {})).status, 200)
    },
    { ociosoMs: 150 }
  )
})

test('emparejar: con la clave del QR solo se pide entrar; los datos abren con la clave de un celu que la PC dejó entrar', async () => {
  const CELU = Buffer.alloc(32, 9).toString('base64url')
  const lista: { id: string; clave: string }[] = []
  const vistos: unknown[] = []
  await conServidor(
    {
      celus: () => lista,
      entrar: (b, q) => {
        vistos.push(['entrar', b, q.celu])
        return { status: 200, data: { codigo: '0042', estado: 'esperando' } }
      },
      estado: async (q) => {
        vistos.push(['estado', q?.celu])
        return ESTADO
      },
      puedeAprobar: (q) => q?.celu === 'c1',
      decidir: (id, d, q) => void vistos.push(['decidir', id, d, q?.celu])
    },
    async (base) => {
      assert.equal((await postSellado(base, '/api/estado', {})).status, 401, 'el QR solo no deja ver nada')
      assert.equal((await postSellado(base, '/api/terminal', { id: 'w', desde: -1 })).status, 401)
      const pide = await postSellado(base, '/api/emparejar', { clave: CELU })
      assert.equal(pide.status, 200)
      assert.deepEqual(pide.cuerpo, { codigo: '0042', estado: 'esperando' })
      assert.equal((await postSellado(base, '/api/estado', {}, { con: CELU })).status, 401, 'sin el sí de la PC, la clave del celu no sirve')
      lista.push({ id: 'c1', clave: CELU })
      assert.equal((await postSellado(base, '/api/estado', {}, { con: CELU })).status, 200)
      const ya = await postSellado(base, '/api/emparejar', { clave: CELU }, { con: CELU })
      assert.deepEqual([ya.status, ya.cuerpo], [200, { ya: true }], 'con la clave del celu, emparejar dice que ya está')
      assert.equal((await postSellado(base, '/api/permiso', { id: 'p', decision: 'allow' }, { con: CELU })).status, 200, 'puedeAprobar recibe quién es')
      lista.length = 0
      assert.equal((await postSellado(base, '/api/estado', {}, { con: CELU })).status, 401, 'sacado de la lista, queda afuera en el acto')
      assert.deepEqual(vistos, [['entrar', { clave: CELU }, undefined], ['estado', 'c1'], ['decidir', 'p', 'allow', 'c1']])
    }
  )
})

test('emparejar sin proveedor de entradas (como en v1): la clave del QR da acceso y emparejar contesta que ya está', async () => {
  await conServidor({}, async (base) => {
    assert.equal((await postSellado(base, '/api/estado', {})).status, 200)
    const ya = await postSellado(base, '/api/emparejar', { clave: CLAVE })
    assert.deepEqual([ya.status, ya.cuerpo], [200, { ya: true }])
  })
})
