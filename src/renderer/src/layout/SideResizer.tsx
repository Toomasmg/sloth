import { useRef, type RefObject } from 'react'
import { requestPanesFit } from './store'

/** Ancho de la barra lateral: por defecto (el de siempre), mínimo y tope absoluto. */
export const SIDE_DEFAULT = 264
export const SIDE_MIN = 220
const SIDE_CAP = 520
/** Paso de las flechas (px). */
const KEY_STEP = 16

/** Máximo para una ventana de `winW` px: min(520, 45 %), sin bajar del mínimo. */
export function sideMax(winW: number): number {
  return Math.max(SIDE_MIN, Math.min(SIDE_CAP, Math.floor(winW * 0.45)))
}

/** Acota un ancho a los límites de la ventana actual. */
export function clampSide(w: number, winW: number): number {
  return Math.min(sideMax(winW), Math.max(SIDE_MIN, Math.round(w)))
}

interface Props {
  /** Ancho vigente (ya acotado). */
  width: number
  /** Máximo para la ventana actual. */
  max: number
  /** Cuerpo de la grilla: durante el arrastre se cambia su variable --side-w en vivo. */
  bodyRef: RefObject<HTMLElement | null>
  /** Confirma un ancho (persiste). */
  onChange(w: number): void
}

interface Drag {
  id: number
  x0: number
  w0: number
  cur: number
  off(): void
}

/**
 * Tirador vertical en el borde derecho de la barra lateral. Mientras se arrastra solo cambia la
 * variable CSS del cuerpo (sin re-render de App); al soltar confirma el ancho y pide un único fit
 * de las terminales (las de layout/TerminalView no re-ajustan durante el arrastre).
 */
export function SideResizer({ width, max, bodyRef, onChange }: Props): React.JSX.Element {
  const drag = useRef<Drag | null>(null)

  const setLive = (w: number): void => bodyRef.current?.style.setProperty('--side-w', `${w}px`)

  const endDrag = (commit: boolean): void => {
    const d = drag.current
    if (!d) return
    drag.current = null
    d.off()
    document.body.classList.remove('is-resizing-side')
    if (commit && d.cur !== d.w0) onChange(d.cur)
    else setLive(d.w0)
    requestPanesFit()
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || drag.current) return
    e.preventDefault()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* puntero ya liberado: igual se escucha en el tirador */
    }
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopPropagation()
      endDrag(false)
    }
    window.addEventListener('keydown', onKey, true)
    drag.current = {
      id: e.pointerId,
      x0: e.clientX,
      w0: width,
      cur: width,
      off: () => window.removeEventListener('keydown', onKey, true)
    }
    document.body.classList.add('is-resizing-side')
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    d.cur = clampSide(d.w0 + e.clientX - d.x0, window.innerWidth)
    setLive(d.cur)
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.id === e.pointerId) endDrag(true)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.ctrlKey || e.altKey || e.metaKey) return
    let next: number | null = null
    if (e.key === 'ArrowLeft') next = width - KEY_STEP
    else if (e.key === 'ArrowRight') next = width + KEY_STEP
    else if (e.key === 'Home') next = SIDE_MIN
    else if (e.key === 'End') next = max
    if (next === null) return
    e.preventDefault()
    e.stopPropagation()
    onChange(clampSide(next, window.innerWidth))
  }

  return (
    <div
      className="sl-resize"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Ancho de la barra lateral"
      aria-valuenow={width}
      aria-valuemin={SIDE_MIN}
      aria-valuemax={max}
      aria-valuetext={`${width} píxeles`}
      title="Arrastrá para cambiar el ancho · doble clic: ancho por defecto"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => endDrag(false)}
      onDoubleClick={() => onChange(SIDE_DEFAULT)}
      onKeyDown={onKeyDown}
    />
  )
}
