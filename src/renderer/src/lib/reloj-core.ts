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

export function crearReloj(
  ahora: () => number,
  programar: (fn: () => void, ms: number) => unknown,
  cancelar: (handle: unknown) => void,
  visible: () => boolean
): Reloj {
  const subs = new Set<Sub>()
  let marca = ahora()
  let timer: unknown = null

  const parar = (): void => {
    if (timer === null) return
    cancelar(timer)
    timer = null
  }

  const armar = (): void => {
    parar()
    if (subs.size === 0 || !visible()) return
    let min = Infinity
    for (const s of subs) min = Math.min(min, s.cadaMs)
    timer = programar(tick, min)
  }

  function tick(): void {
    timer = null
    marca = ahora()
    for (const s of [...subs]) {
      if (!subs.has(s) || marca - s.ultimo < s.cadaMs) continue
      s.ultimo = marca
      s.cb()
    }
    armar()
  }

  return {
    suscribir(cb, cadaMs) {
      if (subs.size === 0) marca = ahora()
      const sub: Sub = { cb, cadaMs, ultimo: marca }
      subs.add(sub)
      armar()
      return () => {
        subs.delete(sub)
        armar()
      }
    },
    reanudar() {
      if (!visible()) {
        parar()
        return
      }
      marca = ahora()
      for (const s of [...subs]) {
        if (!subs.has(s)) continue
        s.ultimo = marca
        s.cb()
      }
      armar()
    },
    marca: () => marca
  }
}
