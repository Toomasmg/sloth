import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planRotacion } from './rotacion'

const base = { max: 100, base: 'sloth', mantener: 3 }

test('bajo el máximo no rota', () => {
  const p = planRotacion({ ...base, tamanoActual: 99, existentes: ['sloth.log', 'sloth.1.log'] })
  assert.deepEqual(p, { rotar: false, mover: [], borrar: [] })
})

test('un log vacío no rota aunque el máximo sea 0', () => {
  assert.equal(planRotacion({ ...base, max: 0, tamanoActual: 0, existentes: [] }).rotar, false)
})

test('en el máximo, sin rotados, solo pasa sloth.log a sloth.1.log', () => {
  const p = planRotacion({ ...base, tamanoActual: 100, existentes: ['sloth.log'] })
  assert.deepEqual(p, { rotar: true, mover: [{ de: 'sloth.log', a: 'sloth.1.log' }], borrar: [] })
})

test('con dos rotados los corre del más viejo al más nuevo', () => {
  const p = planRotacion({ ...base, tamanoActual: 150, existentes: ['sloth.log', 'sloth.1.log', 'sloth.2.log'] })
  assert.deepEqual(p.mover, [
    { de: 'sloth.2.log', a: 'sloth.3.log' },
    { de: 'sloth.1.log', a: 'sloth.2.log' },
    { de: 'sloth.log', a: 'sloth.1.log' }
  ])
  assert.deepEqual(p.borrar, [])
})

test('con `mantener` rotados borra el más viejo antes de mover', () => {
  const p = planRotacion({
    ...base,
    tamanoActual: 100,
    existentes: ['sloth.3.log', 'sloth.log', 'sloth.1.log', 'sloth.2.log']
  })
  assert.deepEqual(p.borrar, ['sloth.3.log'])
  assert.deepEqual(p.mover, [
    { de: 'sloth.2.log', a: 'sloth.3.log' },
    { de: 'sloth.1.log', a: 'sloth.2.log' },
    { de: 'sloth.log', a: 'sloth.1.log' }
  ])
})

test('borra también los rotados que sobran de una configuración anterior', () => {
  const p = planRotacion({ ...base, tamanoActual: 100, existentes: ['sloth.5.log', 'sloth.4.log', 'sloth.1.log'] })
  assert.deepEqual(p.borrar, ['sloth.5.log', 'sloth.4.log'])
  assert.deepEqual(p.mover, [
    { de: 'sloth.1.log', a: 'sloth.2.log' },
    { de: 'sloth.log', a: 'sloth.1.log' }
  ])
})

test('los nombres ajenos no se tocan', () => {
  const ajenos = ['sesion.json', 'sloth.1.log.bak', 'otro.1.log', 'sloth.01.log', 'sloth.x.log', 'sloth.0.log', 'xsloth.1.log']
  const p = planRotacion({ ...base, tamanoActual: 100, existentes: [...ajenos, 'sloth.1.log'] })
  assert.deepEqual(p.mover, [
    { de: 'sloth.1.log', a: 'sloth.2.log' },
    { de: 'sloth.log', a: 'sloth.1.log' }
  ])
  assert.deepEqual(p.borrar, [])
})

test('un base con puntos no se confunde con una expresión regular', () => {
  const p = planRotacion({ ...base, base: 'a.b', tamanoActual: 100, existentes: ['aXb.1.log', 'a.b.1.log'] })
  assert.deepEqual(p.mover, [
    { de: 'a.b.1.log', a: 'a.b.2.log' },
    { de: 'a.b.log', a: 'a.b.1.log' }
  ])
})

test('sin rotados que conservar se borra el log actual', () => {
  const p = planRotacion({ ...base, mantener: 0, tamanoActual: 100, existentes: ['sloth.1.log'] })
  assert.deepEqual(p, { rotar: true, mover: [], borrar: ['sloth.1.log', 'sloth.log'] })
})
