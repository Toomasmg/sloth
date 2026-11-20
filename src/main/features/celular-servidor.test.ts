import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import type { EstadoCelular } from '../../shared/celular'
import { crearFuenteWifi, type ProveedorDeEstado } from './celular-servidor'
import { abrirRespuesta, derivarClaves, sellarPedido, type Claves } from './celular-sello'

const CLAVE = Buffer.alloc(32, 7).toString('base64url')
const ESTADO: EstadoCelular = { ahora: 1, aprobar: false, terminal: false, cuentas: [], sesiones: [], pedidos: [] }

const claves = derivarClaves(CLAVE) as Claves

async function conServidor(over: Partial<ProveedorDeEstado>, fn: (base: string, decisiones: string[]) => Promise<void>): Promise<void> {
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
  const f = crearFuenteWifi({ host: '127.0.0.1', puerto: 0, proveedor })
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
}

/** Manda un pedido sellado como lo hace la página y abre la respuesta; la hora y la ruta sellada se pueden falsear. */
async function postSellado(base: string, ruta: string, obj: unknown, o: Opciones = {}): Promise<{ status: number; cuerpo: unknown; texto: string }> {
  const iv = randomBytes(16)
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

test('la página se sirve sin clave, con CSP y sin referer; lo desconocido es 404', async () => {
  await conServidor({}, async (base) => {
    const r = await fetch(`${base}/`)
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-security-policy') ?? '', /script-src 'self'/)
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer')
    assert.ok(!(await r.text()).includes(CLAVE))
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
