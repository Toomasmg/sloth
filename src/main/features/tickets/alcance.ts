/**
 * Qué tickets se leen y cuáles se ven cuando el conector filtra por personas: los propios siempre,
 * los de las personas elegidas, los sin asignar si se pide, por estado y dentro de una ventana de días.
 * Módulo puro (lo corre `node --test` con type stripping): sin enums, namespaces ni parameter
 * properties, y los tipos se importan con `type`.
 */
import {
  categoriaDe,
  esMio,
  PERSONAS_ELEGIDAS_MAX,
  SIN_ASIGNAR,
  VENTANA_DEFECTO,
  VENTANA_MAX,
  type AlcanceLeido,
  type Categoria,
  type ConteosTickets,
  type FiltroVista,
  type PendientesLista,
  type Ticket,
  type TicketsConfig,
  type Yo
} from '../../../shared/tickets'
import { regexDePersona, type ConectorDef } from './conector'

const DIA_MS = 24 * 60 * 60 * 1000
const ESTADOS_ELEGIDOS_MAX = 30
const CLAVE_RE = /^[a-z0-9_]{1,40}$/
/** Estados que se ven si la persona no eligió: lo que se está trabajando, lo que espera revisión y lo terminado. */
const CATEGORIAS_POR_DEFECTO: readonly Categoria[] = ['en_curso', 'revision', 'hecho']

/** Qué se le pide al conector en una consulta: a quién y desde cuándo (YYYY-MM-DD). Los propios van siempre. */
export interface AlcanceLista {
  personas: string[]
  sinAsignar: boolean
  hechos: boolean
  desde: string
}

export const ventanaValida = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= VENTANA_MAX ? v : undefined

/** Los ids de persona elegidos, sin repetir y con la forma que pide el conector; null si algo no sirve. */
export function personasValidas(def: ConectorDef, raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > PERSONAS_ELEGIDAS_MAX) return null
  const re = regexDePersona(def)
  const out: string[] = []
  for (const p of raw) {
    if (typeof p !== 'string' || !re.test(p)) return null
    if (!out.includes(p)) out.push(p)
  }
  return out
}

/** Las claves de estado elegidas, sin repetir y entre las que el conector conoce; null si algo no sirve. */
export function estadosValidos(raw: unknown, conocidas: readonly string[]): string[] | null {
  if (!Array.isArray(raw) || raw.length > ESTADOS_ELEGIDOS_MAX) return null
  const out: string[] = []
  for (const e of raw) {
    if (typeof e !== 'string' || !CLAVE_RE.test(e) || !conocidas.includes(e)) return null
    if (!out.includes(e)) out.push(e)
  }
  return out
}

export const estadosPorDefecto = (def: ConectorDef): string[] => def.estados.filter((e) => CATEGORIAS_POR_DEFECTO.includes(e.categoria)).map((e) => e.clave)

/** Lo guardado con los valores por defecto resueltos y lo que ya no sirve (estados que el conector no tiene) descartado. */
export function filtroDe(c: Pick<TicketsConfig, 'personasElegidas' | 'incluirSinAsignar' | 'estadosElegidos' | 'ventanaDias'>, def: ConectorDef): FiltroVista {
  const conocidas = def.estados.map((e) => e.clave)
  const elegidos = (c.estadosElegidos ?? []).filter((e) => conocidas.includes(e))
  return {
    personasElegidas: c.personasElegidas ?? [],
    incluirSinAsignar: c.incluirSinAsignar === true,
    estadosElegidos: elegidos.length ? elegidos : estadosPorDefecto(def),
    ventanaDias: c.ventanaDias ?? VENTANA_DEFECTO
  }
}

const hayHechos = (f: FiltroVista, def: ConectorDef): boolean => f.estadosElegidos.some((e) => categoriaDe(e, def.estados) === 'hecho')

/** ISO normalizado si es una fecha; undefined si no (el ticket se conserva, sin fecha). */
export function fechaValida(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > 40) return undefined
  const ms = Date.parse(v)
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined
}

export const diaDesde = (ahora: number, dias: number): string => new Date(ahora - dias * DIA_MS).toISOString().slice(0, 10)

/** Lo que falta leer: todo si no se leyó nada, se sumaron los terminados o se alargó la ventana; si no, las personas que no se leyeron. */
export function pendientesDe(f: FiltroVista, leido: AlcanceLeido | undefined, def: ConectorDef, me: Yo | undefined): PendientesLista {
  if (!leido || !me || (hayHechos(f, def) && (!leido.hechos || f.ventanaDias > leido.ventanaDias)))
    return { personas: f.personasElegidas.filter((p) => p !== me?.id), sinAsignar: f.incluirSinAsignar, todo: true }
  return {
    personas: f.personasElegidas.filter((p) => p !== me.id && !leido.personas.includes(p)),
    sinAsignar: f.incluirSinAsignar && !leido.sinAsignar,
    todo: false
  }
}

