import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tomarCandado, type Candado, type ResultadoCandado } from './candado-archivo'
import { escribirJsonAtomico, leerJson, respaldar, rutaLibre } from './json-file'
import { MAX_NOMBRE_PERFIL } from '../shared/perfiles'
import {
  aCopiar,
  clasificarJson,
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
  type LecturaClasificada,
  type Perfil
} from './perfiles-core'

// perfiles.json y perfil.json nacen en version 1; si el formato crece, se migra con migrar() de versionado.ts como en store-core.
// Una versión futura de cualquiera de los dos no se aparta como .corrupt ni se reescribe: se respeta y se avisa.

export interface RutasPerfiles {
  raiz: string
  carpeta: string
  indice: string
  respaldos: string
  candado: string
}

export const rutasPerfiles = (raiz: string): RutasPerfiles => ({
  raiz,
  carpeta: join(raiz, 'perfiles'),
  indice: join(raiz, 'perfiles.json'),
  respaldos: join(raiz, 'respaldos'),
  candado: join(raiz, 'perfiles.lock')
})

export interface ResultadoArranque {
  indice: IndicePerfiles
  migrado: boolean
  reconstruido: boolean
  /** Todavía no había perfiles y no se pudieron preparar: se sigue con la raíz de siempre (no hay nada más nuevo en otro lado). */
  error?: string
  /** Ya hay perfiles pero no se puede usar ninguno (o los tiene tomados otra copia de Sloth): no se toca nada ni se cae a la raíz, que quedó congelada. */
  bloqueado?: string
  /** Algo menor que no frena el arranque y que conviene decirle a la persona. */
  avisoUsuario?: string
  /** Algo menor que no frena el arranque (restos de un intento cortado que no se pudieron borrar). */
  aviso?: string
}

const META = 'perfil.json'
const TMP_PRINCIPAL = `.${PERFIL_INICIAL_ID}.tmp`
const RESPALDO_PREVIO = /^pre-perfiles-\d+$/
const RESPALDO_TMP = /^\.pre-perfiles-\d+\.tmp$/

const mensaje = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const codigo = (e: unknown): string | undefined => (e && typeof e === 'object' && 'code' in e && typeof e.code === 'string' ? e.code : undefined)
const unir = (...partes: (string | undefined)[]): string | undefined => {
  const r = partes.filter((p): p is string => !!p).join('; ')
  return r || undefined
}

function listar(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch (e) {
    if (codigo(e) === 'ENOENT') return []
    throw e
  }
}

type Lectura<T> = LecturaClasificada<T> | { estado: 'ausente' } | { estado: 'ilegible'; motivo: string }

/** Solo mira: no aparta, no reescribe ni bloquea nada. */
function leerArchivo<T>(ruta: string, validar: (raw: unknown) => T | null): Lectura<T> {
  let texto: string
  try {
    texto = readFileSync(ruta, 'utf8')
  } catch (e) {
    return codigo(e) === 'ENOENT' ? { estado: 'ausente' } : { estado: 'ilegible', motivo: mensaje(e) }
  }
  return clasificarJson(texto, validar)
}

const leerEstadoMeta = (carpetaPerfil: string): Lectura<Perfil> => leerArchivo(join(carpetaPerfil, META), validarMeta)

export function leerMeta(carpetaPerfil: string): Perfil | null {
  const l = leerEstadoMeta(carpetaPerfil)
  return l.estado === 'ok' ? l.valor : null
}

export function escribirMeta(carpetaPerfil: string, p: Perfil): void {
  if (!escribirJsonAtomico(join(carpetaPerfil, META), p)) throw new Error('perfil.json quedó en solo lectura')
}

export function guardarIndice(raiz: string, indice: IndicePerfiles): void {
  if (!escribirJsonAtomico(rutasPerfiles(raiz).indice, indice)) throw new Error('perfiles.json quedó en solo lectura')
}

interface Escaneo {
  metas: Perfil[]
  /** Carpetas con pinta de perfil que no se pueden leer ahora o son de una versión futura: no se las deja fuera de un índice guardado. */
  inutilizables: { id: string; motivo: string }[]
  /** Tienen un perfil.json que no sirve (roto, otro id, nombre inválido). */
  descartadas: string[]
}

