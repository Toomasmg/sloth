/**
 * Conectores que no vienen con Sloth: los que arma la persona y los que trae el .sloth/conectores.json de un
 * repo. Pasan por el mismo validador que los incluidos y además nunca son «verificados» ni pueden
 * leer con una herramienta que no parezca de lectura.
 * Módulo puro y sin `node:*`: también lo importa la interfaz. El hash se inyecta desde main.
 */
import { ACCIONES, type HerramientasVista, type OrigenConector } from '../../../shared/tickets'
import { ConectorInvalidoError, validarConector, type ConectorDef, type ConectorMcp } from './conector'
import { permisosPorConsulta } from './motor'

export interface ConectorRegistrado {
  def: ConectorDef
  origen: OrigenConector
  hash: string
  /** Del equipo: las claves (repoKey) de las otras copias del repo con el mismo conector, p. ej. worktrees. */
  otrosRepos?: string[]
}

export interface ArchivoPropios {
  version: 1
  conectores: ConectorDef[]
  /** `claveAceptado(repoKey, id)` → hash de la versión del conector del equipo que la persona aceptó. */
  aceptados: Record<string, string>
  /** Los que no validan (de otra versión de Sloth o tocados a mano), tal cual: no se borran al guardar y se reintentan al leer. */
  apartados: unknown[]
}

export const PROPIOS_MAX = 30
export const EQUIPO_MAX = 10
export const IMPORT_MAX_BYTES = 64 * 1024
/** `<repo>/.sloth/conectores.json`: aparte del team.json para que las versiones viejas de Sloth no lo rechacen entero. */
export const EQUIPO_ARCHIVO = 'conectores.json'
export const EQUIPO_FORMATO = 'sloth-conectores'
export const EQUIPO_MAX_BYTES = 256 * 1024

const AVISO_MAX = 200
const AVISOS_MAX = 10
const CLAVE_ACEPTADO_MAX = 1100
const HASH_RE = /^[0-9a-f]{16}$/
const PROHIBIDAS = ['__proto__', 'constructor', 'prototype']

// Heurística, no garantía: una herramienta de lectura tiene que tener alguna parte de LECTURA y
// ninguna de ESCRITURA. Lo que no se reconoce como lectura se trata como escritura.
const LECTURA = new Set(['get', 'list', 'search', 'find', 'fetch', 'read', 'query', 'lookup', 'view', 'show', 'describe', 'count', 'filter', 'info', 'whoami', 'retrieve', 'listar', 'ver', 'buscar', 'leer', 'obtener', 'consultar', 'traer', 'mostrar'])
const ESCRITURA = new Set([
  'create', 'update', 'delete', 'remove', 'add', 'edit', 'set', 'move', 'transition', 'assign', 'unassign', 'save', 'post', 'put', 'patch', 'write', 'close', 'reopen', 'merge', 'upload', 'send', 'archive', 'complete', 'toggle', 'log', 'duplicate',
  'execute', 'exec', 'run', 'push', 'fork', 'bulk', 'publish', 'submit', 'import', 'invite', 'share', 'approve', 'reject', 'cancel', 'trigger', 'deploy', 'rollback', 'rename', 'insert', 'upsert', 'drop', 'batch', 'replace', 'dismiss',
  'destroy', 'trash', 'purge', 'revoke', 'grant', 'restore', 'reset', 'clear', 'mark', 'modify', 'mutate', 'apply', 'sync', 'transfer', 'attach', 'detach', 'enable', 'disable', 'notify', 'subscribe', 'unsubscribe', 'vote', 'pin', 'unpin',
  'crear', 'actualizar', 'borrar', 'eliminar', 'agregar', 'mover', 'asignar', 'cerrar', 'editar', 'guardar', 'enviar', 'comentar', 'cargar', 'tildar', 'tomar', 'soltar', 'cambiar', 'subir', 'publicar', 'ejecutar'
])

/** `getJiraIssue` → get, jira, issue; `jira_create_issue` → jira, create, issue. */
export function partes(corto: string): string[] {
  return corto
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean)
}

export function pareceDeLectura(corto: string): boolean {
  const xs = partes(corto)
  return xs.some((x) => LECTURA.has(x)) && !xs.some((x) => ESCRITURA.has(x))
}

/** Copia con `verificado: false`. Tira si no es de vía mcp o si lee con algo que no parece de lectura. */
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
    const i = xs.findIndex((x) => !pareceDeLectura(x))
    if (i >= 0) throw new ConectorInvalidoError(`conector.herramientas.${g}[${i}]`, `«${xs[i]}» no parece de lectura: no puede leer`)
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

/** Las claves a guardar al aceptar: una por copia del repo, así borrar un worktree no deshace la aceptación. */
export function clavesAceptadas(r: ConectorRegistrado, repoKey: (repo: string) => string): string[] {
  if (r.origen.tipo !== 'equipo') return []
  return [repoKey(r.origen.repo), ...(r.otrosRepos ?? [])].map((k) => claveAceptado(k, r.def.id))
}

/** Uno del equipo vale si se aceptó esta misma versión desde cualquiera de las copias del repo. */
export function estaAceptado(r: ConectorRegistrado, aceptados: Readonly<Record<string, string>>, repoKey: (repo: string) => string): boolean {
  if (r.origen.tipo !== 'equipo') return true
  const claves = [repoKey(r.origen.repo), ...(r.otrosRepos ?? [])]
  return claves.some((k) => aceptados[claveAceptado(k, r.def.id)] === r.hash)
}

const motivo = (e: unknown): string => (e instanceof Error ? e.message : 'inválido')

export function recortarAvisos(avisos: readonly string[]): string[] {
  return avisos.slice(0, AVISOS_MAX).map((a) => (a.length > AVISO_MAX ? `${a.slice(0, AVISO_MAX - 1)}…` : a))
}

