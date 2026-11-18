import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { escribirJsonAtomico, leerJson, respaldar, rutaLibre } from './json-file'
import { MAX_NOMBRE_PERFIL } from '../shared/perfiles'
import {
  aCopiar,
  dentroDe,
  loginGhValido,
  MAX_PERFILES,
  nombreLibre,
  nombrePerfilValido,
  nuevoIdPerfil,
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
  if (!escribirJsonAtomico(join(carpetaPerfil, META), p)) throw new Error('perfil.json quedó en solo lectura')
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

export const MAX_BYTES_FOTO = 512 * 1024
const FOTO = 'foto.png'

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG = [0xff, 0xd8, 0xff]

const empieza = (b: Buffer, firma: readonly number[]): boolean => b.length >= firma.length && firma.every((x, i) => b[i] === x)

/** Solo por los bytes: ni la extensión ni lo que diga el servidor cuentan. */
export function tipoImagen(b: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (empieza(b, PNG)) return 'image/png'
  if (empieza(b, JPEG)) return 'image/jpeg'
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

function indiceVigente(raiz: string): IndicePerfiles {
  const r = leerJson<IndicePerfiles | null>(rutasPerfiles(raiz).indice, {
    validar: (v) => validarIndice(v) ?? undefined,
    porDefecto: () => null,
    silencioso: true,
    soloConsulta: true
  })
  if (!r.valor) throw new Error('No pude leer perfiles.json. Reiniciá Sloth para que lo rearme.')
  return r.valor
}

/** El id viene del renderer: solo vale uno que ya está en el índice y cuya carpeta queda dentro de perfiles/. */
function carpetaDe(raiz: string, id: unknown, indice: IndicePerfiles): { perfil: Perfil; dir: string } {
  if (!idPerfilValido(id)) throw new Error('Perfil inválido.')
  const base = rutasPerfiles(raiz).carpeta
  const perfil = indice.perfiles.find((p) => p.id === id)
  const dir = join(base, id)
  if (!perfil || !dentroDe(base, dir)) throw new Error('Ese perfil no existe.')
  return { perfil, dir }
}

function nombreOError(nombre: unknown): string {
  const n = nombrePerfilValido(nombre)
  if (!n) throw new Error(`El nombre del perfil tiene que tener entre 1 y ${MAX_NOMBRE_PERFIL} caracteres y no puede llevar caracteres de control.`)
  return n
}

function reemplazarPerfil(raiz: string, indice: IndicePerfiles, dir: string, nuevo: Perfil): void {
  escribirMeta(dir, nuevo)
  guardarIndice(raiz, { ...indice, perfiles: indice.perfiles.map((p) => (p.id === nuevo.id ? nuevo : p)) })
}

export function crearPerfilFs(raiz: string, nombre: unknown, ahora: number, azar: () => string): Perfil {
  const n = nombreOError(nombre)
  const indice = indiceVigente(raiz)
  if (indice.perfiles.length >= MAX_PERFILES) throw new Error(`No se pueden tener más de ${MAX_PERFILES} perfiles.`)
  if (!nombreLibre(n, indice.perfiles)) throw new Error('Ya hay un perfil con ese nombre.')
  const r = rutasPerfiles(raiz)
  mkdirSync(r.carpeta, { recursive: true })
  const id = nuevoIdPerfil([...indice.perfiles.map((p) => p.id), ...listar(r.carpeta)], azar)
  const perfil: Perfil = { id, nombre: n, creado: ahora }
  const tmp = join(r.carpeta, `.tmp-${id}`)
  const destino = join(r.carpeta, id)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(join(tmp, 'features'), { recursive: true })
  try {
    escribirMeta(tmp, perfil)
    if (!validarMeta(leerMeta(tmp))) throw new Error('no se pudo verificar perfil.json')
    renameSync(tmp, destino)
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true })
    throw e
  }
  try {
    guardarIndice(raiz, { ...indice, perfiles: [...indice.perfiles, perfil] })
  } catch (e) {
    // La carpeta es nueva y está vacía: no hay nada del usuario que perder.
    rmSync(destino, { recursive: true, force: true })
    throw e
  }
  return perfil
}

