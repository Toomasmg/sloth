/**
 * Código QR (modo byte, corrección M, versiones 1 a 10) para el enlace del celular. Sigue el
 * algoritmo de la norma ISO/IEC 18004 en la forma de la implementación de Nayuki. Alcanza para
 * ~210 bytes, de sobra para http://<ip>:<puerto>/?t=<token>.
 */

/** Corrección M: palabras de corrección por bloque y cantidad de bloques, por versión (índice 0 sin uso). */
const ECC_POR_BLOQUE = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]
const BLOQUES = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5]
const VERSION_MAX = 10
/** Bits de formato del nivel M. */
const FORMATO_M = 0

export interface Qr {
  size: number
  /** `modules[y][x]`: true es oscuro. */
  modules: boolean[][]
}

function modulosCrudos(ver: number): number {
  let n = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const alin = Math.floor(ver / 7) + 2
    n -= (25 * alin - 10) * alin - 55
    if (ver >= 7) n -= 36
  }
  return n
}

const palabrasDeDatos = (ver: number): number => Math.floor(modulosCrudos(ver) / 8) - ECC_POR_BLOQUE[ver] * BLOQUES[ver]

function multiplicar(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

export function divisor(grado: number): number[] {
  const r: number[] = new Array<number>(grado).fill(0)
  r[grado - 1] = 1
  let raiz = 1
  for (let i = 0; i < grado; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = multiplicar(r[j], raiz)
      if (j + 1 < r.length) r[j] ^= r[j + 1]
    }
    raiz = multiplicar(raiz, 0x02)
  }
  return r
}

/** Resto de Reed-Solomon: las palabras de corrección de un bloque. */
export function restoRs(datos: readonly number[], div: readonly number[]): number[] {
  const r: number[] = new Array<number>(div.length).fill(0)
  for (const b of datos) {
    const factor = b ^ (r.shift() as number)
    r.push(0)
    for (let i = 0; i < div.length; i++) r[i] ^= multiplicar(div[i], factor)
  }
  return r
}

function conCorreccion(datos: number[], ver: number): number[] {
  const nBloques = BLOQUES[ver]
  const eccLen = ECC_POR_BLOQUE[ver]
  const crudas = Math.floor(modulosCrudos(ver) / 8)
  const cortos = nBloques - (crudas % nBloques)
  const largoCorto = Math.floor(crudas / nBloques)
  const div = divisor(eccLen)
  const bloques: number[][] = []
  for (let i = 0, k = 0; i < nBloques; i++) {
    const dat = datos.slice(k, k + largoCorto - eccLen + (i < cortos ? 0 : 1))
    k += dat.length
    const ecc = restoRs(dat, div)
    if (i < cortos) dat.push(0)
    bloques.push([...dat, ...ecc])
  }
  const out: number[] = []
  for (let i = 0; i < bloques[0].length; i++) {
    bloques.forEach((b, j) => {
      if (i !== largoCorto - eccLen || j >= cortos) out.push(b[i])
    })
  }
  return out
}

/** Bits de formato (nivel de corrección + máscara) con su BCH y la máscara fija 0x5412. */
export function bitsDeFormato(mascara: number): number {
  const dato = (FORMATO_M << 3) | mascara
  let rem = dato
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((dato << 10) | rem) ^ 0x5412
}

/** Bits de versión (desde la 7) con su BCH. */
export function bitsDeVersion(ver: number): number {
  let rem = ver
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  return (ver << 12) | rem
}

function posicionesDeAlineacion(ver: number, size: number): number[] {
  if (ver === 1) return []
  const n = Math.floor(ver / 7) + 2
  const paso = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2
  const r = [6]
  for (let pos = size - 7; r.length < n; pos -= paso) r.splice(1, 0, pos)
  return r
}

const bit = (x: number, i: number): boolean => ((x >>> i) & 1) !== 0

const MASCARAS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
]

class Matriz {
  readonly size: number
  readonly mod: boolean[][]
  readonly fn: boolean[][]
  constructor(size: number) {
    this.size = size
    this.mod = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
    this.fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  }
  fija(x: number, y: number, oscuro: boolean): void {
    this.mod[y][x] = oscuro
    this.fn[y][x] = true
  }
}

function patronesFijos(m: Matriz, ver: number): void {
  const s = m.size
  for (let i = 0; i < s; i++) {
    m.fija(6, i, i % 2 === 0)
    m.fija(i, 6, i % 2 === 0)
  }
  const buscador = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        const x = cx + dx
        const y = cy + dy
        if (x >= 0 && x < s && y >= 0 && y < s) m.fija(x, y, d !== 2 && d !== 4)
      }
  }
  buscador(3, 3)
  buscador(s - 4, 3)
  buscador(3, s - 4)
  const pos = posicionesDeAlineacion(ver, s)
  const u = pos.length - 1
  pos.forEach((px, i) =>
    pos.forEach((py, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === u) || (i === u && j === 0)) return
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) m.fija(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    })
  )
  dibujarFormato(m, 0)
  if (ver >= 7) {
    const v = bitsDeVersion(ver)
    for (let i = 0; i < 18; i++) {
      const a = s - 11 + (i % 3)
      const b = Math.floor(i / 3)
      m.fija(a, b, bit(v, i))
      m.fija(b, a, bit(v, i))
    }
  }
}

