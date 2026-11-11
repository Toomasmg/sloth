/**
 * Qué es un conector de tickets y cómo se valida. Un conector es SOLO datos: nombres de
 * herramientas, pistas para el prompt y estados; el motor arma todo lo demás.
 * Módulo puro (lo corre `node --test` con type stripping): sin enums, namespaces ni parameter
 * properties, y los tipos se importan con `type`.
 */
import { ACCIONES, CATEGORIAS, type Accion, type Estado } from '../../../shared/tickets'

export type ArgValor = string | number | boolean | null | { [k: string]: ArgValor }

/** Un string que es EXACTAMENTE `{ticket}`, `{estado}`… se reemplaza por el valor tipado; si el valor es undefined, la clave no va. Admite objetos anidados (hasta 3 niveles). */
export interface PasoLlamada {
  herramienta: string
  args: Record<string, ArgValor>
}

export interface PistaAccion {
  args: Record<string, ArgValor>
  /** Admite los mismos placeholders que los args de la acción. */
  nota?: string
}

export interface ConectorBase {
  id: string
  nombre: string
  verificado: boolean
  /** Anclada con ^…$; se compila como ^(?:…)$ para que una alternancia no la desancle. */
  idRegex: string
  idMayusculas: boolean
  /** Forma del id de persona, anclada como idRegex. Sin esto, letras, números y guiones. */
  personaId?: string
  ejemplo: { id: string; estado: string; prioridad: string; proyecto: string }
  estados: Estado[]
  /** Lo que responde Claude cuando la cuenta no tiene el conector, y lo que se le muestra a la persona. */
  faltaConector: { clave: string; mensaje: string }
}

export interface ConectorMcp extends ConectorBase {
  via: 'mcp'
  /** Nombres cortos; el completo es `prefijo + corto`. */
  herramientas: {
    prefijo: string
    lista: string[]
    detalle: string[]
    escritura: Partial<Record<Accion, string>>
    negar: string[]
    /** De lectura, permitidas también en el detalle y en cada acción (p. ej. para sacar un id de sitio). */
    apoyo?: string[]
    /** De lectura, permitidas además del apoyo solo en esa acción. */
    apoyoEn?: Partial<Record<Accion, string[]>>
  }
  pistas: {
    /** conId lleva `{id}` una sola vez. */
    yo: { conId: string; sinId: string }
    lista: string
    /** Sin esto no hay paso 3 ni "estados" en el ejemplo. */
    estados?: string
    detalle: PasoLlamada[]
    /** Cuándo usar las herramientas de apoyo; admite solo `{ticket}`. */
    apoyo?: string
    acciones: Partial<Record<Accion, PistaAccion>>
  }
}

export interface ConectorGh extends ConectorBase {
  via: 'gh'
}

export type ConectorDef = ConectorMcp | ConectorGh

/** Lo que gh puede hacer desde Sloth. */
export const ACCIONES_GH: readonly Accion[] = ['estado', 'tomar', 'soltar', 'comentar']
export const ESTADOS_GH = ['abierto', 'cerrado'] as const

