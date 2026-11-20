export interface Conexiones {
  /** true si ese cliente puede abrir otra conexión; false si ya tiene el máximo abierto. */
  abrir(ip: string): boolean
  /** Una por cada `abrir` que dio true. */
  cerrar(ip: string): void
}

/**
 * Conexiones simultáneas por cliente. Sin clave cualquiera de la red puede abrir sockets: con un tope global
 * llenaría los lugares y dejaría afuera al celu de verdad; por cliente, solo se llena a sí mismo.
 */
export function crearConexiones(maxPorIp = 16): Conexiones {
  const abiertas = new Map<string, number>()
  return {
    abrir(ip) {
      const n = abiertas.get(ip) ?? 0
      if (n >= maxPorIp) return false
      abiertas.set(ip, n + 1)
      return true
    },
    cerrar(ip) {
      const n = (abiertas.get(ip) ?? 0) - 1
      if (n > 0) abiertas.set(ip, n)
      else abiertas.delete(ip)
    }
  }
}
