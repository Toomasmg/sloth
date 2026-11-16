import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deA } from './concurrencia'

test('deA no pasa de n a la vez y corre todos', async () => {
  let enCurso = 0
  let maximo = 0
  const hechos: number[] = []
  await deA([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
    enCurso++
    maximo = Math.max(maximo, enCurso)
    await new Promise((r) => setTimeout(r, 5))
    hechos.push(x)
    enCurso--
  })
  assert.equal(maximo, 3)
  assert.deepEqual([...hechos].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7])
})

test('deA con lista vacía o n menor a 1 no se cuelga', async () => {
  await deA([], 3, async () => assert.fail('no debería correr'))
  const hechos: string[] = []
  await deA(['a', 'b'], 0, async (x) => {
    hechos.push(x)
  })
  assert.deepEqual(hechos, ['a', 'b'])
})

test('deA rechaza si una tarea tira', async () => {
  await assert.rejects(
    deA([1, 2], 2, async (x) => {
      if (x === 2) throw new Error('mal')
    }),
    /mal/
  )
})
