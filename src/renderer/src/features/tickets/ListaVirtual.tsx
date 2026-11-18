import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  ajusteAncla,
  calcularVentana,
  destinoTeclado,
  estaDibujada,
  estimadaDe,
  indiceEnOffset,
  offsetDeIndice,
  scrollParaVer,
  tramos
} from '../../lib/ventana-virtual'

/** Con más tarjetas que esto se dibuja solo la ventana visible; con menos, la lista entera como siempre. */
export const UMBRAL_VENTANA = 100

const ESTIMADA_INICIAL = 94
const MARGEN = 400
/** `top` se redondea hacia abajo a este paso: el margen cubre la diferencia y el scroll no re-renderiza en cada píxel. */
const PASO = 100

interface Pos {
  top: number
  vista: number
}

const igual = (a: Pos, b: Pos): boolean => a.top === b.top && a.vista === b.vista

function padreScroll(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p
  return null
}

interface Props {
  ids: readonly string[]
  /** Ticket abierto en el detalle: se dibuja aunque quede fuera de la ventana. */
  abiertoId: string | undefined
  /** La tarjeta de la fila `i`; su `key` es el id del ticket. */
  fila: (i: number) => React.ReactNode
  /** Tarjeta que tenía el foco en la lista que esta reemplaza: se dibuja y se enfoca al montar. */
  enfocarAlMontar?: string | null
}

/**
 * La lista de tarjetas con ventana virtual. Scrollea el ancestro con scroll (la lista no tiene el suyo), mide
 * las tarjetas que dibuja y deja espaciadores del alto del resto. La tarjeta con foco, la que se está
 * navegando y la abierta se dibujan siempre.
 */
