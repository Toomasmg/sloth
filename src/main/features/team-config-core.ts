/**
 * Configuración de equipo (`<repo>/.sloth/team.json`): validación estricta, hash de cambios,
 * plan para importar plantillas sin duplicar y armado del archivo para exportar.
 * Sin Electron a propósito (solo node:*): se prueba con Node y repos falsos.
 * Nunca ejecuta nada del archivo: solo lo lee y lo valida.
 */
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { applyVars, SUGGESTED, today, validBranch, varsIn } from './templates-core'
import { parseChatServerConfig, type ChatServerConfig } from './chat-config'

export const TEAM_FORMAT = 'sloth-team'
export const TEAM_VERSION = 1
export const TEAM_DIR = '.sloth'
export const TEAM_FILE = 'team.json'
export const MAX_TEAM_BYTES = 256 * 1024
const MAX_TEMPLATES = 50
const MAX_LINKS = 12
const VARS = ['ticket', 'ticketmin', 'fecha', 'n', 'plantilla']

/** Los mismos valores que la Configuración de Sloth (settings-model.ts). */
export type Density = 'compacta' | 'cómoda'
export const DENSITIES: readonly Density[] = ['compacta', 'cómoda']

export interface TeamTemplate {
  name: string
  /** Relativo a la raíz del repo: «.» o una subcarpeta (sin «..»). */
  repoPath: string
  /** Siempre «sugerida»: el archivo no sabe qué cuentas tiene cada uno. */
  cuenta: typeof SUGGESTED
  namePattern?: string
  initialPrompt?: string
  useWorktree?: { branchPattern: string }
  autoStartClaude: boolean
  resume: boolean
}

export interface TeamSettings {
  densidad?: Density
  /** Tamaño de letra de la terminal, en px. */
  tamañoTerminal?: number
}

export interface TeamLink {
  nombre: string
  url: string
}

export interface TeamConfig {
  formato: typeof TEAM_FORMAT
  versión: typeof TEAM_VERSION
  equipo: string
  plantillas: TeamTemplate[]
  ajustes?: TeamSettings
  links: TeamLink[]
  /** Chat del equipo: se usa solo si el usuario lo acepta (ver chat.ts). */
  chat?: ChatServerConfig
}

export class TeamConfigError extends Error {}

const fail = (msg: string): never => {
  throw new TeamConfigError(msg)
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/** Claves que no conocemos: error (las que empiezan con «_» o «$» son comentarios y se ignoran). */
function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(o)) {
    if (k.startsWith('_') || k.startsWith('$')) continue
    if (!allowed.includes(k)) fail(`${where}: no conozco la clave «${k}».`)
  }
}

function text(v: unknown, max: number, where: string, required = false): string | undefined {
  if (v === undefined || v === null) return required ? fail(`${where}: falta.`) : undefined
  if (typeof v !== 'string') return fail(`${where}: tiene que ser texto.`)
  const t = v.trim()
  if (!t) return required ? fail(`${where}: está vacío.`) : undefined
  if (t.length > max) fail(`${where}: es demasiado largo (máximo ${max}).`)
  // Sin caracteres de control (salvo saltos de línea y tab en los prompts).
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(t)) fail(`${where}: tiene caracteres de control.`)
  return t
}

function bool(v: unknown, where: string, def: boolean): boolean {
  if (v === undefined) return def
  if (typeof v !== 'boolean') fail(`${where}: tiene que ser true o false.`)
  return v as boolean
}

function checkVars(s: string | undefined, where: string): void {
  for (const v of varsIn(s)) if (!VARS.includes(v)) fail(`${where}: variable desconocida {${v}}. Usá {ticket}, {ticketmin}, {fecha}, {n} o {plantilla}.`)
}

/** Ruta relativa segura dentro del repo: «.», «apps/web»; nunca absoluta ni con «..». */
export function safeRelative(p: string): string | null {
  const s = p.replace(/\\/g, '/').trim()
  if (!s || s.length > 200) return null
  if (isAbsolute(s) || /^[A-Za-z]:/.test(s) || s.startsWith('/') || s.startsWith('~')) return null
  const parts = s.split('/').filter((x) => x && x !== '.')
  if (parts.some((x) => x === '..' || !/^[A-Za-z0-9._ -]+$/.test(x))) return null
  return parts.length ? parts.join('/') : '.'
}

