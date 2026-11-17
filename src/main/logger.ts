import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { acotar, redactar } from './diag/redactar'
import { planRotacion } from './diag/rotacion'
import type { EntradaLog } from './diag/diagnostico-texto'

export interface Logger {
  error(origen: string, e: unknown): void
  aviso(origen: string, msg: string): void
  info(origen: string, msg: string): void
  recientes(n: number): EntradaLog[]
  fallo(): string | undefined
}

export interface OpcionesLogger {
  dir: string
  home: string
  userData: string
  max?: number
  mantener?: number
  ahora?: () => number
  /** Sin archivo: solo el buffer en memoria (el logger global antes de iniciarse). */
  soloMemoria?: boolean
}

const BASE = 'sloth'
const MAX_POR_DEFECTO = 512 * 1024
const MANTENER_POR_DEFECTO = 3
const LARGO_LINEA = 4000
const LARGO_ENTRADA_MAX = 200_000
const BUFFER = 200

const unaLinea = (s: string): string => s.replace(/\s*[\r\n]+\s*/g, ' | ')
const motivo = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function textoDeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  const stack = e.stack ?? ''
  return stack.includes(e.message) ? stack : `${e.message}\n${stack}`
}

export function crearLogger(opts: OpcionesLogger): Logger {
  const max = opts.max ?? MAX_POR_DEFECTO
  const mantener = opts.mantener ?? MANTENER_POR_DEFECTO
  const ahora = opts.ahora ?? Date.now
  const ctx = { home: opts.home, userData: opts.userData }
  const recientes: EntradaLog[] = []
  let fallo: string | undefined
  let conArchivo = !opts.soloMemoria
  const archivo = join(opts.dir, `${BASE}.log`)

  const limpiar = (s: string): string => acotar(redactar(s.slice(0, LARGO_ENTRADA_MAX), ctx), LARGO_LINEA)

  const falla = (donde: string, e: unknown): void => {
    fallo = acotar(redactar(`${donde}: ${motivo(e)}`, ctx), 500)
  }

  if (conArchivo) {
    try {
      mkdirSync(opts.dir, { recursive: true })
    } catch (e) {
      falla('no se pudo crear la carpeta de logs', e)
      conArchivo = false
    }
  }

  function rotarSiHaceFalta(): void {
    let tamano = 0
    try {
      tamano = statSync(archivo).size
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    if (tamano < max) return
    const plan = planRotacion({ tamanoActual: tamano, max, existentes: readdirSync(opts.dir), base: BASE, mantener })
    if (!plan.rotar) return
    for (const f of plan.borrar) unlinkSync(join(opts.dir, f))
    for (const m of plan.mover) renameSync(join(opts.dir, m.de), join(opts.dir, m.a))
  }

  function escribir(nivel: EntradaLog['nivel'], origen: string, crudo: string): void {
    const t = ahora()
    const msg = unaLinea(limpiar(crudo))
    const org = unaLinea(origen)
    recientes.push({ t, nivel, origen: org, msg })
    if (recientes.length > BUFFER) recientes.shift()
    if (!conArchivo) return
    try {
      rotarSiHaceFalta()
      appendFileSync(archivo, `${new Date(t).toISOString()} ${nivel} [${org}] ${msg}\n`, 'utf8')
    } catch (e) {
      falla('no se pudo escribir el log', e)
    }
  }

  return {
    error: (origen, e) => escribir('error', origen, textoDeError(e)),
    aviso: (origen, msg) => escribir('aviso', origen, msg),
    info: (origen, msg) => escribir('info', origen, msg),
    recientes: (n) => (n <= 0 ? [] : recientes.slice(-n)),
    fallo: () => fallo
  }
}
