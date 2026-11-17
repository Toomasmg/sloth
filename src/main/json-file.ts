import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { avisoArchivoApartado } from './avisos'

export interface OpcionesLectura<T> {
  /** Devuelve el valor normalizado, o undefined si el contenido no sirve (el archivo se aparta). */
  validar: (v: unknown) => T | undefined
  porDefecto: () => T
  /** Sin aviso a la UI (p. ej. quien llama arma su propio mensaje). */
  silencioso?: boolean
}

export interface LecturaJson<T> {
  valor: T
  /** Ruta donde quedó el archivo roto, si hubo que apartarlo. */
  apartado?: string
}

const codigo = (e: unknown): string | undefined =>
  e && typeof e === 'object' && 'code' in e && typeof e.code === 'string' ? e.code : undefined

export function rutaLibre(base: string): string {
  if (!existsSync(base)) return base
  for (let i = 1; ; i++) if (!existsSync(`${base}-${i}`)) return `${base}-${i}`
}

/**
 * Lee un JSON del usuario. Si no existe, el valor por defecto. Si existe pero no se puede usar, lo
 * aparta como `<archivo>.corrupt-<ts>` para que el próximo guardado no lo pise. Los errores de
 * lectura que no son ENOENT (permisos, disco) se propagan: el archivo puede estar sano.
 */
export function leerJson<T>(path: string, o: OpcionesLectura<T>): LecturaJson<T> {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    if (codigo(e) === 'ENOENT') return { valor: o.porDefecto() }
    throw e
  }
  let valor: T | undefined
  try {
    valor = o.validar(JSON.parse(raw.replace(/^﻿/, '')))
  } catch {
    valor = undefined
  }
  if (valor !== undefined) return { valor }
  const apartado = rutaLibre(`${path}.corrupt-${Date.now()}`)
  renameSync(path, apartado)
  if (!o.silencioso) avisoArchivoApartado(path, apartado)
  return { valor: o.porDefecto(), apartado }
}

/** tmp + fsync + rename: ni un corte de luz deja el JSON a medias o vacío. */
export function escribirJsonAtomico(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, JSON.stringify(data, null, 2), null, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

export const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
