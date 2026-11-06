import type { SlothApi, PtyChunk } from '../../shared/types'

declare global {
  interface Window {
    sloth: SlothApi
  }
}

export const api = window.sloth

type DataListener = (chunk: PtyChunk) => void
type ExitListener = (code: number) => void
const dataListeners = new Map<string, Set<DataListener>>()
const exitListeners = new Map<string, Set<ExitListener>>()

// Un solo listener de IPC que reparte por id de terminal.
api.onPtyData((id, chunk) => dataListeners.get(id)?.forEach((l) => l(chunk)))
api.onPtyExit((id, code) => exitListeners.get(id)?.forEach((l) => l(code)))

function subscribe<T>(map: Map<string, Set<T>>, id: string, l: T): () => void {
  let set = map.get(id)
  if (!set) map.set(id, (set = new Set()))
  set.add(l)
  return () => {
    set!.delete(l)
  }
}

export const onPtyData = (id: string, l: DataListener): (() => void) => subscribe(dataListeners, id, l)
export const onPtyExit = (id: string, l: ExitListener): (() => void) => subscribe(exitListeners, id, l)