export function renombrarPerfilFs(raiz: string, id: unknown, nombre: unknown): Perfil {
  const n = nombreOError(nombre)
  const indice = indiceVigente(raiz)
  const { perfil, dir } = carpetaDe(raiz, id, indice)
  if (!nombreLibre(n, indice.perfiles, perfil.id)) throw new Error('Ya hay un perfil con ese nombre.')
  const nuevo: Perfil = { ...perfil, nombre: n }
  reemplazarPerfil(raiz, indice, dir, nuevo)
  return nuevo
}

export function guardarGhLogin(raiz: string, id: unknown, login: unknown): Perfil {
  if (!loginGhValido(login)) throw new Error('Usuario de GitHub inválido.')
  const indice = indiceVigente(raiz)
  const { perfil, dir } = carpetaDe(raiz, id, indice)
  const nuevo: Perfil = { ...perfil, ghLogin: login }
  reemplazarPerfil(raiz, indice, dir, nuevo)
  return nuevo
}

export function cambiarActivoFs(raiz: string, id: unknown): void {
  const indice = indiceVigente(raiz)
  const { perfil, dir } = carpetaDe(raiz, id, indice)
  if (!leerMeta(dir)) throw new Error('La carpeta de ese perfil no está o está dañada.')
  guardarIndice(raiz, { ...indice, activo: perfil.id })
}

/** rename; si cruza de disco (EXDEV) copia, verifica que cada archivo llegó con su tamaño y recién ahí borra el origen. */
function mover(origen: string, destino: string): void {
  try {
    renameSync(origen, destino)
  } catch (e) {
    if (!(e && typeof e === 'object' && 'code' in e && e.code === 'EXDEV')) throw e
    try {
      cpSync(origen, destino, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true })
      verificarCopia(origen, destino)
    } catch (err) {
      rmSync(destino, { recursive: true, force: true })
      throw err
    }
    rmSync(origen, { recursive: true, force: true })
  }
}

/** Un perfil borrado se mueve a respaldos/: nunca se elimina. Devuelve la carpeta donde quedó. */
export function borrarPerfilFs(raiz: string, id: unknown, ahora: number): string {
  const indice = indiceVigente(raiz)
  const { perfil, dir } = carpetaDe(raiz, id, indice)
  if (perfil.id === indice.activo) throw new Error('No se puede borrar el perfil activo. Cambiá a otro primero.')
  if (indice.perfiles.length <= 1) throw new Error('No se puede borrar el último perfil.')
  const r = rutasPerfiles(raiz)
  mkdirSync(r.respaldos, { recursive: true })
  const destino = rutaLibre(join(r.respaldos, `perfil-${perfil.id}-${ahora}`))
  if (existsSync(dir)) mover(dir, destino)
  try {
    guardarIndice(raiz, { ...indice, perfiles: indice.perfiles.filter((p) => p.id !== perfil.id) })
  } catch (e) {
    if (existsSync(destino)) mover(destino, dir)
    throw e
  }
  return destino
}

export function guardarFoto(raiz: string, id: unknown, bytes: Buffer): void {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES_FOTO) throw new Error('La foto tiene que pesar menos de 512 KB.')
  if (!tipoImagen(bytes)) throw new Error('La foto tiene que ser PNG, JPEG o WebP.')
  const { dir } = carpetaDe(raiz, id, indiceVigente(raiz))
  const tmp = join(dir, `${FOTO}.${process.pid}.tmp`)
  try {
    writeFileSync(tmp, bytes)
    renameSync(tmp, join(dir, FOTO))
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

export function tieneFoto(raiz: string, id: string): boolean {
  return idPerfilValido(id) && existsSync(join(rutasPerfiles(raiz).carpeta, id, FOTO))
}

export function leerFotoDataUrl(raiz: string, id: unknown): string | null {
  const { dir } = carpetaDe(raiz, id, indiceVigente(raiz))
  let bytes: Buffer
  try {
    const f = join(dir, FOTO)
    if (statSync(f).size > MAX_BYTES_FOTO) return null
    bytes = readFileSync(f)
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return null
    throw e
  }
  const tipo = tipoImagen(bytes)
  return tipo ? `data:${tipo};base64,${bytes.toString('base64')}` : null
}
