import { test } from 'node:test'
import assert from 'node:assert/strict'
import { migrar } from '../versionado'
import { ENTRADA_MS, MAX_ENTRADAS, VENCE_SIN_USO_MS, VERSION_CELULAR, crearEntradas, leerCelus, migracionesCelular, paraVista, permisosDe, sinVencidos, usar, type CeluGuardado } from './celular-acceso'

const CLAVE = Buffer.alloc(32, 7).toString('base64url')
const OTRA = Buffer.alloc(32, 8).toString('base64url')
const AHORA = 1_800_000_000_000
const quien = { ip: '192.168.1.40', ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile Safari/537.36' }

/** Así era celular.json antes de numerarlo (v1): una sola clave para todos. */
const ARCHIVO_V1 = {
  encendido: true,
  puerto: 47321,
  clave: CLAVE,
  aprobar: true,
  terminal: false,
  ntfy: { encendido: false, tema: 'sloth-abcdefabcdefabcdefabcdef', servidor: 'https://ntfy.sh' },
  remoto: { encendido: false, aprobar: false, secreto: OTRA },
  campoQueNoConozco: 1
}

test('migrar v1: la clave de antes queda como un celu con acceso y el QR se queda sin clave (se genera una nueva)', () => {
  const r = migrar(ARCHIVO_V1, migracionesCelular(AHORA), VERSION_CELULAR)
  assert.equal(r.estado, 'migrado')
  assert.equal(r.datos.version, 2)
  assert.equal(r.datos.clave, undefined)
  assert.deepEqual(r.datos.celus, [{ id: 'antes', nombre: 'Celus emparejados antes', clave: CLAVE, nivel: 'controlar', creado: AHORA, ultimo: AHORA }])
  assert.equal(r.datos.campoQueNoConozco, 1, 'lo desconocido se conserva')
  assert.equal(r.datos.aprobar, true)
  assert.equal(ARCHIVO_V1.clave, CLAVE, 'no muta la entrada')
})

test('migrar v1 sin clave válida: ningún celu queda adentro', () => {
  const r = migrar({ ...ARCHIVO_V1, clave: 'corta' }, migracionesCelular(AHORA), VERSION_CELULAR)
  assert.deepEqual(r.datos.celus, [])
})

test('una versión más nueva que la app no se toca', () => {
  const futuro = { version: 3, celus: 'otra cosa' }
  const r = migrar(futuro, migracionesCelular(AHORA), VERSION_CELULAR)
  assert.equal(r.estado, 'futura')
  assert.equal(r.datos, futuro)
})

test('leerCelus descarta los rotos, los vencidos, las claves repetidas y la del QR', () => {
  const bien: CeluGuardado = { id: 'a1', nombre: 'Android · Chrome', clave: CLAVE, nivel: 'aprobar', creado: AHORA, ultimo: AHORA }
  const lista = [
    bien,
    { ...bien, id: 'a2' },
    { ...bien, id: 'viejo', clave: Buffer.alloc(32, 1).toString('base64url'), ultimo: AHORA - VENCE_SIN_USO_MS - 1 },
    { ...bien, id: 'qr', clave: OTRA },
    { ...bien, id: 'nivel', clave: Buffer.alloc(32, 2).toString('base64url'), nivel: 'root' },
    { ...bien, id: 'mal id!', clave: Buffer.alloc(32, 3).toString('base64url') },
    'cualquier cosa'
  ]
  assert.deepEqual(leerCelus(lista, AHORA, OTRA), [bien])
  assert.deepEqual(leerCelus('no', AHORA), [])
})

test('sinVencidos saca los que pasaron 30 días sin usarse', () => {
  const c: CeluGuardado = { id: 'a', nombre: 'x', clave: CLAVE, nivel: 'ver', creado: 0, ultimo: AHORA }
  assert.equal(sinVencidos([c], AHORA + VENCE_SIN_USO_MS).length, 1)
  assert.equal(sinVencidos([c], AHORA + VENCE_SIN_USO_MS + 1).length, 0)
})

test('usar anota el uso a lo sumo una vez por hora', () => {
  const c: CeluGuardado = { id: 'a', nombre: 'x', clave: CLAVE, nivel: 'ver', creado: 0, ultimo: AHORA }
  assert.equal(usar(c, AHORA + 60_000), false)
  assert.equal(usar(c, AHORA + 3600_000), true)
  assert.equal(c.ultimo, AHORA + 3600_000)
})

test('el panel nunca recibe la clave', () => {
  const v = paraVista([{ id: 'a', nombre: 'x', clave: CLAVE, nivel: 'ver', creado: 1, ultimo: 2 }])
  assert.deepEqual(v, [{ id: 'a', nombre: 'x', nivel: 'ver', creado: 1, ultimo: 2 }])
  assert.equal(JSON.stringify(v).includes(CLAVE), false)
})

test('el nivel nunca da más de lo que prenden los interruptores', () => {
  const todo = { aprobar: true, terminal: true }
  assert.deepEqual(permisosDe('ver', todo), { aprobar: false, terminal: false })
  assert.deepEqual(permisosDe('aprobar', todo), { aprobar: true, terminal: false })
  assert.deepEqual(permisosDe('controlar', todo), { aprobar: true, terminal: true })
  assert.deepEqual(permisosDe('controlar', { aprobar: false, terminal: false }), { aprobar: false, terminal: false })
})

test('entradas: pedir da un código de 4 dígitos; el mismo pedido repetido, el mismo código', () => {
  const e = crearEntradas()
  const r = e.pedir(CLAVE, quien, AHORA)
  assert.ok('codigo' in r && /^\d{4}$/.test(r.codigo))
  assert.deepEqual(e.pedir(CLAVE, quien, AHORA + 1000), r)
  const [p] = e.pendientes(AHORA)
  assert.equal(p.nombre, 'Android · Chrome')
  assert.equal(p.ip, quien.ip)
  assert.equal(p.codigo, (r as { codigo: string }).codigo)
  assert.equal(JSON.stringify(e.pendientes(AHORA)).includes(CLAVE), false, 'la clave del celu no va al panel')
})

test('entradas: dejar entrar, rechazar, y lo que vence', () => {
  const e = crearEntradas()
  e.pedir(CLAVE, quien, AHORA)
  e.pedir(OTRA, quien, AHORA)
  const [a, b] = e.pendientes(AHORA)
  assert.equal(e.estado(CLAVE, AHORA), 'esperando')
  const si = e.responder(a.id, true, AHORA)
  assert.ok(si)
  assert.equal(e.estado(si.clave, AHORA), 'listo')
  assert.equal(e.responder(a.id, false, AHORA), null, 'no se responde dos veces')
  e.responder(b.id, false, AHORA)
  assert.equal(e.pendientes(AHORA).length, 0)
  const otra = e.pedir(si.clave, quien, AHORA)
  assert.ok('error' in otra, 'una clave ya respondida no vuelve a pedir')
  assert.equal(e.estado(CLAVE, AHORA + ENTRADA_MS + 1), 'vencido')
  assert.equal(e.responder(b.id, true, AHORA + ENTRADA_MS + 1), null)
})

test('entradas: con muchos esperando, no se aceptan más (el QR no sirve para llenar el panel)', () => {
  const e = crearEntradas()
  for (let i = 0; i < MAX_ENTRADAS; i++) assert.ok('codigo' in e.pedir(Buffer.alloc(32, 20 + i).toString('base64url'), quien, AHORA))
  assert.ok('error' in e.pedir(CLAVE, quien, AHORA))
  assert.equal(new Set(e.pendientes(AHORA).map((p) => p.codigo)).size, MAX_ENTRADAS, 'códigos distintos')
  assert.ok('codigo' in e.pedir(CLAVE, quien, AHORA + ENTRADA_MS + 1), 'al vencer los de antes, entra')
})

test('proximoVence: cuánto falta para que caduque el primero que espera', () => {
  const e = crearEntradas()
  assert.equal(e.proximoVence(AHORA), null)
  e.pedir(CLAVE, quien, AHORA)
  assert.equal(e.proximoVence(AHORA + 1000), ENTRADA_MS - 1000)
})
