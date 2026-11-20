import type { PtyChunk } from '../../shared/types'

/** Lo que el celu tiene guardado de una terminal: la salida desde que la abrió, recortada al final. */
export interface Visor {
  chunks: PtyChunk[]
  tam: number
  /** Hasta qué seq llegó la foto inicial; mientras es null, todavía no llegó. */
  foto: number | null
  usadoEn: number
}

export interface PedidoTerminal {
  id: string
  /** Último seq que ya tiene el celu; -1 la primera vez. */
  desde: number
  escribir?: string
  /** Lo mandaban las páginas viejas para achicar la terminal: se valida y no hace nada, el celu nunca cambia el tamaño de la PC. */
  tam?: { cols: number; rows: number } | 'pc'
  /** Cuánto puede esperar la PC (ms) a que haya salida nueva antes de contestar vacío. Solo en un pedido de mirar. */
  espera?: number
  /** Pedido que solo escribe o cambia el tamaño: la PC contesta ya y sin salida. */
  soloEscribir?: true
  /** Identifica a la página (se renueva al recargarla); con `n`, el número de la escritura: la PC no repite una que ya hizo. */
  sesion?: string
  n?: number
}

export interface RespuestaTerminal {
  /** true: el celu tiene que borrar lo que tiene y escribir `datos` desde cero. */
  reinicio: boolean
  datos: string
  hasta: number
  /** Hay más salida ya guardada que no entró en esta respuesta: el celu vuelve a pedir enseguida. */
  mas: boolean
  viva: boolean
  cols: number
  rows: number
  /** Siempre false: lo lee la página vieja que quedó en caché. */
  ajustado: boolean
}

export const MAX_VISOR_CHARS = 150_000
export const MAX_ESCRIBIR = 4000
export const VISOR_VENCE_MS = 30_000
export const ESPERA_MAX_MS = 25_000
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/
const SESION_RE = /^[A-Za-z0-9_-]{8,40}$/
const N_MAX = 1_000_000_000

export function nuevoVisor(ahora: number): Visor {
  return { chunks: [], tam: 0, foto: null, usadoEn: ahora }
}

function recortar(v: Visor): void {
  while (v.tam > MAX_VISOR_CHARS && v.chunks.length > 1) v.tam -= (v.chunks.shift() as PtyChunk).data.length
}

/** Salida en vivo. Antes de la foto se guarda igual: la foto puede llegar después y no tiene que perderse nada. */
export function sumarSalida(v: Visor, chunks: PtyChunk[]): void {
  const ultimo = v.chunks.length ? v.chunks[v.chunks.length - 1].seq : -1
  for (const c of chunks) {
    if (c.seq <= ultimo) continue
    v.chunks.push(c)
    v.tam += c.data.length
  }
  recortar(v)
}

/** La foto del buffer del daemon, más lo que llegó en vivo mientras se pedía y es posterior. */
export function ponerFoto(v: Visor, foto: PtyChunk[], upTo: number): void {
  const vivo = v.chunks.filter((c) => c.seq > upTo)
  v.chunks = [...foto.filter((c) => c.seq <= upTo), ...vivo]
  v.tam = v.chunks.reduce((n, c) => n + c.data.length, 0)
  v.foto = upTo
  recortar(v)
}

/**
 * Lo que `texto` ocupa dentro del JSON de la respuesta, en bytes UTF-8 ya escapados (como lo deja JSON.stringify):
 * un ESC pesa 6, una comilla o una barra 2, un salto de línea 2, una letra con tilde 2 y un emoji 4.
 */
export function pesoJson(texto: string): number {
  let n = 0
  for (let i = 0; i < texto.length; i++) {
    const c = texto.charCodeAt(i)
    if (c === 0x22 || c === 0x5c || c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d) n += 2
    else if (c < 0x20) n += 6
    else if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < texto.length && (texto.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4
      i++
    } else if (c >= 0xd800 && c < 0xe000) n += 6
    else n += 3
  }
  return n
}

/** El final de `texto` que entra en `max`, sin partir un par de sustitutos (un emoji). */
function colaQueEntra(texto: string, max: number): string {
  let peso = 0
  let i = texto.length
  while (i > 0) {
    const par = i > 1 && (texto.charCodeAt(i - 1) & 0xfc00) === 0xdc00 && (texto.charCodeAt(i - 2) & 0xfc00) === 0xd800
    const unidad = par ? texto.slice(i - 2, i) : texto[i - 1]
    peso += pesoJson(unidad)
    if (peso > max) break
    i -= unidad.length
  }
  return texto.slice(i)
}

/** Lo que va en cada respuesta: la página rechaza sobres de más de 262144 caracteres, y con AES en JS puro un celu lento no debería procesar mucho más de lo que se ve. */
export const MAX_DATOS_PESO = 120_000

/**
 * Lo que le falta al celu, sin pasar de `max` (peso en el JSON). Si pide algo que el visor ya recortó (o de otro
 * visor), va la cola más reciente que entre, cortada entre trozos. En una respuesta común van los trozos que
 * entran desde `desde` y `hasta` es el seq del último incluido: el próximo pedido sigue de ahí, sin huecos
 * ni repetidos, y `mas` avisa que quedó salida por mandar. Un trozo solo que no entra en `max` se manda
 * truncado a su final (lo más reciente) y lo que quedó antes se pierde.
 */
