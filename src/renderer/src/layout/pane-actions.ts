import type { ReactNode } from 'react'

/** Grupos del menú del espacio, en orden; entre grupo y grupo va un separador. */
export const PANE_ACTION_GROUPS = ['editar', 'ver', 'compartir', 'abrir', 'panel', 'quitar'] as const
export type PaneActionGroup = (typeof PANE_ACTION_GROUPS)[number]

/** Una entrada del menú del espacio. `order` ordena dentro del grupo (menor primero). */
export interface PaneAction {
  id: string
  label: string
  group: PaneActionGroup
  order: number
  icon?: ReactNode
  /** Aclaración corta («la terminal sigue»). */
  hint?: string
  shortcut?: string
  danger?: boolean
  run(): void
}

/** Ordena por grupo y por `order`; si dos tienen el mismo id gana la primera (el núcleo va antes). */
export function sortPaneActions(list: PaneAction[]): PaneAction[] {
  const seen = new Set<string>()
  const unique = list.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)))
  const rank = (a: PaneAction): number => PANE_ACTION_GROUPS.indexOf(a.group)
  return unique
    .map((a, i) => ({ a, i }))
    .sort((x, y) => rank(x.a) - rank(y.a) || x.a.order - y.a.order || x.i - y.i)
    .map((x) => x.a)
}

/** Las acciones ya ordenadas, con un separador donde cambia el grupo. */
export function withSeparators(list: PaneAction[]): (PaneAction | 'sep')[] {
  const out: (PaneAction | 'sep')[] = []
  list.forEach((a, i) => {
    if (i > 0 && list[i - 1].group !== a.group) out.push('sep')
    out.push(a)
  })
  return out
}
