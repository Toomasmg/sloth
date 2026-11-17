import { test } from 'node:test'
import assert from 'node:assert/strict'
import { podarSegunStore } from './poda'

const existe = (id: string): boolean => id === 'w1'

test('I2: con el store confiable se poda lo que ya no existe', () => {
  assert.deepEqual(podarSegunStore(['w1', 'w2'], existe, true), { vista: ['w1'], guardar: ['w1'] })
})

test('I2: con el store vacío o incompleto la vista se filtra pero el archivo conserva todo', () => {
  assert.deepEqual(podarSegunStore(['w1', 'w2'], existe, false), { vista: ['w1'], guardar: ['w1', 'w2'] })
  assert.deepEqual(podarSegunStore(['w2', 'w3'], () => false, false), { vista: [], guardar: ['w2', 'w3'] })
})
