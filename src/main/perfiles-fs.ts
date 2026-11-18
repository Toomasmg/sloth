import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { escribirJsonAtomico, leerJson, respaldar } from './json-file'
import {
  aCopiar,
  idPerfilValido,
  NOMBRE_INICIAL,
  PERFIL_INICIAL_ID,
  reconstruirIndice,
  validarIndice,
  validarMeta,
  type IndicePerfiles,
  type Perfil
} from './perfiles-core'

// perfiles.json y perfil.json nacen en version 1; si el formato crece, se migra con migrar() de versionado.ts como en store-core.

export interface RutasPerfiles {
  raiz: string
  carpeta: string
  indice: string
  respaldos: string
}

export const rutasPerfiles = (raiz: string): RutasPerfiles => ({
  raiz,
  carpeta: join(raiz, 'perfiles'),
  indice: join(raiz, 'perfiles.json'),
  respaldos: join(raiz, 'respaldos')
})

export interface ResultadoArranque {
  indice: IndicePerfiles
  migrado: boolean
  reconstruido: boolean
  /** No se pudieron preparar los perfiles: se sigue con la raíz de siempre. */
  error?: string
  /** Algo menor que no frena el arranque (restos de un intento cortado que no se pudieron borrar). */
  aviso?: string
}

const META = 'perfil.json'
const TMP_PRINCIPAL = `.${PERFIL_INICIAL_ID}.tmp`
const RESPALDO_PREVIO = /^pre-perfiles-\d+$/
const RESPALDO_TMP = /^\.pre-perfiles-\d+\.tmp$/

const mensaje = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function listar(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return []
    throw e
  }
}

export function leerMeta(carpetaPerfil: string): Perfil | null {
  const r = leerJson<Perfil | null>(join(carpetaPerfil, META), { validar: (v) => validarMeta(v) ?? undefined, porDefecto: () => null, silencioso: true })
  return r.valor
}

export function escribirMeta(carpetaPerfil: string, p: Perfil): void {
  escribirJsonAtomico(join(carpetaPerfil, META), p)
}

export function guardarIndice(raiz: string, indice: IndicePerfiles): void {
  if (!escribirJsonAtomico(rutasPerfiles(raiz).indice, indice)) throw new Error('perfiles.json quedó en solo lectura')
}

/** Solo cuenta la carpeta cuyo perfil.json dice ser ella: una carpeta copiada a mano con otro nombre no se confunde. */
function escanear(carpeta: string): Perfil[] {
  const metas: Perfil[] = []
  for (const n of listar(carpeta)) {
    if (!idPerfilValido(n)) continue
    const dir = join(carpeta, n)
    if (!lstatSync(dir).isDirectory()) continue
    const m = leerMeta(dir)
    if (m && m.id === n) metas.push(m)
  }
  return metas
}

/** Los .tmp que dejó una migración o un respaldo cortados. Nunca hay uno en curso: hay una sola instancia. */
function barrerTmp(r: RutasPerfiles): string | undefined {
  const fallas: string[] = []
  const barrer = (dir: string, es: (n: string) => boolean): void => {
    for (const n of listar(dir)) {
      if (!es(n)) continue
      try {
        rmSync(join(dir, n), { recursive: true, force: true })
      } catch (e) {
        fallas.push(`${n}: ${mensaje(e)}`)
      }
    }
  }
  try {
    barrer(r.carpeta, (n) => n.startsWith('.') && n.includes('.tmp'))
    barrer(r.respaldos, (n) => RESPALDO_TMP.test(n))
  } catch (e) {
    fallas.push(mensaje(e))
  }
  return fallas.length ? `no pude limpiar restos de una migración cortada (${fallas.join('; ')})` : undefined
}

/** Cada archivo del original existe en la copia con el mismo tamaño. */
function verificarCopia(origen: string, destino: string): void {
  const o = lstatSync(origen)
  const d = lstatSync(destino)
  if (o.isDirectory()) {
    if (!d.isDirectory()) throw new Error(`la copia de ${origen} no es una carpeta`)
    for (const n of readdirSync(origen)) verificarCopia(join(origen, n), join(destino, n))
    return
  }
  if (o.size !== d.size) throw new Error(`la copia de ${origen} no coincide con el original`)
}

