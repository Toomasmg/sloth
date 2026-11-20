export interface Escrituras {
  /** true si esta escritura hay que hacerla; false si ya se hizo (la página reintentó porque la respuesta se perdió). */
  nueva(id: string, sesion: string, n: number, ahora: number): boolean
}

interface Marca {
  n: number
  en: number
}

/**
 * El último número de escritura hecho por cada página (sesion) en cada terminal. Una página que reintenta manda
 * el mismo número; uno ya visto no se vuelve a ejecutar. Un número mayor que el siguiente (se perdió una
 * escritura que la página decidió no reenviar) se hace igual. Acotado en cantidad y en edad.
 */
export function crearEscrituras(max = 64, venceMs = 10 * 60_000): Escrituras {
  const marcas = new Map<string, Marca>()

  function podar(ahora: number): void {
    for (const [clave, m] of marcas) if (ahora - m.en > venceMs) marcas.delete(clave)
  }

  return {
    nueva(id, sesion, n, ahora) {
      const clave = `${id}|${sesion}`
      const previa = marcas.get(clave)
      if (previa && ahora - previa.en <= venceMs && n <= previa.n) return false
      marcas.delete(clave)
      if (marcas.size >= max) {
        podar(ahora)
        if (marcas.size >= max) marcas.delete(marcas.keys().next().value as string)
      }
      marcas.set(clave, { n, en: ahora })
      return true
    }
  }
}