/** Un id de ticket más largo que esto no se evalúa contra la regex (ni se guarda). */
export const ID_MAX = 20
/** Los ids van sin comillas a los prompts y al PTY (`/ticket <id>`): además de la regex del conector, solo esto. */
export const ID_SEGURO_RE = /^[A-Za-z0-9_#.-]+$/
export const ID_CONECTOR_RE = /^[a-z][a-z0-9-]{1,31}$/

export const PLACEHOLDERS: Record<Accion, readonly string[]> = {
  estado: ['ticket', 'estado'],
  tomar: ['ticket', 'persona'],
  soltar: ['ticket'],
  comentar: ['ticket', 'cuerpo'],
  criterio: ['ticket', 'criterioId', 'hecho'],
  horas: ['ticket', 'minutos', 'motivo']
}

export class ConectorInvalidoError extends Error {
  ruta: string
  constructor(ruta: string, motivo: string) {
    super(`Conector inválido en ${ruta}: ${motivo}`)
    this.ruta = ruta
  }
}

type Obj = Record<string, unknown>

// Los args de una pista quedan a 4 niveles de la raíz y admiten 3 más adentro.
const PROF_MAX = 7
const TAM_MAX = 64 * 1024
const PISTA_MAX = 1000
const NOMBRE_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._&-]{0,39}$/u
const CLAVE_ESTADO_RE = /^[a-z0-9_]{1,40}$/
const CLAVE_FALTA_RE = /^[a-z_]{3,40}$/
export const PREFIJO_RE = /^mcp__[A-Za-z0-9_-]+__$/
export const CORTO_RE = /^[A-Za-z0-9_-]{1,64}$/
const ARG_RE = /^[a-z_][A-Za-z0-9_]{0,40}$/
const ARGS_PROF_MAX = 3
const PLACEHOLDER_RE = /^\{([A-Za-z]+)\}$/
// Lo que va dentro de un JSON de ejemplo del prompt: sin nada que lo pueda cerrar o escapar.
const SIN_ESCAPE = /^[^"\\{}]*$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const LLAVES = /[{}]/

function fallar(ruta: string, motivo: string): never {
  throw new ConectorInvalidoError(ruta, motivo)
}

function esPlano(v: unknown): v is Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const p: unknown = Object.getPrototypeOf(v)
  return p === Object.prototype || p === null
}

function soloDatos(v: unknown, ruta: string, prof: number): void {
  if (prof > PROF_MAX) fallar(ruta, `más de ${PROF_MAX} niveles`)
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) fallar(ruta, 'número no finito')
    return
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => soloDatos(x, `${ruta}[${i}]`, prof + 1))
    return
  }
  if (!esPlano(v)) fallar(ruta, typeof v === 'object' ? 'objeto que no es plano' : `${typeof v} no permitido`)
  if (Object.getOwnPropertySymbols(v).length) fallar(ruta, 'claves símbolo no permitidas')
  for (const [k, x] of Object.entries(v)) soloDatos(x, `${ruta}.${k}`, prof + 1)
}

function objeto(v: unknown, ruta: string, claves: readonly string[], opcionales: readonly string[] = []): Obj {
  if (!esPlano(v)) fallar(ruta, 'tiene que ser un objeto')
  for (const k of Object.keys(v)) if (!claves.includes(k) && !opcionales.includes(k)) fallar(`${ruta}.${k}`, 'clave desconocida')
  for (const k of claves) if (!(k in v)) fallar(`${ruta}.${k}`, 'falta')
  return v
}

function campo(v: unknown, ruta: string, max: number, forma?: RegExp): string {
  if (typeof v !== 'string' || !v) fallar(ruta, 'tiene que ser un texto no vacío')
  // El largo antes que la forma: ninguna regex corre sobre textos enormes.
  if (v.length > max) fallar(ruta, `más de ${max} caracteres`)
  if (CONTROL.test(v)) fallar(ruta, 'tiene caracteres de control o saltos de línea')
  if (forma && !forma.test(v)) fallar(ruta, 'tiene un formato inválido')
  return v
}

function booleano(v: unknown, ruta: string): boolean {
  if (typeof v !== 'boolean') fallar(ruta, 'tiene que ser true o false')
  return v
}

function lista(v: unknown, ruta: string, min: number, max: number): unknown[] {
  if (!Array.isArray(v)) fallar(ruta, 'tiene que ser una lista')
  if (v.length < min || v.length > max) fallar(ruta, `tiene que tener entre ${min} y ${max} elementos`)
  return v
}

function sinRepetidos(xs: readonly string[], ruta: string): void {
  const r = xs.find((x, i) => xs.indexOf(x) !== i)
  if (r !== undefined) fallar(ruta, `«${r}» está repetido`)
}

// Con prefijo y nombre corto de hasta 64 cada uno, el nombre completo ya es válido y entra en 128.
const herramienta = (v: unknown, ruta: string): string => campo(v, ruta, 64, CORTO_RE)

