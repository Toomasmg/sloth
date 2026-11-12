import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dropAlVolver, openSettings, takeAlVolver } from './bus'

test('dropAlVolver descarta la vuelta pendiente: al cerrar Configuración no se reabre nada', () => {
  let n = 0
  openSettings('tickets', () => n++)
  dropAlVolver()
  takeAlVolver()?.()
  assert.equal(n, 0)
})

test('sin descartar, la vuelta corre una sola vez', () => {
  let n = 0
  openSettings('tickets', () => n++)
  takeAlVolver()?.()
  takeAlVolver()?.()
  assert.equal(n, 1)
})
