import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bloqueado, escribirJsonAtomico, esObjeto, leerJson, respaldar, RESPALDOS_POR_ARCHIVO } from './json-file'
import { tomarAvisos } from './avisos'

const carpeta = (): string => mkdtempSync(join(tmpdir(), 'sloth-json-'))

interface Ajustes {
  theme: string
}
const opciones = {
  validar: (v: unknown): Ajustes | undefined => (esObjeto(v) && typeof v.theme === 'string' ? { theme: v.theme } : undefined),
  porDefecto: (): Ajustes => ({ theme: 'oscuro' })
}

test('sin archivo: valor por defecto, sin apartar ni avisar', () => {
  tomarAvisos()
  const d = carpeta()
  const r = leerJson(join(d, 'settings.json'), opciones)
  assert.deepEqual(r, { valor: { theme: 'oscuro' } })
  assert.deepEqual(tomarAvisos(), [])
  rmSync(d, { recursive: true })
})

test('archivo válido con BOM: se lee y no se toca', () => {
  const d = carpeta()
  const f = join(d, 'settings.json')
  writeFileSync(f, '﻿{"theme":"claro"}')
  assert.deepEqual(leerJson(f, opciones), { valor: { theme: 'claro' } })
  assert.deepEqual(readdirSync(d), ['settings.json'])
  rmSync(d, { recursive: true })
})

test('QA #3: settings.json con una coma de más se aparta con su contenido y avisa', () => {
  tomarAvisos()
  const d = carpeta()
  const f = join(d, 'settings.json')
  const roto = '{ "theme":"claro", "shortcuts":{}, }'
  writeFileSync(f, roto)
  const r = leerJson(f, opciones)
  assert.deepEqual(r.valor, { theme: 'oscuro' })
  assert.ok(r.apartado && /settings\.json\.corrupt-\d+$/.test(r.apartado))
  assert.equal(readFileSync(r.apartado, 'utf8'), roto)
  assert.deepEqual(readdirSync(d), [r.apartado.slice(d.length + 1)])
  const avisos = tomarAvisos()
  assert.equal(avisos.length, 1)
  assert.match(avisos[0], /settings\.json.*settings\.json\.corrupt-\d+.*valores por defecto/)
  escribirJsonAtomico(f, r.valor)
  assert.equal(readFileSync(r.apartado, 'utf8'), roto, 'el guardado siguiente no pisa el respaldo')
  rmSync(d, { recursive: true })
})

test('JSON válido que no valida también se aparta', () => {
  const d = carpeta()
  const f = join(d, 'settings.json')
  writeFileSync(f, '[1,2]')
  const r = leerJson(f, { ...opciones, silencioso: true })
  assert.ok(r.apartado)
  assert.deepEqual(r.valor, { theme: 'oscuro' })
  rmSync(d, { recursive: true })
})

test('un validador que tira cuenta como contenido inválido', () => {
  const d = carpeta()
  const f = join(d, 'x.json')
  writeFileSync(f, 'null')
  const r = leerJson(f, {
    validar: (v: unknown) => (v as { a: number }).a,
    porDefecto: () => 0,
    silencioso: true
  })
  assert.equal(r.valor, 0)
  assert.ok(r.apartado)
  rmSync(d, { recursive: true })
})

test('B1: error de lectura que no es ENOENT no tira: valores por defecto, aviso y sin escribir encima', () => {
  tomarAvisos()
  const d = carpeta()
  const f = join(d, 'settings.json')
  mkdirSync(f)
  const r = leerJson(f, opciones)
  assert.deepEqual(r.valor, { theme: 'oscuro' })
  assert.equal(r.soloLectura, true)
  assert.match(r.motivo ?? '', /no se pudo leer/)
  assert.equal(bloqueado(f), true)
  assert.equal(escribirJsonAtomico(f, { theme: 'claro' }), false)
  assert.ok(statSync(f).isDirectory(), 'no se tocó')
  assert.deepEqual(readdirSync(d), ['settings.json'])
  const avisos = tomarAvisos()
  assert.equal(avisos.length, 1)
  assert.match(avisos[0], /settings\.json no se pudo leer.*no voy a guardar cambios/)
  rmSync(d, { recursive: true })
})

test('B1: archivo roto que no se puede apartar: no tira, queda intacto y no se pisa', () => {
  tomarAvisos()
  const d = carpeta()
  const f = join(d, 'settings.json')
  writeFileSync(f, '{ roto')
  const m = mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })
  })
  syncBuiltinESMExports()
  try {
    const r = leerJson(f, opciones)
    assert.deepEqual(r.valor, { theme: 'oscuro' })
    assert.equal(r.soloLectura, true)
  } finally {
    m.mock.restore()
    syncBuiltinESMExports()
  }
  assert.equal(escribirJsonAtomico(f, { theme: 'claro' }), false)
  assert.equal(readFileSync(f, 'utf8'), '{ roto')
  assert.match(tomarAvisos()[0], /dañado y no se pudo apartar/)
  rmSync(d, { recursive: true })
})

