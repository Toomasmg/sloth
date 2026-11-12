import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortPaneActions, withSeparators, type PaneAction } from './pane-actions'

const act = (id: string, group: PaneAction['group'], order: number): PaneAction => ({ id, label: id, group, order, run: () => {} })

test('ordena por grupo y después por order, sin importar quién la sumó', () => {
  const out = sortPaneActions([act('cerrar', 'panel', 30), act('mover', 'compartir', 20), act('renombrar', 'editar', 10), act('cambios', 'ver', 10), act('plantilla', 'compartir', 10)])
  assert.deepEqual(
    out.map((a) => a.id),
    ['renombrar', 'cambios', 'plantilla', 'mover', 'cerrar']
  )
})

test('un id repetido queda una sola vez (la primera)', () => {
  const a = act('x', 'ver', 10)
  const out = sortPaneActions([a, { ...act('x', 'panel', 1), label: 'otra' }])
  assert.equal(out.length, 1)
  assert.equal(out[0], a)
})

test('separa los grupos, nunca al principio ni dos seguidos', () => {
  const out = withSeparators(sortPaneActions([act('a', 'editar', 1), act('b', 'editar', 2), act('c', 'panel', 1)]))
  assert.deepEqual(
    out.map((x) => (x === 'sep' ? '|' : x.id)),
    ['a', 'b', '|', 'c']
  )
  assert.deepEqual(withSeparators([]), [])
})
