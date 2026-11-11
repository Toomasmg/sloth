/**
 * Lo que llega por IPC para un ticket (id, acción y sus datos) se valida acá, y el resultado de una
 * escritura se aplica acá al estado local. Sin fs ni Claude.
 * Módulo puro (lo corre `node --test` con type stripping): sin enums, namespaces ni parameter
 * properties, y los tipos se importan con `type`.
 */
import { ACCIONES, type Accion, type Detalle, type EstadoBase, type Ticket, type Yo } from '../../../shared/tickets'
import type { ConectorDef } from './conector'
import { clavesOcultas, idValido, type AccionInput } from './motor'

export const MAX_HORAS = 12
const MOTIVO_HORAS = 'Horas cargadas desde Sloth'

export const esAccion = (v: unknown): v is Accion => typeof v === 'string' && (ACCIONES as readonly string[]).includes(v)

export function ticketId(def: ConectorDef, v: unknown): string {
  const id = idValido(def, v)
  if (!id) throw new Error(`El ticket tiene que ser tipo ${def.ejemplo.id}.`)
  return id
}

/** Texto en una línea (los espacios y saltos se colapsan). undefined si viene vacío. */
export function texto(v: unknown, max: number, name: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') throw new Error(`${name} no es válido.`)
  const s = v.replace(/\s+/g, ' ').trim()
  if (s.length > max) throw new Error(`${name} es demasiado largo (máx. ${max}).`)
  return s || undefined
}

export function textoObligatorio(v: unknown, max: number, name: string): string {
  const s = texto(v, max, name)
  if (!s) throw new Error(`Falta ${name}.`)
  return s
}

export function esMio(me: Yo | undefined, t: Ticket): boolean {
  if (!me || !t.responsable) return false
  if (me.id && t.responsableId) return t.responsableId === me.id
  return t.responsable.trim().toLowerCase() === me.nombre.trim().toLowerCase()
}

export interface Contexto {
  /** Las columnas del tablero (sin las de categoría 'hecho'). */
  estados: EstadoBase[]
  me?: Yo
  /** El último detalle leído del ticket, si se abrió. */
  detalle?: Detalle
}

/** Lo que se le pide a Claude para la acción, o null si no hay nada que hacer (ya está en ese estado). */
export function entradaDeAccion(def: ConectorDef, a: Accion, t: Ticket, raw: unknown, c: Contexto): AccionInput | null {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const ticket = t.id
  switch (a) {
    case 'estado': {
      const estado = typeof p.estado === 'string' ? p.estado : ''
      if (clavesOcultas(def).includes(estado) || !c.estados.some((e) => e.clave === estado))
        throw new Error(`Ese estado no está en el flujo de ${def.nombre}.`)
      return t.estado === estado ? null : { ticket, estado }
    }
    case 'tomar':
      if (t.responsable) throw new Error(`Ya lo tiene ${t.responsable}.`)
      if (!c.me?.id) throw new Error(`Falta tu id de ${def.nombre}: actualizá la lista para cargarlo.`)
      return { ticket, persona: c.me.id }
    case 'soltar':
      if (!esMio(c.me, t)) throw new Error('Solo podés soltar un ticket que tenés asignado.')
      return { ticket, persona: null }
    case 'comentar':
      return { ticket, cuerpo: textoObligatorio(p.cuerpo, 2000, 'El comentario') }
    case 'criterio': {
      const criterioId = typeof p.criterioId === 'string' ? p.criterioId : ''
      if (!c.detalle?.criterios.some((x) => x.id === criterioId)) throw new Error('Abrí el ticket de nuevo: no encuentro ese criterio.')
      return { ticket, criterioId, hecho: p.hecho === true }
    }
    case 'horas': {
      const h = typeof p.horas === 'number' ? p.horas : NaN
      const minutos = Math.round(h * 60)
      if (!Number.isFinite(h) || h <= 0 || h > MAX_HORAS || minutos < 1) throw new Error(`Las horas tienen que ser más de 0 y hasta ${MAX_HORAS}.`)
      return { ticket, minutos, motivo: MOTIVO_HORAS }
    }
  }
}

export interface Aplicar {
  me?: Yo
  /** El detalle cargado ahora (puede haberse releído mientras corría la acción). */
  detalle?: Detalle
  /** El total de minutos que devolvió el conector al sumar horas, si lo dio. */
  minutosTotal?: number
  /** ISO, para el comentario recién publicado. */
  fecha: string
}

/** Pasa al estado local lo que se pidió, para no tener que releer el ticket. */
export function aplicarAccion(a: Accion, t: Ticket, i: AccionInput, c: Aplicar): void {
  const d = c.detalle
  switch (a) {
    case 'estado':
      t.estado = i.estado
      break
    case 'tomar':
      if (!c.me) break
      t.responsable = c.me.nombre
      if (c.me.id) t.responsableId = c.me.id
      break
    case 'soltar':
      delete t.responsable
      delete t.responsableId
      break
    case 'comentar':
      if (d && i.cuerpo) d.comentarios.push({ autor: c.me?.nombre ?? 'Vos', cuerpo: i.cuerpo, fecha: c.fecha })
      break
    case 'criterio': {
      if (!d) break
      const crit = d.criterios.find((x) => x.id === i.criterioId)
      if (crit) crit.hecho = i.hecho === true
      t.criterios = d.criterios.map((x) => ({ ...x }))
      break
    }
    case 'horas':
      if (d && i.minutos) d.minutos = c.minutosTotal ?? (d.minutos ?? 0) + i.minutos
      break
  }
}
