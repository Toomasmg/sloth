import { useSyncExternalStore } from 'react'

interface PrsState {
  open: boolean
  nonce: number
}

let returnFocus: HTMLElement | null = null
let state: PrsState = { open: false, nonce: 0 }
const listeners = new Set<() => void>()

function set(next: Partial<PrsState>): void {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

export function openPrs(): void {
  if (!state.open) returnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
  set({ open: true, nonce: state.nonce + 1 })
}

export function closePrs(): void {
  set({ open: false })
  const back = returnFocus
  returnFocus = null
  requestAnimationFrame(() => {
    if (back?.isConnected) back.focus()
  })
}

export function usePrs(): PrsState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state
  )
}
