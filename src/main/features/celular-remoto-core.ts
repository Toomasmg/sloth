import type { EstadoCelular } from '../../shared/celular'
import { CELU_ACTIVO_MS, LATIDO_MS, MIN_ENTRE_ESTADOS_MS } from '../../shared/celu-remoto'

export interface RitmoEntrada {
  ahora: number
  ultimoHola: number | null
  ultimoEnvio: number | null
  cambio: boolean
  holaNuevo: boolean
}

/** Solo se publica con un celu mirando: al toque ante un hola, con cambios cada 2 s como mucho y un latido. */
export function debePublicar(e: RitmoEntrada): boolean {
  if (e.ultimoHola === null || e.ahora - e.ultimoHola > CELU_ACTIVO_MS) return false
  if (e.holaNuevo || e.ultimoEnvio === null) return true
  const desde = e.ahora - e.ultimoEnvio
  if (e.cambio && desde >= MIN_ENTRE_ESTADOS_MS) return true
  return desde >= LATIDO_MS
}

export const celuActivo = (ultimoHola: number | null, ahora: number): boolean => ultimoHola !== null && ahora - ultimoHola <= CELU_ACTIVO_MS

/** `ahora` cambia en cada lectura: sin sacarlo, todo parecería un cambio. */
export function huella(e: EstadoCelular): string {
  const { ahora: _ahora, ...resto } = e
  return JSON.stringify(resto)
}

export class Nonces {
  #vistos = new Set<string>()
  #orden: string[] = []
  #max: number

  constructor(max = 500) {
    this.#max = max
  }

  /** false si ya se usó. */
  usar(n: string): boolean {
    if (this.#vistos.has(n)) return false
    this.#vistos.add(n)
    this.#orden.push(n)
    if (this.#orden.length > this.#max) this.#vistos.delete(this.#orden.shift() as string)
    return true
  }
}
