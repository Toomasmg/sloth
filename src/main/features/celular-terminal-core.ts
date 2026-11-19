import type { PtyChunk } from '../../shared/types'

/** Lo que el celu tiene guardado de una terminal: la salida desde que la abrió, recortada al final. */
export interface Visor {
  chunks: PtyChunk[]
  tam: number
  /** Hasta qué seq llegó la foto inicial; mientras es null, todavía no llegó. */
  foto: number | null
  usadoEn: number
  /** El tamaño que le puso el celu, o null si quedó el de la PC. */
  ajustado: { cols: number; rows: number } | null
  /** El de la PC cuando el celu la achicó: si la PC cambia de tamaño después, gana la PC. */
  pcAlAjustar: { cols: number; rows: number } | null
}

export interface PedidoTerminal {
  id: string
  /** Último seq que ya tiene el celu; -1 la primera vez. */
  desde: number
  escribir?: string
  /** Un tamaño para achicar la terminal al celu, o 'pc' para devolverle el de la PC. */
  tam?: { cols: number; rows: number } | 'pc'
}

export interface RespuestaTerminal {
  /** true: el celu tiene que borrar lo que tiene y escribir `datos` desde cero. */
  reinicio: boolean
  datos: string
  hasta: number
  viva: boolean
  cols: number
  rows: number
  ajustado: boolean
}

export const MAX_VISOR_CHARS = 150_000
export const MAX_ESCRIBIR = 4000
export const VISOR_VENCE_MS = 30_000
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/

export function nuevoVisor(ahora: number): Visor {
  return { chunks: [], tam: 0, foto: null, usadoEn: ahora, ajustado: null, pcAlAjustar: null }
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

/** Lo que le falta al celu. Si pide algo que el visor ya recortó (o de otro visor), va todo de nuevo. */
export function salidaDesde(v: Visor, desde: number): { reinicio: boolean; datos: string; hasta: number } {
  const hasta = v.chunks.length ? v.chunks[v.chunks.length - 1].seq : (v.foto ?? 0)
  const primero = v.chunks.length ? v.chunks[0].seq : hasta + 1
  const reinicio = desde < 0 || desde > hasta || desde < primero - 1
  const datos = (reinicio ? v.chunks : v.chunks.filter((c) => c.seq > desde)).map((c) => c.data).join('')
  return { reinicio, datos, hasta }
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
  return p
}

/** Los visores que nadie consulta hace rato: se sueltan y, si el celu la había achicado, la terminal vuelve al tamaño de la PC. */
export function vencidos(visores: ReadonlyMap<string, Visor>, ahora: number, venceMs = VISOR_VENCE_MS): string[] {
  return [...visores].filter(([, v]) => ahora - v.usadoEn > venceMs).map(([id]) => id)
}

type Tam = { cols: number; rows: number } | null

/** El tamaño real de la terminal: el del celu si la achicó y la PC no la cambió desde entonces; si no, el de la PC. */
export function tamanoActual(v: Visor | undefined, pc: Tam): { cols: number; rows: number } {
  if (v?.ajustado) {
    const a = v.pcAlAjustar
    if (!pc || (a && a.cols === pc.cols && a.rows === pc.rows)) return v.ajustado
    v.ajustado = null
    v.pcAlAjustar = null
  }
  return pc ?? { cols: 80, rows: 24 }
}
