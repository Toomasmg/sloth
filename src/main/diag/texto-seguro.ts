/** Como String(x) pero sin lanzar: un objeto sin prototipo o con toString roto no puede tirar abajo un handler de errores. */
export function textoSeguro(x: unknown): string {
  try {
    return String(x)
  } catch {
    return '(sin detalle)'
  }
}