function herramientas(v: unknown, ruta: string, min: number, max: number): string[] {
  const xs = lista(v, ruta, min, max).map((x, i) => herramienta(x, `${ruta}[${i}]`))
  sinRepetidos(xs, ruta)
  return xs
}

function args(v: unknown, ruta: string, permitidos: readonly string[], prof = 1): void {
  if (!esPlano(v)) fallar(ruta, 'tiene que ser un objeto')
  const claves = Object.keys(v)
  if (claves.length < 1 || claves.length > 10) fallar(ruta, 'tiene que tener entre 1 y 10 argumentos')
  for (const k of claves) {
    const r = `${ruta}.${k}`
    if (!ARG_RE.test(k)) fallar(r, 'nombre de argumento inválido')
    const x = v[k]
    if (x === null || typeof x === 'number' || typeof x === 'boolean') continue
    if (esPlano(x)) {
      if (prof >= ARGS_PROF_MAX) fallar(r, `más de ${ARGS_PROF_MAX} niveles de argumentos`)
      args(x, r, permitidos, prof + 1)
      continue
    }
    const s = campo(x, r, 200)
    if (!LLAVES.test(s)) continue
    const m = PLACEHOLDER_RE.exec(s)
    if (!m || !permitidos.includes(m[1])) fallar(r, `solo admite ${permitidos.map((p) => `{${p}}`).join(', ')} como valor completo`)
  }
}

function soloPlaceholders(v: unknown, ruta: string, permitidos: readonly string[]): void {
  const resto = permitidos.reduce((s, p) => s.replaceAll(`{${p}}`, ''), campo(v, ruta, PISTA_MAX))
  if (LLAVES.test(resto)) fallar(ruta, `solo admite ${permitidos.map((p) => `{${p}}`).join(', ')}`)
}

function compilar(idRegex: string): RegExp {
  return new RegExp(`^(?:${idRegex.slice(1, -1)})$`)
}

