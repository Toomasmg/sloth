// Margen holgado: el corte fino lo hace el logger después de redactar, así un secreto no queda partido por la mitad.
const MAX_CRUDO = 20_000

/** Lo que manda la UI desde window.onerror / unhandledrejection; llega por IPC sin validar. */
export function leerErrorRenderer(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const { mensaje, stack } = payload as { mensaje?: unknown; stack?: unknown }
  if (typeof mensaje !== 'string' || mensaje.length === 0) return undefined
  const cabeza = mensaje.slice(0, MAX_CRUDO)
  return typeof stack === 'string' && stack.length > 0 ? `${cabeza}\n${stack.slice(0, MAX_CRUDO)}` : cabeza
}
