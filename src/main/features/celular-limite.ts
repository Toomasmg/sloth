export interface Limite {
  /** true si el cliente puede hacer otro pedido ahora. Un pedido rechazado no suma a la cuenta. */
  permitir(clave: string, ahora: number): boolean
}

/** Ventana deslizante por cliente; las claves que ya no piden se sueltan, y con `maxClaves` se descarta la más vieja. */
export function crearLimite(max = 200, ventanaMs = 5000, maxClaves = 256): Limite {
  const instantes = new Map<string, number[]>()

  function podar(ahora: number): void {
    for (const [clave, lista] of instantes) {
      while (lista.length && lista[0] <= ahora - ventanaMs) lista.shift()
      if (!lista.length) instantes.delete(clave)
    }
  }

  return {
    permitir(clave, ahora) {
      let lista = instantes.get(clave)
      if (lista) while (lista.length && lista[0] <= ahora - ventanaMs) lista.shift()
      else {
        if (instantes.size >= maxClaves) {
          podar(ahora)
          if (instantes.size >= maxClaves) instantes.delete(instantes.keys().next().value as string)
        }
        lista = []
        instantes.set(clave, lista)
      }
      if (lista.length >= max) return false
      lista.push(ahora)
      return true
    }
  }
}
