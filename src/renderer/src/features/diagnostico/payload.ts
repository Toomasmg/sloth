export interface ErrorPayload {
  mensaje: string
  stack?: string
}

export function payloadDeRazon(razon: unknown): ErrorPayload {
  if (razon instanceof Error) return { mensaje: razon.message || razon.name, stack: razon.stack }
  if (razon === undefined || razon === null || razon === '') return { mensaje: '(sin detalle)' }
  if (typeof razon === 'string') return { mensaje: razon }
  try {
    return { mensaje: String(razon) }
  } catch {
    return { mensaje: '(sin detalle)' }
  }
}

export function payloadDeEvento(mensaje: string, error: unknown): ErrorPayload {
  if (error instanceof Error) return payloadDeRazon(error)
  return { mensaje: mensaje || '(sin detalle)' }
}

// Aviso benigno de Chromium cuando un ResizeObserver no llega a entregar todo en un frame; la app lo usa en las terminales.
export function esRuido(mensaje: string): boolean {
  return /^ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)/.test(mensaje)
}