export function salidaDesde(v: Visor, desde: number, max = MAX_DATOS_PESO): { reinicio: boolean; datos: string; hasta: number; mas: boolean } {
  const ultimo = v.chunks.length ? v.chunks[v.chunks.length - 1].seq : (v.foto ?? 0)
  const primero = v.chunks.length ? v.chunks[0].seq : ultimo + 1
  const reinicio = desde < 0 || desde > ultimo || desde < primero - 1
  const lista = reinicio ? v.chunks : v.chunks.filter((c) => c.seq > desde)
  if (!lista.length) return { reinicio, datos: '', hasta: ultimo, mas: false }
  if (reinicio) {
    let peso = 0
    let i = lista.length
    while (i > 0) {
      const p = pesoJson(lista[i - 1].data)
      if (peso + p > max) break
      peso += p
      i--
    }
    const datos = i < lista.length ? lista.slice(i).map((c) => c.data).join('') : colaQueEntra(lista[lista.length - 1].data, max)
    return { reinicio, datos, hasta: ultimo, mas: false }
  }
  let peso = 0
  let n = 0
  let datos = ''
  while (n < lista.length) {
    const p = pesoJson(lista[n].data)
    if (n > 0 && peso + p > max) break
    datos += p > max ? colaQueEntra(lista[n].data, max) : lista[n].data
    peso += p
    n++
  }
  return { reinicio, datos, hasta: lista[n - 1].seq, mas: n < lista.length }
}

const dim = (n: unknown, min: number, max: number): n is number => Number.isInteger(n) && (n as number) >= min && (n as number) <= max

/** Valida lo que manda el celu (ya abierto el sello). null = pedido inválido. */
export function leerPedidoTerminal(b: unknown): PedidoTerminal | null {
  if (!b || typeof b !== 'object') return null
  const o = b as Record<string, unknown>
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) return null
  if (!Number.isInteger(o.desde) || (o.desde as number) < -1) return null
  const p: PedidoTerminal = { id: o.id, desde: o.desde as number }
  if (o.escribir !== undefined) {
    if (typeof o.escribir !== 'string' || !o.escribir || o.escribir.length > MAX_ESCRIBIR) return null
    p.escribir = o.escribir
  }
  if (o.tam !== undefined) {
    if (o.tam === 'pc') p.tam = 'pc'
    else {
      const t = o.tam as { cols?: unknown; rows?: unknown } | null
      if (!t || typeof t !== 'object' || !dim(t.cols, 20, 500) || !dim(t.rows, 5, 200)) return null
      p.tam = { cols: t.cols, rows: t.rows }
    }
  }
  const escribe = p.escribir !== undefined || p.tam !== undefined
  if (o.espera !== undefined) {
    if (!dim(o.espera, 0, ESPERA_MAX_MS)) return null
    p.espera = o.espera
  }
  if (o.soloEscribir !== undefined) {
    if (o.soloEscribir !== true || !escribe) return null
    p.soloEscribir = true
  }
  if (p.espera && (escribe || p.soloEscribir)) return null
  if (o.sesion !== undefined) {
    if (typeof o.sesion !== 'string' || !SESION_RE.test(o.sesion)) return null
    p.sesion = o.sesion
  }
  if (o.n !== undefined) {
    if (!p.sesion || !escribe || !dim(o.n, 1, N_MAX)) return null
    p.n = o.n
  }
  return p
}

/** Los visores que nadie consulta hace rato. */
export function vencidos(visores: ReadonlyMap<string, Visor>, ahora: number, venceMs = VISOR_VENCE_MS): string[] {
  return [...visores].filter(([, v]) => ahora - v.usadoEn > venceMs).map(([id]) => id)
}

type Tam = { cols: number; rows: number } | null

/** El tamaño de la terminal: el de la PC, que el celu nunca cambia. */
export function tamanoActual(pc: Tam): { cols: number; rows: number } {
  return pc ?? { cols: 80, rows: 24 }
}

/** Si el pedido de mirar tiene que quedar abierto: no hay nada nuevo que mandar, la terminal está viva y no es la primera vez. */
export function debeEsperar(p: PedidoTerminal, salida: { reinicio: boolean; datos: string }, viva: boolean): boolean {
  return !!p.espera && !p.soloEscribir && viva && p.desde >= 0 && !salida.reinicio && !salida.datos
}

/** La respuesta de un pedido que no trae salida: el celu sigue desde donde estaba. */
export function sinSalida(p: PedidoTerminal): { reinicio: false; datos: ''; hasta: number; mas: false } {
  return { reinicio: false, datos: '', hasta: p.desde, mas: false }
}

/**
 * Lo que el xterm del celu emite solo y no tipeó nadie: respuestas a consultas del programa (posición del cursor,
 * atributos, modos, tamaño, colores), reportes de foco y de mouse (SGR y X10). El primer grupo es un pegado entre
 * corchetes, que se deja tal cual: lo de adentro es texto del usuario.
 */
const AUTOMATICAS =
  /(\x1b\[200~[\s\S]*?(?:\x1b\[201~|$))|\x1b\[[?>=]?[\d;:]*\$y|\x1b\[\??\d+;\d+R|\x1b\[[?>=][\d;]*c|\x1b\[\??\d+(?:;\d+)*n|\x1b\[\d+(?:;\d+)*t|\x1b\[[IO]|\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\x20-\uffff]{3}|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\/g

/** Le saca a lo que manda el celu las secuencias completas que no tipeó nadie. Solo quita, nunca agrega. */
export function sinAutomaticas(texto: string): string {
  return texto.replace(AUTOMATICAS, (m, pegado: string | undefined) => (pegado ? m : ''))
}
