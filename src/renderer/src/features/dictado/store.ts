import { useSyncExternalStore } from 'react'
import type { ErrorDictado, EventoEstadoDictado, EventoTextoDictado } from '../../../../shared/dictado'

/** Estado del micrófono de cada panel (lo manda main) y a quién va el texto dictado. */

const estados = new Map<string, EventoEstadoDictado>()
const subs = new Set<() => void>()
const destinos = new Map<string, (texto: string) => void>()
let escuchando = false

const avisar = (): void => subs.forEach((f) => f())

function setEstado(ev: EventoEstadoDictado): void {
  estados.set(ev.paneId, ev)
  avisar()
}

function conectar(): void {
  if (escuchando) return
  escuchando = true
  window.sloth.feat.on('feat:dictado:estado', (ev: EventoEstadoDictado) => {
    if (ev && typeof ev.paneId === 'string') setEstado(ev)
  })
  window.sloth.feat.on('feat:dictado:texto', (ev: EventoTextoDictado) => {
    if (ev && typeof ev.paneId === 'string' && typeof ev.texto === 'string') destinos.get(ev.paneId)?.(ev.texto)
  })
}

const subscribe = (f: () => void): (() => void) => {
  conectar()
  subs.add(f)
  return () => subs.delete(f)
}

export function useDictado(paneId: string): EventoEstadoDictado | undefined {
  return useSyncExternalStore(subscribe, () => estados.get(paneId))
}

/** Lo dictado en `paneId` va a `fn` (la terminal del panel). Devuelve cómo dejar de recibirlo. */
export function recibirTexto(paneId: string, fn: (texto: string) => void): () => void {
  conectar()
  destinos.set(paneId, fn)
  return () => {
    if (destinos.get(paneId) === fn) destinos.delete(paneId)
  }
}

export function empezar(paneId: string): Promise<void> {
  setEstado({ paneId, estado: 'escuchando' })
  return window.sloth.feat.invoke('feat:dictado:start', paneId) as Promise<void>
}

export function parar(paneId: string): Promise<void> {
  return window.sloth.feat.invoke('feat:dictado:stop', paneId) as Promise<void>
}

export function abrirAjustes(tipo: ErrorDictado['tipo']): Promise<void> {
  return window.sloth.feat.invoke('feat:dictado:ajustes', tipo) as Promise<void>
}

export function mostrarError(paneId: string, error?: ErrorDictado): void {
  setEstado(error ? { paneId, estado: 'inactivo', error } : { paneId, estado: 'inactivo' })
}
