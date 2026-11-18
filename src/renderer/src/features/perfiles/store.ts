import { useEffect, useSyncExternalStore } from 'react'
import type { PerfilesPayload } from '../../../../shared/perfiles'
import type { UiCtx } from '../host'

interface Estado {
  payload: PerfilesPayload | null
  fotos: Record<string, string>
}

let estado: Estado = { payload: null, fotos: {} }
const oyentes = new Set<() => void>()
const pedidas = new Set<string>()
let usuarios = 0
let soltar: (() => void) | null = null

const poner = (e: Estado): void => {
  estado = e
  oyentes.forEach((l) => l())
}

async function refrescar(ui: UiCtx, invalidarFotos: boolean): Promise<void> {
  try {
    const p = await ui.invoke<PerfilesPayload>('feat:perfiles:estado')
    if (invalidarFotos) pedidas.clear()
    poner({ payload: p, fotos: invalidarFotos ? {} : estado.fotos })
  } catch {
    // Sin estado el chip no aparece y la sección queda en «Cargando…»: no hay nada más que hacer acá.
  }
}

export const refrescarPerfiles = (ui: UiCtx): Promise<void> => refrescar(ui, true)

function conectar(ui: UiCtx): () => void {
  usuarios++
  if (usuarios === 1) {
    void refrescar(ui, false)
    soltar = ui.on('feat:perfiles:cambio', () => void refrescar(ui, true))
  }
  return () => {
    usuarios--
    if (usuarios === 0) {
      soltar?.()
      soltar = null
    }
  }
}

const suscribir = (l: () => void): (() => void) => {
  oyentes.add(l)
  return () => oyentes.delete(l)
}
const leer = (): Estado => estado

export function usePerfiles(ui: UiCtx): PerfilesPayload | null {
  useEffect(() => conectar(ui), [ui])
  return useSyncExternalStore(suscribir, leer).payload
}

/** La foto se pide recién cuando se necesita y se guarda por perfil. */
export function useFotoPerfil(ui: UiCtx, id: string, tieneFoto: boolean): string | null {
  const fotos = useSyncExternalStore(suscribir, leer).fotos
  useEffect(() => {
    if (!tieneFoto || pedidas.has(id)) return
    pedidas.add(id)
    ui.invoke<string | null>('feat:perfiles:foto', id)
      .then((url) => {
        if (typeof url === 'string' && url.startsWith('data:image/')) poner({ ...estado, fotos: { ...estado.fotos, [id]: url } })
      })
      .catch(() => pedidas.delete(id))
  }, [ui, id, tieneFoto, fotos])
  return tieneFoto ? (fotos[id] ?? null) : null
}
