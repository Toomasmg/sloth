import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crearLimite } from './celular-limite'

test('pasan 200 pedidos en la ventana y el 201 no', () => {
  const l = crearLimite()
  for (let i = 0; i < 200; i++) assert.equal(l.permitir('1.1.1.1', 1000 + i), true, `pedido ${i}`)
  assert.equal(l.permitir('1.1.1.1', 1500), false)
  assert.equal(l.permitir('1.1.1.1', 1500), false)
})

test('pasada la ventana vuelve a dejar pasar, y los rechazados no estiran el castigo', () => {
  const l = crearLimite(3, 1000)
  for (let t = 0; t < 3; t++) assert.equal(l.permitir('a', t), true)
  for (let t = 3; t < 900; t += 100) assert.equal(l.permitir('a', t), false)
  assert.equal(l.permitir('a', 1001), true, 'salió el primero')
  assert.equal(l.permitir('a', 1001), true)
  assert.equal(l.permitir('a', 1002), true)
  assert.equal(l.permitir('a', 1003), false)
  assert.equal(l.permitir('a', 5000), true)
})

test('cada cliente tiene su cuenta: uno que se pasa no le quita lugar a otro', () => {
  const l = crearLimite(2, 1000)
  assert.equal(l.permitir('malo', 0), true)
  assert.equal(l.permitir('malo', 0), true)
  assert.equal(l.permitir('malo', 0), false)
  assert.equal(l.permitir('celu', 0), true)
  assert.equal(l.permitir('celu', 1), true)
})

test('las claves no crecen sin tope: con el cupo lleno se descarta la más vieja, y primero se sueltan las vencidas', () => {
  const l = crearLimite(1, 1000, 4)
  for (const c of ['a', 'b', 'c', 'd']) assert.equal(l.permitir(c, 0), true)
  assert.equal(l.permitir('e', 10), true, 'sin vencidas: entra y echa a la más vieja')
  assert.equal(l.permitir('a', 10), true, 'a fue descartada: arranca de cero')
  assert.equal(l.permitir('d', 10), false, 'd sigue contada')
  assert.equal(l.permitir('f', 5000), true, 'todas vencieron: se podan y f entra')
  assert.equal(l.permitir('d', 5000), true, 'd vencida, vuelve a pasar')
})

test('muchas claves distintas no rompen nada ni agrandan la memoria más allá del tope', () => {
  const l = crearLimite(5, 1000, 8)
  for (let i = 0; i < 10_000; i++) assert.equal(l.permitir(`ip-${i}`, i), true)
  assert.equal(l.permitir('ip-9999', 10_000), true)
})
