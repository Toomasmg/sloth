import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Account, Workspace } from '../../../shared/types'
import { armarModelo, coincide, leerPlegadas, normalizarFiltro } from './sidebar-model'

const cuenta = (id: string): Account => ({ id, label: id, configDir: `/${id}`, createdAt: 0 })
const espacio = (id: string, accountId: string, extra: Partial<Workspace> = {}): Workspace => ({
  id,
  name: id,
  repoPath: '/r',
  cwd: '/r',
  accountId,
  autoStartClaude: false,
  createdAt: 0,
  ...extra
})

const cuentas = [cuenta('a'), cuenta('b')]
const espacios = [
  espacio('api-pagos', 'a', { branch: 'feat/pagos', ticket: 'COS-142' }),
  espacio('frontend', 'a'),
  espacio('blog', 'b'),
  espacio('huerfano', 'borrada')
]

test('el filtro busca en nombre, rama y ticket sin distinguir mayúsculas', () => {
  const f = normalizarFiltro('  PAGOS ')
  assert.equal(f, 'pagos')
  assert.ok(coincide(espacios[0], f))
  assert.ok(coincide(espacios[0], 'cos-1'))
  assert.ok(coincide(espacios[0], 'feat/'))
  assert.ok(!coincide(espacios[1], f))
  assert.ok(coincide(espacios[1], ''))
})

test('sin filtro: todas las cuentas, cada una con sus espacios y los huérfanos aparte', () => {
  const m = armarModelo(cuentas, espacios, '', {})
  assert.deepEqual(m.grupos.map((g) => [g.cuenta.id, g.visibles.map((w) => w.id), g.abierto]), [
    ['a', ['api-pagos', 'frontend'], true],
    ['b', ['blog'], true]
  ])
  assert.deepEqual(m.huerfanos.map((w) => w.id), ['huerfano'])
  assert.equal(m.sinResultados, false)
})

test('una cuenta plegada queda cerrada pero conserva todos sus espacios para el resumen', () => {
  const m = armarModelo(cuentas, espacios, '', { a: true })
  assert.equal(m.grupos[0].abierto, false)
  assert.equal(m.grupos[0].todos.length, 2)
})

test('con filtro, las cuentas sin coincidencias se van y las que quedan se abren aunque estén plegadas', () => {
  const m = armarModelo(cuentas, espacios, 'pagos', { a: true })
  assert.deepEqual(m.grupos.map((g) => [g.cuenta.id, g.visibles.map((w) => w.id), g.abierto, g.todos.length]), [['a', ['api-pagos'], true, 2]])
  assert.deepEqual(m.huerfanos, [])
})

test('el filtro también alcanza a los huérfanos, y sin nada que coincida avisa', () => {
  assert.deepEqual(armarModelo(cuentas, espacios, 'huerf', {}).huerfanos.map((w) => w.id), ['huerfano'])
  const nada = armarModelo(cuentas, espacios, 'zzz', {})
  assert.equal(nada.sinResultados, true)
  assert.equal(armarModelo([], [], '', {}).sinResultados, false)
})

test('leerPlegadas tolera lo que no sea un objeto', () => {
  assert.deepEqual(leerPlegadas('{"a":true}'), { a: true })
  for (const malo of [null, '', '[1]', '7', 'null', '{no json']) assert.deepEqual(leerPlegadas(malo), {})
})
