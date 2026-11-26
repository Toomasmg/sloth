import type { ModeloSidebar } from './sidebar-model'

/** Un elemento de la lista que se recorre con flechas: el encabezado de una cuenta o una fila de espacio. */
export interface ItemNav {
  clave: string
  /** Para una fila, la clave de su encabezado (null en las de una cuenta borrada, que no tiene). */
  grupo: string | null
  encabezado: boolean
  abierta: boolean
  /** Con filtro todo se ve abierto, así que plegar no tendría efecto. */
  plegable: boolean
}

export type AccionNav = { tipo: 'foco'; clave: string } | { tipo: 'plegar'; clave: string } | { tipo: 'desplegar'; clave: string } | { tipo: 'nada' }

const PREFIJO_CUENTA = 'cuenta:'
const TECLAS = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft']

export const claveCuenta = (id: string): string => `${PREFIJO_CUENTA}${id}`
export const claveEspacio = (id: string): string => `espacio:${id}`
export const idDeCuenta = (clave: string): string | null => (clave.startsWith(PREFIJO_CUENTA) ? clave.slice(PREFIJO_CUENTA.length) : null)

/** Los elementos en el orden en que se ven: cuenta, sus espacios si está abierta, la siguiente cuenta… y al final los huérfanos. */
export function itemsNav(modelo: ModeloSidebar, filtro: string): ItemNav[] {
  const items: ItemNav[] = []
  for (const g of modelo.grupos) {
    const clave = claveCuenta(g.cuenta.id)
    items.push({ clave, grupo: null, encabezado: true, abierta: g.abierto, plegable: !filtro })
    if (g.abierto) for (const w of g.visibles) items.push({ clave: claveEspacio(w.id), grupo: clave, encabezado: false, abierta: false, plegable: false })
  }
  for (const w of modelo.huerfanos) items.push({ clave: claveEspacio(w.id), grupo: null, encabezado: false, abierta: false, plegable: false })
  return items
}

/** Quién está en el orden de Tab (roving tabindex): el último que tuvo el foco, o el preferido, o el primero. */
export function itemActivo(items: readonly ItemNav[], activo: string | null, preferido: string | null): string | null {
  for (const c of [activo, preferido]) if (c !== null && items.some((i) => i.clave === c)) return c
  return items[0]?.clave ?? null
}

/**
 * Patrón de árbol de WAI-ARIA para las flechas. `null` es una tecla que no es de la lista (no se la
 * toca); `nada` es una de la lista que acá no tiene a dónde ir (se la frena igual para que no desplace).
 */
export function accionNav(items: readonly ItemNav[], actual: string | null, tecla: string): AccionNav | null {
  if (!TECLAS.includes(tecla)) return null
  if (items.length === 0) return { tipo: 'nada' }
  const i = items.findIndex((x) => x.clave === actual)
  const ir = (n: number): AccionNav => (n >= 0 && n < items.length && n !== i ? { tipo: 'foco', clave: items[n].clave } : { tipo: 'nada' })
  if (i < 0) return { tipo: 'foco', clave: items[tecla === 'ArrowUp' || tecla === 'End' ? items.length - 1 : 0].clave }
  const item = items[i]
  switch (tecla) {
    case 'ArrowDown':
      return ir(i + 1)
    case 'ArrowUp':
      return ir(i - 1)
    case 'Home':
      return ir(0)
    case 'End':
      return ir(items.length - 1)
    case 'ArrowRight':
      if (!item.encabezado) return { tipo: 'nada' }
      if (!item.abierta) return item.plegable ? { tipo: 'desplegar', clave: item.clave } : { tipo: 'nada' }
      return items[i + 1]?.grupo === item.clave ? ir(i + 1) : { tipo: 'nada' }
    default:
      if (item.encabezado) return item.abierta && item.plegable ? { tipo: 'plegar', clave: item.clave } : { tipo: 'nada' }
      return item.grupo !== null ? { tipo: 'foco', clave: item.grupo } : { tipo: 'nada' }
  }
}