/** https y nada más (los links se abren con shell.openExternal). */
export function safeHttpsUrl(u: unknown): string | null {
  if (typeof u !== 'string' || u.length > 500) return null
  try {
    const url = new URL(u.trim())
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

function parseTemplate(raw: unknown, i: number): TeamTemplate {
  const where = `plantillas[${i}]`
  if (!isObj(raw)) return fail(`${where}: tiene que ser un objeto.`)
  onlyKeys(raw, ['name', 'repoPath', 'cuenta', 'namePattern', 'initialPrompt', 'useWorktree', 'autoStartClaude', 'resume'], where)
  const name = text(raw.name, 80, `${where}.name`, true)!
  const label = `Plantilla «${name}»`
  const repoRaw = raw.repoPath === undefined ? '.' : text(raw.repoPath, 200, `${label}: repoPath`, true)!
  const repoPath = safeRelative(repoRaw) ?? fail(`${label}: repoPath tiene que ser relativo al repo («.» o una subcarpeta), sin rutas absolutas ni «..».`)
  if (raw.cuenta !== undefined && raw.cuenta !== SUGGESTED) fail(`${label}: cuenta tiene que ser «${SUGGESTED}» (el archivo es para todo el equipo).`)
  const namePattern = text(raw.namePattern, 120, `${label}: namePattern`)
  const initialPrompt = text(raw.initialPrompt, 4000, `${label}: initialPrompt`)
  checkVars(namePattern, `${label}: namePattern`)
  checkVars(initialPrompt, `${label}: initialPrompt`)
  let useWorktree: TeamTemplate['useWorktree']
  if (raw.useWorktree !== undefined && raw.useWorktree !== null && raw.useWorktree !== false) {
    if (!isObj(raw.useWorktree)) fail(`${label}: useWorktree tiene que ser { "branchPattern": "…" }.`)
    const w = raw.useWorktree as Record<string, unknown>
    onlyKeys(w, ['branchPattern'], `${label}: useWorktree`)
    const bp = text(w.branchPattern, 200, `${label}: branchPattern`, true)!
    checkVars(bp, `${label}: branchPattern`)
    const sample = applyVars(bp, { ticket: 'TCK-1', fecha: today(), n: 1, plantilla: name })
    if (!validBranch(sample)) fail(`${label}: la rama «${sample}» no es un nombre válido para git.`)
    useWorktree = { branchPattern: bp }
  }
  const t: TeamTemplate = {
    name,
    repoPath,
    cuenta: SUGGESTED,
    autoStartClaude: bool(raw.autoStartClaude, `${label}: autoStartClaude`, true),
    resume: bool(raw.resume, `${label}: resume`, true)
  }
  if (namePattern) t.namePattern = namePattern
  if (initialPrompt) t.initialPrompt = initialPrompt
  if (useWorktree) t.useWorktree = useWorktree
  return t
}

function parseSettings(raw: unknown): TeamSettings | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isObj(raw)) return fail('ajustes: tiene que ser un objeto.')
  onlyKeys(raw, ['densidad', 'tamañoTerminal'], 'ajustes')
  const out: TeamSettings = {}
  if (raw.densidad !== undefined) {
    if (!DENSITIES.includes(raw.densidad as Density)) fail(`ajustes.densidad: tiene que ser ${DENSITIES.map((d) => `«${d}»`).join(', ')}.`)
    out.densidad = raw.densidad as Density
  }
  if (raw.tamañoTerminal !== undefined) {
    const n = raw.tamañoTerminal
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 11 || n > 18) fail('ajustes.tamañoTerminal: tiene que ser un número entero entre 11 y 18.')
    out.tamañoTerminal = n as number
  }
  return Object.keys(out).length ? out : undefined
}

function parseLinks(raw: unknown): TeamLink[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) return fail('links: tiene que ser una lista.')
  if (raw.length > MAX_LINKS) fail(`links: como mucho ${MAX_LINKS}.`)
  return raw.map((l, i) => {
    const where = `links[${i}]`
    if (!isObj(l)) return fail(`${where}: tiene que ser { "nombre": "…", "url": "https://…" }.`)
    onlyKeys(l, ['nombre', 'url'], where)
    const nombre = text(l.nombre, 40, `${where}.nombre`, true)!
    const url = safeHttpsUrl(l.url) ?? fail(`Link «${nombre}»: la url tiene que empezar con https://.`)
    return { nombre, url }
  })
}

