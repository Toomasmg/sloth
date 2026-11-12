import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parchear } from './patch-node-pty.mjs'

const LINEA = "var agent = child_process_1.fork(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()]);"

test('agrega windowsHide al fork del agente de consola', () => {
  const { texto, cambio } = parchear(LINEA)
  assert.equal(cambio, true)
  assert.match(texto, /\[_this\._innerPid\.toString\(\)\], \{ windowsHide: true \}\)/)
})

test('aplicarlo dos veces no cambia nada', () => {
  const una = parchear(LINEA).texto
  const dos = parchear(una)
  assert.equal(dos.cambio, false)
  assert.equal(dos.texto, una)
})

test('falla con aviso claro si node-pty cambió esa línea', () => {
  assert.throws(() => parchear('var agent = otraCosa();'), /patch-node-pty: no encontré el fork/)
})