function dibujarFormato(m: Matriz, mascara: number): void {
  const f = bitsDeFormato(mascara)
  const s = m.size
  for (let i = 0; i <= 5; i++) m.fija(8, i, bit(f, i))
  m.fija(8, 7, bit(f, 6))
  m.fija(8, 8, bit(f, 7))
  m.fija(7, 8, bit(f, 8))
  for (let i = 9; i < 15; i++) m.fija(14 - i, 8, bit(f, i))
  for (let i = 0; i < 8; i++) m.fija(s - 1 - i, 8, bit(f, i))
  for (let i = 8; i < 15; i++) m.fija(8, s - 15 + i, bit(f, i))
  m.fija(8, s - 8, true)
}

function ubicarPalabras(m: Matriz, palabras: readonly number[]): void {
  const s = m.size
  let i = 0
  for (let der = s - 1; der >= 1; der -= 2) {
    if (der === 6) der = 5
    for (let v = 0; v < s; v++)
      for (let j = 0; j < 2; j++) {
        const x = der - j
        const sube = ((der + 1) & 2) === 0
        const y = sube ? s - 1 - v : v
        if (!m.fn[y][x] && i < palabras.length * 8) {
          m.mod[y][x] = bit(palabras[i >>> 3], 7 - (i & 7))
          i++
        }
      }
  }
}

function aplicarMascara(m: Matriz, k: number): void {
  const f = MASCARAS[k]
  for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) if (!m.fn[y][x] && f(x, y)) m.mod[y][x] = !m.mod[y][x]
}

/**
 * Penalidad simplificada (rachas, bloques de 2×2 y balance). Deja afuera la regla de los patrones
 * parecidos al buscador: cualquier máscara se puede leer; esto solo elige una más cómoda.
 */
function penalidad(m: Matriz): number {
  const s = m.size
  let p = 0
  for (let a = 0; a < s; a++) {
    let filaRun = 1
    let colRun = 1
    for (let b = 1; b < s; b++) {
      if (m.mod[a][b] === m.mod[a][b - 1]) filaRun++
      else filaRun = 1
      if (filaRun === 5) p += 3
      else if (filaRun > 5) p++
      if (m.mod[b][a] === m.mod[b - 1][a]) colRun++
      else colRun = 1
      if (colRun === 5) p += 3
      else if (colRun > 5) p++
    }
  }
  for (let y = 0; y < s - 1; y++)
    for (let x = 0; x < s - 1; x++) {
      const c = m.mod[y][x]
      if (c === m.mod[y][x + 1] && c === m.mod[y + 1][x] && c === m.mod[y + 1][x + 1]) p += 3
    }
  let oscuros = 0
  for (const fila of m.mod) for (const c of fila) if (c) oscuros++
  const total = s * s
  p += (Math.ceil(Math.abs(oscuros * 20 - total * 10) / total) - 1) * 10
  return p
}

/** Arma el QR del texto. Lanza si no entra en la versión 10. */
export function qrDeTexto(texto: string): Qr {
  const bytes = [...new TextEncoder().encode(texto)]
  let ver = 1
  for (; ver <= VERSION_MAX; ver++) {
    const cuenta = ver <= 9 ? 8 : 16
    if (4 + cuenta + bytes.length * 8 <= palabrasDeDatos(ver) * 8) break
  }
  if (ver > VERSION_MAX) throw new Error('El texto es demasiado largo para el QR.')
  const cap = palabrasDeDatos(ver) * 8
  const bits: number[] = []
  const poner = (v: number, n: number): void => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1)
  }
  poner(0b0100, 4)
  poner(bytes.length, ver <= 9 ? 8 : 16)
  for (const b of bytes) poner(b, 8)
  poner(0, Math.min(4, cap - bits.length))
  poner(0, (8 - (bits.length % 8)) % 8)
  for (let relleno = 0xec; bits.length < cap; relleno ^= 0xec ^ 0x11) poner(relleno, 8)
  const datos: number[] = []
  for (let i = 0; i < bits.length; i += 8) datos.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0))

  const size = ver * 4 + 17
  const palabras = conCorreccion(datos, ver)
  let mejor: Matriz | null = null
  let mejorP = Infinity
  for (let k = 0; k < 8; k++) {
    const m = new Matriz(size)
    patronesFijos(m, ver)
    ubicarPalabras(m, palabras)
    aplicarMascara(m, k)
    dibujarFormato(m, k)
    const p = penalidad(m)
    if (p < mejorP) {
      mejor = m
      mejorP = p
    }
  }
  return { size, modules: (mejor as Matriz).mod }
}

/** Camino SVG (un rectángulo por módulo oscuro), con `margen` módulos de zona libre alrededor. */
export function qrComoCaminoSvg(qr: Qr, margen = 4): { path: string; lado: number } {
  const partes: string[] = []
  qr.modules.forEach((fila, y) =>
    fila.forEach((oscuro, x) => {
      if (oscuro) partes.push(`M${x + margen} ${y + margen}h1v1h-1z`)
    })
  )
  return { path: partes.join(''), lado: qr.size + margen * 2 }
}
