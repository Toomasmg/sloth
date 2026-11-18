import { randomUUID } from 'node:crypto'
import { constants, copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { aplicarNotify, lineaNotify, quitarNotify, verificarCambio } from './codex-notify-core'
import { logger } from './logger-global'

export interface DepsNotify {
  /** undefined si el archivo no existe. */
  leer(file: string): string | undefined
  /** Copia exclusiva a `<file>.sloth-bak`; no hace nada si ya hay una o no hay archivo. */
  respaldar(file: string): void
  /**
   * tmp único y rename. Antes del rename relee el tmp (tiene que pasar `verificar`) y el archivo (tiene que seguir
   * igual a `previo`): si Codex lo tocó en el medio se aborta con code ECAMBIO, y si no pasa la verificación, EVERIF.
   */
  escribir(file: string, texto: string, previo: string | undefined, verificar: (leido: string) => string | undefined): void
}

const conCodigo = (mensaje: string, code: string): Error => Object.assign(new Error(mensaje), { code })

export const depsNotifyReales: DepsNotify = {
  leer(file) {
    if (!existsSync(file)) return undefined
    return readFileSync(file, 'utf8')
  },
  respaldar(file) {
    const bak = `${file}.sloth-bak`
    if (!existsSync(file) || existsSync(bak)) return
    try {
      copyFileSync(file, bak, constants.COPYFILE_EXCL)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  },
  escribir(file, texto, previo, verificar) {
    const tmp = `${file}.tmp-${randomUUID()}`
    writeFileSync(tmp, texto, { encoding: 'utf8', flag: 'wx' })
    try {
      const leido = readFileSync(tmp, 'utf8')
      if (leido !== texto || verificar(leido)) throw conCodigo('verificación', 'EVERIF')
      // Codex guarda la confianza de cada proyecto en este mismo archivo: si cambió desde que lo leímos, ese cambio se perdería.
      if ((existsSync(file) ? readFileSync(file, 'utf8') : undefined) !== previo) throw conCodigo('cambió', 'ECAMBIO')
      renameSync(tmp, file)
    } catch (e) {
      rmSync(tmp, { force: true })
      throw e
    }
  }
}

export const MOTIVO_AJENO = 'Esta cuenta de Codex ya tiene un «notify» propio en su config.toml. Sloth no lo toca, así que no llega el aviso de «terminó».'
export const MOTIVO_SIN_NODE = 'Para el aviso de «terminó» hace falta Node.js en el PATH, y no lo encuentro.'
const MOTIVO_RUTA = 'La ruta de la carpeta de datos de Sloth tiene caracteres que no se pueden escribir en el config.toml de Codex; no se activa el aviso de «terminó».'
export const MOTIVO_DUDOSO = 'No pude leer con seguridad el config.toml de esta cuenta de Codex (TOML que no entiendo o con claves repetidas). No lo toco, así que no llega el aviso de «terminó».'
export const MOTIVO_CAMBIO = 'El config.toml de la cuenta cambió mientras lo editaba (Codex lo estaba guardando). No escribí nada; probá de nuevo en un momento.'

// Solo el código del error: el mensaje de fs trae la ruta de la carpeta de la cuenta y el log se comparte.
function motivoDeError(cual: string, e: unknown): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ECAMBIO') return MOTIVO_CAMBIO
  if (code === 'EVERIF') return MOTIVO_DUDOSO
  return `No pude ${cual} el config.toml de la cuenta de Codex (${code ?? 'error'}).`
}

/**
 * Pone (o actualiza) la línea `notify` de Sloth en el config.toml de la cuenta. Devuelve el motivo por el
 * que no quedó puesta, o undefined si quedó. Nunca pisa un `notify` del usuario y respalda antes de escribir.
 */
export function prepararNotify(configDir: string, nodeExe: string | undefined, script: string, deps: DepsNotify = depsNotifyReales): string | undefined {
  if (!nodeExe) return MOTIVO_SIN_NODE
  const linea = lineaNotify(nodeExe, script)
  if (!linea) return MOTIVO_RUTA
  const file = join(configDir, 'config.toml')
  let actual: string | undefined
  try {
    actual = deps.leer(file)
  } catch (e) {
    return motivoDeError('leer', e)
  }
  const previo = actual ?? ''
  const r = aplicarNotify(previo, linea)
  if (r.cambio === 'ajeno') return MOTIVO_AJENO
  if (r.cambio === 'dudoso') return MOTIVO_DUDOSO
  if (r.cambio === 'igual') return undefined
  const verificar = (texto: string): string | undefined => verificarCambio(previo, texto, true)
  if (verificar(r.toml)) return MOTIVO_DUDOSO
  try {
    deps.respaldar(file)
    deps.escribir(file, r.toml, actual, verificar)
  } catch (e) {
    return motivoDeError('escribir', e)
  }
  return undefined
}

/** Saca solo la línea `notify` que puso Sloth. Sin esa línea no toca el archivo (ni lo respalda). */
export function desinstalarNotify(configDir: string, deps: DepsNotify = depsNotifyReales): string | undefined {
  const file = join(configDir, 'config.toml')
  try {
    const actual = deps.leer(file)
    if (actual === undefined) return undefined
    const r = quitarNotify(actual)
    if (r.dudoso) return MOTIVO_DUDOSO
    if (!r.quitada) return undefined
    const verificar = (texto: string): string | undefined => verificarCambio(actual, texto, false)
    if (verificar(r.toml)) return MOTIVO_DUDOSO
    deps.respaldar(file)
    deps.escribir(file, r.toml, actual, verificar)
  } catch (e) {
    return motivoDeError('actualizar', e)
  }
  return undefined
}

/** El mismo motivo se dice una sola vez por arranque: el aviso no lleva datos de la cuenta, así que da igual de cuál venga. */
export function avisoUnaVez(decir: (msg: string) => void): (msg: string) => void {
  const dichos = new Set<string>()
  return (msg) => {
    if (dichos.has(msg)) return
    dichos.add(msg)
    decir(msg)
  }
}

export const avisarNotify = avisoUnaVez((msg) => logger.aviso('codex', msg))
