import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPatch } from '../../shared/settings-model'
import { armarArchivo, leerSettings } from './settings-archivo'

test('un campo desconocido de la raíz sobrevive a cambiar el tema y guardar', () => {
  const { settings, resto } = leerSettings({ version: 1, x: 1, theme: 'claro' })
  const guardado = armarArchivo(applyPatch(settings, { theme: 'noche' }), resto, 1)
  assert.equal(guardado.x, 1)
  assert.equal(guardado.theme, 'noche')
  assert.equal(guardado.version, 1)
})

test('conserva claves nuevas dentro de terminal y notify sin pisar las conocidas', () => {
  const { settings, resto } = leerSettings({ terminal: { fontSize: 14, ligaduras: true }, notify: { done: false, nueva: 'a' } })
  const guardado = armarArchivo(settings, resto, 1) as { terminal: Record<string, unknown>; notify: Record<string, unknown> }
  assert.equal(guardado.terminal.ligaduras, true)
  assert.equal(guardado.terminal.fontSize, 14)
  assert.equal(guardado.notify.nueva, 'a')
  assert.equal(guardado.notify.done, false)
})

test('sin campos desconocidos no agrega nada y una entrada inválida no tira', () => {
  assert.deepEqual(leerSettings({ theme: 'claro' }).resto, {})
  assert.deepEqual(leerSettings(null).resto, {})
  assert.deepEqual(leerSettings([1]).resto, {})
})
