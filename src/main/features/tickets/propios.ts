/**
 * Conectores que no vienen con Sloth: los que arma la persona y los que trae el team.json de un
 * repo. Pasan por el mismo validador que los incluidos y además nunca son «verificados» ni pueden
 * leer con una herramienta que parezca de escritura.
 * Módulo puro y sin `node:*`: también lo importa la interfaz. El hash se inyecta desde main.
 */
import type { OrigenConector } from '../../../shared/tickets'
import { ConectorInvalidoError, validarConector, type ConectorDef } from './conector'

export interface ConectorRegistrado {
  def: ConectorDef
  origen: OrigenConector
  hash: string
}

export interface ArchivoPropios {
  version: 1
  conectores: ConectorDef[]
  /** `claveAceptado(repoKey, id)` → hash de la versión del conector del equipo que la persona aceptó. */
  aceptados: Record<string, string>
}

export const PROPIOS_MAX = 30
export const EQUIPO_MAX = 10
export const IMPORT_MAX_BYTES = 64 * 1024

const AVISO_MAX = 200
const AVISOS_MAX = 10
const CLAVE_ACEPTADO_MAX = 1100
const HASH_RE = /^[0-9a-f]{16}$/
const PROHIBIDAS = ['__proto__', 'constructor', 'prototype']

// Un nombre corto que empieza con alguno de estos (y sigue con _, -, mayúscula o nada) se trata como de escritura.
const VERBOS = ['create', 'update', 'delete', 'remove', 'add', 'edit', 'set', 'move', 'transition', 'assign', 'unassign', 'save', 'post', 'put', 'patch', 'write', 'close', 'reopen', 'merge', 'upload', 'send', 'archive', 'complete', 'toggle', 'log', 'duplicate']

export function esVerboEscritura(corto: string): boolean {
  const min = corto.toLowerCase()
  return VERBOS.some((v) => {
    if (!min.startsWith(v)) return false
    const sig = corto.charAt(v.length)
    return sig === '' || sig === '_' || sig === '-' || /[A-Z]/.test(sig)
  })
}

/** Copia con `verificado: false`. Tira si no es de vía mcp o si lee con algo que parece de escritura. */
export function revisarNoConfiable(def: ConectorDef): ConectorDef {
  if (def.via !== 'mcp') throw new ConectorInvalidoError('conector.via', 'los conectores propios son de vía mcp')
  const h = def.herramientas
  const grupos: [string, readonly string[]][] = [
    ['lista', h.lista],
    ['detalle', h.detalle],
    ['apoyo', h.apoyo ?? []],
    ...Object.entries(h.apoyoEn ?? {}).map(([a, xs]): [string, readonly string[]] => [`apoyoEn.${a}`, xs ?? []])
  ]
  for (const [g, xs] of grupos) {
    const i = xs.findIndex(esVerboEscritura)
    if (i >= 0) throw new ConectorInvalidoError(`conector.herramientas.${g}[${i}]`, `«${xs[i]}» parece de escritura: no puede ser de lectura`)
  }
  return { ...structuredClone(def), verificado: false }
}

export const validarPropio = (raw: unknown): ConectorDef => revisarNoConfiable(validarConector(raw))

export type Hash = (texto: string) => string

const esObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/** JSON con las claves ordenadas: el mismo conector da el mismo hash aunque cambie el orden. */
export function jsonCanonico(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(jsonCanonico).join(',')}]`
  if (esObj(v))
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${jsonCanonico(v[k])}`)
      .join(',')}}`
  return JSON.stringify(v)
}

export const claveAceptado = (repoKey: string, id: string): string => `${repoKey}::${id}`

const motivo = (e: unknown): string => (e instanceof Error ? e.message : 'inválido')

export function recortarAvisos(avisos: readonly string[]): string[] {
  return avisos.slice(0, AVISOS_MAX).map((a) => (a.length > AVISO_MAX ? `${a.slice(0, AVISO_MAX - 1)}…` : a))
}

const vacio = (): ArchivoPropios => ({ version: 1, conectores: [], aceptados: {} })

const sinPrototipos = (k: string, v: unknown): unknown => {
  if (PROHIBIDAS.includes(k)) throw new ConectorInvalidoError('conector', `clave no permitida «${k}»`)
  return v
}

export function parsearArchivoPropios(texto: string | null): { archivo: ArchivoPropios; corrupto: boolean; avisos: string[] } {
  if (texto === null) return { archivo: vacio(), corrupto: false, avisos: [] }
  let raw: unknown
  try {
    raw = JSON.parse(texto.replace(/^﻿/, ''), sinPrototipos)
  } catch {
    return { archivo: vacio(), corrupto: true, avisos: [] }
  }
  if (!esObj(raw) || raw.version !== 1) return { archivo: vacio(), corrupto: true, avisos: [] }
  const avisos: string[] = []
  const archivo = vacio()
  const entradas = Array.isArray(raw.conectores) ? raw.conectores : []
  for (const x of entradas) {
    try {
      const def = validarPropio(x)
      if (archivo.conectores.some((c) => c.id === def.id)) throw new Error(`el id «${def.id}» está repetido`)
      archivo.conectores.push(def)
    } catch (e) {
      avisos.push(`Un conector propio guardado no se cargó: ${motivo(e)}`)
    }
  }
  if (esObj(raw.aceptados))
    for (const [k, v] of Object.entries(raw.aceptados)) if (k.length <= CLAVE_ACEPTADO_MAX && typeof v === 'string' && HASH_RE.test(v)) archivo.aceptados[k] = v
  return { archivo, corrupto: false, avisos: recortarAvisos(avisos) }
}

export function armarRegistro(o: {
  incluidos: readonly ConectorDef[]
  usuario: readonly unknown[]
  equipos: readonly { repo: string; repoKey: string; equipo: string; conectores: readonly unknown[] }[]
  hash: Hash
}): { lista: ConectorRegistrado[]; avisos: string[] } {
  const avisos: string[] = []
  const lista: ConectorRegistrado[] = o.incluidos.map((def) => ({ def, origen: { tipo: 'incluido' }, hash: o.hash(jsonCanonico(def)) }))
  const origenDe = (id: string): OrigenConector['tipo'] | undefined => lista.find((r) => r.def.id === id)?.origen.tipo

  for (const raw of o.usuario.slice(0, PROPIOS_MAX)) {
    let def: ConectorDef
    try {
      def = validarPropio(raw)
    } catch (e) {
      avisos.push(`Un conector propio no se cargó: ${motivo(e)}`)
      continue
    }
    const choca = origenDe(def.id)
    if (choca === 'incluido') avisos.push(`El conector «${def.id}» usa el id de uno incluido: no se cargó.`)
    else if (choca) avisos.push(`El conector «${def.id}» está repetido: no se cargó.`)
    else lista.push({ def, origen: { tipo: 'usuario' }, hash: o.hash(jsonCanonico(def)) })
  }
  if (o.usuario.length > PROPIOS_MAX) avisos.push(`Hay más de ${PROPIOS_MAX} conectores propios: se cargaron los primeros ${PROPIOS_MAX}.`)

  const equipos = [...o.equipos].sort((a, b) => (a.repoKey < b.repoKey ? -1 : a.repoKey > b.repoKey ? 1 : 0))
  for (const e of equipos) {
    const del = `Del equipo ${e.equipo}: `
    if (e.conectores.length > EQUIPO_MAX) avisos.push(`${del}trae más de ${EQUIPO_MAX} conectores; se cargaron los primeros ${EQUIPO_MAX}.`)
    for (const raw of e.conectores.slice(0, EQUIPO_MAX)) {
      let def: ConectorDef
      try {
        def = validarPropio(raw)
      } catch (err) {
        avisos.push(`${del}un conector no se cargó: ${motivo(err)}`)
        continue
      }
      const hash = o.hash(jsonCanonico(def))
      const previo = lista.find((r) => r.def.id === def.id)
      // El mismo conector en otra copia del repo (p. ej. un worktree): no es un choque.
      if (previo?.origen.tipo === 'equipo' && previo.hash === hash) continue
      if (previo?.origen.tipo === 'incluido') avisos.push(`${del}«${def.id}» usa el id de uno incluido: no se cargó.`)
      else if (previo?.origen.tipo === 'usuario') avisos.push(`${del}«${def.id}» tiene el id de uno tuyo: no se cargó.`)
      else if (previo) avisos.push(`${del}«${def.id}» ya viene de otro repo o está repetido: no se cargó.`)
      else lista.push({ def, origen: { tipo: 'equipo', repo: e.repo, equipo: e.equipo }, hash })
    }
  }
  return { lista, avisos: recortarAvisos(avisos) }
}

/** El texto de un archivo `.sloth-conector.json`. Tira con un mensaje legible. */
export function parsearImport(texto: string): ConectorDef {
  if (new TextEncoder().encode(texto).length > IMPORT_MAX_BYTES) throw new Error(`El archivo pesa más de ${IMPORT_MAX_BYTES / 1024} KB.`)
  let raw: unknown
  try {
    raw = JSON.parse(texto.replace(/^﻿/, ''), sinPrototipos)
  } catch (e) {
    if (e instanceof ConectorInvalidoError) throw e
    throw new Error('El archivo no es un JSON válido.')
  }
  return validarPropio(raw)
}

export const textoExport = (def: ConectorDef): string => JSON.stringify(def, null, 2) + '\n'
