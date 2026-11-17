import { test } from 'node:test'
import assert from 'node:assert/strict'
import { migrar, type Migraciones } from './versionado'

test('sin version con actual 1: migrado, trae version 1 y no pierde campos', () => {
  const entrada = { accounts: [{ id: 'a' }], extra: { x: 1 } }
  const r = migrar(entrada, {}, 1)
  assert.equal(r.estado, 'migrado')
  assert.deepEqual(r.datos, { accounts: [{ id: 'a' }], extra: { x: 1 }, version: 1 })
  assert.equal(r.desde, 1)
  assert.equal(r.hasta, 1)
})

test('version explícita igual a la actual: actual, sin copiar', () => {
  const entrada = { version: 1, a: 1 }
  const r = migrar(entrada, {}, 1)
  assert.equal(r.estado, 'actual')
  assert.equal(r.datos, entrada)
})

test('la cadena v1 a v3 aplica las migraciones en orden', () => {
  const orden: number[] = []
  const migraciones: Migraciones = {
    1: (d) => {
      orden.push(1)
      return { ...d, paso1: true }
    },
    2: (d) => {
      orden.push(2)
      return { ...d, paso2: d.paso1 === true }
    }
  }
  const r = migrar({ version: 1, dato: 'x' }, migraciones, 3)
  assert.deepEqual(orden, [1, 2])
  assert.equal(r.estado, 'migrado')
  assert.deepEqual(r.datos, { version: 3, dato: 'x', paso1: true, paso2: true })
  assert.equal(r.desde, 1)
  assert.equal(r.hasta, 3)
})

test('una migración no puede dejar una version vieja en el resultado', () => {
  const r = migrar({ version: 1 }, { 1: (d) => ({ ...d, version: 7 }) }, 2)
  assert.equal(r.datos.version, 2)
})

test('no muta la entrada, ni siquiera lo anidado', () => {
  const entrada = { version: 1, lista: [1, 2], anidado: { n: 1 } }
  const copiaProfunda = structuredClone(entrada)
  const r = migrar(
    entrada,
    {
      1: (d) => {
        ;(d.lista as number[]).push(3)
        ;(d.anidado as { n: number }).n = 99
        return d
      }
    },
    2
  )
  assert.equal(r.estado, 'migrado')
  assert.deepEqual(entrada, copiaProfunda)
  assert.deepEqual(r.datos.lista, [1, 2, 3])
})

test('falta un eslabón: invalida con motivo', () => {
  const r = migrar({ version: 1 }, { 2: (d) => d }, 3)
  assert.equal(r.estado, 'invalida')
  assert.match(r.motivo ?? '', /falta la migración de la versión 1 a la 2/)
})

test('una migración que tira o que no devuelve un objeto: invalida y no tira', () => {
  const tira = migrar(
    { version: 1 },
    {
      1: () => {
        throw new Error('boom')
      }
    },
    2
  )
  assert.equal(tira.estado, 'invalida')
  assert.match(tira.motivo ?? '', /boom/)
  const rara = migrar({ version: 1 }, { 1: () => [] as unknown as Record<string, unknown> }, 2)
  assert.equal(rara.estado, 'invalida')
})

test('versión futura: misma referencia, sin tocar', () => {
  const entrada = { version: 2, accounts: [], campoNuevo: { a: 1 } }
  const r = migrar(entrada, {}, 1)
  assert.equal(r.estado, 'futura')
  assert.equal(r.datos, entrada)
  assert.deepEqual(entrada, { version: 2, accounts: [], campoNuevo: { a: 1 } })
  assert.equal(r.desde, 2)
})

test('version rara: texto, fraccionaria, cero, negativa, null o booleana es inválida', () => {
  for (const version of ['2', '1', 1.5, 0, -1, null, true, [], {}, NaN]) {
    const r = migrar({ version }, {}, 1)
    assert.equal(r.estado, 'invalida', JSON.stringify(version))
    assert.ok(r.motivo)
  }
})

test('lo que no es un objeto es inválido', () => {
  for (const x of [null, undefined, [], [{ version: 1 }], 'texto', 3, true]) {
    assert.equal(migrar(x, {}, 1).estado, 'invalida')
  }
})

test('un número enorme es una versión futura, no un error', () => {
  assert.equal(migrar({ version: 1e300 }, {}, 1).estado, 'futura')
})
