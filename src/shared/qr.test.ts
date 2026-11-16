import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bitsDeFormato, bitsDeVersion, divisor, qrComoCaminoSvg, qrDeTexto, restoRs } from './qr'

test('Reed-Solomon da la corrección del ejemplo HELLO WORLD 1-M', () => {
  const datos = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]
  assert.deepEqual(restoRs(datos, divisor(10)), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23])
})

test('bits de formato y de versión de la tabla de la norma', () => {
  assert.equal(bitsDeFormato(0), 0b101010000010010)
  assert.equal(bitsDeFormato(1), 0b101000100100101)
  assert.equal(bitsDeFormato(4), 0b100010111111001)
  assert.equal(bitsDeFormato(7), 0b100101010100000)
  assert.equal(bitsDeVersion(7), 0b000111110010010100)
})

test('el enlace del celular entra y arma una matriz cuadrada con los tres buscadores', () => {
  const url = 'http://192.168.100.200:47321/?t=' + 'A'.repeat(43)
  const qr = qrDeTexto(url)
  assert.equal(qr.modules.length, qr.size)
  assert.ok(qr.size >= 21 && qr.size <= 57)
  const esBuscador = (x0: number, y0: number): boolean => {
    for (let i = 0; i < 7; i++) {
      if (!qr.modules[y0][x0 + i] || !qr.modules[y0 + 6][x0 + i] || !qr.modules[y0 + i][x0] || !qr.modules[y0 + i][x0 + 6]) return false
    }
    return qr.modules[y0 + 3][x0 + 3] && !qr.modules[y0 + 1][x0 + 1]
  }
  assert.ok(esBuscador(0, 0))
  assert.ok(esBuscador(qr.size - 7, 0))
  assert.ok(esBuscador(0, qr.size - 7))
  assert.equal(qr.modules[qr.size - 8][8], true)
})

test('lo que no entra en la versión 10 tira un error claro', () => {
  assert.throws(() => qrDeTexto('x'.repeat(400)), /demasiado largo/)
})

test('el camino SVG suma la zona libre al lado', () => {
  const qr = qrDeTexto('hola')
  const { lado, path } = qrComoCaminoSvg(qr)
  assert.equal(lado, qr.size + 8)
  assert.ok(path.startsWith('M4 4h1v1h-1z'))
})
