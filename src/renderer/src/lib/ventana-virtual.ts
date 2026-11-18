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
