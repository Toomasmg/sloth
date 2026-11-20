import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crearEscrituras } from './celular-escrituras'

test('la primera vez se hace y el reintento con el mismo número no', () => {
  const e = crearEscrituras()
  assert.equal(e.nueva('ws', 'sesion-1', 1, 0), true)
  assert.equal(e.nueva('ws', 'sesion-1', 1, 10), false)
  assert.equal(e.nueva('ws', 'sesion-1', 1, 20), false)
  assert.equal(e.nueva('ws', 'sesion-1', 2, 30), true)
  assert.equal(e.nueva('ws', 'sesion-1', 2, 40), false)
})

test('un número viejo (uno anterior al último hecho) tampoco se repite', () => {
  const e = crearEscrituras()
  assert.equal(e.nueva('ws', 's-1-1-1', 5, 0), true)
  assert.equal(e.nueva('ws', 's-1-1-1', 3, 1), false)
  assert.equal(e.nueva('ws', 's-1-1-1', 4, 2), false)
})

test('un hueco se acepta: lo perdido no se reenvía y lo que sigue se hace', () => {
  const e = crearEscrituras()
  assert.equal(e.nueva('ws', 'sesion-1', 1, 0), true)
  assert.equal(e.nueva('ws', 'sesion-1', 4, 1), true)
  assert.equal(e.nueva('ws', 'sesion-1', 4, 2), false)
})

test('otra página (otra sesion) o otra terminal tienen su propia cuenta: recargar y volver a empezar en 1 se hace', () => {
  const e = crearEscrituras()
  assert.equal(e.nueva('ws', 'sesion-1', 9, 0), true)
  assert.equal(e.nueva('ws', 'sesion-2', 1, 1), true)
  assert.equal(e.nueva('otra', 'sesion-1', 9, 2), true)
  assert.equal(e.nueva('ws', 'sesion-1', 9, 3), false, 'la primera sigue contada aunque otra escriba en la misma terminal')
  assert.equal(e.nueva('ws', 'sesion-2', 1, 4), false)
})

test('pasado el vencimiento se olvida: no crece para siempre', () => {
  const e = crearEscrituras(64, 1000)
  assert.equal(e.nueva('ws', 'sesion-1', 1, 0), true)
  assert.equal(e.nueva('ws', 'sesion-1', 1, 1001), true)
  assert.equal(e.nueva('ws', 'sesion-1', 1, 1500), false)
})

test('con el tope lleno se descarta la más vieja y entran las nuevas', () => {
  const e = crearEscrituras(3, 10_000)
  for (const s of ['sesion-a', 'sesion-b', 'sesion-c']) assert.equal(e.nueva('ws', s, 1, 0), true)
  assert.equal(e.nueva('ws', 'sesion-d', 1, 1), true)
  assert.equal(e.nueva('ws', 'sesion-b', 1, 2), false, 'b sigue')
  assert.equal(e.nueva('ws', 'sesion-a', 1, 3), true, 'a se descartó')
})

test('mil páginas distintas no hacen crecer el mapa más allá del tope y la última sigue protegida', () => {
  const e = crearEscrituras(8, 600_000)
  for (let i = 0; i < 1000; i++) assert.equal(e.nueva('ws', `sesion-${i}`, 1, i), true)
  assert.equal(e.nueva('ws', 'sesion-999', 1, 1000), false)
})