/** Solo cuenta la carpeta cuyo perfil.json dice ser ella: una carpeta copiada a mano con otro nombre no se confunde. */
function escanear(carpeta: string): Escaneo {
  const e: Escaneo = { metas: [], inutilizables: [], descartadas: [] }
  let nombres: string[]
  try {
    nombres = listar(carpeta)
  } catch (err) {
    // Si «perfiles» es un archivo no hay carpetas; cualquier otro fallo (permisos) hay que decirlo, no tomarlo por vacío.
    if (codigo(err) === 'ENOTDIR') return e
    throw err
  }
  for (const n of nombres) {
    if (!idPerfilValido(n)) continue
    const dir = join(carpeta, n)
    try {
      if (!lstatSync(dir).isDirectory()) continue
    } catch (err) {
      e.inutilizables.push({ id: n, motivo: mensaje(err) })
      continue
    }
    const l = leerEstadoMeta(dir)
    if (l.estado === 'ok') {
      if (l.valor.id === n) e.metas.push(l.valor)
      else e.descartadas.push(n)
    } else if (l.estado === 'futura') e.inutilizables.push({ id: n, motivo: 'su perfil.json es de una versión más nueva de Sloth' })
    else if (l.estado === 'ilegible') e.inutilizables.push({ id: n, motivo: `no pude leer su perfil.json (${l.motivo})` })
    else if (l.estado === 'invalida') e.descartadas.push(n)
  }
  return e
}

/** Los .tmp que dejó una migración o un respaldo cortados. Va con el candado tomado: otra copia de Sloth podría tener uno en curso. */
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

const esEnlace = (ruta: string): boolean => lstatSync(ruta).isSymbolicLink()

/** Cada archivo del original existe en la copia con el mismo tamaño. Los enlaces no se copian, así que tampoco se miran. */
function verificarCopia(origen: string, destino: string): void {
  const o = lstatSync(origen)
  if (o.isSymbolicLink()) return
  const d = lstatSync(destino)
  if (o.isDirectory()) {
    if (!d.isDirectory()) throw new Error(`la copia de ${origen} no es una carpeta`)
    for (const n of readdirSync(origen)) verificarCopia(join(origen, n), join(destino, n))
    return
  }
  if (o.size !== d.size) throw new Error(`la copia de ${origen} no coincide con el original`)
}

/**
 * Un enlace (symlink o junction) dentro de lo que se copia podría apuntar a la misma raíz o fuera de la carpeta
 * de datos: copiarlo como enlace dejaría al perfil y al respaldo compartiendo archivos con la raíz. No se
 * siguen ni se copian: se anotan y se avisa.
 */
function copiarEntradas(raiz: string, entradas: readonly string[], destino: string, omitidos: Set<string>): void {
  for (const e of entradas) {
    const origen = join(raiz, e)
    if (esEnlace(origen)) {
      omitidos.add(origen)
      continue
    }
    cpSync(origen, join(destino, e), {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      filter: (src) => {
        if (!esEnlace(src)) return true
        omitidos.add(src)
        return false
      }
    })
    verificarCopia(origen, join(destino, e))
  }
}

function avisoEnlaces(omitidos: ReadonlySet<string>): string | undefined {
  if (!omitidos.size) return undefined
  const lista = [...omitidos].sort().join(', ')
  return `no copié ${omitidos.size === 1 ? 'un enlace' : `${omitidos.size} enlaces`} (${lista}): seguirlos podía dejar al perfil apuntando a tu carpeta de datos de siempre. Quedan donde estaban`
}

/** Uno solo, del primer intento: los reintentos no lo pisan ni suman otros. */
function respaldarRaiz(r: RutasPerfiles, entradas: readonly string[], ahora: number, omitidos: Set<string>): void {
  if (!entradas.length || listar(r.respaldos).some((n) => RESPALDO_PREVIO.test(n))) return
  const tmp = join(r.respaldos, `.pre-perfiles-${ahora}.tmp`)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  try {
    copiarEntradas(r.raiz, entradas, tmp, omitidos)
    renameSync(tmp, join(r.respaldos, `pre-perfiles-${ahora}`))
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true })
    throw e
  }
}

