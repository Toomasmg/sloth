import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupNotes, plain } from './updater-notes'

test('agrupa por encabezados conocidos y los ordena Nuevo, Mejoras, Arreglos', () => {
  const md = '## Arreglos\n- a\n## Nuevo\n- b\n### Mejoras:\n- c'
  assert.deepEqual(groupNotes(md), [
    { id: 'nuevo', label: 'Nuevo', items: ['b'] },
    { id: 'mejoras', label: 'Mejoras', items: ['c'] },
    { id: 'arreglos', label: 'Arreglos', items: ['a'] }
  ])
})

test('reconoce encabezados con acentos, emojis y sinónimos', () => {
  const g = groupNotes('## 🚀 Novedades\n* x\n## Corrección\n1. y\n## Fixes\n+ z')
  assert.deepEqual(g.map((x) => x.id), ['nuevo', 'arreglos'])
  assert.deepEqual(g[1].items, ['y', 'z'])
})

test('un encabezado desconocido conserva su texto como grupo propio, después de los fijos', () => {
  const g = groupNotes('## Seguridad\n- s\n## Nuevo\n- n')
  assert.deepEqual(g.map((x) => x.label), ['Nuevo', 'Seguridad'])
})

test('viñetas sin encabezado van a Novedades', () => {
  assert.deepEqual(groupNotes('- uno\n- dos'), [{ id: 'otros', label: 'Novedades', items: ['uno', 'dos'] }])
})

test('sin viñetas, el texto suelto son las novedades y se ignoran los separadores', () => {
  const g = groupNotes('Hola\n---\nChau')
  assert.deepEqual(g[0].items, ['Hola', 'Chau'])
})

test('con viñetas, el texto suelto se descarta', () => {
  assert.deepEqual(groupNotes('intro\n- a')[0].items, ['a'])
})

test('entradas vacías o no texto dan lista vacía', () => {
  assert.deepEqual(groupNotes(''), [])
  assert.deepEqual(groupNotes(null), [])
  assert.deepEqual(groupNotes(undefined), [])
  assert.deepEqual(groupNotes('   \n\n  '), [])
  assert.deepEqual(groupNotes('## Nuevo'), [])
})

test('acepta saltos de línea CRLF', () => {
  assert.deepEqual(groupNotes('## Nuevo\r\n- a\r\n- b\r\n')[0].items, ['a', 'b'])
})

test('limita a 60 ítems por grupo y 300 caracteres por ítem', () => {
  const md = Array.from({ length: 100 }, (_, i) => `- item ${i}`).join('\n')
  assert.equal(groupNotes(md)[0].items.length, 60)
  assert.equal(groupNotes(`- ${'x'.repeat(5000)}`)[0].items[0].length, 300)
})

test('una entrada enorme no se cuelga', () => {
  const md = `## Nuevo\n${'- a [b](c) `d` **e**\n'.repeat(20000)}`
  assert.equal(groupNotes(md)[0].items.length, 60)
})

test('ignora viñetas que quedan vacías tras limpiar el markdown', () => {
  assert.deepEqual(groupNotes('- <br>\n- ![img](x)'), [])
})

test('plain quita markdown en línea y el sufijo de autor de GitHub', () => {
  assert.equal(plain('Arregla **algo** con `code` y [link](http://x) by @tomy in https://github.com/a/pull/1'), 'Arregla algo con code y link')
  assert.equal(plain('<b>hola</b>   mundo'), 'hola mundo')
})
