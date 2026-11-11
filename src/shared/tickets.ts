/**
 * Tickets sin atarse a un sistema: el modelo que comparten main y la interfaz.
 * Módulo puro (lo corre `node --test` con type stripping): sin enums, namespaces ni parameter
 * properties, y los tipos se importan con `type`.
 */

export const ACCIONES = ['estado', 'tomar', 'soltar', 'comentar', 'criterio', 'horas'] as const
export type Accion = (typeof ACCIONES)[number]

/** Qué significa un estado para la app (color, si va al tablero), sea cual sea su nombre. */
export const CATEGORIAS = ['pendiente', 'en_curso', 'revision', 'bloqueado', 'hecho'] as const
export type Categoria = (typeof CATEGORIAS)[number]

export const MODELOS = ['haiku', 'sonnet', 'opus'] as const
export type Modelo = (typeof MODELOS)[number]

export interface EstadoBase {
  clave: string
  nombre: string
}

export interface Estado extends EstadoBase {
  categoria: Categoria
}

export interface Persona {
  id?: string
  nombre: string
}

/** La persona dueña de la cuenta que consultó. */
export type Yo = Persona

export interface Criterio {
  /** Solo viene con el detalle; hace falta para tildarlo. */
  id?: string
  texto: string
  hecho: boolean
}

export interface Comentario {
  autor: string
  cuerpo: string
  fecha?: string
}

export interface Detalle {
  criterios: Criterio[]
  comentarios: Comentario[]
  /** null = sin registro (no es cero). */
  minutos: number | null
}

export interface Ticket {
  id: string
  titulo: string
  estado?: string
  prioridad?: string
  proyecto?: string
  url?: string
  responsable?: string
  responsableId?: string
  descripcion?: string
  criterios?: Criterio[]
}

export interface TicketsConfig {
  conectorId: string
  queryAccountId?: string
  model: Modelo
  /** Vacío = la persona dueña de la cuenta que consulta. */
  assigneeId: string
  defaultRepo?: string
  projectRepos: Record<string, string>
  confirmRefresh: boolean
}

/** Cómo habla Sloth con el sistema: Claude con un conector MCP, o GitHub CLI directo. */
export type Via = 'mcp' | 'gh'

/** De dónde sale un conector: viene con Sloth, lo armó la persona o lo trae el .sloth/conectores.json de un repo. */
export type OrigenConector = { tipo: 'incluido' } | { tipo: 'usuario' } | { tipo: 'equipo'; repo: string; equipo: string }

export interface ConectorResumen {
  id: string
  nombre: string
  verificado: boolean
  via: Via
  origen: OrigenConector
  /** Solo los del equipo: si la persona aceptó esta versión. Sin aceptar no se puede usar. */
  aceptado?: boolean
}

export interface HerramientasVista {
  prefijo: string
  lista: string[]
  detalle: string[]
  apoyo: string[]
  escritura: Partial<Record<Accion, string>>
  negar: number
}

export interface ConectorPropioVista {
  id: string
  nombre: string
  origen: OrigenConector
  aceptado: boolean
  hash: string
  herramientas: HerramientasVista
  pistaLista: string
}

export interface ConectorInfo {
  id: string
  nombre: string
  verificado: boolean
  via: Via
  /** false = el conectorId guardado no existe en esta versión. */
  disponible: boolean
  acciones: Accion[]
  leeDetalle: boolean
  ejemploId: string
  /** Los del conector, incluidos los de categoría 'hecho'. */
  estados: Estado[]
  /** Si los espacios de sus tickets arrancan con `/ticket <id>` (la skill es de Gruv). */
  comandoTicket: boolean
}

export interface Corrida {
  tokens?: number
  costUsd?: number
  durationMs?: number
}

export interface TicketsSnapshot {
  conector: ConectorInfo
  /** Los que se pueden elegir en esta versión. */
  conectores: ConectorResumen[]
  tickets: Ticket[]
  estados: Estado[]
  me?: Yo
  fetchedAt?: number
  fetchedBy?: string
  lastRun?: Corrida
  /** Solo errores de la consulta. */
  lastError?: string
  /** Sobre el guardado de tickets.json (no se guarda, falló o se reemplazó). No es de conexión. */
  aviso?: string
  config: TicketsConfig
  running: boolean
  /** Acciones que esta cuenta no puede hacer, con el motivo. */
  noDisponible?: Partial<Record<Accion, string>>
  lastRepo?: string
  /** Si el conector elegido no está en esta versión, al que se puede volver. */
  porDefecto?: { id: string; nombre: string }
  /** Conectores propios o del equipo que no se cargaron, y por qué. */
  avisosPropios?: string[]
}

/** La primera lista que tenga la clave gana; si ninguna la tiene, 'pendiente'. */
export function categoriaDe(clave: string | undefined, ...listas: readonly (readonly Estado[])[]): Categoria {
  if (clave === undefined) return 'pendiente'
  for (const l of listas) {
    const e = l.find((x) => x.clave === clave)
    if (e) return e.categoria
  }
  return 'pendiente'
}

/** Nombre para comparar personas: sin espacios de más, sin tildes y en minúsculas. */
const nombrePersona = (s: string): string =>
  s
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

/**
 * El ticket es de la persona que consulta: por id si el conector lo da, si no por nombre. La UI
 * («Míos», «Soltar») y main (que valida «soltar») usan esta misma regla.
 */
export function esMio(me: Yo | undefined, t: Pick<Ticket, 'responsable' | 'responsableId'>): boolean {
  if (!me || !t.responsable) return false
  if (me.id && t.responsableId) return t.responsableId === me.id
  return nombrePersona(t.responsable) === nombrePersona(me.nombre)
}