function migrar(r: RutasPerfiles, ahora: number, omitidos: Set<string>): Perfil {
  const entradas = aCopiar(listar(r.raiz))
  respaldarRaiz(r, entradas, ahora, omitidos)
  const meta: Perfil = { id: PERFIL_INICIAL_ID, nombre: NOMBRE_INICIAL, creado: ahora }
  mkdirSync(r.carpeta, { recursive: true })
  const tmp = join(r.carpeta, TMP_PRINCIPAL)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp)
  try {
    copiarEntradas(r.raiz, entradas, tmp, omitidos)
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

/** Un perfiles.json roto se aparta como .corrupt para que lo nuevo no lo pise. Si no se puede apartar queda en solo lectura. */
function apartarIndice(raiz: string): void {
  leerJson<IndicePerfiles | null>(rutasPerfiles(raiz).indice, { validar: (v) => validarIndice(v) ?? undefined, porDefecto: () => null, silencioso: true })
}

const indiceVacio = (ahora: number): IndicePerfiles => ({ version: 1, activo: PERFIL_INICIAL_ID, perfiles: [{ id: PERFIL_INICIAL_ID, nombre: NOMBRE_INICIAL, creado: ahora }] })

const emergencia = (ahora: number, error: string): ResultadoArranque => ({ indice: indiceVacio(ahora), migrado: false, reconstruido: false, error })

const bloquear = (ahora: number, bloqueado: string): ResultadoArranque => ({ indice: indiceVacio(ahora), migrado: false, reconstruido: false, bloqueado })

function motivoBloqueo(indice: Lectura<IndicePerfiles>, e: Escaneo): string {
  const partes: string[] = []
  if (indice.estado === 'futura') partes.push('perfiles.json es de una versión más nueva de Sloth: actualizá Sloth')
  else if (indice.estado === 'ilegible') partes.push(`no pude leer perfiles.json (${indice.motivo})`)
  else if (indice.estado === 'ok') partes.push('perfiles.json lista perfiles pero no encuentro sus carpetas')
  for (const i of e.inutilizables) partes.push(`perfiles/${i.id}: ${i.motivo}`)
  if (e.descartadas.length) partes.push(`perfil.json que no sirve en: ${e.descartadas.map((n) => `perfiles/${n}`).join(', ')}`)
  return partes.join('; ')
}

const OCUPADO = 'Otra copia de Sloth está preparando tus perfiles en este momento. Cerrala y volvé a abrir Sloth.'

/** Con el candado tomado: otra copia de Sloth no puede migrar ni barrer tmp a la vez. */
function arrancarLento(raiz: string, r: RutasPerfiles, ahora: () => number): ResultadoArranque {
  const lectura = leerArchivo(r.indice, validarIndice)
  const previo = lectura.estado === 'ok' ? lectura.valor : null
  let e: Escaneo
  try {
    e = escanear(r.carpeta)
  } catch (err) {
    return bloquear(ahora(), `no pude leer la carpeta de perfiles (${mensaje(err)})`)
  }

  if (e.metas.length) {
    if (previo && e.inutilizables.some((i) => i.id === previo.activo)) return bloquear(ahora(), motivoBloqueo(lectura, e))
    const indice = previo && e.metas.some((m) => m.id === previo.activo) ? previo : reconstruirIndice(e.metas, previo?.activo)
    if (!indice) return bloquear(ahora(), 'no pude rearmar perfiles.json')
    const reconstruido = indice !== previo
    // Con un perfiles.json que no se puede leer o con perfiles que hoy no se pueden leer, guardar el rearmado los dejaría afuera.
    let avisoUsuario: string | undefined
    if (reconstruido && (lectura.estado === 'futura' || lectura.estado === 'ilegible' || e.inutilizables.length)) {
      avisoUsuario = `No guardé perfiles.json: ${motivoBloqueo(lectura, e)}. Sigo con los perfiles que pude leer.`
    } else if (reconstruido) {
      try {
        if (lectura.estado === 'invalida') apartarIndice(raiz)
        reemplazarIndice(raiz, indice)
      } catch (err) {
        avisoUsuario = `No pude guardar perfiles.json (${mensaje(err)}). Sigo con el que armé en memoria.`
      }
    }
    return { indice, migrado: false, reconstruido, avisoUsuario, aviso: unir(barrerTmp(r), e.descartadas.length ? `perfil.json que no sirve en ${e.descartadas.join(', ')}` : undefined) }
  }

  // Sin ningún perfil usable: si ya había (índice o carpetas con perfil.json), la raíz está congelada y migrar de nuevo pisaría lo nuevo.
  const habiaPerfiles = lectura.estado === 'ok' || lectura.estado === 'futura' || lectura.estado === 'ilegible' || e.inutilizables.length > 0 || e.descartadas.length > 0
  if (habiaPerfiles) return bloquear(ahora(), motivoBloqueo(lectura, e))

  const omitidos = new Set<string>()
  let meta: Perfil
  try {
    meta = migrar(r, ahora(), omitidos)
  } catch (err) {
    return emergencia(ahora(), mensaje(err))
  }
  const indice: IndicePerfiles = { version: 1, activo: meta.id, perfiles: [meta] }
  let falloIndice: string | undefined
  try {
    if (lectura.estado === 'invalida') apartarIndice(raiz)
    reemplazarIndice(raiz, indice)
  } catch (err) {
    // `principal` ya está completo: seguir en la raíz dejaría lo que se haga ahora fuera del perfil que el próximo arranque va a usar.
    falloIndice = `No pude guardar perfiles.json (${mensaje(err)}). Sigo con el perfil principal y lo reintento al abrir de nuevo.`
  }
  const enlaces = avisoEnlaces(omitidos)
  return { indice, migrado: true, reconstruido: false, avisoUsuario: unir(falloIndice, enlaces && `Perfiles: ${enlaces}.`), aviso: barrerTmp(r) }
}

function barrerConCandado(r: RutasPerfiles): string | undefined {
  let c: ResultadoCandado
  try {
    c = tomarCandado(r.candado)
  } catch (e) {
    return `no pude tomar el candado para limpiar restos de una migración cortada (${mensaje(e)})`
  }
  if (!c.tomado) return undefined
  const restos = barrerTmp(r)
  try {
    c.candado.liberar()
  } catch (e) {
    return unir(restos, `no pude borrar perfiles.lock (${mensaje(e)})`)
  }
  return restos
}

/**
 * Idempotente. Devuelve el índice vigente. La raíz nunca se modifica: se copia, así una versión anterior de
 * Sloth sigue abriendo sus datos. Una vez que hay perfiles la raíz queda congelada, así que desde ahí un
 * fallo nunca vuelve a ella ni migra de nuevo: se rearma el índice con los perfil.json válidos o se devuelve
 * `bloqueado` sin tocar nada. Solo si todavía no había perfiles y la migración falla se sigue con la raíz (`error`).
 */
export function iniciarPerfilesFs(raiz: string, ahora: () => number): ResultadoArranque {
  const r = rutasPerfiles(raiz)
  const rapido = leerArchivo(r.indice, validarIndice)
  if (rapido.estado === 'ok') {
    const activo = leerEstadoMeta(join(r.carpeta, rapido.valor.activo))
    if (activo.estado === 'ok' && activo.valor.id === rapido.valor.activo) {
      return { indice: rapido.valor, migrado: false, reconstruido: false, aviso: barrerConCandado(r) }
    }
  }
  let candado: Candado | undefined
  let sinCandado: string | undefined
  try {
    const c = tomarCandado(r.candado)
    if (!c.tomado) return bloquear(ahora(), OCUPADO)
    candado = c.candado
  } catch (e) {
    sinCandado = `no pude tomar el candado de los perfiles (${mensaje(e)})`
  }
  let res: ResultadoArranque
  try {
    res = arrancarLento(raiz, r, ahora)
  } catch (e) {
    res = bloquear(ahora(), `error inesperado al leer los perfiles (${mensaje(e)})`)
  }
  let sinLiberar: string | undefined
  try {
    candado?.liberar()
  } catch (e) {
    sinLiberar = `no pude borrar perfiles.lock (${mensaje(e)})`
  }
  const extra = unir(sinCandado, sinLiberar)
  return extra ? { ...res, aviso: unir(res.aviso, extra) } : res
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

export function leerIndiceVigente(raiz: string): IndicePerfiles | null {
  const l = leerArchivo(rutasPerfiles(raiz).indice, validarIndice)
  return l.estado === 'ok' ? l.valor : null
}

function indiceVigente(raiz: string): IndicePerfiles {
  const l = leerArchivo(rutasPerfiles(raiz).indice, validarIndice)
  if (l.estado === 'ok') return l.valor
  if (l.estado === 'futura') throw new Error('perfiles.json es de una versión más nueva de Sloth. Actualizá Sloth para administrar los perfiles.')
  throw new Error('No pude leer perfiles.json. Reiniciá Sloth para que lo rearme.')
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

/**
 * Valida el destino y devuelve lo que escribe el cambio. Se separa para poder validar antes de cerrar terminales:
 * si el perfil no está o está dañado no se debe haber matado nada.
 */
export function prepararCambioFs(raiz: string, id: unknown): () => void {
  const indice = indiceVigente(raiz)
  const { perfil, dir } = carpetaDe(raiz, id, indice)
  if (!leerMeta(dir)) throw new Error('La carpeta de ese perfil no está o está dañada.')
  return () => guardarIndice(raiz, { ...indiceVigente(raiz), activo: perfil.id })
}

export const cambiarActivoFs = (raiz: string, id: unknown): void => prepararCambioFs(raiz, id)()

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