export const sinPendientes = (p: PendientesLista): boolean => !p.todo && !p.personas.length && !p.sinAsignar

/** Lo que se pide en la consulta: todo el filtro, o solo lo pendiente. */
export function alcanceAPedir(f: FiltroVista, p: PendientesLista, def: ConectorDef, ahora: number, me: Yo | undefined, completo: boolean): AlcanceLista {
  const todo = completo || p.todo
  return {
    personas: todo ? f.personasElegidas.filter((x) => x !== me?.id) : p.personas,
    sinAsignar: todo ? f.incluirSinAsignar : p.sinAsignar,
    hechos: hayHechos(f, def),
    desde: diaDesde(ahora, f.ventanaDias)
  }
}

/** Lo leído después de una consulta; `todo` reemplaza lo anterior y si no se suma. */
export function leidoTras(f: FiltroVista, previo: AlcanceLeido | undefined, pedido: AlcanceLista, todo: boolean, def: ConectorDef): AlcanceLeido {
  const base = todo || !previo ? { personas: [], sinAsignar: false } : previo
  return {
    personas: [...new Set([...base.personas, ...pedido.personas])],
    sinAsignar: base.sinAsignar || pedido.sinAsignar,
    hechos: hayHechos(f, def) && (todo || !previo ? pedido.hechos : previo.hechos),
    ventanaDias: todo || !previo ? f.ventanaDias : Math.max(previo.ventanaDias, f.ventanaDias)
  }
}

/** Los de lo que se volvió a leer se reemplazan; el resto de lo ya leído queda. */
export function mezclar(previos: readonly Ticket[], nuevos: readonly Ticket[], pedido: AlcanceLista, me: Yo | undefined, todo: boolean): Ticket[] {
  if (todo) return [...nuevos]
  const releidos = (t: Ticket): boolean =>
    esMio(me, t) || (t.responsableId !== undefined && pedido.personas.includes(t.responsableId)) || (pedido.sinAsignar && !t.responsable)
  const ids = new Set(nuevos.map((t) => t.id))
  return [...previos.filter((t) => !releidos(t) && !ids.has(t.id)), ...nuevos]
}

const esHecho = (t: Ticket, def: ConectorDef): boolean => categoriaDe(t.estado, def.estados) === 'hecho'

/** ¿Es de alguien que se ve? Los propios, los de las personas elegidas y los sin responsable si se pidió. */
function dentroDelAlcance(t: Ticket, f: FiltroVista, me: Yo | undefined): boolean {
  if (esMio(me, t)) return true
  if (!t.responsable) return f.incluirSinAsignar
  return t.responsableId !== undefined && f.personasElegidas.includes(t.responsableId)
}

/** La ventana corta solo lo terminado: lo abierto, de quien sea, se ve siempre. Sin fecha válida no se descarta. */
function dentroDeLaVentana(t: Ticket, f: FiltroVista, def: ConectorDef, ahora: number): boolean {
  if (!esHecho(t, def)) return true
  const ms = t.fecha === undefined ? NaN : Date.parse(t.fecha)
  return Number.isNaN(ms) || ms >= ahora - f.ventanaDias * DIA_MS
}

export function visibles(tickets: readonly Ticket[], f: FiltroVista, me: Yo | undefined, def: ConectorDef, ahora: number): Ticket[] {
  return tickets.filter(
    (t) => dentroDelAlcance(t, f, me) && dentroDeLaVentana(t, f, def, ahora) && (t.estado === undefined || f.estadosElegidos.includes(t.estado))
  )
}

export function conteos(tickets: readonly Ticket[], f: FiltroVista, me: Yo | undefined, def: ConectorDef, ahora: number): ConteosTickets {
  const porPersona: Record<string, number> = {}
  const porEstado: Record<string, number> = {}
  let ocultos = 0
  let sinFecha = 0
  for (const t of tickets) {
    const enAlcance = dentroDelAlcance(t, f, me)
    const enVentana = dentroDeLaVentana(t, f, def, ahora)
    const enEstado = t.estado === undefined || f.estadosElegidos.includes(t.estado)
    if (enAlcance && enVentana && t.estado !== undefined) porEstado[t.estado] = (porEstado[t.estado] ?? 0) + 1
    if (enAlcance && enVentana && enEstado) {
      const quien = esMio(me, t) && me?.id ? me.id : t.responsable ? (t.responsableId ?? t.responsable) : SIN_ASIGNAR
      porPersona[quien] = (porPersona[quien] ?? 0) + 1
      if (t.fecha === undefined) sinFecha++
    } else ocultos++
  }
  return { porPersona, porEstado, ocultos, sinFecha }
}
