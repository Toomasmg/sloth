import { useRef } from 'react'
import { boundaryPos, cellRects, equalParts, nudgeBoundary, resizeBoundary, type Sizes } from './logic'

interface Props {
  shape: number[]
  sizes: Sizes
  /** Nombre de cada panel en orden de lectura (para los aria-label). */
  names: string[]
  area: React.RefObject<HTMLElement | null>
  onCommit(next: Sizes): void
}

/** Ancho y alto mínimos de un panel al redimensionar (en px del área). */
const MIN_W = 220
const MIN_H = 120
const STEP = 0.02
const BIG_STEP = 0.1

type SepSpec =
  | { kind: 'col'; row: number; i: number; a: string; b: string }
  | { kind: 'row'; i: number; a: string; b: string }

function minFrac(px: number, total: number): number {
  return total > 0 ? Math.min(0.45, Math.max(0.05, px / total)) : 0.1
}

function pct(v: number): number {
  return Math.round(v * 100)
}

/**
 * Separadores arrastrables entre columnas (por fila) y entre filas. Mientras se arrastra solo se
 * mueve una guía; las proporciones se aplican al soltar, así xterm hace un único fit.
 */
export function Separators({ shape, sizes, names, area, onCommit }: Props): React.JSX.Element {
  const guide = useRef<HTMLDivElement>(null)
  const rects = cellRects(shape, sizes)

  let rowStart = 0
  const rowFirst: number[] = shape.map((n) => {
    const v = rowStart
    rowStart += n
    return v
  })

  const specs: SepSpec[] = []
  let idx = 0
  for (let r = 0; r < shape.length; r++) {
    for (let c = 0; c < shape[r] - 1; c++) specs.push({ kind: 'col', row: r, i: c, a: names[idx + c] ?? '', b: names[idx + c + 1] ?? '' })
    idx += shape[r]
  }
  for (let r = 0; r < shape.length - 1; r++) specs.push({ kind: 'row', i: r, a: `fila ${r + 1}`, b: `fila ${r + 2}` })

  const arrOf = (s: SepSpec, src: Sizes = sizes): number[] => (s.kind === 'col' ? src.cols[s.row] : src.rows)
  const withArr = (s: SepSpec, arr: number[]): Sizes =>
    s.kind === 'col' ? { rows: sizes.rows, cols: sizes.cols.map((c, k) => (k === s.row ? arr : c)) } : { rows: arr, cols: sizes.cols }
  const minOf = (s: SepSpec): number => {
    const r = area.current?.getBoundingClientRect()
    return s.kind === 'col' ? minFrac(MIN_W, r?.width ?? 0) : minFrac(MIN_H, r?.height ?? 0)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>, s: SepSpec): void => {
    if (e.button !== 0) return
    const box = area.current?.getBoundingClientRect()
    const g = guide.current
    if (!box || !g) return
    e.preventDefault()
    const el = e.currentTarget
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      /* puntero ya liberado: igual se escucha en el separador */
    }
    el.classList.add('active')
    document.body.classList.add(s.kind === 'col' ? 'is-resizing-col' : 'is-resizing-row')
    const min = minOf(s)
    const base = arrOf(s)
    const rowRect = s.kind === 'col' ? rects[rowFirst[s.row]] : undefined
    let next = base
    let raf = 0
    let px = e.clientX
    let py = e.clientY

    g.hidden = false
    g.className = `pane-guide ${s.kind}`
    if (s.kind === 'col' && rowRect) {
      g.style.setProperty('--y', String(rowRect.y))
      g.style.setProperty('--h', String(rowRect.h))
    }
    const place = (): void => {
      raf = 0
      const pos = s.kind === 'col' ? (px - box.left) / box.width : (py - box.top) / box.height
      next = resizeBoundary(base, s.i, pos, min)
      const at = boundaryPos(next, s.i)
      g.style.setProperty('--at', String(at))
      g.dataset.label = `${pct(next[s.i])} % · ${pct(next[s.i + 1])} %`
    }
    place()

    const onMove = (ev: PointerEvent): void => {
      px = ev.clientX
      py = ev.clientY
      if (!raf) raf = requestAnimationFrame(place)
    }
    const end = (commit: boolean): void => {
      if (raf) cancelAnimationFrame(raf)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onCancel)
      el.removeEventListener('keydown', onKey)
      el.classList.remove('active')
      document.body.classList.remove('is-resizing-col', 'is-resizing-row')
      g.hidden = true
      if (commit && next !== base) onCommit(withArr(s, next))
    }
    const onUp = (): void => end(true)
    const onCancel = (): void => end(false)
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') end(false)
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onCancel)
    el.addEventListener('keydown', onKey)
  }

  const onKeyDown = (e: React.KeyboardEvent, s: SepSpec): void => {
    const dec = s.kind === 'col' ? 'ArrowLeft' : 'ArrowUp'
    const inc = s.kind === 'col' ? 'ArrowRight' : 'ArrowDown'
    const arr = arrOf(s)
    const min = minOf(s)
    let next: number[] | null = null
    const step = e.shiftKey ? BIG_STEP : STEP
    if (e.key === dec) next = nudgeBoundary(arr, s.i, -step, min)
    else if (e.key === inc) next = nudgeBoundary(arr, s.i, step, min)
    else if (e.key === 'Home') next = resizeBoundary(arr, s.i, 0, min)
    else if (e.key === 'End') next = resizeBoundary(arr, s.i, 1, min)
    else if (e.key === 'Enter') next = equalParts(arr.length)
    if (!next) return
    e.preventDefault()
    e.stopPropagation()
    onCommit(withArr(s, next))
  }

  return (
    <>
      {specs.map((s) => {
        const arr = arrOf(s)
        const min = 0.05
        const style =
          s.kind === 'col'
            ? ({
                '--at': boundaryPos(arr, s.i),
                '--y': rects[rowFirst[s.row]]?.y ?? 0,
                '--h': rects[rowFirst[s.row]]?.h ?? 1
              } as React.CSSProperties)
            : ({ '--at': boundaryPos(arr, s.i) } as React.CSSProperties)
        const label =
          s.kind === 'col' ? `Ancho entre «${s.a}» y «${s.b}»` : `Alto entre la ${s.a} y la ${s.b}`
        return (
          <div
            key={s.kind === 'col' ? `c${s.row}-${s.i}` : `r${s.i}`}
            className={`pane-sep ${s.kind}`}
            style={style}
            role="separator"
            tabIndex={0}
            aria-orientation={s.kind === 'col' ? 'vertical' : 'horizontal'}
            aria-label={label}
            aria-valuemin={pct(min)}
            aria-valuemax={pct(arr[s.i] + arr[s.i + 1] - min)}
            aria-valuenow={pct(arr[s.i])}
            aria-valuetext={`${pct(arr[s.i])} % y ${pct(arr[s.i + 1])} %`}
            title="Arrastrá para cambiar el tamaño · doble clic: repartir igual"
            onPointerDown={(e) => onPointerDown(e, s)}
            onDoubleClick={() => onCommit(withArr(s, equalParts(arr.length)))}
            onKeyDown={(e) => onKeyDown(e, s)}
          >
            <span className="pane-sep-line" aria-hidden="true" />
          </div>
        )
      })}
      <div ref={guide} className="pane-guide" hidden aria-hidden="true" />
    </>
  )
}