test('soloConsulta: con el archivo roto devuelve el valor por defecto sin apartar, avisar ni bloquear', () => {
  tomarAvisos()
  const d = carpeta()
  const f = join(d, 'settings.json')
  writeFileSync(f, '{ roto')
  assert.deepEqual(leerJson(f, { ...opciones, soloConsulta: true }), { valor: { theme: 'oscuro' } })
  assert.deepEqual(readdirSync(d), ['settings.json'])
  assert.deepEqual(tomarAvisos(), [])
  assert.equal(bloqueado(f), false)
  rmSync(d, { recursive: true })
})

test('se conservan solo los 5 .corrupt-* más nuevos de cada archivo', () => {
  const d = carpeta()
  const f = join(d, 'git.json')
  for (const ts of [1, 2, 3, 4, 5, 6]) writeFileSync(`${f}.corrupt-${ts}`, String(ts))
  writeFileSync(`${f}.corrupt-6-1`, '6-1')
  writeFileSync(join(d, 'otro.json.corrupt-1'), 'x')
  writeFileSync(f, 'roto')
  const r = leerJson(f, { ...opciones, silencioso: true })
  assert.ok(r.apartado)
  const quedan = readdirSync(d).filter((n) => n.startsWith('git.json.corrupt-'))
  assert.equal(quedan.length, RESPALDOS_POR_ARCHIVO)
  assert.ok(quedan.includes(r.apartado.slice(d.length + 1)))
  assert.ok(quedan.includes('git.json.corrupt-6-1'))
  assert.ok(!quedan.includes('git.json.corrupt-1') && !quedan.includes('git.json.corrupt-2') && !quedan.includes('git.json.corrupt-3'))
  assert.ok(existsSync(join(d, 'otro.json.corrupt-1')), 'los de otro archivo no se tocan')
  rmSync(d, { recursive: true })
})

test('M1: respaldar reusa el último .bak si el contenido no cambió y poda los viejos', () => {
  const d = carpeta()
  const f = join(d, 'sloth-state.json')
  writeFileSync(f, '{"version":2}')
  const a = respaldar(f)
  assert.equal(respaldar(f), a, 'mismo contenido: no se suma otro .bak')
  writeFileSync(f, '{"version":3}')
  const b = respaldar(f)
  assert.notEqual(b, a)
  assert.equal(readFileSync(b, 'utf8'), '{"version":3}')
  for (const ts of [1, 2, 3, 4, 5]) writeFileSync(`${f}.bak-${ts}`, String(ts))
  writeFileSync(f, '{"version":4}')
  respaldar(f)
  assert.equal(readdirSync(d).filter((n) => n.startsWith('sloth-state.json.bak-')).length, RESPALDOS_POR_ARCHIVO)
  rmSync(d, { recursive: true })
})

test('respaldar tira si no hay archivo que copiar', () => {
  const d = carpeta()
  assert.throws(() => respaldar(join(d, 'no.json')))
  rmSync(d, { recursive: true })
})

test('al leer se borran los .tmp viejos de otro proceso; los recientes y los propios quedan', () => {
  const d = carpeta()
  const f = join(d, 'a.json')
  const viejo = `${f}.999999.tmp`
  const reciente = `${f}.999998.tmp`
  const propio = `${f}.${process.pid}.tmp`
  for (const t of [viejo, reciente, propio]) writeFileSync(t, '{')
  const hace = new Date(Date.now() - 10 * 60_000)
  utimesSync(viejo, hace, hace)
  utimesSync(propio, hace, hace)
  leerJson(f, opciones)
  assert.equal(existsSync(viejo), false)
  assert.equal(existsSync(reciente), true)
  assert.equal(existsSync(propio), true)
  rmSync(d, { recursive: true })
})

test('M3: si el rename falla, escribirJsonAtomico tira y no deja el .tmp', () => {
  const d = carpeta()
  const f = join(d, 'a.json')
  mkdirSync(join(f, 'adentro'), { recursive: true })
  assert.throws(() => escribirJsonAtomico(f, { a: 1 }))
  assert.deepEqual(readdirSync(d), ['a.json'])
  rmSync(d, { recursive: true })
})

test('M3: un fsync que el disco no soporta no impide guardar; otro error sí y no deja el .tmp', () => {
  const d = carpeta()
  const f = join(d, 'a.json')
  let codigo = 'EINVAL'
  const m = mock.method(fs, 'fsyncSync', () => {
    throw Object.assign(new Error(codigo), { code: codigo })
  })
  syncBuiltinESMExports()
  try {
    assert.equal(escribirJsonAtomico(f, { a: 1 }), true)
    assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { a: 1 })
    codigo = 'EIO'
    assert.throws(() => escribirJsonAtomico(f, { a: 2 }), /EIO/)
  } finally {
    m.mock.restore()
    syncBuiltinESMExports()
  }
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { a: 1 })
  assert.deepEqual(readdirSync(d), ['a.json'])
  rmSync(d, { recursive: true })
})

test('escribirJsonAtomico crea la carpeta, reemplaza y no deja el tmp', () => {
  const d = carpeta()
  const f = join(d, 'features', 'a.json')
  escribirJsonAtomico(f, { a: 1 })
  escribirJsonAtomico(f, { a: 2 })
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { a: 2 })
  assert.deepEqual(readdirSync(join(d, 'features')), ['a.json'])
  rmSync(d, { recursive: true })
})
