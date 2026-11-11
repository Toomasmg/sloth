import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ConectorFaltaError } from './motor'
import { NO_GRUV, NoGruvError, WRITE_TOOLS } from './legado-gruv'

const golden = JSON.parse(readFileSync(new URL('./__golden__/gruv-0.6.4.json', import.meta.url), 'utf8')) as {
  constantes: { WRITE_TOOLS: string[]; NO_GRUV: string; msgNoGruv: string }
}

test('Equipo recibe las mismas constantes que en 0.6.4', () => {
  assert.deepEqual(WRITE_TOOLS, golden.constantes.WRITE_TOOLS)
  assert.equal(NO_GRUV, golden.constantes.NO_GRUV)
})

test('NoGruvError: mismo mensaje y es un ConectorFaltaError', () => {
  const e = new NoGruvError()
  assert.equal(e.message, golden.constantes.msgNoGruv)
  assert.ok(e instanceof ConectorFaltaError)
  assert.ok(e instanceof NoGruvError)
})