function idRegex(v: unknown, ruta: string): RegExp {
  const s = campo(v, ruta, 200)
  const fin = /(\\*)\$$/.exec(s)
  if (!s.startsWith('^') || !fin || fin[1].length % 2) fallar(ruta, 'tiene que estar anclada con ^…$')
  if (/\)[*+?{]/.test(s)) fallar(ruta, 'no admite grupos cuantificados')
  if (/\\[1-9]|\\k</.test(s)) fallar(ruta, 'no admite referencias hacia atrás')
  if (/\(\?<?[=!]/.test(s)) fallar(ruta, 'no admite lookarounds')
  try {
    return compilar(s)
  } catch {
    return fallar(ruta, 'no compila')
  }
}

const en = (xs: readonly string[], v: unknown): boolean => typeof v === 'string' && xs.includes(v)

const R = 'conector'
const CLAVES_BASE = ['id', 'nombre', 'via', 'verificado', 'idRegex', 'idMayusculas', 'ejemplo', 'estados', 'faltaConector']
const OPCIONALES_BASE = ['personaId']

/** Valida lo común a toda vía y devuelve el objeto con las claves de estado. */
function validarBase(raw: Obj, extras: readonly string[]): { o: Obj; claves: string[] } {
  const o = objeto(raw, R, [...CLAVES_BASE, ...extras], OPCIONALES_BASE)
  campo(o.id, `${R}.id`, 32, ID_CONECTOR_RE)
  campo(o.nombre, `${R}.nombre`, 40, NOMBRE_RE)
  booleano(o.verificado, `${R}.verificado`)
  const mayusculas = booleano(o.idMayusculas, `${R}.idMayusculas`)
  const re = idRegex(o.idRegex, `${R}.idRegex`)
  if ('personaId' in o) idRegex(o.personaId, `${R}.personaId`)

  const claves = lista(o.estados, `${R}.estados`, 1, 30).map((x, i) => {
    const r = `${R}.estados[${i}]`
    const e = objeto(x, r, ['clave', 'nombre', 'categoria'])
    campo(e.nombre, `${r}.nombre`, 40, SIN_ESCAPE)
    if (!en(CATEGORIAS, e.categoria)) fallar(`${r}.categoria`, `tiene que ser una de ${CATEGORIAS.join(', ')}`)
    return campo(e.clave, `${r}.clave`, 40, CLAVE_ESTADO_RE)
  })
  sinRepetidos(claves, `${R}.estados`)
  if ((o.estados as Estado[]).every((e) => e.categoria === 'hecho')) fallar(`${R}.estados`, "hace falta al menos uno que no sea 'hecho'")

  const ej = objeto(o.ejemplo, `${R}.ejemplo`, ['id', 'estado', 'prioridad', 'proyecto'])
  for (const k of Object.keys(ej)) campo(ej[k], `${R}.ejemplo.${k}`, 60, SIN_ESCAPE)
  const ejId = ej.id as string
  if ((mayusculas && ejId !== ejId.toUpperCase()) || ejId.length > ID_MAX || !ID_SEGURO_RE.test(ejId) || !re.test(ejId)) fallar(`${R}.ejemplo.id`, 'no cumple idRegex')
  if (!claves.includes(ej.estado as string)) fallar(`${R}.ejemplo.estado`, 'no es la clave de ningún estado')

  const falta = objeto(o.faltaConector, `${R}.faltaConector`, ['clave', 'mensaje'])
  campo(falta.clave, `${R}.faltaConector.clave`, 40, CLAVE_FALTA_RE)
  campo(falta.mensaje, `${R}.faltaConector.mensaje`, 300)
  return { o, claves }
}

function validarGh(raw: Obj): void {
  const { claves } = validarBase(raw, [])
  claves.forEach((c, i) => {
    if (!en(ESTADOS_GH, c)) fallar(`${R}.estados[${i}].clave`, `con gh tiene que ser una de ${ESTADOS_GH.join(', ')}`)
  })
  if (!claves.includes('abierto')) fallar(`${R}.estados`, "con gh hace falta el estado 'abierto'")
}

function validarMcp(raw: Obj): void {
  const { o } = validarBase(raw, ['herramientas', 'pistas'])
  const H = `${R}.herramientas`
  const h = objeto(o.herramientas, H, ['prefijo', 'lista', 'detalle', 'escritura', 'negar'], ['apoyo', 'apoyoEn'])
  campo(h.prefijo, `${H}.prefijo`, 64, PREFIJO_RE)
  const deLista = herramientas(h.lista, `${H}.lista`, 1, 20)
  const deDetalle = herramientas(h.detalle, `${H}.detalle`, 0, 20)
  const negar = herramientas(h.negar, `${H}.negar`, 0, 100)
  const escritura = objeto(h.escritura, `${H}.escritura`, [], ACCIONES)
  const deEscritura = Object.entries(escritura).map(([a, t]) => herramienta(t, `${H}.escritura.${a}`))
  const lectura = new Set([...deLista, ...deDetalle])
  const choca = [...negar, ...deEscritura].find((t) => lectura.has(t))
  if (choca) fallar(H, `«${choca}» no puede ser de lectura y estar negada o escribir`)
  const apoyo = 'apoyo' in h ? herramientas(h.apoyo, `${H}.apoyo`, 0, 10) : []
  const apoyoChoca = apoyo.find((t) => negar.includes(t) || deEscritura.includes(t))
  if (apoyoChoca) fallar(`${H}.apoyo`, `«${apoyoChoca}» no puede ser de apoyo y estar negada o escribir`)
  const apoyoEn = 'apoyoEn' in h ? objeto(h.apoyoEn, `${H}.apoyoEn`, [], Object.keys(escritura)) : {}
  for (const [a, x] of Object.entries(apoyoEn)) {
    const choca = herramientas(x, `${H}.apoyoEn.${a}`, 1, 5).find((t) => negar.includes(t) || deEscritura.includes(t))
    if (choca) fallar(`${H}.apoyoEn.${a}`, `«${choca}» no puede ser de apoyo y estar negada o escribir`)
  }
  if ('criterio' in escritura && !deDetalle.length) fallar(`${H}.escritura.criterio`, 'tildar criterios necesita herramientas de detalle (de ahí salen sus ids)')

  const P = `${R}.pistas`
  const p = objeto(o.pistas, P, ['yo', 'lista', 'detalle', 'acciones'], ['estados', 'apoyo'])
  const yo = objeto(p.yo, `${P}.yo`, ['conId', 'sinId'])
  const conId = campo(yo.conId, `${P}.yo.conId`, PISTA_MAX)
  if (conId.split('{id}').length !== 2 || LLAVES.test(conId.replace('{id}', ''))) fallar(`${P}.yo.conId`, 'tiene que llevar {id} una sola vez y ninguna otra llave')
  campo(yo.sinId, `${P}.yo.sinId`, PISTA_MAX)
  campo(p.lista, `${P}.lista`, PISTA_MAX)
  if ('estados' in p) campo(p.estados, `${P}.estados`, PISTA_MAX)
  if ('apoyo' in p) soloPlaceholders(p.apoyo, `${P}.apoyo`, ['ticket'])
  if (!('apoyo' in p) !== !apoyo.length) fallar(`${P}.apoyo`, 'la pista de apoyo y las herramientas de apoyo van juntas')
  if (Object.keys(apoyoEn).length && !('apoyo' in p)) fallar(`${H}.apoyoEn`, 'necesita la pista de apoyo')

  const pasos = lista(p.detalle, `${P}.detalle`, 0, 20)
  if (!pasos.length !== !deDetalle.length) fallar(`${P}.detalle`, 'hay pasos de detalle sin herramientas de detalle o al revés')
  pasos.forEach((x, i) => {
    const r = `${P}.detalle[${i}]`
    const paso = objeto(x, r, ['herramienta', 'args'])
    if (!en(deDetalle, paso.herramienta)) fallar(`${r}.herramienta`, 'no está en herramientas.detalle')
    args(paso.args, `${r}.args`, ['ticket'])
  })

  const acciones = objeto(p.acciones, `${P}.acciones`, Object.keys(escritura))
  for (const [a, x] of Object.entries(acciones)) {
    const r = `${P}.acciones.${a}`
    const pista = objeto(x, r, ['args'], ['nota'])
    args(pista.args, `${r}.args`, PLACEHOLDERS[a as Accion])
    if ('nota' in pista) soloPlaceholders(pista.nota, `${r}.nota`, PLACEHOLDERS[a as Accion])
  }
}

function validar(raw: unknown): void {
  if (!esPlano(raw)) fallar(R, 'tiene que ser un objeto')
  if (raw.via === 'mcp') validarMcp(raw)
  else if (raw.via === 'gh') validarGh(raw)
  else fallar(`${R}.via`, 'vía no soportada')
}

/** Valida un conector y devuelve una copia nueva. Tira ConectorInvalidoError con la ruta del problema. */
export function validarConector(raw: unknown): ConectorDef {
  soloDatos(raw, 'conector', 0)
  const json = JSON.stringify(raw)
  if (json.length > TAM_MAX) fallar('conector', 'pesa más de 64 KB')
  const copia: unknown = JSON.parse(json)
  validar(copia)
  return copia as ConectorDef
}

const regexes = new WeakMap<ConectorDef, RegExp>()

export function regexDeId(def: ConectorDef): RegExp {
  let re = regexes.get(def)
  if (!re) regexes.set(def, (re = compilar(def.idRegex)))
  return re
}

const personas = new WeakMap<ConectorDef, RegExp>()
export const PERSONA_POR_DEFECTO = /^[A-Za-z0-9-]{1,64}$/

export function regexDePersona(def: ConectorDef): RegExp {
  if (def.personaId === undefined) return PERSONA_POR_DEFECTO
  let re = personas.get(def)
  if (!re) personas.set(def, (re = compilar(def.personaId)))
  return re
}

export const nombreCompleto = (def: ConectorMcp, corto: string): string => def.herramientas.prefijo + corto
