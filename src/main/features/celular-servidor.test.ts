import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { EstadoCelular } from '../../shared/celular'
import { crearFuenteWifi, type ProveedorDeEstado } from './celular-servidor'

const TOKEN = 'x'.repeat(43)
const ESTADO: EstadoCelular = { ahora: 1, aprobar: false, cuentas: [], sesiones: [], pedidos: [] }

async function conServidor(over: Partial<ProveedorDeEstado>, fn: (base: string, decisiones: string[]) => Promise<void>): Promise<void> {
  const decisiones: string[] = []
  const proveedor: ProveedorDeEstado = {
    estado: async () => ESTADO,
    decidir: (id, d) => {
      decisiones.push(`${id}:${d}`)
    },
    puedeAprobar: () => false,
    token: () => TOKEN,
    icono: () => null,
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

const post = (url: string, token: string, body: unknown): Promise<Response> =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sloth-token': token }, body: JSON.stringify(body) })

test('sin token o con uno equivocado: 401 sin cuerpo', async () => {
  await conServidor({}, async (base) => {
    const sin = await fetch(`${base}/api/estado`)
    assert.equal(sin.status, 401)
    assert.equal(await sin.text(), '')
    const mal = await fetch(`${base}/api/estado`, { headers: { 'x-sloth-token': 'y'.repeat(43) } })
    assert.equal(mal.status, 401)
    assert.equal((await post(`${base}/api/permiso`, 'nada', { id: 'p', decision: 'allow' })).status, 401)
  })
})

test('con token devuelve el estado, sin caché', async () => {
  await conServidor({}, async (base) => {
    const r = await fetch(`${base}/api/estado`, { headers: { 'x-sloth-token': TOKEN } })
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await r.json(), ESTADO)
  })
})

test('aprobar desde el celu apagado: 403 y no decide nada', async () => {
  await conServidor({}, async (base, decisiones) => {
    const r = await post(`${base}/api/permiso`, TOKEN, { id: 'p1', decision: 'allow' })
    assert.equal(r.status, 403)
    assert.deepEqual(decisiones, [])
  })
})

test('aprobar prendido: valida el pedido y pasa la decisión', async () => {
  await conServidor({ puedeAprobar: () => true }, async (base, decisiones) => {
    assert.equal((await post(`${base}/api/permiso`, TOKEN, { id: 'p1', decision: 'allow' })).status, 200)
    assert.equal((await post(`${base}/api/permiso`, TOKEN, { id: 'p2', decision: 'allowAlways' })).status, 400)
    assert.equal((await post(`${base}/api/permiso`, TOKEN, { id: 'p'.repeat(200), decision: 'deny' })).status, 400)
    assert.deepEqual(decisiones, ['p1:allow'])
  })
})

test('si el pedido ya no está, el celu recibe el motivo', async () => {
  const decidir = (): void => {
    throw new Error('Ese permiso ya no está pendiente.')
  }
  await conServidor({ puedeAprobar: () => true, decidir }, async (base) => {
    const r = await post(`${base}/api/permiso`, TOKEN, { id: 'p1', decision: 'deny' })
    assert.equal(r.status, 409)
    assert.deepEqual(await r.json(), { error: 'Ese permiso ya no está pendiente.' })
  })
})

test('la página se sirve sin token, con CSP y sin referer; lo desconocido es 404', async () => {
  await conServidor({}, async (base) => {
    const r = await fetch(`${base}/?t=${TOKEN}`)
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-security-policy') ?? '', /script-src 'self'/)
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer')
    assert.ok(!(await r.text()).includes(TOKEN))
    assert.equal((await fetch(`${base}/app.js`)).status, 200)
    assert.equal((await fetch(`${base}/icono.png`)).status, 404)
    assert.equal((await fetch(`${base}/.env`)).status, 404)
  })
})
