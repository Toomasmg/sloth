import { app } from 'electron'
import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { avisar } from './avisos'
import { logger } from './logger-global'
import { NOMBRE_INICIAL, PERFIL_INICIAL_ID, type IndicePerfiles, type Perfil } from './perfiles-core'
import { iniciarPerfilesFs, leerIndiceVigente, rutasPerfiles, type ResultadoArranque } from './perfiles-fs'

let resultado: ResultadoArranque | undefined
// El perfil con el que arrancó esta sesión: el Store y todas las rutas lo usan, aunque el índice cambie en disco antes del reinicio.
let activoSesion: string | undefined
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
  activoSesion = resultado.indice.activo
  if (resultado.bloqueado) {
    logger.error('perfiles', `no se pueden usar los perfiles: ${resultado.bloqueado}`)
  } else if (resultado.error) {
    logger.aviso('perfiles', `sigo con la raíz de siempre: ${resultado.error}`)
    avisar(`No pude preparar los perfiles (${resultado.error}). Sloth sigue con tus datos de siempre; reiniciá para reintentar.`)
  } else {
    if (resultado.migrado) logger.info('perfiles', 'datos copiados al perfil principal')
    if (resultado.reconstruido) logger.aviso('perfiles', 'perfiles.json rearmado a partir de las carpetas')
    if (resultado.aviso) logger.aviso('perfiles', resultado.aviso)
    if (resultado.avisoUsuario) {
      logger.aviso('perfiles', resultado.avisoUsuario)
      avisar(resultado.avisoUsuario)
    }
  }
  return resultado
}

/** Si la relectura falla se conserva el índice anterior: perder de vista los perfiles a mitad de sesión es peor que mostrar uno viejo. */
export function recargarIndice(): void {
  const actual = iniciarPerfiles()
  const indice = leerIndiceVigente(raizDatos())
  if (!indice) {
    logger.aviso('perfiles', 'no pude releer perfiles.json; sigo con el índice de antes')
    return
  }
  resultado = { ...actual, indice }
}

/** Todavía no había perfiles y no se pudieron preparar: se trabaja sobre la raíz, como antes de los perfiles. */
export function modoRaiz(): boolean {
  return iniciarPerfiles().error !== undefined
}

export function indicePerfiles(): IndicePerfiles {
  return iniciarPerfiles().indice
}

/** El id del perfil con el que corre esta sesión. */
export function idPerfilActivo(): string {
  iniciarPerfiles()
  return activoSesion ?? PERFIL_INICIAL_ID
}

export function perfilActivo(): Perfil {
  const id = idPerfilActivo()
  return indicePerfiles().perfiles.find((p) => p.id === id) ?? { id: PERFIL_INICIAL_ID, nombre: NOMBRE_INICIAL, creado: 0 }
}

export function rutaPerfil(...partes: string[]): string {
  const r = iniciarPerfiles()
  // Con los perfiles bloqueados no hay un lugar seguro donde escribir: ni la raíz congelada ni un perfil que no se pudo leer.
  if (r.bloqueado) throw new Error(`Los perfiles no están disponibles: ${r.bloqueado}`)
  if (modoRaiz()) return join(raizDatos(), ...partes)
  return join(rutasPerfiles(raizDatos()).carpeta, idPerfilActivo(), ...partes)
}

export const carpetaFeatures = (): string => rutaPerfil('features')

/** Reinicio por cambio de perfil: las terminales quedan vivas en el daemon aunque «Terminales vivas» esté apagado. */
export const marcarCambioDePerfil = (): void => {
  cambiando = true
}

export const cambiandoDePerfil = (): boolean => cambiando
