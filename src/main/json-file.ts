import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { avisoArchivoApartado, avisoSoloLectura } from './avisos'

export interface OpcionesLectura<T> {
  /** Devuelve el valor normalizado, o undefined si el contenido no sirve (el archivo se aparta). */
  validar: (v: unknown) => T | undefined
  porDefecto: () => T
  /** Sin aviso a la UI (p. ej. quien llama arma su propio mensaje). */
  silencioso?: boolean
  /**
   * Solo mirar (p. ej. el tema antes de crear la ventana): ante cualquier problema devuelve el valor
   * por defecto sin apartar, avisar ni bloquear. La lectura de verdad la hace después quien guarda.
   */
  soloConsulta?: boolean
}

export interface LecturaJson<T> {
  valor: T
  /** Ruta donde quedó el archivo roto, si hubo que apartarlo. */
  apartado?: string
  /** No se pudo leer o apartar: el archivo puede estar sano, así que no se escribe encima hasta reiniciar. */
  soloLectura?: true
  motivo?: string
}

export const RESPALDOS_POR_ARCHIVO = 5
const TMP_HUERFANO_MS = 60_000
const FSYNC_NO_SOPORTADO = new Set(['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR', 'ENOSYS'])

const bloqueados = new Set<string>()
const clave = (path: string): string => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path))

const codigo = (e: unknown): string | undefined =>
  e && typeof e === 'object' && 'code' in e && typeof e.code === 'string' ? e.code : undefined
const mensaje = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const escapar = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function rutaLibre(base: string): string {
  if (!existsSync(base)) return base
  for (let i = 1; ; i++) if (!existsSync(`${base}-${i}`)) return `${base}-${i}`
}

/** ¿Este archivo quedó en solo lectura en esta sesión? */
export function bloqueado(path: string): boolean {
  return bloqueados.has(clave(path))
}

function enSoloLectura<T>(path: string, o: OpcionesLectura<T>, motivo: string): LecturaJson<T> {
  bloqueados.add(clave(path))
  if (!o.silencioso) avisoSoloLectura(path, motivo)
  return { valor: o.porDefecto(), soloLectura: true, motivo }
}

/**
 * Lee un JSON del usuario. Si no existe, el valor por defecto. Si existe pero no se puede usar, lo
 * aparta como `<archivo>.corrupt-<ts>` para que el próximo guardado no lo pise. Si no se puede leer
 * (permisos, antivirus) o apartar, no tira: devuelve el valor por defecto y deja el archivo en solo
 * lectura, porque puede estar sano.
 */
export function leerJson<T>(path: string, o: OpcionesLectura<T>): LecturaJson<T> {
  if (!o.soloConsulta) limpiarTmpHuerfanos(path)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    if (codigo(e) === 'ENOENT' || o.soloConsulta) return { valor: o.porDefecto() }
    return enSoloLectura(path, o, `no se pudo leer (${mensaje(e)})`)
  }
  let valor: T | undefined
  try {
    valor = o.validar(JSON.parse(raw.replace(/^﻿/, '')))
  } catch {
    valor = undefined
  }
  if (valor !== undefined) return { valor }
  if (o.soloConsulta) return { valor: o.porDefecto() }
  const apartado = rutaLibre(`${path}.corrupt-${Date.now()}`)
  try {
    renameSync(path, apartado)
  } catch (e) {
    return enSoloLectura(path, o, `está dañado y no se pudo apartar (${mensaje(e)})`)
  }
  podarRespaldos(path, '.corrupt-')
  if (!o.silencioso) avisoArchivoApartado(path, apartado)
  return { valor: o.porDefecto(), apartado }
}

/**
 * tmp + fsync + rename: ni un corte de luz deja el JSON a medias o vacío. Devuelve false sin tocar
 * nada si el archivo quedó en solo lectura al leerlo.
 */
export function escribirJsonAtomico(path: string, data: unknown): boolean {
  if (bloqueado(path)) return false
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, JSON.stringify(data, null, 2), null, 'utf8')
      sincronizar(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  } catch (e) {
    borrar(tmp)
    throw e
  }
  return true
}

/** Algunos montajes (unidades virtuales, ciertos SMB) no soportan fsync: ahí se sigue sin él. */
function sincronizar(fd: number): void {
  try {
    fsyncSync(fd)
  } catch (e) {
    if (!FSYNC_NO_SOPORTADO.has(codigo(e) ?? '')) throw e
  }
}

function borrar(f: string): void {
  try {
    unlinkSync(f)
  } catch (e) {
    if (codigo(e) !== 'ENOENT') console.warn('[json] no se pudo borrar', f, mensaje(e))
  }
}

function listar(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch (e) {
    if (codigo(e) !== 'ENOENT') console.warn('[json] no se pudo listar', dir, mensaje(e))
    return []
  }
}

/** Los `<archivo>.<pid>.tmp` de otro proceso que quedaron de un guardado cortado. */
function limpiarTmpHuerfanos(path: string): void {
  const dir = dirname(path)
  const patron = new RegExp(`^${escapar(basename(path))}\\.(\\d+)\\.tmp$`)
  for (const n of listar(dir)) {
    const m = patron.exec(n)
    if (!m || Number(m[1]) === process.pid) continue
    const f = join(dir, n)
    try {
      if (Date.now() - statSync(f).mtimeMs > TMP_HUERFANO_MS) borrar(f)
    } catch (e) {
      if (codigo(e) !== 'ENOENT') console.warn('[json] no se pudo revisar', f, mensaje(e))
    }
  }
}

/** Respaldos `<archivo><marcador><ts>[-n]`, del más nuevo al más viejo. */
function respaldos(path: string, marcador: string): string[] {
  const dir = dirname(path)
  const patron = new RegExp(`^${escapar(basename(path) + marcador)}(\\d+)(?:-(\\d+))?$`)
  return listar(dir)
    .map((n) => ({ n, m: patron.exec(n) }))
    .filter((x): x is { n: string; m: RegExpExecArray } => x.m !== null)
    .sort((a, b) => Number(b.m[1]) - Number(a.m[1]) || Number(b.m[2] ?? 0) - Number(a.m[2] ?? 0))
    .map((x) => join(dir, x.n))
}

/** Deja solo los `conservar` respaldos más nuevos de ese archivo. */
export function podarRespaldos(path: string, marcador: string, conservar = RESPALDOS_POR_ARCHIVO): void {
  for (const f of respaldos(path, marcador).slice(conservar)) borrar(f)
}

/**
 * Copia el archivo a `<archivo>.bak-<ts>` y poda los viejos. Si el respaldo más nuevo ya tiene el
 * mismo contenido lo reusa, así no se suma uno por arranque. Tira si no puede copiar.
 */
export function respaldar(path: string): string {
  const actual = readFileSync(path)
  const ultimo = respaldos(path, '.bak-')[0]
  if (ultimo) {
    try {
      if (readFileSync(ultimo).equals(actual)) return ultimo
    } catch (e) {
      console.warn('[json] no se pudo comparar con', ultimo, mensaje(e))
    }
  }
  const bak = rutaLibre(`${path}.bak-${Date.now()}`)
  copyFileSync(path, bak)
  podarRespaldos(path, '.bak-')
  return bak
}

export const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
