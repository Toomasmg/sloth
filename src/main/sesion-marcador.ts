import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { huboCierreInesperado, leerSesion } from './diag/sesion'
import { escribirJsonAtomico } from './json-file'
import { logger } from './logger-global'

const archivo = (logsDir: string): string => join(logsDir, 'sesion.json')

function escribir(logsDir: string, limpia: boolean, inicio: number): void {
  try {
    escribirJsonAtomico(archivo(logsDir), { inicio, limpia })
  } catch (e) {
    logger.error('sesion', e)
  }
}

/** Lee cómo terminó la sesión anterior y deja marcada la actual como en curso. */
export function iniciarSesion(logsDir: string): { crashPrevio: boolean; inicio: number } {
  let raw: string | undefined
  try {
    raw = readFileSync(archivo(logsDir), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') logger.error('sesion', e)
  }
  const inicio = Date.now()
  escribir(logsDir, false, inicio)
  return { crashPrevio: huboCierreInesperado(leerSesion(raw)), inicio }
}

export function cerrarSesion(logsDir: string, inicio: number): void {
  escribir(logsDir, true, inicio)
}
