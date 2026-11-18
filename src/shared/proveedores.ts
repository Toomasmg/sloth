export const PROVEEDORES_IDS = ['claude', 'codex'] as const
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

export interface Capacidades {
  hooks: boolean
  statusline: boolean
  setupCompartido: boolean
  tickets: boolean
  chatMcp: boolean
  historial: boolean
  moverCuenta: boolean
  dormir: boolean
  uso: boolean
  overrideClaude: boolean
}

const TODAS: Capacidades = {
  hooks: true,
  statusline: true,
  setupCompartido: true,
  tickets: true,
  chatMcp: true,
  historial: true,
  moverCuenta: true,
  dormir: true,
  uso: true,
  overrideClaude: true
}

const NINGUNA: Capacidades = {
  hooks: false,
  statusline: false,
  setupCompartido: false,
  tickets: false,
  chatMcp: false,
  historial: false,
  moverCuenta: false,
  dormir: false,
  uso: false,
  overrideClaude: false
}

export const CAPACIDADES: Record<ProveedorId, Capacidades> = { claude: TODAS, codex: NINGUNA }

export const NOMBRE_PROVEEDOR: Record<ProveedorId, string> = { claude: 'Claude Code', codex: 'Codex' }

export function nombreProveedor(cuenta: { proveedor?: unknown }): string {
  const id = proveedorIdDe(cuenta)
  return id === undefined ? 'Agente desconocido' : NOMBRE_PROVEEDOR[id]
}

/** undefined si el agente de la cuenta no se conoce: quien lo use decide qué hacer (en general, no lanzar nada). */
export function capacidadesDe(cuenta: { proveedor?: unknown }): Capacidades | undefined {
  const id = proveedorIdDe(cuenta)
  return id === undefined ? undefined : CAPACIDADES[id]
}

const MOTIVOS_ESPECIFICOS: Partial<Record<ProveedorId, Partial<Record<keyof Capacidades, string>>>> = {
  codex: { hooks: 'Con Codex no hay avisos de permisos desde el celu: Codex todavía no se los manda a Sloth.' }
}

/** Por qué la cuenta no puede usar esa función, o undefined si puede. */
export function motivoSinCapacidad(cuenta: { proveedor?: unknown }, k: keyof Capacidades): string | undefined {
  const id = proveedorIdDe(cuenta)
  if (id === undefined) return 'Esta cuenta es de un agente que esta versión de Sloth no conoce; actualizá Sloth.'
  if (CAPACIDADES[id][k]) return undefined
  return MOTIVOS_ESPECIFICOS[id]?.[k] ?? `${NOMBRE_PROVEEDOR[id]} todavía no soporta esto en Sloth.`
}

/**
 * La cuenta sugerida: con sesión y la que menos usó en las últimas 5 h. Una cuenta sin dato de uso
 * (agente sin esa capacidad, o desconocido) cuenta 0 y ganaría siempre: solo se elige si no hay otra.
 */
export function cuentaSugerida(
  cuentas: { id: string; proveedor?: unknown }[],
  conSesion: (id: string) => boolean,
  usado5h: (id: string) => number
): string | undefined {
  const conUso = (c: { proveedor?: unknown }): boolean => capacidadesDe(c)?.uso === true
  const logueadas = cuentas.filter((c) => conSesion(c.id))
  const pool = [logueadas.filter(conUso), cuentas.filter(conUso), logueadas, cuentas].find((l) => l.length) ?? []
  return [...pool].sort((a, b) => usado5h(a.id) - usado5h(b.id))[0]?.id
}
