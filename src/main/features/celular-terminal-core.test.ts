import { test } from 'node:test'
import assert from 'node:assert/strict'
import { leerPedidoTerminal, tamanoActual, MAX_ESCRIBIR, MAX_VISOR_CHARS, nuevoVisor, ponerFoto, salidaDesde, sumarSalida, vencidos } from './celular-terminal-core'

const c = (seq: number, data = `[${seq}]`) => ({ seq, data })

test('la foto se junta con lo que llegó en vivo mientras se pedía, sin repetir', () => {
  const v = nuevoVisor(0)
  sumarSalida(v, [c(4), c(5)])
  ponerFoto(v, [c(1), c(2), c(3), c(4)], 4)
  assert.deepEqual(v.chunks.map((x) => x.seq), [1, 2, 3, 4, 5])
  assert.equal(v.foto, 4)
})

test('la primera vez va todo; después, solo lo nuevo', () => {
  const v = nuevoVisor(0)
  ponerFoto(v, [c(1), c(2)], 2)
  assert.deepEqual(salidaDesde(v, -1), { reinicio: true, datos: '[1][2]', hasta: 2 })
  sumarSalida(v, [c(3)])
  assert.deepEqual(salidaDesde(v, 2), { reinicio: false, datos: '[3]', hasta: 3 })
  assert.deepEqual(salidaDesde(v, 3), { reinicio: false, datos: '', hasta: 3 })
})

test('si el celu pide algo ya recortado o de otro visor, se le manda todo de nuevo', () => {
  const v = nuevoVisor(0)
  ponerFoto(v, [c(10), c(11)], 11)
  assert.equal(salidaDesde(v, 3).reinicio, true)
  assert.equal(salidaDesde(v, 50).reinicio, true)
  assert.equal(salidaDesde(v, 9).reinicio, false)
})

test('el visor no pasa del tope, pero nunca queda vacío', () => {
  const v = nuevoVisor(0)
  ponerFoto(v, [c(1, 'x'.repeat(MAX_VISOR_CHARS)), c(2, 'y'.repeat(10))], 2)
  assert.deepEqual(v.chunks.map((x) => x.seq), [2])
  const w = nuevoVisor(0)
  sumarSalida(w, [c(1, 'z'.repeat(MAX_VISOR_CHARS + 5))])
  assert.equal(w.chunks.length, 1)
})

test('valida el pedido del celu', () => {
  assert.deepEqual(leerPedidoTerminal({ id: 'ws-1', desde: -1 }), { id: 'ws-1', desde: -1 })
  assert.deepEqual(leerPedidoTerminal({ id: 'ws-1', desde: 3, escribir: 'hola\r', tam: { cols: 60, rows: 30 } }), { id: 'ws-1', desde: 3, escribir: 'hola\r', tam: { cols: 60, rows: 30 } })
  assert.deepEqual(leerPedidoTerminal({ id: 'ws-1', desde: 0, tam: 'pc' }), { id: 'ws-1', desde: 0, tam: 'pc' })
  assert.equal(leerPedidoTerminal(null), null)
  assert.equal(leerPedidoTerminal({ id: '../x', desde: 0 }), null)
  assert.equal(leerPedidoTerminal({ id: 'login:abc', desde: 0 }), null)
  assert.equal(leerPedidoTerminal({ id: 'ws', desde: -2 }), null)
  assert.equal(leerPedidoTerminal({ id: 'ws', desde: 1.5 }), null)
  assert.equal(leerPedidoTerminal({ id: 'ws', desde: 0, escribir: '' }), null)
  assert.equal(leerPedidoTerminal({ id: 'ws', desde: 0, escribir: 'x'.repeat(MAX_ESCRIBIR + 1) }), null)
  assert.equal(leerPedidoTerminal({ id: 'ws', desde: 0, tam: { cols: 5, rows: 30 } }), null)
  assert.equal(leerPedidoTerminal({ id: 'ws', desde: 0, tam: 'grande' }), null)
})

test('vencen los visores que nadie consulta', () => {
  const m = new Map([['a', nuevoVisor(0)], ['b', nuevoVisor(25_000)]])
  assert.deepEqual(vencidos(m, 40_000), ['a'])
})

test('el tamaño: el del celu mientras la PC no se mueva; si la PC cambia, gana la PC', () => {
  const v = nuevoVisor(0)
  assert.deepEqual(tamanoActual(v, { cols: 120, rows: 30 }), { cols: 120, rows: 30 })
  assert.deepEqual(tamanoActual(undefined, null), { cols: 80, rows: 24 })
  v.ajustado = { cols: 45, rows: 40 }
  v.pcAlAjustar = { cols: 120, rows: 30 }
  assert.deepEqual(tamanoActual(v, { cols: 120, rows: 30 }), { cols: 45, rows: 40 })
  assert.deepEqual(tamanoActual(v, { cols: 140, rows: 30 }), { cols: 140, rows: 30 })
  assert.equal(v.ajustado, null)
})
