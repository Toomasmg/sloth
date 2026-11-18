/**
 * Reintento con tope: un intento que falla por algo pasajero se repite, pero el total no pasa de un tiempo
 * ni de un costo. Módulo puro (lo corre `node --test` con type stripping).
 */

export interface PresupuestoReintento {
  /** Lo que queda para este intento; undefined = sin tope de costo. */
  restanteUsd: number | undefined
  restanteMs: number
}

export interface OpcionesReintento {
  intentosMax: number
  /** Tope de tiempo de todos los intentos juntos. */
  tiempoMaxMs: number
  /** Tope de costo de todos los intentos juntos; sin él, no se descuenta nada. */
  costoMaxUsd?: number
  /** Menos que esto de tiempo restante no vale otro intento. */
  minimoMs?: number
  /** Menos que esto de costo restante no vale otro intento (el tope de `claude` no admite menos de un centavo). */
  minimoUsd?: number
  reintentable: (e: unknown) => boolean
  /** Lo que gastó el intento que falló, si se sabe. */
  costoDe?: (e: unknown) => number | undefined
  ahora?: () => number
}

export async function conReintento<T>(corre: (p: PresupuestoReintento) => Promise<T>, o: OpcionesReintento): Promise<T> {
  const ahora = o.ahora ?? Date.now
  const inicio = ahora()
  let gastado = 0
  for (let intento = 1; ; intento++) {
    const restanteMs = Math.max(0, o.tiempoMaxMs - (ahora() - inicio))
    try {
      return await corre({ restanteUsd: o.costoMaxUsd === undefined ? undefined : Math.max(0, o.costoMaxUsd - gastado), restanteMs })
    } catch (e) {
      const costo = o.costoDe?.(e)
      if (costo !== undefined && Number.isFinite(costo) && costo > 0) gastado += costo
      const sinTiempo = o.tiempoMaxMs - (ahora() - inicio) < (o.minimoMs ?? 0)
      const sinCosto = o.costoMaxUsd !== undefined && (o.costoMaxUsd - gastado <= 0 || o.costoMaxUsd - gastado < (o.minimoUsd ?? 0))
      if (!o.reintentable(e) || intento >= o.intentosMax || sinTiempo || sinCosto) throw e
    }
  }
}
