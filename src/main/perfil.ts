import { app } from 'electron'
import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { avisar } from './avisos'
import { logger } from './logger-global'
import { NOMBRE_INICIAL, PERFIL_INICIAL_ID, type IndicePerfiles, type Perfil } from './perfiles-core'
import { iniciarPerfilesFs, rutasPerfiles, type ResultadoArranque } from './perfiles-fs'

let resultado: ResultadoArranque | undefined
let cambiando = false

const mensaje = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function raizDatos(): string {
  return app.getPath('userData')
}

/**
 * La app antes se llamaba AntiRea: si existe %APPDATA%\AntiRea y todavía no hay %APPDATA%\Sloth,
 * se mueve la carpeta entera (logins de las cuentas incluidos). Va antes de preparar los perfiles
 * para que lo traído entre en la migración.
 */
function traerDeAntiRea(): void {
  // Instancia de prueba o tests (SLOTH_USER_DATA): nunca se traen datos reales a su carpeta.
  if (process.env.SLOTH_USER_DATA) return
  const oldDir = join(app.getPath('appData'), 'AntiRea')
  const newDir = raizDatos()
  if (!existsSync(oldDir) || existsSync(join(newDir, 'sloth-state.json')) || existsSync(join(newDir, 'accounts'))) return
  try {
    if (!existsSync(newDir)) {
      renameSync(oldDir, newDir)
    } else {
      // Chromium ya creó la carpeta nueva (cachés): movemos solo lo nuestro.
      for (const name of ['accounts', 'antirea-state.json']) {
        const from = join(oldDir, name)
        if (existsSync(from)) renameSync(from, join(newDir, name))
      }
    }
  } catch (e) {
    logger.aviso('perfiles', `no se pudo mover %APPDATA%\\AntiRea: ${mensaje(e)}`)
  }
}

function renombrarEstadoViejo(): void {
  const actual = join(raizDatos(), 'sloth-state.json')
  const legacy = join(raizDatos(), 'antirea-state.json')
  try {
    if (!existsSync(actual) && existsSync(legacy)) renameSync(legacy, actual)
  } catch (e) {
    logger.aviso('perfiles', `no se pudo renombrar antirea-state.json: ${mensaje(e)}`)
  }
}

/** Idempotente: lo llama el store al arrancar o la primera función que pida una ruta del perfil. */
export function iniciarPerfiles(): ResultadoArranque {
  if (resultado) return resultado
  traerDeAntiRea()
  renombrarEstadoViejo()
  resultado = iniciarPerfilesFs(raizDatos(), Date.now)
  if (resultado.error) {
    logger.aviso('perfiles', `sigo con la raíz de siempre: ${resultado.error}`)
    avisar(`No pude preparar los perfiles (${resultado.error}). Sloth sigue con tus datos de siempre; reiniciá para reintentar.`)
  } else {
    if (resultado.migrado) logger.info('perfiles', 'datos copiados al perfil principal')
    if (resultado.reconstruido) logger.aviso('perfiles', 'perfiles.json rearmado a partir de las carpetas')
    if (resultado.aviso) logger.aviso('perfiles', resultado.aviso)
  }
  return resultado
}

export function recargarIndice(): void {
  resultado = undefined
  iniciarPerfiles()
}

/** La migración falló: se trabaja sobre la raíz vieja, como antes de los perfiles. */
export function modoRaiz(): boolean {
  return iniciarPerfiles().error !== undefined
}

export function indicePerfiles(): IndicePerfiles {
  return iniciarPerfiles().indice
}

export function perfilActivo(): Perfil {
  const i = indicePerfiles()
  return i.perfiles.find((p) => p.id === i.activo) ?? { id: PERFIL_INICIAL_ID, nombre: NOMBRE_INICIAL, creado: 0 }
}

export function rutaPerfil(...partes: string[]): string {
  if (modoRaiz()) return join(raizDatos(), ...partes)
  return join(rutasPerfiles(raizDatos()).carpeta, indicePerfiles().activo, ...partes)
}

export const carpetaFeatures = (): string => rutaPerfil('features')

/** Reinicio por cambio de perfil: las terminales quedan vivas en el daemon aunque «Terminales vivas» esté apagado. */
export const marcarCambioDePerfil = (): void => {
  cambiando = true
}

export const cambiandoDePerfil = (): boolean => cambiando
