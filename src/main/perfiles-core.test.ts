import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  aCopiar,
  dentroDe,
  idPerfilValido,
  nombreLibre,
  nombrePerfilValido,
  nuevoIdPerfil,
  reconstruirIndice,
  validarIndice,
  validarMeta,
  type Perfil
} from './perfiles-core'

const p = (id: string, nombre: string, creado: number): Perfil => ({ id, nombre, creado })

test('ids: solo minúsculas, dígitos y guiones, hasta 40, sin nombres reservados de Windows', () => {
  for (const ok of ['principal', 'p-abc123', 'a', 'x'.repeat(40), 'con1', 'nulo']) assert.equal(idPerfilValido(ok), true, ok)
  for (const mal of ['', '../x', '..', '.', 'A', 'a/b', 'a\\b', '-a', 'x'.repeat(41), 'con', 'nul', 'aux', 'prn', 'com1', 'lpt9', 'perfil.', 'ñandú', 'a b', 7, null])
    assert.equal(idPerfilValido(mal), false, String(mal))
})

test('nombre: se recorta, 1 a 40 caracteres, sin control ni caracteres engañosos', () => {
  assert.equal(nombrePerfilValido('  Trabajo  '), 'Trabajo')
  assert.equal(nombrePerfilValido('Ñandú 🦥'), 'Ñandú 🦥')
  assert.equal(nombrePerfilValido('../../Windows'), '../../Windows')
  assert.equal(nombrePerfilValido('🦥'.repeat(40)), '🦥'.repeat(40))
  assert.equal(nombrePerfilValido('x'.repeat(40)), 'x'.repeat(40))
  for (const mal of ['', '   ', 'x'.repeat(41), 'a\nb', 'a\u0000b', 'a\u007fb', 'abc‮dcba', 'a​b', 3, undefined])
    assert.equal(nombrePerfilValido(mal), null, JSON.stringify(mal))
  assert.equal(nombrePerfilValido('José'), 'José')
})

test('nombreLibre: no distingue mayúsculas y puede ignorar el propio', () => {
  const lista = [p('principal', 'Mi perfil', 1), p('p-1', 'Trabajo', 2)]
  assert.equal(nombreLibre('TRABAJO', lista), false)
  assert.equal(nombreLibre(' trabajo ', lista), false)
  assert.equal(nombreLibre('Trabajo', lista, 'p-1'), true)
  assert.equal(nombreLibre('Casa', lista), true)
})

test('nuevoIdPerfil: reintenta hasta no chocar', () => {
  const salidas = ['abc', 'abc', 'def']
  assert.equal(nuevoIdPerfil(['p-abc'], () => salidas.shift() ?? 'zzz'), 'p-def')
})

test('validarMeta: exige id, nombre y fecha válidos', () => {
  assert.deepEqual(validarMeta({ id: 'principal', nombre: 'Mi perfil', creado: 5, extra: 1 }), p('principal', 'Mi perfil', 5))
  assert.deepEqual(validarMeta({ id: 'p-1', nombre: 'A', creado: 1, ghLogin: 'octo-cat' }), { ...p('p-1', 'A', 1), ghLogin: 'octo-cat' })
  for (const mal of [null, [], 'x', { id: '../x', nombre: 'A', creado: 1 }, { id: 'a', nombre: '', creado: 1 }, { id: 'a', nombre: 'A', creado: 'hoy' }, { id: 'a', nombre: 'A', creado: Number.NaN }, { id: 'a', nombre: 'A', creado: 1, ghLogin: 'a b' }])
    assert.equal(validarMeta(mal), null, JSON.stringify(mal))
})

test('validarIndice: rechaza activo inexistente, ids repetidos, otra versión y no-objetos', () => {
  const bueno = { version: 1, activo: 'principal', perfiles: [p('principal', 'Mi perfil', 1)] }
  assert.deepEqual(validarIndice(bueno), bueno)
  assert.equal(validarIndice({ ...bueno, activo: 'otro' }), null)
  assert.equal(validarIndice({ ...bueno, perfiles: [p('principal', 'A', 1), p('principal', 'B', 2)] }), null)
  assert.equal(validarIndice({ ...bueno, version: 2 }), null)
  assert.equal(validarIndice({ ...bueno, perfiles: [{ id: 'con', nombre: 'A', creado: 1 }], activo: 'con' }), null)
  for (const mal of [null, 'x', [], 1, { version: 1 }]) assert.equal(validarIndice(mal), null)
})

test('reconstruirIndice: ordena por fecha y conserva el activo previo si sigue existiendo', () => {
  const metas = [p('p-b', 'B', 20), p('principal', 'Mi perfil', 10)]
  assert.deepEqual(reconstruirIndice(metas, 'p-b'), { version: 1, activo: 'p-b', perfiles: [metas[1], metas[0]] })
  assert.equal(reconstruirIndice(metas, 'p-perdido')?.activo, 'principal')
  assert.equal(reconstruirIndice(metas)?.activo, 'principal')
  assert.equal(reconstruirIndice([]), null)
})

test('aCopiar: solo el estado y las funciones, nunca logins, claves ni respaldos', () => {
  assert.deepEqual(
    aCopiar(['accounts', 'daemon-key', 'daemon-token', 'sloth-state.json', 'sloth-state.json.bak-1', 'sloth-state.json.corrupt-2', 'features', 'logs', 'whisper', 'perfiles', 'respaldos']),
    ['sloth-state.json', 'features']
  )
})

test('dentroDe: rechaza salir con .. y carpetas hermanas con el mismo prefijo', () => {
  const base = join('/a', 'perfiles')
  assert.equal(dentroDe(base, join(base, 'principal')), true)
  assert.equal(dentroDe(base, join(base, 'principal', 'features', 'x.json')), true)
  assert.equal(dentroDe(base, base), false)
  assert.equal(dentroDe(base, join(base, '..', 'accounts')), false)
  assert.equal(dentroDe(base, join(base, 'principal', '..', '..', 'x')), false)
  assert.equal(dentroDe(base, join('/a', 'perfiles-x')), false)
  assert.equal(dentroDe(base, join('/a', 'perfiles-x', 'y')), false)
})
