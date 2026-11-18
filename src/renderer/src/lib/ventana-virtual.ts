export type Alturas = ReadonlyArray<number | undefined>

export interface Ventana {
  /** Primera fila dibujada. */
  desde: number
  /** Una más allá de la última fila dibujada. */
  hasta: number
  /** Alto en px de todo lo que queda antes de `desde`. */
  antes: number
  /** Alto en px de todo lo que queda desde `hasta` hasta el final. */
  despues: number
  /** Filas fuera de [desde, hasta) que se dibujan igual (foco, activa, resaltada), ordenadas. */
  fijos: number[]
}

export type Tramo = { tipo: 'espacio'; alto: number } | { tipo: 'fila'; i: number }

export interface Entrada {
  n: number
  scrollTop: number
  alto: number
  /** Alto medido de cada fila; undefined donde todavía no se midió. */
  alturas: Alturas
  /** Alto que se supone para lo que no se midió. */
  estimada: number
  /** Px extra arriba y abajo de lo que se ve. */
  margen: number
  fijos: readonly number[]
}

const altoDe = (alturas: Alturas, estimada: number, i: number): number => alturas[i] ?? estimada

export function offsetDeIndice(alturas: Alturas, estimada: number, i: number): number {
  let y = 0
  for (let k = 0; k < i; k++) y += altoDe(alturas, estimada, k)
  return y
}

export function alturaTotal(alturas: Alturas, estimada: number, n: number): number {
  return offsetDeIndice(alturas, estimada, n)
}

/** Fila que contiene `offset`; antes del principio es la primera y pasado el final es la última. */
export function indiceEnOffset(alturas: Alturas, estimada: number, offset: number, n: number = alturas.length): number {
  if (n <= 0) return 0
  let y = 0
  for (let i = 0; i < n; i++) {
    y += altoDe(alturas, estimada, i)
    if (offset < y) return i
  }
  return n - 1
}

/** Cuánto hay que mover scrollTop para que la fila ancla quede donde estaba en pantalla. */
export function ajusteAncla(offsetAnclaAntes: number, offsetAnclaDespues: number): number {
  return offsetAnclaDespues - offsetAnclaAntes
}

export function calcularVentana(e: Entrada): Ventana {
  const { n, alturas, estimada } = e
  if (n <= 0) return { desde: 0, hasta: 0, antes: 0, despues: 0, fijos: [] }
  const total = alturaTotal(alturas, estimada, n)
  const scrollTop = Math.min(Math.max(0, e.scrollTop), Math.max(0, total - e.alto))
  const arriba = scrollTop - e.margen
  const abajo = scrollTop + e.alto + e.margen

  let y = 0
  let desde = -1
  let hasta = n
  let antes = 0
  for (let i = 0; i < n; i++) {
    const h = altoDe(alturas, estimada, i)
    if (desde < 0 && y + h > arriba) {
      desde = i
      antes = y
    }
    if (desde >= 0 && y >= abajo) {
      hasta = i
      break
    }
    y += h
  }
  if (desde < 0) {
    desde = n - 1
    antes = total - altoDe(alturas, estimada, n - 1)
  }
  if (hasta <= desde) hasta = desde + 1
  const despues = total - offsetDeIndice(alturas, estimada, hasta)

  const fijos = [...new Set(e.fijos)].filter((i) => Number.isInteger(i) && i >= 0 && i < n && (i < desde || i >= hasta)).sort((a, b) => a - b)
  return { desde, hasta, antes, despues, fijos }
}

/** Lo que se dibuja de arriba abajo: espaciadores donde faltan filas y las filas de la ventana y las fijas. */
export function tramos(v: Ventana, n: number, alturas: Alturas, estimada: number): Tramo[] {
  const out: Tramo[] = []
  let proxima = 0
  const hueco = (hasta: number): void => {
    if (hasta <= proxima) return
    out.push({ tipo: 'espacio', alto: offsetDeIndice(alturas, estimada, hasta) - offsetDeIndice(alturas, estimada, proxima) })
    proxima = hasta
  }
  const fila = (i: number): void => {
    out.push({ tipo: 'fila', i })
    proxima = i + 1
  }
  for (const i of v.fijos) {
    if (i >= v.desde) break
    hueco(i)
    fila(i)
  }
  hueco(v.desde)
  for (let i = v.desde; i < v.hasta; i++) fila(i)
  for (const i of v.fijos) {
    if (i < v.hasta) continue
    hueco(i)
    fila(i)
  }
  hueco(n)
  return out
}

/** Alto que se supone para lo no medido: el promedio redondeado de lo medido, o `defecto` si todavía no hay nada. */
export function estimadaDe(medidas: Iterable<number>, defecto: number): number {
  let suma = 0
  let k = 0
  for (const h of medidas) {
    suma += h
    k++
  }
  return k === 0 ? defecto : Math.max(1, Math.round(suma / k))
}

/** Nuevo `top` (offset de la vista sobre la lista) para que la fila [offset, offset + alto) quede entera a la vista, moviendo lo mínimo. */
export function scrollParaVer(offset: number, alto: number, top: number, vista: number): number {
  if (offset < top) return offset
  if (offset + alto > top + vista) return alto >= vista ? offset : offset + alto - vista
  return top
}

export function estaDibujada(v: Ventana, i: number): boolean {
  return (i >= v.desde && i < v.hasta) || v.fijos.includes(i)
}

/** A qué fila pasa el foco con una tecla de navegación de lista; null si la tecla no navega. */
export function destinoTeclado(key: string, i: number, n: number, pagina: number): number | null {
  if (n <= 0) return null
  const tope = (j: number): number => Math.min(n - 1, Math.max(0, j))
  switch (key) {
    case 'ArrowDown':
      return tope(i + 1)
    case 'ArrowUp':
      return tope(i - 1)
    case 'PageDown':
      return tope(i + Math.max(1, pagina))
    case 'PageUp':
      return tope(i - Math.max(1, pagina))
    case 'Home':
      return 0
    case 'End':
      return n - 1
    default:
      return null
  }
}