/** Valida el texto de un team.json. Tira TeamConfigError con un mensaje claro. */
export function parseTeamConfig(textIn: string): TeamConfig {
  if (typeof textIn !== 'string') fail('Archivo inválido.')
  if (Buffer.byteLength(textIn, 'utf8') > MAX_TEAM_BYTES) fail('El archivo pesa más de 256 KB.')
  let data: unknown
  try {
    // Sin prototipos: «__proto__» queda como clave común y después se rechaza por desconocida.
    data = JSON.parse(textIn.replace(/^﻿/, ''), (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? fail(`Clave no permitida: «${k}».`) : v))
  } catch (e) {
    if (e instanceof TeamConfigError) throw e
    fail('No es un JSON válido.')
  }
  if (!isObj(data)) return fail('El archivo tiene que ser un objeto JSON.')
  onlyKeys(data, ['formato', 'versión', 'equipo', 'plantillas', 'ajustes', 'links', 'chat'], 'team.json')
  if (data.formato !== TEAM_FORMAT) fail(`formato: tiene que ser «${TEAM_FORMAT}».`)
  if (data.versión !== TEAM_VERSION) fail(`versión: esta versión de Sloth entiende la ${TEAM_VERSION}. Actualizá Sloth.`)
  const equipo = text(data.equipo, 60, 'equipo', true)!
  if (data.plantillas !== undefined && !Array.isArray(data.plantillas)) fail('plantillas: tiene que ser una lista.')
  const rawT = (data.plantillas as unknown[] | undefined) ?? []
  if (rawT.length > MAX_TEMPLATES) fail(`plantillas: como mucho ${MAX_TEMPLATES}.`)
  const plantillas = rawT.map(parseTemplate)
  const seen = new Set<string>()
  for (const t of plantillas) {
    const k = t.name.toLowerCase()
    if (seen.has(k)) fail(`Hay dos plantillas «${t.name}».`)
    seen.add(k)
  }
  const cfg: TeamConfig = { formato: TEAM_FORMAT, versión: TEAM_VERSION, equipo, plantillas, links: parseLinks(data.links) }
  const ajustes = parseSettings(data.ajustes)
  if (ajustes) cfg.ajustes = ajustes
  if (data.chat !== undefined && data.chat !== null) {
    try {
      cfg.chat = parseChatServerConfig(data.chat)
    } catch (e) {
      fail(`chat: ${e instanceof Error ? e.message : 'configuración inválida.'}`)
    }
  }
  return cfg
}

/** JSON con las claves ordenadas: el mismo contenido da el mismo hash aunque cambie el formato. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (isObj(v))
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`
  return JSON.stringify(v)
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16)

/** Hash de las plantillas (lo que dispara «Hay plantillas nuevas del equipo»). */
export const templatesHash = (cfg: TeamConfig): string => sha(canonical(cfg.plantillas))
/** Hash de los ajustes recomendados (para no volver a sugerir lo que ya se aceptó o descartó). */
export const settingsHash = (cfg: TeamConfig): string | undefined => (cfg.ajustes ? sha(canonical(cfg.ajustes)) : undefined)

export const teamFilePath = (repo: string): string => join(repo, TEAM_DIR, TEAM_FILE)

/** Clave estable de un repo (Windows no distingue mayúsculas). */
export const repoKey = (repo: string): string => {
  const n = normalize(resolve(repo)).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? n.toLowerCase() : n
}

export type ReadResult =
  | { kind: 'none' }
  | { kind: 'invalid'; error: string }
  | { kind: 'ok'; config: TeamConfig; hash: string; settingsHash?: string; size: number; mtimeMs: number }

