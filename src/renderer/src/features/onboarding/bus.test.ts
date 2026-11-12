import { test } from 'node:test'
import assert from 'node:assert/strict'
import { onOpen, requestOpen, showingFirstRun } from './bus'

test('sin «Empecemos» a la vista, pedir Primeros pasos abre la Vista', () => {
  let opened = 0
  const off = onOpen(() => opened++)
  requestOpen()
  off()
  assert.equal(opened, 1)
})

test('con «Empecemos» a la vista, no se abre otra: se lleva el foco a la que ya está', () => {
  let opened = 0
  let focused = 0
  const off = onOpen(() => opened++)
  const hide = showingFirstRun(() => focused++)
  requestOpen()
  hide()
  requestOpen()
  off()
  assert.equal(focused, 1)
  assert.equal(opened, 1)
})
