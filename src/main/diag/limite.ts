export function crearLimite(max: number, ventanaMs: number, ahora: () => number): () => boolean {
  const marcas: number[] = []
  return () => {
    const t = ahora()
    while (marcas.length > 0 && t - marcas[0] >= ventanaMs) marcas.shift()
    if (marcas.length >= max) return false
    marcas.push(t)
    return true
  }
}
