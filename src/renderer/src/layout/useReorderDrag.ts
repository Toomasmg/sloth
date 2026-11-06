import { useCallback, useEffect, useRef, useState } from 'react'
import { dropModeAt, type DropMode } from './logic'

export interface ReorderDrag {
  id: string
  target: string | null
  mode: DropMode | null
}

interface Options {
  kind: 'pane' | 'tab'
  /** Atributo que identifica a los destinos posibles (p. ej. `data-pane-id`). */
  attr: string
  /** Solo valen destinos dentro de este elemento. */
  scope: React.RefObject<HTMLElement | null>
  /** Etiqueta flotante que sigue al puntero (se mueve por transform, sin re-render). */
  ghost: React.RefObject<HTMLElement | null>
  /** Desde dónde NO se arrastra (botones, campos…). */
  ignore?: string
  onDrop(id: string, target: string, mode: DropMode): void
}

const THRESHOLD = 5

/**
 * Arrastrar para reordenar con Pointer Events. Los listeners globales existen solo entre el
 * pointerdown y el pointerup (nada de mousemove permanente); el cálculo va en un frame.
 */
export function useReorderDrag(opts: Options): {
  drag: ReorderDrag | null
  onPointerDown(e: React.PointerEvent, id: string): void
} {
  const [drag, setDrag] = useState<ReorderDrag | null>(null)
  const optsRef = useRef(opts)
  optsRef.current = opts
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => () => cleanupRef.current?.(), [])

  const onPointerDown = useCallback((e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || !e.isPrimary || cleanupRef.current) return
    const o = optsRef.current
    if (o.ignore && (e.target as Element).closest(o.ignore)) return
    const sx = e.clientX
    const sy = e.clientY
    let x = sx
    let y = sy
    let active = false
    let raf = 0
    let cur: ReorderDrag = { id, target: null, mode: null }

    const frame = (): void => {
      raf = 0
      const g = optsRef.current.ghost.current
      if (g) {
        // Pegada al puntero pero siempre dentro de la ventana.
        const gx = Math.min(x + 14, window.innerWidth - g.offsetWidth - 8)
        const gy = Math.min(y + 12, window.innerHeight - g.offsetHeight - 8)
        g.style.transform = `translate(${Math.round(Math.max(4, gx))}px, ${Math.round(Math.max(4, gy))}px)`
      }
      const { attr, scope, kind } = optsRef.current
      const hit = document.elementFromPoint(x, y)
      const el = hit?.closest<HTMLElement>(`[${attr}]`)
      let target: string | null = null
      let mode: DropMode | null = null
      if (el && scope.current?.contains(el)) {
        const t = el.getAttribute(attr)
        if (t && t !== id) {
          const r = el.getBoundingClientRect()
          target = t
          mode = dropModeAt(r.width > 0 ? (x - r.left) / r.width : 0.5, kind)
        }
      }
      if (target !== cur.target || mode !== cur.mode) {
        cur = { id, target, mode }
        setDrag(cur)
      }
    }

    const onMove = (ev: PointerEvent): void => {
      x = ev.clientX
      y = ev.clientY
      if (!active) {
        if (Math.hypot(x - sx, y - sy) < THRESHOLD) return
        active = true
        document.body.classList.add('is-reordering')
        window.getSelection()?.removeAllRanges()
        setDrag(cur)
      }
      if (!raf) raf = requestAnimationFrame(frame)
    }
    // Después de un arrastre real, el click que dispara el navegador no tiene que seleccionar nada.
    const swallowClick = (ev: MouseEvent): void => {
      ev.stopPropagation()
      ev.preventDefault()
    }
    const finish = (commit: boolean): void => {
      const wasActive = active
      cleanup()
      if (wasActive) {
        window.addEventListener('click', swallowClick, { capture: true, once: true })
        setTimeout(() => window.removeEventListener('click', swallowClick, true), 0)
      }
      if (commit && wasActive && cur.target && cur.mode) optsRef.current.onDrop(cur.id, cur.target, cur.mode)
    }
    const onUp = (): void => finish(true)
    const onCancel = (): void => finish(false)
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape' || !active) return
      ev.preventDefault()
      ev.stopPropagation()
      finish(false)
    }
    const cleanup = (): void => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onCancel)
      document.body.classList.remove('is-reordering')
      cleanupRef.current = null
      setDrag(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onCancel)
    cleanupRef.current = cleanup
  }, [])

  return { drag, onPointerDown }
}
