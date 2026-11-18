import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Candado {
  liberar(): void
}

export type ResultadoCandado = { tomado: true; candado: Candado } | { tomado: false; pid: number | null }

export interface OpcionesCandado {
  pid?: number
  ahora?: () => number
  vivo?: (pid: number) => boolean
  /** Un candado más viejo que esto se da por abandonado aunque el pid siga existiendo (el pid se puede reusar). */
  vencimientoMs?: number
}

const VENCIMIENTO_MS = 10 * 60_000
// Entre crear el archivo y escribirle el pid hay un instante en que está vacío: no es abandono.
const GRACIA_MS = 5_000

const codigo = (e: unknown): string | undefined => (e && typeof e === 'object' && 'code' in e && typeof e.code === 'string' ? e.code : undefined)

function procesoVivo(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return codigo(e) !== 'ESRCH'
  }
}

function borrar(ruta: string): void {
  try {
    unlinkSync(ruta)
  } catch (e) {
    if (codigo(e) !== 'ENOENT') throw e
  }
}

function leerDueno(ruta: string): { pid: number; desde: number } | null {
  try {
    const v: unknown = JSON.parse(readFileSync(ruta, 'utf8'))
    if (typeof v === 'object' && v !== null && 'pid' in v && 'desde' in v && Number.isInteger(v.pid) && typeof v.desde === 'number') {
      return { pid: v.pid as number, desde: v.desde }
    }
  } catch (e) {
    if (codigo(e) === 'ENOENT') return null
    if (!(e instanceof SyntaxError)) throw e
  }
  return null
}

/**
 * Candado de archivo entre procesos: crea `ruta` con `wx` y la deja hasta liberar. Si ya existe y su dueño
 * sigue vivo y reciente, devuelve `tomado: false`; si quedó de un proceso que murió, lo toma.
 * Tira solo ante un error de disco (no poder crear el archivo), no por contención.
 */
export function tomarCandado(ruta: string, o: OpcionesCandado = {}): ResultadoCandado {
  const pid = o.pid ?? process.pid
  const ahora = o.ahora ?? Date.now
  const vivo = o.vivo ?? procesoVivo
  const vence = o.vencimientoMs ?? VENCIMIENTO_MS
  mkdirSync(dirname(ruta), { recursive: true })
  for (let intento = 0; intento < 2; intento++) {
    try {
      const fd = openSync(ruta, 'wx')
      try {
        writeSync(fd, JSON.stringify({ pid, desde: ahora() }))
      } finally {
        closeSync(fd)
      }
      return { tomado: true, candado: { liberar: () => borrar(ruta) } }
    } catch (e) {
      if (codigo(e) !== 'EEXIST') throw e
    }
    const dueno = leerDueno(ruta)
    if (dueno) {
      if (ahora() - dueno.desde < vence && vivo(dueno.pid)) return { tomado: false, pid: dueno.pid }
    } else {
      let mtime = 0
      try {
        mtime = statSync(ruta).mtimeMs
      } catch (e) {
        if (codigo(e) !== 'ENOENT') throw e
      }
      if (ahora() - mtime < GRACIA_MS) return { tomado: false, pid: null }
    }
    borrar(ruta)
  }
  return { tomado: false, pid: null }
}
