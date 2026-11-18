export const PROVEEDORES_IDS = ['claude'] as const
export type ProveedorId = (typeof PROVEEDORES_IDS)[number]
export const PROVEEDOR_DEFECTO: ProveedorId = 'claude'

export function esProveedorId(v: unknown): v is ProveedorId {
  return typeof v === 'string' && (PROVEEDORES_IDS as readonly string[]).includes(v)
}

/** Un valor ausente o desconocido (archivo editado a mano, versión futura) cae al proveedor por defecto. */
export function proveedorIdDe(cuenta: { proveedor?: unknown }): ProveedorId {
  return esProveedorId(cuenta.proveedor) ? cuenta.proveedor : PROVEEDOR_DEFECTO
}
