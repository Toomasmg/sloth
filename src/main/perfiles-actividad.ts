import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { EntradaActividad, TipoActividad } from '../shared/perfiles'

export const MAX_BYTES_ACTIVIDAD = 256 * 1024
export const ARCHIVOS_ACTIVIDAD = 3

const TIPOS: readonly TipoActividad[] = ['espacio', 'ticket', 'pr']
const MAX_CAMPO = 120
const MAX_LIMITE = 200
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g

const nombreArchivo = (i: number): string => (i === 0 ? 'actividad.jsonl' : `actividad-${i}.jsonl`)

function campo(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const limpio = [...v.replace(CONTROL, ' ').trim()].slice(0, MAX_CAMPO).join('').trim()
  return limpio || undefined
}

/** Lo que llega de un archivo del disco o de otro módulo no se confía: solo pasan los campos conocidos. */
export function limpiarEntrada(raw: unknown): EntradaActividad | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const tipo = TIPOS.find((t) => t === r.tipo)
  if (!tipo || typeof r.t !== 'number' || !Number.isInteger(r.t) || r.t <= 0) return null
  const e: EntradaActividad = { t: r.t, tipo }
  const espacio = campo(r.espacio)
  const ticket = campo(r.ticket)
  const pr = campo(r.pr)
  if (espacio) e.espacio = espacio
  if (ticket) e.ticket = ticket
  if (pr) e.pr = pr
  return e
}

function rotar(dir: string): void {
  rmSync(join(dir, nombreArchivo(ARCHIVOS_ACTIVIDAD - 1)), { force: true })
  for (let i = ARCHIVOS_ACTIVIDAD - 2; i >= 0; i--) {
    const origen = join(dir, nombreArchivo(i))
    if (existsSync(origen)) renameSync(origen, join(dir, nombreArchivo(i + 1)))
  }
}

export function agregarActividad(dir: string, entrada: EntradaActividad): void {
  const e = limpiarEntrada(entrada)
  if (!e) throw new Error('actividad inválida')
  mkdirSync(dir, { recursive: true })
  const actual = join(dir, nombreArchivo(0))
  if (existsSync(actual) && statSync(actual).size > MAX_BYTES_ACTIVIDAD) rotar(dir)
  appendFileSync(actual, JSON.stringify(e) + '\n', 'utf8')
}

export function leerActividad(dir: string, limite: number): EntradaActividad[] {
  const max = Number.isInteger(limite) ? Math.min(Math.max(limite, 1), MAX_LIMITE) : 50
  const salida: EntradaActividad[] = []
  for (let i = 0; i < ARCHIVOS_ACTIVIDAD && salida.length < max; i++) {
    let texto: string
    try {
      texto = readFileSync(join(dir, nombreArchivo(i)), 'utf8')
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') continue
      throw err
    }
    const lineas = texto.split('\n')
    for (let j = lineas.length - 1; j >= 0 && salida.length < max; j--) {
      const linea = lineas[j]
      if (!linea) continue
      let crudo: unknown
      try {
        crudo = JSON.parse(linea)
      } catch {
        continue
      }
      const e = limpiarEntrada(crudo)
      if (e) salida.push(e)
    }
  }
  return salida
}