function copiarEntradas(raiz: string, entradas: readonly string[], destino: string): void {
  for (const e of entradas) {
    cpSync(join(raiz, e), join(destino, e), { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true })
    verificarCopia(join(raiz, e), join(destino, e))
  }
}

/** Uno solo, del primer intento: los reintentos no lo pisan ni suman otros. */
function respaldarRaiz(r: RutasPerfiles, entradas: readonly string[], ahora: number): void {
  if (!entradas.length || listar(r.respaldos).some((n) => RESPALDO_PREVIO.test(n))) return
  const tmp = join(r.respaldos, `.pre-perfiles-${ahora}.tmp`)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  try {
    copiarEntradas(r.raiz, entradas, tmp)
    renameSync(tmp, join(r.respaldos, `pre-perfiles-${ahora}`))
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true })
    throw e
  }
}

function migrar(r: RutasPerfiles, ahora: number): Perfil {
  const entradas = aCopiar(listar(r.raiz))
  respaldarRaiz(r, entradas, ahora)
  const meta: Perfil = { id: PERFIL_INICIAL_ID, nombre: NOMBRE_INICIAL, creado: ahora }
  mkdirSync(r.carpeta, { recursive: true })
  const tmp = join(r.carpeta, TMP_PRINCIPAL)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp)
  try {
    copiarEntradas(r.raiz, entradas, tmp)
    escribirMeta(tmp, meta)
    if (!validarMeta(leerMeta(tmp))) throw new Error('no se pudo verificar perfil.json')
    renameSync(tmp, join(r.carpeta, PERFIL_INICIAL_ID))
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true })
    throw e
  }
  return meta
}

/** Un perfiles.json sano pero que apunta a carpetas que ya no están se guarda aparte antes de rearmarlo. */
function reemplazarIndice(raiz: string, indice: IndicePerfiles): void {
  if (existsSync(rutasPerfiles(raiz).indice)) respaldar(rutasPerfiles(raiz).indice)
  guardarIndice(raiz, indice)
}

const emergencia = (ahora: number, error: string): ResultadoArranque => ({
  indice: { version: 1, activo: PERFIL_INICIAL_ID, perfiles: [{ id: PERFIL_INICIAL_ID, nombre: NOMBRE_INICIAL, creado: ahora }] },
  migrado: false,
  reconstruido: false,
  error
})

/**
 * Idempotente. Devuelve el índice vigente; nunca tira por el disco: ante un fallo devuelve `error` y un
 * índice de emergencia, y quien llama sigue trabajando sobre la raíz de siempre. La raíz nunca se modifica:
 * se copia, así una versión anterior de Sloth sigue abriendo sus datos.
 */
export function iniciarPerfilesFs(raiz: string, ahora: () => number): ResultadoArranque {
  const r = rutasPerfiles(raiz)
  try {
    const lectura = leerJson<IndicePerfiles | null>(r.indice, { validar: (v) => validarIndice(v) ?? undefined, porDefecto: () => null, silencioso: true })
    const previo = lectura.valor
    const metas = escanear(r.carpeta)
    if (previo && metas.some((m) => m.id === previo.activo)) {
      return { indice: previo, migrado: false, reconstruido: false, aviso: barrerTmp(r) }
    }
    if (metas.length) {
      const indice = reconstruirIndice(metas, previo?.activo)
      if (!indice) throw new Error('no se pudo rearmar perfiles.json')
      // Sin poder leer perfiles.json (puede estar sano) se usa el rearmado sin escribirlo encima.
      if (!lectura.soloLectura) reemplazarIndice(raiz, indice)
      return { indice, migrado: false, reconstruido: true, aviso: barrerTmp(r) }
    }
    if (lectura.soloLectura) throw new Error(`perfiles.json ${lectura.motivo ?? 'no se pudo leer'}`)
    const meta = migrar(r, ahora())
    const indice: IndicePerfiles = { version: 1, activo: meta.id, perfiles: [meta] }
    reemplazarIndice(raiz, indice)
    return { indice, migrado: true, reconstruido: false, aviso: barrerTmp(r) }
  } catch (e) {
    return emergencia(ahora(), mensaje(e))
  }
}
