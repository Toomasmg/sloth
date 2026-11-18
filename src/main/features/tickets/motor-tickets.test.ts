import { test } from 'node:test'
import assert from 'node:assert/strict'
import { etiquetarAgente } from './motor-tickets'
import { TopeVueltasError } from './uso'

test('etiquetarAgente: Claude no cambia nada, ni la referencia', () => {
  const e = new Error('Claude no pudo completar la consulta: x')
  assert.equal(etiquetarAgente(e, 'Claude'), e)
})

test('etiquetarAgente: otro agente reemplaza el prefijo', () => {
  const r = etiquetarAgente(new Error('Claude no pudo completar la consulta: x'), 'Codex') as Error
  assert.equal(r.message, 'Codex no pudo completar la consulta: x')
})

test('etiquetarAgente: otros mensajes y errores propios vuelven iguales', () => {
  const otro = new Error('No pude abrir Codex')
  assert.equal(etiquetarAgente(otro, 'Codex'), otro)
  const tope = new TopeVueltasError('Claude no pudo completar la consulta: tope', 'vueltas', { numTurns: 3, tope: 'vueltas' })
  assert.equal(etiquetarAgente(tope, 'Codex'), tope)
  assert.equal(etiquetarAgente('texto', 'Codex'), 'texto')
})
