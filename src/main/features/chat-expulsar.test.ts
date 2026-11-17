import { test } from 'node:test'
import assert from 'node:assert/strict'
import { faltaLaFuncion, resultadoExpulsar } from './chat-expulsar'

test('reconoce que la RPC no existe (sin la 0007) y no confunde otros errores', () => {
  assert.equal(faltaLaFuncion({ code: 'PGRST202' }), true)
  assert.equal(faltaLaFuncion({ code: '42883' }), true)
  assert.equal(faltaLaFuncion({ code: 'P0001' }), false)
  assert.equal(faltaLaFuncion(null), false)
})

test('siempre avisa que hay que reenviar invitaciones, y pide la 0007 si no estaba', () => {
  assert.match(resultadoExpulsar({ conRpc: true, codigoNuevo: true }).aviso, /reenviá/)
  assert.doesNotMatch(resultadoExpulsar({ conRpc: true, codigoNuevo: true }).aviso, /0007/)
  const viejo = resultadoExpulsar({ conRpc: false, codigoNuevo: false })
  assert.equal(viejo.codigoNuevo, false)
  assert.match(viejo.aviso, /NO cambió.*0007_expulsar\.sql/)
  assert.match(resultadoExpulsar({ conRpc: false, codigoNuevo: true }).aviso, /reenviá.*0007/)
})
