/**
 * Lo que la barra de filtros del tablero decide sin tocar React: atajos de estado, grupos de personas,
 * resumen de una línea y búsqueda en la lista de personas. Módulo puro (lo corre `node --test`).
 */
import { categoriaDe, esMio, PERSONAS_ELEGIDAS_MAX, SIN_ASIGNAR, type Categoria, type Estado, type FiltroVista, type PendientesLista, type PersonaEquipo, type Ticket, type Yo } from '../../../../shared/tickets'

export const NOMBRE_MAX = 60
export const VENTANAS: readonly number[] = [1, 2, 4, 7, 14]
export const GRUPO_MIOS = 'mios'
export const GRUPO_TODOS = 'todos'
const PERSONAS_VISIBLES_MAX = 120

/** Sin mayúsculas, tildes ni espacios de más: para buscar «jose» y encontrar «José». */
export const normaliza = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

/** Los nombres vienen de afuera: sin caracteres de control ni de dirección, de una línea y acotados. */
export function nombreSeguro(s: string, max = NOMBRE_MAX): string {
  const limpio = s
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return limpio.length > max ? `${limpio.slice(0, max - 1).trimEnd()}…` : limpio
}

export interface Atajo {
  id: 'en_curso' | 'revision' | 'hecho'
  nombre: string
  /** Claves de los estados del conector que esa categoría reúne. */
  claves: string[]
}

const ATAJOS: { id: Atajo['id']; nombre: string; categoria: Categoria }[] = [
  { id: 'en_curso', nombre: 'En curso', categoria: 'en_curso' },
  { id: 'revision', nombre: 'Revisión / QA', categoria: 'revision' },
  { id: 'hecho', nombre: 'Terminado', categoria: 'hecho' }
]

/** Los atajos que el conector puede cumplir: salen de sus categorías, no de nombres fijos. */
export function atajosDe(estados: readonly Estado[]): Atajo[] {
  return ATAJOS.map((a) => ({ id: a.id, nombre: a.nombre, claves: estados.filter((e) => e.categoria === a.categoria).map((e) => e.clave) })).filter((a) => a.claves.length > 0)
}

export const atajoActivo = (a: Atajo, elegidos: readonly string[]): boolean => a.claves.every((c) => elegidos.includes(c))

/** Prende o apaga todos los estados de un atajo; null si dejaría el filtro sin ningún estado. */
export function alternarAtajo(a: Atajo, elegidos: readonly string[]): string[] | null {
  const sigue = atajoActivo(a, elegidos) ? elegidos.filter((c) => !a.claves.includes(c)) : [...new Set([...elegidos, ...a.claves])]
  return sigue.length ? sigue : null
}

export function alternarEstado(clave: string, elegidos: readonly string[]): string[] | null {
  const sigue = elegidos.includes(clave) ? elegidos.filter((c) => c !== clave) : [...elegidos, clave]
  return sigue.length ? sigue : null
}

export const tieneHechos = (estados: readonly Estado[], elegidos: readonly string[]): boolean => elegidos.some((c) => categoriaDe(c, estados) === 'hecho')

export type CambioPersonas = { ok: true; ids: string[] } | { ok: false; motivo: string }

/** Suma o saca una persona de las elegidas. «Yo» no entra: los propios se traen siempre. */
export function alternarPersona(id: string, elegidas: readonly string[], me: Yo | undefined): CambioPersonas {
  if (me?.id === id) return { ok: true, ids: [...elegidas] }
  if (elegidas.includes(id)) return { ok: true, ids: elegidas.filter((x) => x !== id) }
  if (elegidas.length >= PERSONAS_ELEGIDAS_MAX) return { ok: false, motivo: `Se pueden elegir hasta ${PERSONAS_ELEGIDAS_MAX} personas a la vez.` }
  return { ok: true, ids: [...elegidas, id] }
}

/** Las personas que coinciden con el texto. Sin texto, primero las elegidas. Sin «yo»: va aparte y fijo. */
export function filtrarPersonas(personas: readonly PersonaEquipo[], texto: string, elegidas: readonly string[], me: Yo | undefined): { lista: PersonaEquipo[]; total: number } {
  const q = normaliza(texto)
  const coinciden = personas.filter((p) => p.id !== me?.id && (!q || normaliza(p.nombre).includes(q)))
  const ordenadas = q ? coinciden : [...coinciden.filter((p) => elegidas.includes(p.id)), ...coinciden.filter((p) => !elegidas.includes(p.id))]
  return { lista: ordenadas.slice(0, PERSONAS_VISIBLES_MAX), total: coinciden.length }
}

export interface Grupo {
  clave: string
  nombre: string
  tipo: 'mios' | 'persona' | 'sin'
  n: number
  /** Todavía no se trajeron sus tickets (si lo que falta es volver a leer todo, no se sabe de nadie en particular). */
  sinTraer: boolean
}

/** A qué grupo del panel pertenece un ticket: los míos, una persona (por id, o por nombre si no hay id) o sin asignar. */
export function grupoDe(t: Pick<Ticket, 'responsable' | 'responsableId'>, me: Yo | undefined): string {
  if (esMio(me, t)) return GRUPO_MIOS
  if (!t.responsable) return SIN_ASIGNAR
  return t.responsableId ?? `n:${normaliza(t.responsable)}`
}

