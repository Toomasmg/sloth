export const PROVEEDORES_IDS = ['claude', 'codex', 'copilot'] as const
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
  ticketsHeadless: boolean
  chatMcp: boolean
  historial: boolean
  moverCuenta: boolean
  dormir: boolean
  uso: boolean
  overrideClaude: boolean
  avisoTurno: boolean
  limitesExperimental: boolean
}

const TODAS: Capacidades = {
  hooks: true,
  statusline: true,
  setupCompartido: true,
  tickets: true,
  ticketsHeadless: true,
  chatMcp: true,
  historial: true,
  moverCuenta: true,
  dormir: true,
  uso: true,
  overrideClaude: true,
  avisoTurno: true,
  limitesExperimental: false
}

const NINGUNA: Capacidades = {
  hooks: false,
  statusline: false,
  setupCompartido: false,
  tickets: false,
  ticketsHeadless: false,
  chatMcp: false,
  historial: false,
  moverCuenta: false,
  dormir: false,
  uso: false,
  overrideClaude: false,
  avisoTurno: false,
  limitesExperimental: false
}

export const CAPACIDADES: Record<ProveedorId, Capacidades> = { claude: TODAS, codex: { ...NINGUNA, avisoTurno: true, limitesExperimental: true }, copilot: { ...NINGUNA } }

export const NOMBRE_PROVEEDOR: Record<ProveedorId, string> = { claude: 'Claude Code', codex: 'Codex', copilot: 'GitHub Copilot' }

export function nombreProveedor(cuenta: { proveedor?: unknown }): string {
  const id = proveedorIdDe(cuenta)
  return id === undefined ? 'Agente desconocido' : NOMBRE_PROVEEDOR[id]
}

export const ETIQUETA_AGENTE: Record<ProveedorId, string> = { claude: 'Claude', codex: 'Codex', copilot: 'Copilot' }

/** Nombre corto del agente de la cuenta para un texto; 'el agente' si no se conoce. */
export function agenteDe(cuenta: { proveedor?: unknown }): string {
  const id = proveedorIdDe(cuenta)
  return id === undefined ? 'el agente' : ETIQUETA_AGENTE[id]
}

/** 'Claude' si todas son de Claude o no hay cuentas (el texto de siempre); el nombre si todas son del mismo agente; undefined si hay mezcla. */
export function agenteComun(cuentas: readonly { proveedor?: unknown }[]): string | undefined {
  const nombres = new Set(cuentas.map(agenteDe))
  if (nombres.size === 0) return ETIQUETA_AGENTE.claude
  return nombres.size === 1 ? [...nombres][0] : undefined
}

/** undefined si el agente de la cuenta no se conoce: quien lo use decide qué hacer (en general, no lanzar nada). */
export function capacidadesDe(cuenta: { proveedor?: unknown }): Capacidades | undefined {
  const id = proveedorIdDe(cuenta)
  return id === undefined ? undefined : CAPACIDADES[id]
}

/** hooks, statusline, setupCompartido, overrideClaude y uso son permanentes; tickets, historial y moverCuenta (y chatMcp, dormir) se retoman en las ramas 4 y 5. */
const MOTIVOS_ESPECIFICOS: Partial<Record<ProveedorId, Partial<Record<keyof Capacidades, string>>>> = {
  codex: {
    hooks: 'Con Codex no hay avisos de permisos desde el celu: Codex todavía no se los manda a Sloth.',
    tickets: 'Los tickets todavía solo corren con Claude Code: ni las consultas ni el trabajo por ticket usan cuentas de Codex.',
    historial: 'El historial todavía solo lee las conversaciones de Claude Code.',
    moverCuenta: 'Mover espacios todavía solo anda entre cuentas de Claude Code.',
    statusline: 'Codex no ejecuta un comando externo para la barra de estado: Sloth no puede leer sus límites por ahí.',
    setupCompartido: 'El setup compartido es el de tu carpeta de Claude Code: no aplica a Codex.',
    uso: 'El conteo de tokens todavía solo lee las conversaciones de Claude Code.',
    overrideClaude: 'Estos reemplazos de comando son de Claude Code.'
  }
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

MOTIVOS_ESPECIFICOS.copilot = {
  hooks: 'Con Copilot no hay avisos de permisos desde el celu todavía.',
  tickets: 'Los tickets todavía solo corren con Claude Code: ni las consultas ni el trabajo por ticket usan cuentas de Copilot.',
  historial: 'El historial todavía solo lee las conversaciones de Claude Code.',
  moverCuenta: 'Mover espacios todavía solo anda entre cuentas de Claude Code.',
  uso: 'Copilot no informa cuánto te queda: Sloth no puede mostrar el uso.',
  statusline: 'Copilot no ejecuta un comando externo para la barra de estado.',
  setupCompartido: 'El setup compartido es el de tu carpeta de Claude Code: no aplica a Copilot.',
  overrideClaude: 'Estos reemplazos de comando son de Claude Code.'
}

/** Con un login compartido del sistema, dos cuentas de Copilot se pisarían entre sí. */
export const MAX_CUENTAS: Partial<Record<ProveedorId, number>> = { copilot: 1 }

/**
 * Por qué no se puede sumar otra cuenta de ese agente, o undefined si se puede. El login del sistema es el mismo
 * para todos los perfiles: `enOtrosPerfiles` son las cuentas de ese agente que ya hay en los demás.
 */
export function motivoNoAgregar(cuentas: readonly { proveedor?: unknown }[], id: ProveedorId, enOtrosPerfiles = 0): string | undefined {
  const tope = MAX_CUENTAS[id]
  if (tope === undefined) return undefined
  const aca = cuentas.filter((c) => proveedorIdDe(c) === id).length
  if (aca >= tope) return `Ya tenés una cuenta de ${NOMBRE_PROVEEDOR[id]}: su login es del sistema y dos cuentas se pisarían entre sí.`
  if (aca + enOtrosPerfiles >= tope) return `Ya tenés una cuenta de ${NOMBRE_PROVEEDOR[id]} en otro perfil: su login es del sistema y es el mismo en todos los perfiles.`
  return undefined
}