/** Lee y valida `<repo>/.sloth/team.json`. Lee por bloques y corta en 256 KB: nunca un archivo enorme entero. */
export function readTeamConfig(repo: string): ReadResult {
  const file = teamFilePath(repo)
  let st
  try {
    st = statSync(file)
  } catch {
    return { kind: 'none' }
  }
  if (!st.isFile()) return { kind: 'invalid', error: '.sloth/team.json no es un archivo.' }
  if (st.size > MAX_TEAM_BYTES) return { kind: 'invalid', error: 'El archivo pesa más de 256 KB.' }
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(MAX_TEAM_BYTES + 1)
    let n = 0
    for (;;) {
      const r = readSync(fd, buf, n, buf.length - n, null)
      if (r <= 0) break
      n += r
      if (n > MAX_TEAM_BYTES) return { kind: 'invalid', error: 'El archivo pesa más de 256 KB.' }
    }
    const config = parseTeamConfig(buf.subarray(0, n).toString('utf8'))
    return { kind: 'ok', config, hash: templatesHash(config), settingsHash: settingsHash(config), size: st.size, mtimeMs: st.mtimeMs }
  } catch (e) {
    return { kind: 'invalid', error: e instanceof TeamConfigError ? e.message : 'No se pudo leer el archivo.' }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// ---------- Importar plantillas sin duplicar ----------

/** Lo mínimo que necesitamos de las plantillas guardadas (templates.json). */
export interface ExistingTemplate {
  id: string
  name: string
  repoPath: string
  accountId: string
  namePattern?: string
  initialPrompt?: string
  useWorktree?: { branchPattern: string }
  autoStartClaude: boolean
  resume: boolean
}

export type PlanAction = 'new' | 'update' | 'same' | 'renamed'

export interface PlanItem {
  /** Nombre en el team.json (la identidad de la plantilla del equipo). */
  key: string
  action: PlanAction
  /** Lo que se le pasa a `feat:templates:save` (con `id` si actualiza). Falta si es «same». */
  payload?: Record<string, unknown>
  /** Id de la plantilla local si ya existe. */
  id?: string
  /** Nombre con el que queda guardada (cambia si chocaba con una plantilla tuya). */
  savedName: string
  error?: string
}

export interface ImportPlan {
  equipo: string
  hash: string
  items: PlanItem[]
  /** Plantillas que importaste antes y el equipo ya no tiene (no se borran). */
  orphans: string[]
}

const sameContent = (a: ExistingTemplate, b: Record<string, unknown>): boolean =>
  a.name === b.name &&
  repoKey(a.repoPath) === repoKey(String(b.repoPath)) &&
  a.accountId === b.accountId &&
  (a.namePattern ?? '') === (b.namePattern ?? '') &&
  (a.initialPrompt ?? '') === (b.initialPrompt ?? '') &&
  (a.useWorktree?.branchPattern ?? '') === ((b.useWorktree as { branchPattern?: string } | undefined)?.branchPattern ?? '') &&
  a.autoStartClaude === b.autoStartClaude &&
  a.resume === b.resume

/** La carpeta absoluta de una plantilla del equipo; se asegura de que quede dentro del repo. */
export function resolveTeamRepo(repo: string, rel: string): string | null {
  const safe = safeRelative(rel)
  if (!safe) return null
  const abs = resolve(repo, safe === '.' ? '' : safe)
  const r = relative(resolve(repo), abs)
  if (r.startsWith('..') || isAbsolute(r) || r.split(sep).includes('..')) return null
  return abs
}

/**
 * Qué hacer con cada plantilla del equipo. `mapping`: nombre en el team.json (minúsculas) → id local
 * de lo que se importó antes. Nunca duplica: actualiza la que ya importaste, adopta una tuya idéntica,
 * y si una tuya distinta usa el mismo nombre, guarda la del equipo como «Nombre (equipo)».
 */
export function planImport(
  cfg: TeamConfig,
  repo: string,
  existing: readonly ExistingTemplate[],
  mapping: Readonly<Record<string, string>>,
  dirExists: (p: string) => boolean = (p) => existsSync(p) && statSync(p).isDirectory()
): ImportPlan {
  const byId = new Map(existing.map((t) => [t.id, t]))
  const mappedIds = new Set(Object.values(mapping))
  const taken = (name: string, exceptId?: string): ExistingTemplate | undefined =>
    existing.find((t) => t.id !== exceptId && t.name.toLowerCase() === name.toLowerCase())
  const items: PlanItem[] = []
  const reserved = new Set<string>()
  for (const t of cfg.plantillas) {
    const key = t.name.toLowerCase()
    const abs = resolveTeamRepo(repo, t.repoPath)
    if (!abs || !dirExists(abs)) {
      items.push({ key, action: 'new', savedName: t.name, error: `La carpeta «${t.repoPath}» no existe en este repo.` })
      continue
    }
    const base: Record<string, unknown> = {
      name: t.name,
      repoPath: abs,
      accountId: SUGGESTED,
      namePattern: t.namePattern,
      initialPrompt: t.initialPrompt,
      useWorktree: t.useWorktree ? { ...t.useWorktree } : undefined,
      autoStartClaude: t.autoStartClaude,
      resume: t.resume
    }
    const prevId = mapping[key]
    const prev = prevId ? byId.get(prevId) : undefined
    if (prev) {
      // Ya importada: conserva el nombre con el que quedó (puede ser «X (equipo)»).
      const payload = { ...base, name: prev.name, id: prev.id }
      reserved.add(prev.name.toLowerCase())
      items.push({ key, id: prev.id, savedName: prev.name, action: sameContent(prev, payload) ? 'same' : 'update', payload: sameContent(prev, payload) ? undefined : payload })
      continue
    }
    const clash = taken(t.name)
    if (clash && !mappedIds.has(clash.id) && sameContent(clash, base)) {
      // Una tuya idéntica: se adopta como del equipo (sin duplicar).
      reserved.add(clash.name.toLowerCase())
      items.push({ key, id: clash.id, savedName: clash.name, action: 'same' })
      continue
    }
    if (clash || reserved.has(key)) {
      let alt = `${t.name} (equipo)`.slice(0, 80)
      for (let i = 2; taken(alt) || reserved.has(alt.toLowerCase()); i++) alt = `${t.name} (equipo ${i})`.slice(0, 80)
      reserved.add(alt.toLowerCase())
      items.push({ key, action: 'renamed', savedName: alt, payload: { ...base, name: alt } })
      continue
    }
    reserved.add(key)
    items.push({ key, action: 'new', savedName: t.name, payload: base })
  }
  const keys = new Set(cfg.plantillas.map((t) => t.name.toLowerCase()))
  const orphans = Object.entries(mapping)
    .filter(([k, id]) => !keys.has(k) && byId.has(id))
    .map(([, id]) => byId.get(id)!.name)
  return { equipo: cfg.equipo, hash: templatesHash(cfg), items, orphans }
}

// ---------- Exportar mi configuración como la del equipo ----------

/** Rutas absolutas o correos dentro de un texto (no tienen que salir en el archivo del equipo). */
export function personalData(s: string | undefined): string | null {
  if (!s) return null
  if (/(^|[\s"'`(=])([A-Za-z]:[\\/]|\\\\[^\\\s]+\\)/.test(s)) return 'una ruta absoluta'
  if (/(^|[\s"'`(=])\/(Users|home|mnt|var|opt|tmp)\//.test(s)) return 'una ruta absoluta'
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(s)) return 'un correo'
  return null
}

export interface ExportInput {
  equipo: unknown
  links?: unknown
  ajustes?: unknown
  /** Nombres de plantillas elegidas (si falta, todas las del repo). */
  include?: unknown
}

export interface ExportResult {
  config: TeamConfig
  text: string
  /** Plantillas que quedaron afuera y por qué. */
  skipped: { name: string; reason: string }[]
}

/**
 * Arma el team.json desde mis plantillas que apuntan a este repo (o a una subcarpeta).
 * Sin cuentas (todas «sugerida»), sin rutas absolutas, sin ids, contadores ni fechas.
 */
export function buildTeamExport(repo: string, templates: readonly ExistingTemplate[], input: ExportInput): ExportResult {
  const equipo = text(input.equipo, 60, 'El nombre del equipo', true)!
  const include =
    input.include === undefined ? null : Array.isArray(input.include) ? new Set(input.include.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase())) : fail('Selección inválida.')
  const root = repoKey(repo)
  const skipped: ExportResult['skipped'] = []
  const plantillas: TeamTemplate[] = []
  for (const t of templates) {
    const k = repoKey(t.repoPath)
    if (k !== root && !k.startsWith(root + sep)) continue
    if (include && !include.has(t.name.toLowerCase())) continue
    const rel = relative(resolve(repo), resolve(t.repoPath)).split(sep).join('/') || '.'
    const safe = safeRelative(rel)
    if (!safe) {
      skipped.push({ name: t.name, reason: 'su carpeta no está dentro del repo' })
      continue
    }
    const bad = personalData(t.initialPrompt) ?? personalData(t.namePattern) ?? personalData(t.useWorktree?.branchPattern)
    if (bad) {
      skipped.push({ name: t.name, reason: `tiene ${bad} en el prompt o en el nombre` })
      continue
    }
    const out: TeamTemplate = { name: t.name, repoPath: safe, cuenta: SUGGESTED, autoStartClaude: t.autoStartClaude !== false, resume: t.resume !== false }
    if (t.namePattern) out.namePattern = t.namePattern
    if (t.initialPrompt) out.initialPrompt = t.initialPrompt
    if (t.useWorktree?.branchPattern) out.useWorktree = { branchPattern: t.useWorktree.branchPattern }
    plantillas.push(out)
  }
  const draft = { formato: TEAM_FORMAT, versión: TEAM_VERSION, equipo, plantillas, ajustes: input.ajustes ?? undefined, links: input.links ?? [] }
  // Se valida con el mismo parser que la importación: lo que se exporta siempre se puede importar.
  const textOut = JSON.stringify(draft, null, 2) + '\n'
  const config = parseTeamConfig(textOut)
  return { config, text: JSON.stringify(config, null, 2) + '\n', skipped }
}
