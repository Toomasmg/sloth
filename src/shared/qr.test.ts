import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { bitsDeFormato, bitsDeVersion, divisor, posicionesDeAlineacion, qrComoCaminoSvg, qrDeTexto, restoRs, VERSION_MAX } from './qr'

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

// Capacidad en bytes con corrección M, de la tabla 7 de ISO/IEC 18004.
const CAPACIDAD_M = [
  0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666, 711, 779, 857, 911, 997, 1059, 1125, 1190, 1264,
  1370, 1452, 1538, 1628, 1722, 1809, 1911, 1989, 2099, 2213, 2331
]

test('cada versión llena su capacidad de la norma y un byte más pasa a la siguiente', () => {
  assert.equal(VERSION_MAX, 40)
  for (let ver = 1; ver <= VERSION_MAX; ver++) {
    assert.equal(qrDeTexto('x'.repeat(CAPACIDAD_M[ver])).size, ver * 4 + 17, `versión ${ver}`)
    if (ver < VERSION_MAX) assert.equal(qrDeTexto('x'.repeat(CAPACIDAD_M[ver] + 1)).size, ver * 4 + 21, `versión ${ver} + 1`)
  }
})

test('lo que no entra en la versión 40 tira un error claro', () => {
  assert.throws(() => qrDeTexto('x'.repeat(CAPACIDAD_M[40] + 1)), /demasiado largo/)
})

test('patrones de alineación en las posiciones del anexo E', () => {
  const tabla: Record<number, number[]> = {
    2: [6, 18],
    7: [6, 22, 38],
    10: [6, 28, 50],
    14: [6, 26, 46, 66],
    16: [6, 26, 50, 74],
    22: [6, 26, 50, 74, 98],
    25: [6, 32, 58, 84, 110],
    32: [6, 34, 60, 86, 112, 138],
    36: [6, 24, 50, 76, 102, 128, 154],
    40: [6, 30, 58, 86, 114, 142, 170]
  }
  for (const [ver, pos] of Object.entries(tabla)) assert.deepEqual(posicionesDeAlineacion(Number(ver)), pos, `versión ${ver}`)

  const qr = qrDeTexto('x'.repeat(CAPACIDAD_M[25]))
  const pos = tabla[25]
  for (const cx of pos)
    for (const cy of pos) {
      const u = pos.length - 1
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === pos[u]) || (cx === pos[u] && cy === 6)) continue
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) assert.equal(qr.modules[cy + dy][cx + dx], Math.max(Math.abs(dx), Math.abs(dy)) !== 1, `(${cx}, ${cy})`)
    }
})

test('bits de versión de la tabla D.1 de la norma, con su BCH, dibujados en los dos bloques', () => {
  const tabla: Record<number, number> = { 7: 0x07c94, 10: 0x0a4d3, 16: 0x10b78, 21: 0x15683, 25: 0x191e1, 32: 0x209d5, 40: 0x28c69 }
  for (const [ver, bits] of Object.entries(tabla)) assert.equal(bitsDeVersion(Number(ver)), bits, `versión ${ver}`)
  for (let ver = 7; ver <= VERSION_MAX; ver++) {
    let resto = bitsDeVersion(ver)
    for (let i = 17; i >= 12; i--) if ((resto >>> i) & 1) resto ^= 0x1f25 << (i - 12)
    assert.equal(resto, 0, `BCH de la versión ${ver}`)
  }
  const qr = qrDeTexto('x'.repeat(CAPACIDAD_M[24] + 1))
  const s = qr.size
  let arriba = 0
  let izquierda = 0
  for (let i = 17; i >= 0; i--) {
    arriba = (arriba << 1) | Number(qr.modules[Math.floor(i / 3)][s - 11 + (i % 3)])
    izquierda = (izquierda << 1) | Number(qr.modules[s - 11 + (i % 3)][Math.floor(i / 3)])
  }
  assert.equal(arriba, tabla[25])
  assert.equal(izquierda, tabla[25])
})

const VECTOR = 'https://example.com/sloth/celu/#p=' + 'QRvectorDePrueba0123456789-_'.repeat(34)
const VECTOR_SHA256 = '0daee176297151eda5952d68707ea3f7f2c457668e84b4a91f7b15f0427b82ed'

// Matriz verificada al armar este test decodificándola con zxing-cpp (implementación independiente), igual que las
// de las versiones 1 a 40 llenas.
test('vector de versión 25: la matriz no cambia', () => {
  const qr = qrDeTexto(VECTOR)
  assert.equal(qr.size, 117)
  const filas = qr.modules.map((f) => f.map((c) => (c ? '1' : '0')).join('')).join('/')
  assert.equal(createHash('sha256').update(filas).digest('hex'), VECTOR_SHA256)
})

test('el camino SVG suma la zona libre al lado', () => {
  const qr = qrDeTexto('hola')
  const { lado, path } = qrComoCaminoSvg(qr)
  assert.equal(lado, qr.size + 8)
  assert.ok(path.startsWith('M4 4h1v1h-1z'))
})
