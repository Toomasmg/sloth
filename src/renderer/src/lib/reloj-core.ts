export interface Reloj {
  suscribir(cb: () => void, cadaMs: number): () => void
  /** Se llama en cada cambio de visibilidad: oculto cancela el timer; visible refresca una vez y lo rearma. */
  reanudar(): void
  marca(): number
}

interface Sub {
  cb: () => void
  cadaMs: number
  ultimo: number
}

/**
 * `ahora` es un reloj monotónico (performance.now) y decide a quién le toca: si la hora de pared
 * retrocede o salta no frena a nadie. `epoch` (Date.now) solo alimenta la `marca` que ven los componentes.
 */
export function crearReloj(
  ahora: () => number,
  epoch: () => number,
  programar: (fn: () => void, ms: number) => unknown,
  cancelar: (handle: unknown) => void,
  visible: () => boolean
): Reloj {
  const subs = new Set<Sub>()
  let marca = epoch()
  let timer: unknown = null
  let venceTimer = Infinity

  const parar = (): void => {
    if (timer === null) return
    cancelar(timer)
    timer = null
  }

  // El timer sigue al próximo vencimiento real (ultimo + cadaMs), no al período mínimo: cambiar la
  // lista de suscriptores nunca lo corre hacia adelante. Si queda un timer más temprano que el
  // necesario, el tick lo reacomoda sin notificar a nadie de más.
  const armar = (): void => {
    if (subs.size === 0 || !visible()) {
      parar()
      return
    }
    let vence = Infinity
    for (const s of subs) vence = Math.min(vence, s.ultimo + s.cadaMs)
    if (timer !== null && venceTimer <= vence) return
    parar()
    venceTimer = vence
    timer = programar(tick, Math.max(0, vence - ahora()))
  }

  function tick(): void {
    timer = null
    const n = ahora()
    marca = epoch()
    for (const s of [...subs]) {
      if (!subs.has(s) || n - s.ultimo < s.cadaMs) continue
      s.ultimo = n
      s.cb()
    }
    armar()
  }

  return {
    suscribir(cb, cadaMs) {
      if (subs.size === 0) marca = epoch()
      const sub: Sub = { cb, cadaMs, ultimo: ahora() }
      subs.add(sub)
      armar()
      return () => {
        subs.delete(sub)
        if (subs.size === 0) parar()
      }
    },
    reanudar() {
      if (!visible()) {
        parar()
        return
      }
      marca = epoch()
      const n = ahora()
      for (const s of [...subs]) {
        if (!subs.has(s)) continue
        s.ultimo = n
        s.cb()
      }
      parar()
      armar()
    },
    marca: () => marca
  }
}
