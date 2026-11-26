import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Account, Workspace } from '../../../shared/types'
import { armarModelo } from './sidebar-model'
import { accionNav, claveCuenta, claveEspacio, idDeCuenta, itemActivo, itemsNav, type AccionNav, type ItemNav } from './sidebar-nav'

const cuenta = (id: string): Account => ({ id, label: id, configDir: `/${id}`, createdAt: 0 })
const espacio = (id: string, accountId: string): Workspace => ({ id, name: id, repoPath: '/r', cwd: '/r', accountId, autoStartClaude: false, createdAt: 0 })

const cuentas = [cuenta('a'), cuenta('b'), cuenta('vacia')]
const espacios = [espacio('a1', 'a'), espacio('a2', 'a'), espacio('b1', 'b'), espacio('h1', 'borrada')]
const A = claveCuenta('a')
const B = claveCuenta('b')
const E = claveEspacio
const items = (filtro = '', plegadas: Record<string, boolean> = {}): ItemNav[] => itemsNav(armarModelo(cuentas, espacios, filtro, plegadas), filtro)
const claves = (l: ItemNav[]): string[] => l.map((i) => i.clave)
const nada: AccionNav = { tipo: 'nada' }
const foco = (clave: string): AccionNav => ({ tipo: 'foco', clave })

test('el orden visible: cada cuenta con sus espacios, las plegadas sin ellos y los huérfanos al final', () => {
  assert.deepEqual(claves(items()), [A, E('a1'), E('a2'), B, E('b1'), claveCuenta('vacia'), E('h1')])
  assert.deepEqual(claves(items('', { a: true })), [A, B, E('b1'), claveCuenta('vacia'), E('h1')])
})

test('con filtro solo quedan las cuentas con coincidencias, abiertas y sin poder plegarse', () => {
  const l = items('b1')
  assert.deepEqual(claves(l), [B, E('b1')])
  assert.equal(l[0].abierta, true)
  assert.equal(l[0].plegable, false)
})

test('flechas, Inicio y Fin recorren todas las cuentas sin envolver', () => {
  const l = items()
  const tabla: [string, string, AccionNav | null][] = [
    [A, 'ArrowDown', foco(E('a1'))],
    [E('a2'), 'ArrowDown', foco(B)],
    [B, 'ArrowUp', foco(E('a2'))],
    [E('a1'), 'ArrowUp', foco(A)],
    [A, 'ArrowUp', nada],
    [E('h1'), 'ArrowDown', nada],
    [E('a2'), 'Home', foco(A)],
    [A, 'Home', nada],
    [A, 'End', foco(E('h1'))],
    [E('h1'), 'End', nada],
    [A, 'Enter', null],
    [A, 'a', null],
    [A, 'Tab', null]
  ]
  for (const [actual, tecla, esperado] of tabla) assert.deepEqual(accionNav(l, actual, tecla), esperado, `${actual} + ${tecla}`)
})

test('→ despliega una cuenta plegada, entra a una abierta y no hace nada en una fila', () => {
  const abierta = items()
  assert.deepEqual(accionNav(abierta, A, 'ArrowRight'), foco(E('a1')))
  assert.deepEqual(accionNav(abierta, claveCuenta('vacia'), 'ArrowRight'), nada)
  assert.deepEqual(accionNav(abierta, E('a1'), 'ArrowRight'), nada)
  assert.deepEqual(accionNav(items('', { a: true }), A, 'ArrowRight'), { tipo: 'desplegar', clave: A })
})

test('← pliega una cuenta abierta y desde una fila vuelve a su encabezado', () => {
  const l = items()
  assert.deepEqual(accionNav(l, A, 'ArrowLeft'), { tipo: 'plegar', clave: A })
  assert.deepEqual(accionNav(items('', { a: true }), A, 'ArrowLeft'), nada)
  assert.deepEqual(accionNav(l, E('b1'), 'ArrowLeft'), foco(B))
  assert.deepEqual(accionNav(l, E('h1'), 'ArrowLeft'), nada)
})

test('con filtro no se pliega ni se despliega, pero sí se entra y se vuelve', () => {
  const l = items('a')
  assert.deepEqual(accionNav(l, A, 'ArrowLeft'), nada)
  assert.deepEqual(accionNav(l, A, 'ArrowRight'), foco(E('a1')))
  assert.deepEqual(accionNav(l, E('a1'), 'ArrowLeft'), foco(A))
})

test('si el elemento actual ya no está, las flechas arrancan por un extremo', () => {
  const l = items()
  assert.deepEqual(accionNav(l, 'espacio:ya-no-esta', 'ArrowDown'), foco(A))
  assert.deepEqual(accionNav(l, null, 'ArrowUp'), foco(E('h1')))
  assert.deepEqual(accionNav([], A, 'ArrowDown'), nada)
})

test('el único elemento en el orden de Tab: el último con foco, si no el preferido, si no el primero', () => {
  const l = items()
  assert.equal(itemActivo(l, E('a2'), E('b1')), E('a2'))
  assert.equal(itemActivo(l, 'espacio:ya-no-esta', E('b1')), E('b1'))
  assert.equal(itemActivo(l, null, 'espacio:tampoco'), A)
  assert.equal(itemActivo([], null, null), null)
})

test('las claves de cuenta se pueden volver a leer', () => {
  assert.equal(idDeCuenta(claveCuenta('x:y')), 'x:y')
  assert.equal(idDeCuenta(E('x')), null)
})