/** Míos primero, después las personas elegidas en el orden en que se eligieron, y sin asignar si se pidió. */
export function gruposDe(
  f: FiltroVista,
  personas: readonly PersonaEquipo[] | undefined,
  me: Yo | undefined,
  tickets: readonly Ticket[],
  pendientes: PendientesLista | undefined
): Grupo[] {
  const cuenta = new Map<string, number>()
  const nombres = new Map<string, string>()
  for (const t of tickets) {
    const g = grupoDe(t, me)
    cuenta.set(g, (cuenta.get(g) ?? 0) + 1)
    if (t.responsable && g !== GRUPO_MIOS && !nombres.has(g)) nombres.set(g, t.responsable)
  }
  const grupos: Grupo[] = [{ clave: GRUPO_MIOS, nombre: 'Míos', tipo: 'mios', n: cuenta.get(GRUPO_MIOS) ?? 0, sinTraer: false }]
  for (const id of f.personasElegidas) {
    if (id === me?.id) continue
    const nombre = personas?.find((p) => p.id === id)?.nombre ?? nombres.get(id) ?? 'Persona sin nombre'
    grupos.push({ clave: id, nombre: nombreSeguro(nombre), tipo: 'persona', n: cuenta.get(id) ?? 0, sinTraer: pendientes?.todo === false && pendientes.personas.includes(id) })
  }
  if (f.incluirSinAsignar) grupos.push({ clave: SIN_ASIGNAR, nombre: 'Sin asignar', tipo: 'sin', n: cuenta.get(SIN_ASIGNAR) ?? 0, sinTraer: pendientes?.todo === false && pendientes.sinAsignar })
  return grupos
}

/** Deja los tickets en el orden de los grupos; dentro de cada uno, el orden en que venían. */
export function ordenarPorGrupo<T extends Pick<Ticket, 'responsable' | 'responsableId'>>(tickets: readonly T[], grupos: readonly Grupo[], me: Yo | undefined): T[] {
  const lugar = new Map(grupos.map((g, i) => [g.clave, i]))
  const rank = (t: T): number => lugar.get(grupoDe(t, me)) ?? grupos.length
  return tickets.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map((x) => x.t)
}

/** Una línea con lo que se está viendo, para la barra plegada. */
export function resumenFiltro(f: FiltroVista, personas: readonly PersonaEquipo[] | undefined, estados: readonly Estado[]): string {
  const nombres = f.personasElegidas.map((id) => nombreSeguro(personas?.find((p) => p.id === id)?.nombre ?? 'alguien', 24))
  const quien = ['vos']
  if (nombres.length <= 2) quien.push(...nombres)
  else quien.push(nombres[0]!, `${nombres.length - 1} más`)
  if (f.incluirSinAsignar) quien.push('sin asignar')
  const atajos = atajosDe(estados)
  const cubiertas = new Set<string>()
  const que: string[] = []
  for (const a of atajos) {
    if (!atajoActivo(a, f.estadosElegidos)) continue
    que.push(a.nombre)
    a.claves.forEach((c) => cubiertas.add(c))
  }
  for (const c of f.estadosElegidos) if (!cubiertas.has(c)) que.push(estados.find((e) => e.clave === c)?.nombre ?? c)
  const estadosTxt = que.length > 3 ? `${que.slice(0, 3).join(', ')} y ${que.length - 3} más` : que.join(', ')
  const ventana = tieneHechos(estados, f.estadosElegidos) ? ` · terminados de los últimos ${f.ventanaDias} ${f.ventanaDias === 1 ? 'día' : 'días'}` : ''
  return `${quien.join(', ')} · ${estadosTxt}${ventana}`
}

/** Qué falta traer, en una frase para mostrar junto al botón. */
export function textoFaltante(p: PendientesLista, f: FiltroVista, personas: readonly PersonaEquipo[] | undefined): string {
  if (p.todo) return `Cambió lo que se pide (terminados o ${f.ventanaDias} ${f.ventanaDias === 1 ? 'día' : 'días'} de ventana): hay que volver a traerlo.`
  const n = p.personas.length
  const quien =
    n === 1 ? nombreSeguro(personas?.find((x) => x.id === p.personas[0])?.nombre ?? 'una persona', 30) : n > 1 ? `${n} personas` : ''
  const sin = p.sinAsignar ? 'los sin asignar' : ''
  return `Todavía no se trajeron los tickets de ${[quien, sin].filter(Boolean).join(' ni de ')}.`
}

export const hayFaltante = (p: PendientesLista | undefined): p is PendientesLista => p !== undefined && (p.todo || p.personas.length > 0 || p.sinAsignar)

/** Las opciones de la ventana: las de siempre y, si hace falta, la que ya está elegida. */
export const opcionesVentana = (actual: number): number[] => (VENTANAS.includes(actual) ? [...VENTANAS] : [...VENTANAS, actual].sort((a, b) => a - b))