export function ListaVirtual({ ids, abiertoId, fila, enfocarAlMontar }: Props): React.JSX.Element {
  const ulRef = useRef<HTMLUListElement>(null)
  const scrollerRef = useRef<HTMLElement | null>(null)
  const medidas = useRef(new Map<string, number>())
  const idsRef = useRef(ids)
  idsRef.current = ids
  const [pos, setPos] = useState<Pos>({ top: 0, vista: 800 })
  const [ver, setVer] = useState(0)
  const [foco, setFoco] = useState<string | null>(null)
  const [pedido, setPedido] = useState<{ id: string } | null>(enfocarAlMontar ? { id: enfocarAlMontar } : null)

  const indices = useMemo(() => new Map(ids.map((id, i) => [id, i])), [ids])
  const alturas = useMemo(() => ids.map((id) => medidas.current.get(id)), [ids, ver])
  const estimada = useMemo(() => estimadaDe(medidas.current.values(), ESTIMADA_INICIAL), [ids, ver])
  const fijos = [foco, pedido?.id, abiertoId].map((id) => (id == null ? -1 : (indices.get(id) ?? -1)))
  const n = ids.length
  const ventana = calcularVentana({ n, scrollTop: pos.top, alto: pos.vista, alturas, estimada, margen: MARGEN, fijos })
  const trs = tramos(ventana, n, alturas, estimada)

  const leer = (): { top: number; vista: number } => {
    const ul = ulRef.current
    const sc = scrollerRef.current
    if (!ul) return { top: 0, vista: 0 }
    const arriba = sc ? sc.getBoundingClientRect().top : 0
    return { top: arriba - ul.getBoundingClientRect().top, vista: sc ? sc.clientHeight : window.innerHeight }
  }
  const sincronizar = (): void => {
    const l = leer()
    const nueva = { top: Math.floor(l.top / PASO) * PASO, vista: Math.round(l.vista) }
    setPos((prev) => (igual(prev, nueva) ? prev : nueva))
  }
  const leerRef = useRef(leer)
  leerRef.current = leer
  const sincronizarRef = useRef(sincronizar)
  sincronizarRef.current = sincronizar

  /** Tras navegar con teclado, la tarjeta con foco se mantiene a la vista aunque las alturas medidas muevan todo. */
  const siguiendo = useRef(false)
  const observador = useRef<ResizeObserver | null>(null)
  const observados = useRef(new Set<Element>())

  useLayoutEffect(() => {
    const ul = ulRef.current
    if (!ul) return
    const sc = padreScroll(ul)
    scrollerRef.current = sc
    const anclaPrevia = sc?.style.overflowAnchor ?? ''
    // El ajuste del ancla lo hace este componente; el del navegador se sumaría y movería de más.
    if (sc) sc.style.overflowAnchor = 'none'
    let raf = 0
    const alMover = (): void => {
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0
          sincronizarRef.current()
        })
      }
    }
    const objetivo: HTMLElement | Window = sc ?? window
    objetivo.addEventListener('scroll', alMover, { passive: true })
    window.addEventListener('resize', alMover)
    const soltar = (): void => {
      siguiendo.current = false
    }
    objetivo.addEventListener('wheel', soltar, { passive: true })
    objetivo.addEventListener('pointerdown', soltar, { passive: true })
    const alCambiarVista = sc ? new ResizeObserver(alMover) : null
    if (sc) alCambiarVista?.observe(sc)

    const alMedir = (entradas: ResizeObserverEntry[]): void => {
      const nuevas = new Map<string, number>()
      for (const e of entradas) {
        const id = (e.target as HTMLElement).dataset.tid
        if (id === undefined) continue
        const h = e.borderBoxSize?.[0]?.blockSize ?? e.target.getBoundingClientRect().height
        if (h > 0 && Math.abs((medidas.current.get(id) ?? -1) - h) > 0.01) nuevas.set(id, h)
      }
      if (nuevas.size === 0) return
      const lista = idsRef.current
      const alturasDe = (): (number | undefined)[] => lista.map((id) => medidas.current.get(id))
      const a0 = alturasDe()
      const e0 = estimadaDe(medidas.current.values(), ESTIMADA_INICIAL)
      const top = leerRef.current().top
      for (const [id, h] of nuevas) medidas.current.set(id, h)
      const a1 = alturasDe()
      const e1 = estimadaDe(medidas.current.values(), ESTIMADA_INICIAL)
      // Lo que cambia de alto arriba de lo que se está mirando no debe mover lo que se ve.
      const ancla = indiceEnOffset(a0, e0, Math.max(0, top), lista.length)
      const ajuste = top > 0 ? ajusteAncla(offsetDeIndice(a0, e0, ancla), offsetDeIndice(a1, e1, ancla)) : 0
      flushSync(() => setVer((v) => v + 1))
      if (ajuste !== 0) {
        if (sc) sc.scrollTop += ajuste
        else window.scrollBy(0, ajuste)
      }
      if (siguiendo.current && ul.contains(document.activeElement)) document.activeElement?.scrollIntoView({ block: 'nearest' })
    }
    observador.current = new ResizeObserver(alMedir)
    // Con otro ancho (ventana, zoom) los títulos cambian de líneas: lo medido ya no vale. Observar de
    // nuevo cada tarjeta dibujada fuerza una medición nueva aunque su alto no haya cambiado.
    let ancho = -1
    const alCambiarAncho = new ResizeObserver(() => {
      const w = ul.clientWidth
      const cambio = ancho >= 0 && Math.abs(w - ancho) > 0.5
      ancho = w
      if (!cambio) return
      medidas.current.clear()
      for (const el of observados.current) {
        observador.current?.unobserve(el)
        observador.current?.observe(el)
      }
      setVer((v) => v + 1)
    })
    alCambiarAncho.observe(ul)
    sincronizarRef.current()
    return () => {
      if (raf) cancelAnimationFrame(raf)
      objetivo.removeEventListener('scroll', alMover)
      window.removeEventListener('resize', alMover)
      objetivo.removeEventListener('wheel', soltar)
      objetivo.removeEventListener('pointerdown', soltar)
      alCambiarVista?.disconnect()
      alCambiarAncho.disconnect()
      observador.current?.disconnect()
      observador.current = null
      observados.current.clear()
      if (sc) sc.style.overflowAnchor = anclaPrevia
    }
  }, [])

  useLayoutEffect(() => {
    const ul = ulRef.current
    const ro = observador.current
    if (!ul || !ro) return
    const vivos = new Set<Element>(ul.querySelectorAll('li[data-tid]'))
    for (const el of observados.current) {
      if (!vivos.has(el)) {
        ro.unobserve(el)
        observados.current.delete(el)
      }
    }
    for (const el of vivos) {
      if (!observados.current.has(el)) {
        ro.observe(el)
        observados.current.add(el)
      }
    }
    for (const id of medidas.current.keys()) if (!indices.has(id)) medidas.current.delete(id)
    sincronizar()
    // Si la tarjeta pedida ya no está (refresco o filtro), el pedido no puede quedar esperando: robaría el foco si vuelve.
    if (pedido && !indices.has(pedido.id)) setPedido(null)
    else if (pedido) {
      const boton = [...vivos].find((li) => (li as HTMLElement).dataset.tid === pedido.id)?.querySelector('button')
      if (boton) {
        boton.focus()
        setPedido(null)
      }
    }
  })

  const irA = (j: number): void => {
    const { top, vista } = leer()
    const nuevo = scrollParaVer(offsetDeIndice(alturas, estimada, j), alturas[j] ?? estimada, top, vista)
    if (nuevo !== top) {
      if (scrollerRef.current) scrollerRef.current.scrollTop += nuevo - top
      else window.scrollBy(0, nuevo - top)
    }
    sincronizar()
    siguiendo.current = true
    setPedido({ id: ids[j] })
  }

  const alTecla = (e: React.KeyboardEvent<HTMLUListElement>): void => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const id = (e.target as HTMLElement).closest<HTMLElement>('li[data-tid]')?.dataset.tid
    const i = id === undefined ? undefined : indices.get(id)
    if (i === undefined) return
    let destino: number | null
    if (e.key === 'Tab') {
      // Tab pasa a la tarjeta siguiente aunque todavía no esté dibujada.
      const s = e.shiftKey ? i - 1 : i + 1
      destino = s >= 0 && s < n && !estaDibujada(ventana, s) ? s : null
    } else if (e.shiftKey) return
    else destino = destinoTeclado(e.key, i, n, Math.floor(pos.vista / estimada))
    if (destino === null) return
    e.preventDefault()
    if (destino !== i) irA(destino)
  }

  return (
    <ul
      ref={ulRef}
      className="f-tickets-rows f-tickets-rows--virtual"
      onKeyDown={alTecla}
      onFocus={(e) => setFoco(e.target.closest<HTMLElement>('li[data-tid]')?.dataset.tid ?? null)}
      onBlur={(e) => {
        if (document.hasFocus() && !ulRef.current?.contains(e.relatedTarget)) setFoco(null)
      }}
    >
      {trs.map((t, k) => (t.tipo === 'espacio' ? <li key={`e${k}`} aria-hidden="true" style={{ height: t.alto }} /> : fila(t.i)))}
    </ul>
  )
}
