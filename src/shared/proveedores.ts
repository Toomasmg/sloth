export const PROVEEDORES_IDS = ['claude'] as const
export type ProveedorId = (typeof PROVEEDORES_IDS)[number]
export const PROVEEDOR_DEFECTO: ProveedorId = 'claude'

export function esProveedorId(v: unknown): v is ProveedorId {
  return typeof v === 'string' && (PROVEEDORES_IDS as readonly string[]).includes(v)
}

/** Forma que puede tener un id guardado: lo que una versión futura escribe y esta no conoce igual se conserva. */
export const PROVEEDOR_ID_RE = /^[a-z0-9-]{1,32}$/

/**
 * Ausente es el proveedor por defecto (las cuentas de antes). Un valor que esta versión no conoce
 * (versión futura, archivo editado a mano) da undefined: nunca se lo reemplaza por otro agente.
 */
export function proveedorIdDe(cuenta: { proveedor?: unknown }): ProveedorId | undefined {
  if (cuenta.proveedor === undefined) return PROVEEDOR_DEFECTO
  return esProveedorId(cuenta.proveedor) ? cuenta.proveedor : undefined
}
