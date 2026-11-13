import { useSyncExternalStore } from 'react'
import type { ErrorDictado, EstadoDictado, ResultadoDictado } from '../../../../shared/dictado'
import { cleanError } from '../../format'
import { grabar, type Grabacion } from './grabador'
import { safeStorage } from '../../layout/store'

/** Estado del micrófono de cada panel. Graba uno solo a la vez: empezar en otro corta el anterior. */

export interface VistaDictado {
  estado: EstadoDictado
  error?: ErrorDictado
  /** Se terminó y no se escuchó nada. */
  vacio?: boolean
}

const INACTIVO: VistaDictado = { estado: 'inactivo' }
const vistas = new Map<string, VistaDictado>()
const subs = new Set<() => void>()
let activa: { paneId: string; grab: Grabacion } | null = null

function set(paneId: string, v: VistaDictado): void {
  vistas.set(paneId, v)
  avisar()
}

const avisar = (): void => subs.forEach((f) => f())

/**
 * Aviso de «Nuevo» la primera vez: va en un solo panel (el primero que se montó) y deja de salir
 * cuando se usa el micrófono o se cierra el aviso. Se recuerda en este equipo.
 */
const CLAVE_CONOCIDO = 'sloth.dictado.conocido'
let conocido = safeStorage()?.getItem(CLAVE_CONOCIDO) === '1'
const montados: string[] = []

export function montar(paneId: string): () => void {
  montados.push(paneId)
  avisar()
  return () => {
    const i = montados.indexOf(paneId)
    if (i >= 0) montados.splice(i, 1)
    avisar()
  }
}

export function useMostrarNovedad(paneId: string): boolean {
  return useSyncExternalStore(subscribe, () => !conocido && montados[0] === paneId)
}

export function marcarConocido(): void {
  if (conocido) return
  conocido = true
  try {
    safeStorage()?.setItem(CLAVE_CONOCIDO, '1')
  } catch {
    /* sin almacenamiento: el aviso vuelve a salir la próxima vez, nada más */
  }
  avisar()
}

const subscribe = (f: () => void): (() => void) => {
  subs.add(f)
  return () => subs.delete(f)
}

export function useDictado(paneId: string): VistaDictado {
  return useSyncExternalStore(subscribe, () => vistas.get(paneId) ?? INACTIVO)
}

function errorDeMicrofono(e: unknown): ErrorDictado {
  const name = e instanceof DOMException ? e.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return { tipo: 'microfono', mensaje: 'No hay acceso al micrófono. Revisá que Windows deje usarlo a las apps de escritorio.', ajustes: true }
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return { tipo: 'sin-microfono', mensaje: 'No encontramos un micrófono. Conectá uno y probá de nuevo.', ajustes: true }
  if (name === 'NotReadableError')
    return { tipo: 'microfono', mensaje: 'Otra app está usando el micrófono. Cerrala y probá de nuevo.', ajustes: false }
  return { tipo: 'otro', mensaje: `No se pudo usar el micrófono (${cleanError(e)}).`, ajustes: false }
}

export async function empezar(paneId: string, onTexto: (texto: string) => void): Promise<void> {
  if (activa?.paneId === paneId) return
  marcarConocido()
  if (activa) {
    activa.grab.descartar()
    set(activa.paneId, INACTIVO)
    activa = null
  }
  set(paneId, { estado: 'escuchando' })
  try {
    const grab = await grabar(() => void terminar(paneId, onTexto))
    // Si mientras se pedía el micrófono se tocó otro panel o se canceló, se suelta.
    if (vistas.get(paneId)?.estado !== 'escuchando' || activa) {
      grab.descartar()
      return
    }
    activa = { paneId, grab }
  } catch (e) {
    set(paneId, { estado: 'inactivo', error: errorDeMicrofono(e) })
  }
}

export async function terminar(paneId: string, onTexto: (texto: string) => void): Promise<void> {
  if (activa?.paneId !== paneId) return
  const { grab } = activa
  activa = null
  set(paneId, { estado: 'transcribiendo' })
  try {
    const wav = await grab.terminar()
    if (!wav) return set(paneId, { estado: 'inactivo', vacio: true })
    const r = (await window.sloth.feat.invoke('feat:dictado:transcribir', wav)) as ResultadoDictado
    if (!r.ok) return set(paneId, { estado: 'inactivo', error: r.error })
    if (r.texto) onTexto(r.texto)
    set(paneId, r.texto ? INACTIVO : { estado: 'inactivo', vacio: true })
  } catch (e) {
    set(paneId, { estado: 'inactivo', error: { tipo: 'otro', mensaje: `No se pudo transcribir (${cleanError(e)}).`, ajustes: false } })
  }
}

/** Si el panel se cierra mientras graba, se suelta el micrófono sin transcribir. */
export function soltar(paneId: string): void {
  if (activa?.paneId !== paneId) return
  activa.grab.descartar()
  activa = null
  vistas.delete(paneId)
}

export function cerrarAviso(paneId: string): void {
  set(paneId, INACTIVO)
}

export function abrirAjustes(tipo: ErrorDictado['tipo']): Promise<void> {
  return window.sloth.feat.invoke('feat:dictado:ajustes', tipo) as Promise<void>
}