const vacio = (): ArchivoPropios => ({ version: 1, conectores: [], aceptados: {}, apartados: [] })

const sinPrototipos = (k: string, v: unknown): unknown => {
  if (PROHIBIDAS.includes(k)) throw new ConectorInvalidoError('conector', `clave no permitida «${k}»`)
  return v
}

export interface LecturaPropios {
  archivo: ArchivoPropios
  /** No se entiende: se aparta el archivo entero. */
  corrupto: boolean
  /** De una versión más nueva de Sloth: no se toca ni se aparta. */
  futuro: boolean
  avisos: string[]
}

export function parsearArchivoPropios(texto: string | null): LecturaPropios {
  const nada = { archivo: vacio(), corrupto: false, futuro: false, avisos: [] }
  if (texto === null) return nada
  let raw: unknown
  try {
    raw = JSON.parse(texto.replace(/^﻿/, ''), sinPrototipos)
  } catch {
    return { ...nada, corrupto: true }
  }
  if (esObj(raw) && typeof raw.version === 'number' && raw.version > 1)
    return { ...nada, futuro: true, avisos: ['Tus conectores propios son de una versión más nueva de Sloth: actualizá Sloth. Mientras, no se pueden cambiar.'] }
  if (!esObj(raw) || raw.version !== 1) return { ...nada, corrupto: true }
  const avisos: string[] = []
  const archivo = vacio()
  const entradas = [...(Array.isArray(raw.conectores) ? raw.conectores : []), ...(Array.isArray(raw.apartados) ? raw.apartados : [])]
  for (const x of entradas) {
    try {
      const def = validarPropio(x)
      if (archivo.conectores.some((c) => c.id === def.id)) throw new Error(`el id «${def.id}» está repetido`)
      archivo.conectores.push(def)
    } catch (e) {
      if (archivo.apartados.length >= PROPIOS_MAX) {
        avisos.push(`Hay más de ${PROPIOS_MAX} conectores propios que no se cargan: los que sobran se pierden al guardar.`)
        continue
      }
      archivo.apartados.push(x)
      const id = esObj(x) && typeof x.id === 'string' ? `«${x.id.slice(0, 32)}» ` : ''
      avisos.push(`Tu conector ${id}no se cargó (${motivo(e)}). Quedó guardado aparte en el archivo: no se borra.`)
    }
  }
  if (esObj(raw.aceptados))
    for (const [k, v] of Object.entries(raw.aceptados)) if (k.length <= CLAVE_ACEPTADO_MAX && typeof v === 'string' && HASH_RE.test(v)) archivo.aceptados[k] = v
  return { ...nada, archivo, avisos: recortarAvisos([...new Set(avisos)]) }
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
      if (previo?.origen.tipo === 'equipo' && previo.hash === hash) {
        previo.otrosRepos = [...(previo.otrosRepos ?? []), e.repoKey]
        continue
      }
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

/** El texto de `.sloth/conectores.json`: la lista cruda, que después pasa por `armarRegistro`. Tira con un mensaje legible. */
export function parsearConectoresEquipo(texto: string): unknown[] {
  if (new TextEncoder().encode(texto).length > EQUIPO_MAX_BYTES) throw new Error(`pesa más de ${EQUIPO_MAX_BYTES / 1024} KB.`)
  let raw: unknown
  try {
    raw = JSON.parse(texto.replace(/^﻿/, ''), sinPrototipos)
  } catch (e) {
    if (e instanceof ConectorInvalidoError) throw new Error(e.message)
    throw new Error('no es un JSON válido.')
  }
  if (!esObj(raw)) throw new Error('tiene que ser un objeto JSON.')
  for (const k of Object.keys(raw)) {
    if (k.startsWith('_') || k.startsWith('$')) continue
    if (!['formato', 'versión', 'conectores'].includes(k)) throw new Error(`no conozco la clave «${k}».`)
  }
  if (raw.formato !== EQUIPO_FORMATO) throw new Error(`formato: tiene que ser «${EQUIPO_FORMATO}».`)
  if (raw.versión !== 1) throw new Error('versión: esta versión de Sloth entiende la 1. Actualizá Sloth.')
  if (!Array.isArray(raw.conectores)) throw new Error('conectores: tiene que ser una lista.')
  if (raw.conectores.length > EQUIPO_MAX) throw new Error(`conectores: como mucho ${EQUIPO_MAX}.`)
  return raw.conectores
}

export const textoExport = (def: ConectorDef): string => JSON.stringify(def, null, 2) + '\n'

/** Lo que se muestra antes de aceptar o guardar un conector que no armó la persona: sale de lo mismo que usa el motor. */
export function vistaHerramientas(def: ConectorMcp): HerramientasVista {
  const h = def.herramientas
  const p = def.pistas
  const permisos = permisosPorConsulta(def)
  const acciones: HerramientasVista['pistas']['acciones'] = {}
  for (const a of ACCIONES) {
    const x = p.acciones[a]
    if (x) acciones[a] = { args: JSON.stringify(x.args), ...(x.nota ? { nota: x.nota } : {}) }
  }
  return {
    prefijo: h.prefijo,
    lista: permisos.lista,
    detalle: permisos.detalle,
    acciones: permisos.acciones,
    escritura: { ...h.escritura },
    negar: h.negar.length,
    pistas: {
      yoConId: p.yo.conId,
      yoSinId: p.yo.sinId,
      lista: p.lista,
      ...(p.estados !== undefined ? { estados: p.estados } : {}),
      ...(p.apoyo !== undefined ? { apoyo: p.apoyo } : {}),
      detalle: p.detalle.map((x) => `${x.herramienta} ${JSON.stringify(x.args)}`),
      acciones
    }
  }
}
