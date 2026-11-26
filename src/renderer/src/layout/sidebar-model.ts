import type { Account, Workspace } from '../../../shared/types'

export interface GrupoCuenta {
  cuenta: Account
  /** Todos los espacios de la cuenta: el resumen del encabezado los cuenta aunque el filtro oculte algunos. */
  todos: Workspace[]
  visibles: Workspace[]
  abierto: boolean
}

export interface ModeloSidebar {
  grupos: GrupoCuenta[]
  huerfanos: Workspace[]
  sinResultados: boolean
}

export function normalizarFiltro(texto: string): string {
  return texto.trim().toLowerCase()
}

export function coincide(ws: Pick<Workspace, 'name' | 'branch' | 'ticket'>, filtro: string): boolean {
  return !filtro || `${ws.name} ${ws.branch ?? ''} ${ws.ticket ?? ''}`.toLowerCase().includes(filtro)
}

/**
 * Lo que dibuja el panel. Con filtro, las cuentas sin coincidencias desaparecen y las que quedan se ven
 * abiertas aunque estén plegadas (si no, el resultado quedaría escondido).
 */
export function armarModelo(cuentas: readonly Account[], espacios: readonly Workspace[], filtro: string, plegadas: Readonly<Record<string, boolean>>): ModeloSidebar {
  const grupos: GrupoCuenta[] = []
  for (const cuenta of cuentas) {
    const todos = espacios.filter((w) => w.accountId === cuenta.id)
    const visibles = todos.filter((w) => coincide(w, filtro))
    if (filtro && visibles.length === 0) continue
    grupos.push({ cuenta, todos, visibles, abierto: !plegadas[cuenta.id] || !!filtro })
  }
  const ids = new Set(cuentas.map((a) => a.id))
  const huerfanos = espacios.filter((w) => !ids.has(w.accountId) && coincide(w, filtro))
  return { grupos, huerfanos, sinResultados: !!filtro && grupos.length === 0 && huerfanos.length === 0 }
}

/** Lo guardado en localStorage de las cuentas plegadas; cualquier cosa rara vale como «ninguna». */
export function leerPlegadas(crudo: string | null): Record<string, boolean> {
  try {
    const v = JSON.parse(crudo ?? '{}') as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}
