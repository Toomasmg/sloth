import { test } from 'node:test'
import assert from 'node:assert/strict'
import { closeAllViews, getViews, pushView, topViewId } from './view-stack'

test('la Vista de arriba es la última que se montó y al sacarla vuelve la anterior', () => {
  const offA = pushView({ id: 'a', request: () => {}, isDirty: () => false })
  const offB = pushView({ id: 'b', request: () => {}, isDirty: () => false })
  assert.equal(topViewId(), 'b')
  offB()
  assert.equal(topViewId(), 'a')
  offA()
  assert.equal(topViewId(), null)
})

test('closeAllViews cierra de arriba hacia abajo', () => {
  const order: string[] = []
  const offs = ['a', 'b'].map((id) => pushView({ id, request: () => order.push(id), isDirty: () => false }))
  assert.equal(closeAllViews(), true)
  assert.deepEqual(order, ['b', 'a'])
  offs.forEach((off) => off())
  assert.equal(getViews().length, 0)
})

test('closeAllViews para en la primera con cambios sin guardar y no cierra las de abajo', () => {
  const order: string[] = []
  const offA = pushView({ id: 'a', request: () => order.push('a'), isDirty: () => false })
  const offB = pushView({ id: 'b', request: () => order.push('b'), isDirty: () => true })
  assert.equal(closeAllViews(), false)
  assert.deepEqual(order, ['b'])
  offB()
  offA()
})
