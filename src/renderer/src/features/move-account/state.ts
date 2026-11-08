// Estado de «Mover a otra cuenta» (qué espacio se mueve). Lo comparten el botón, la paleta y el diálogo.
import { useSyncExternalStore } from 'react'

export interface MoveTarget {
  wsId: string
  /** Elemento que tenía el foco al abrir: vuelve a tenerlo al cerrar. */
  returnFocus: HTMLElement | null
}

let current: MoveTarget | null = null
const listeners = new Set<() => void>()

function setCurrent(v: MoveTarget | null): void {
  current = v
  for (const l of listeners) l()
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
const getCurrent = (): MoveTarget | null => current
export const useMoveTarget = (): MoveTarget | null => useSyncExternalStore(subscribe, getCurrent)

export function openMove(wsId: string): void {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  setCurrent({ wsId, returnFocus: active })
}

export function closeMove(): void {
  const t = current
  setCurrent(null)
  t?.returnFocus?.focus?.()
}


export const spacesTxt = (n: number): string => (n === 0 ? 'Sin espacios' : n === 1 ? '1 espacio' : `${n} espacios`)

export type Phase = 'form' | 'moving' | 'done'

export type MoveRes = { ok: true; resumed: boolean; summary: boolean } | { ok: false; copyFailed: true; message: string }
