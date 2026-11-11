import { prioRank, tintFor, type Categoria } from './model'

/** Piezas compartidas por la lista y el detalle de tickets. */

const PRIO_PATH = {
  0: 'M12 5v9M12 18h.01',
  1: 'M6 14.5l6-6 6 6',
  2: 'M5 9.5h14M5 14.5h14',
  3: 'M6 9.5l6 6 6-6'
} as const
export const prioPath = (p?: string): string => PRIO_PATH[(Math.min(prioRank(p), 3) as keyof typeof PRIO_PATH)]
/** Color del texto de prioridad, como en el artboard: urgente coral, alta ámbar, media gris claro, baja gris. */
export const prioTone = (p?: string): string =>
  prioRank(p) === 0 ? 'var(--danger-fg)' : prioRank(p) === 1 ? 'var(--warn-fg)' : prioRank(p) === 2 ? 'var(--g-c9)' : 'var(--fg-2)'

const KIND = { pendiente: 'todo', en_curso: 'doing', revision: 'review', bloqueado: 'error', hecho: 'todo' } as const

/** Clase de color por categoría del estado (`f-tickets-st-*`). El texto va siempre: el color solo no alcanza. */
export const estadoKind = (cat: Categoria): (typeof KIND)[Categoria] => KIND[cat]

export const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?'

/** Icono de prioridad (trazo, con texto al lado). */
export function PrioGlyph({ p, size = 12 }: { p?: string; size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}>
      <path d={prioPath(p)} />
    </svg>
  )
}

export function ExternalGlyph(): React.JSX.Element {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 4h6v6M20 4l-8 8M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
    </svg>
  )
}

/** Avatar con iniciales y color estable por persona (hash del nombre). */
export function Av({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }): React.JSX.Element {
  const tint = tintFor(name)
  const cls = size === 'md' ? 'f-tickets-av' : `f-tickets-av ${size}`
  return (
    <span className={cls} style={{ background: tint.bg, color: tint.fg }} aria-hidden="true">
      {initials(name)}
    </span>
  )
}
