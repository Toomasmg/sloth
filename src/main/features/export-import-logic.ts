/**
 * Lógica pura de exportar/importar la configuración (sin electron: se prueba con Node).
 *
 * Formato 2 (`.sloth`, o `.json` sin cifrar): {formato, formatoVersion: 2, versión, exportado, ...grupos}.
 * Grupos: espacios (+ cuentas que usan, con su plan), plantillas, apariencia (tema, densidad, tamaño y
 * color de acento), atajos (solo los cambiados), equipo (solo la URL de Supabase) y permisos (las
 * reglas «Permitir siempre» de Sloth de cada espacio, en `permissions.json`). Con contraseña, el archivo
 * es {formato, formatoVersion, versión, exportado, cifrado, datos} (ver export-crypto.ts).
 *
 * Todos los campos nuevos son opcionales: los archivos viejos se leen igual. Formato 1 (sin
 * formatoVersion, las listas `cuentas`/`espacios` con name/repoPath) también se sigue leyendo.
 * El archivo NUNCA lleva configDir, ids internos, credenciales, tokens, sesiones ni transcripts.
 * Las reglas nunca se escriben en la configuración de Claude: solo se agregan a las de Sloth.
 */
import type { Account, Workspace } from '../../shared/types'
import { TEMPLATE_COLOR_KEYS } from '../../shared/templates-shared'
import { normalizeSupabaseUrl } from './chat-config'
import { ACCENTS, ACCOUNT_PALETTE, DENSITIES, THEMES, UI_FONT, SHORTCUT_IDS, canonicalCombo, type AccentChoice } from './settings-model'
import { decryptText, type Encrypted, WRONG_PASSWORD } from './export-crypto'
import { checkRule, FILE_EDIT_TOOLS, type PermissionKind, type RuleDraft } from './permissions-core'

export const FORMAT = 'sloth-config'
export const FORMAT_VERSION = 2
export const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_RULES = 500
const MAX_PLAN_LEN = 20

export interface ExportedAccount {
  label: string
  shareSetup: boolean
  /** Plan escrito a mano («Pro», «Max»…). Es una etiqueta: nunca sale de credenciales. */
  plan?: string
}
export interface ExportedSpace {
  nombre: string
  ruta: string
  /** Hex de la paleta de cuentas (el color de la cuenta asignada). */
  color?: string
  /** Color propio del espacio (TEMPLATE_COLOR_KEYS: cielo, hoja, lila, ambar, coral). */
  colorEspacio?: string
  cuenta: string
}
/** Plantilla sin ids locales: la cuenta va por nombre (sin `cuenta` = «sugerida»). */
export interface ExportedTemplate {
  name: string
  repoPath: string
  cuenta?: string
  namePattern?: string
  initialPrompt?: string
  useWorktree?: { branchPattern: string }
  autoStartClaude: boolean
  resume: boolean
}
/** Una regla «Permitir siempre» de Sloth: tipo, herramienta y comando/dominio/«*» exacto. */
export interface ExportedRule {
  kind: PermissionKind
  tool: string
  match: string
}
export interface ExportedPermissions {
  espacio: string
  ruta: string
  reglas: ExportedRule[]
}
export interface ExportedAppearance {
  theme?: string
  density?: string
  uiFontSize?: number
  accent?: string
  lightMode?: boolean
}
export interface ExportDoc {
  formato: typeof FORMAT
  formatoVersion: number
  versión: string
  exportado: string
  cuentas?: ExportedAccount[]
  espacios?: ExportedSpace[]
  plantillas?: ExportedTemplate[]
  apariencia?: ExportedAppearance
  atajos?: Record<string, string>
  equipo?: { supabaseUrl: string }
  permisos?: ExportedPermissions[]
}

export type SectionId = 'espacios' | 'plantillas' | 'apariencia' | 'atajos' | 'equipo' | 'permisos'
export const SECTIONS: readonly SectionId[] = ['espacios', 'plantillas', 'apariencia', 'atajos', 'equipo', 'permisos']

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/** Plantillas en formato del archivo, a partir de templates.json (ya validado por la función «templates»). */
export function exportTemplates(raw: unknown, accounts: readonly Account[]): ExportedTemplate[] {
  const labelOf = new Map(accounts.map((a) => [a.id, a.label]))
  return (templateList(raw) ?? []).flatMap((t) => {
    if (!isObj(t) || typeof t.name !== 'string' || typeof t.repoPath !== 'string') return []
    const e: ExportedTemplate = {
      name: t.name,
      repoPath: t.repoPath,
      autoStartClaude: t.autoStartClaude !== false,
      resume: t.resume !== false
    }
    const label = typeof t.accountId === 'string' ? labelOf.get(t.accountId) : undefined
    if (label) e.cuenta = label
    if (typeof t.namePattern === 'string' && t.namePattern) e.namePattern = t.namePattern
    if (typeof t.initialPrompt === 'string' && t.initialPrompt) e.initialPrompt = t.initialPrompt
    if (isObj(t.useWorktree) && typeof t.useWorktree.branchPattern === 'string') e.useWorktree = { branchPattern: t.useWorktree.branchPattern }
    return [e]
  })
}

/** Espacios del archivo: ruta, nombre, colores y cuenta asignada (ni ids ni ramas ni prompts). */
export function exportSpaces(workspaces: readonly Workspace[], accounts: readonly Account[], colorOf: (accountId: string) => string | undefined): ExportedSpace[] {
  const labelOf = new Map(accounts.map((a) => [a.id, a.label]))
  return workspaces.flatMap((w) => {
    const cuenta = labelOf.get(w.accountId)
    if (!cuenta) return []
    const e: ExportedSpace = { nombre: w.name, ruta: w.repoPath, cuenta }
    const color = colorOf(w.accountId)
    if (color) e.color = color
    if (w.color && (TEMPLATE_COLOR_KEYS as readonly string[]).includes(w.color)) e.colorEspacio = w.color
    return [e]
  })
}

/** Reglas de Sloth (permissions.json) de cada espacio, ya validadas. Sin `on: false` ni reglas inválidas. */
export function exportRules(rules: readonly unknown[], workspaces: readonly Workspace[]): ExportedPermissions[] {
  return workspaces.flatMap((w) => {
    const reglas: ExportedRule[] = []
    for (const r of rules) {
      if (!isObj(r) || r.workspaceId !== w.id || r.on === false) continue
      const c = checkRule(r)
      if (c.ok) reglas.push({ kind: c.rule.kind, tool: c.rule.tool, match: c.rule.match })
    }
    return reglas.length ? [{ espacio: w.name, ruta: w.repoPath, reglas }] : []
  })
}

/** Tamaño aproximado (KB) de cada grupo, medido con el JSON que se escribiría. */
export function sectionSizes(doc: ExportDoc): Record<SectionId, number> {
  const kb = (v: unknown): number => (v === undefined ? 0 : Buffer.byteLength(JSON.stringify(v), 'utf8') / 1024)
  return {
    espacios: kb({ cuentas: doc.cuentas, espacios: doc.espacios }),
    plantillas: kb(doc.plantillas),
    apariencia: kb(doc.apariencia),
    atajos: kb(doc.atajos),
    equipo: kb(doc.equipo),
    permisos: kb(doc.permisos)
  }
}

export const fmtKb = (kb: number): string => (kb <= 0 ? '0 KB' : kb < 1 ? '< 1 KB' : '≈ ' + Math.round(kb) + ' KB')

// ---------- Lectura ----------

const str = (o: Record<string, unknown>, key: string, where: string, max: number, required: boolean): string | undefined => {
  const v = o[key]
  if (v === undefined || v === null || v === '') {
    if (required) throw new Error(`${where}: falta «${key}».`)
    return undefined
  }
  if (typeof v !== 'string') throw new Error(`${where}: «${key}» tiene que ser texto.`)
  const t = v.trim()
  if (required && !t) throw new Error(`${where}: falta «${key}».`)
  if (t.length > max) throw new Error(`${where}: «${key}» es demasiado largo.`)
  return t || undefined
}

const bool = (o: Record<string, unknown>, key: string, def: boolean): boolean => (typeof o[key] === 'boolean' ? (o[key] as boolean) : def)

/** Plan de cuenta del archivo: texto corto y sin controles; si no es válido, se ignora. */
const planOf = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t && t.length <= MAX_PLAN_LEN && !/[\u0000-\u001f]/.test(t) ? t : undefined
}

/** Lista de plantillas, acepte el archivo un array o un objeto con `templates`/`plantillas`. */
export function templateList(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw
  if (isObj(raw)) {
    if (Array.isArray(raw.templates)) return raw.templates
    if (Array.isArray(raw.plantillas)) return raw.plantillas
  }
  return null
}

export const templateName = (t: unknown): string | undefined => {
  if (!isObj(t)) return undefined
  const n = t.name ?? t.nombre ?? t.title
  return typeof n === 'string' && n.trim() ? n.trim() : undefined
}

export interface ParsedSpace extends ExportedSpace {
  /** Formato 1 con worktree: la carpeta del worktree (sin ella no se puede importar). */
  sinCarpeta?: boolean
  autoStartClaude: boolean
  resume: boolean
  initialPrompt?: string
  ticket?: string
}

/** Una regla del archivo, ya revisada. `texto` es lo que se muestra (comando, dominio…). */
export interface ParsedRule {
  texto: string
  valida: boolean
  motivo?: string
  draft?: RuleDraft
}
export interface ParsedPermiso {
  espacio: string
  ruta: string
  reglas: ParsedRule[]
}

export interface ParsedImport {
  version: string
  formatoVersion: number
  cuentas: ExportedAccount[]
  espacios: ParsedSpace[]
  plantillas: ExportedTemplate[]
  apariencia?: ExportedAppearance
  /** Atajos cambiados: id → combinación canónica. Solo los ids y combinaciones válidos. */
  atajos?: Record<string, string>
  equipo?: string
  permisos: ParsedPermiso[]
}

/** Qué contiene el texto: JSON en claro o archivo cifrado (hay que pedir la contraseña). */
export type Envelope = { kind: 'plano'; text: string } | { kind: 'cifrado'; encrypted: Encrypted; version: string }

/** Lee el sobre: si está cifrado, devuelve el bloque para descifrar; si no, el JSON tal cual. */
export function readEnvelope(text: string): Envelope {
  let data: unknown
  try {
    data = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    throw new Error('El archivo no es un JSON válido.')
  }
  if (!isObj(data) || data.formato !== FORMAT) throw new Error('No es una configuración exportada de Sloth (falta formato «sloth-config»).')
  if (isObj(data.cifrado)) {
    if (typeof data.datos !== 'string') throw new Error('El archivo cifrado está dañado.')
    return {
      kind: 'cifrado',
      encrypted: { cifrado: data.cifrado as unknown as Encrypted['cifrado'], datos: data.datos },
      version: typeof data['versión'] === 'string' ? (data['versión'] as string) : '?'
    }
  }
  return { kind: 'plano', text }
}

/** Descifra el sobre con la contraseña; devuelve el texto del JSON. */
export function openEnvelope(env: Extract<Envelope, { kind: 'cifrado' }>, password: string): string {
  if (!password) throw new Error(WRONG_PASSWORD)
  return decryptText(env.encrypted, password)
}

/**
 * Regla en el formato que usaba Sloth antes (texto de Claude: `Bash(npm test)`, `WebFetch(domain:x)`,
 * `Edit`, `mcp__s__t`). Solo se convierte lo que Sloth podría guardar igual: nada que amplíe el permiso
 * (una edición limitada a rutas, o «Bash» sin comando, no se importa).
 */
function fromTextRule(text: string): { ok: true; raw: unknown } | { ok: false; motivo: string } {
  const m = /^([A-Za-z_][\w.:-]*)(?:\((.*)\))?$/s.exec(text.trim())
  if (!m) return { ok: false, motivo: 'formato no reconocido' }
  const [, name, arg] = m
  if (name === 'Bash') {
    return arg === undefined
      ? { ok: false, motivo: 'regla general de comandos: Sloth solo guarda comandos exactos' }
      : { ok: true, raw: { kind: 'cmd', tool: 'Bash', match: arg } }
  }
  if (name === 'WebFetch') {
    return arg?.startsWith('domain:')
      ? { ok: true, raw: { kind: 'net', tool: 'WebFetch', match: arg.slice('domain:'.length) } }
      : { ok: false, motivo: 'Sloth solo guarda dominios de WebFetch' }
  }
  if (FILE_EDIT_TOOLS.has(name)) {
    return arg === undefined ? { ok: true, raw: { kind: 'edit', tool: name, match: '*' } } : { ok: false, motivo: 'limitada a rutas: Sloth no la importa' }
  }
  if (name.startsWith('mcp__') && arg === undefined) return { ok: true, raw: { kind: 'other', tool: name, match: '*' } }
  return { ok: false, motivo: 'Sloth no maneja esa herramienta' }
}

/** Una regla del archivo: objeto de Sloth o texto de la versión anterior. Siempre pasa por checkRule. */
function parseRule(item: unknown): ParsedRule {
  const shown = (typeof item === 'string' ? item : JSON.stringify(item) ?? '').slice(0, 200)
  let raw: unknown = item
  if (typeof item === 'string') {
    const conv = fromTextRule(item)
    if (!conv.ok) return { texto: shown, valida: false, motivo: conv.motivo }
    raw = conv.raw
  }
  const c = checkRule(raw)
  if (!c.ok) return { texto: shown, valida: false, motivo: c.motivo }
  return { texto: c.rule.label, valida: true, draft: c.rule }
}

export function parseImport(text: string): ParsedImport {
  let data: unknown
  try {
    data = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    throw new Error('El archivo no es un JSON válido.')
  }
  if (!isObj(data) || data.formato !== FORMAT) throw new Error('No es una configuración exportada de Sloth (falta formato «sloth-config»).')
  const formatoVersion = typeof data.formatoVersion === 'number' ? data.formatoVersion : 1
  if (formatoVersion > FORMAT_VERSION) throw new Error('Este archivo es de una versión más nueva de Sloth. Actualizá Sloth para importarlo.')
  const version = typeof data['versión'] === 'string' ? (data['versión'] as string) : '?'

  const rawAcc = data.cuentas ?? []
  const rawWs = data.espacios ?? []
  if (!Array.isArray(rawAcc) || !Array.isArray(rawWs)) throw new Error('«cuentas» y «espacios» tienen que ser listas.')
  if (rawAcc.length > 100) throw new Error('Demasiadas cuentas en el archivo.')
  if (rawWs.length > 500) throw new Error('Demasiados espacios en el archivo.')

  const cuentas: ExportedAccount[] = []
  const seen = new Set<string>()
  rawAcc.forEach((a, i) => {
    const where = `Cuenta ${i + 1}`
    if (!isObj(a)) throw new Error(`${where}: formato inválido.`)
    const label = str(a, 'label', where, 80, true)!
    const k = label.toLowerCase()
    if (seen.has(k)) return
    seen.add(k)
    const c: ExportedAccount = { label, shareSetup: bool(a, 'shareSetup', true) }
    const plan = planOf(a.plan)
    if (plan) c.plan = plan
    cuentas.push(c)
  })

  const espacios: ParsedSpace[] = rawWs.map((w, i) => {
    const where = `Espacio ${i + 1}`
    if (!isObj(w)) throw new Error(`${where}: formato inválido.`)
    // Formato 2: nombre/ruta. Formato 1: name/repoPath (y con branch, la carpeta del worktree).
    const nombre = str(w, 'nombre', where, 120, false) ?? str(w, 'name', where, 120, true)!
    const cuenta = str(w, 'cuenta', where, 80, true)!
    const e: ParsedSpace = { nombre, ruta: '', cuenta, autoStartClaude: bool(w, 'autoStartClaude', true), resume: bool(w, 'resume', true) }
    if (formatoVersion >= 2) {
      e.ruta = str(w, 'ruta', where, 1024, true)!
    } else {
      const branch = str(w, 'branch', where, 250, false)
      const carpeta = str(w, 'carpeta', where, 1024, false)
      if (branch) {
        if (carpeta) e.ruta = carpeta
        else e.sinCarpeta = true
      } else e.ruta = str(w, 'repoPath', where, 1024, true)!
      const initialPrompt = str(w, 'initialPrompt', where, 4000, false)
      const ticket = str(w, 'ticket', where, 40, false)
      if (initialPrompt) e.initialPrompt = initialPrompt
      if (ticket) e.ticket = ticket
    }
    const color = typeof w.color === 'string' && ACCOUNT_PALETTE.some((c) => c.hex === w.color) ? (w.color as string) : undefined
    if (color) e.color = color
    const colorEspacio = typeof w.colorEspacio === 'string' && (TEMPLATE_COLOR_KEYS as readonly string[]).includes(w.colorEspacio) ? w.colorEspacio : undefined
    if (colorEspacio) e.colorEspacio = colorEspacio
    return e
  })

  const rawTpl = data.plantillas ?? []
  if (!Array.isArray(rawTpl)) throw new Error('«plantillas» tiene que ser una lista.')
  if (rawTpl.length > 200) throw new Error('Demasiadas plantillas en el archivo.')
  const plantillas: ExportedTemplate[] = rawTpl.map((t, i) => {
    const where = `Plantilla ${i + 1}`
    if (!isObj(t)) throw new Error(`${where}: formato inválido.`)
    const e: ExportedTemplate = {
      name: str(t, 'name', where, 80, true)!,
      repoPath: str(t, 'repoPath', where, 1000, true)!,
      autoStartClaude: bool(t, 'autoStartClaude', true),
      resume: bool(t, 'resume', true)
    }
    const cuenta = str(t, 'cuenta', where, 80, false)
    const namePattern = str(t, 'namePattern', where, 120, false)
    const initialPrompt = str(t, 'initialPrompt', where, 4000, false)
    if (cuenta) e.cuenta = cuenta
    if (namePattern) e.namePattern = namePattern
    if (initialPrompt) e.initialPrompt = initialPrompt
    if (t.useWorktree !== undefined && t.useWorktree !== null) {
      if (!isObj(t.useWorktree)) throw new Error(`${where}: «useWorktree» inválido.`)
      e.useWorktree = { branchPattern: str(t.useWorktree, 'branchPattern', where, 200, true)! }
    }
    return e
  })

  // Apariencia: solo los valores que la Configuración acepta; el resto se ignora.
  let apariencia: ExportedAppearance | undefined
  if (isObj(data.apariencia)) {
    const a = data.apariencia
    apariencia = {}
    if (typeof a.theme === 'string' && (THEMES as readonly string[]).includes(a.theme)) apariencia.theme = a.theme
    if (typeof a.density === 'string' && (DENSITIES as readonly string[]).includes(a.density)) apariencia.density = a.density
    if (Number.isInteger(a.uiFontSize) && (a.uiFontSize as number) >= UI_FONT.min && (a.uiFontSize as number) <= UI_FONT.max) apariencia.uiFontSize = a.uiFontSize as number
    if (typeof a.accent === 'string' && (ACCENTS as readonly AccentChoice[]).includes(a.accent as AccentChoice)) apariencia.accent = a.accent as AccentChoice
    if (typeof a.lightMode === 'boolean') apariencia.lightMode = a.lightMode
  }

  // Atajos: solo ids conocidos y combinaciones válidas (la Configuración vuelve a validar al aplicar).
  let atajos: Record<string, string> | undefined
  if (isObj(data.atajos)) {
    const out: Record<string, string> = {}
    for (const id of SHORTCUT_IDS) {
      const v = data.atajos[id]
      const canon = typeof v === 'string' ? canonicalCombo(v) : null
      if (canon) out[id] = canon
    }
    if (Object.keys(out).length) atajos = out
  }

  let equipo: string | undefined
  if (isObj(data.equipo) && typeof data.equipo.supabaseUrl === 'string') {
    try {
      equipo = normalizeSupabaseUrl(data.equipo.supabaseUrl)
    } catch {
      equipo = undefined
    }
  }

  // Permisos: cada regla queda en la lista, válida o no. Las inválidas se muestran y no se pueden tildar.
  const permisos: ParsedPermiso[] = []
  if (Array.isArray(data.permisos)) {
    if (data.permisos.length > 500) throw new Error('Demasiados espacios con reglas en el archivo.')
    data.permisos.forEach((p, i) => {
      const where = `Permisos ${i + 1}`
      if (!isObj(p) || !Array.isArray(p.reglas)) throw new Error(`${where}: formato inválido.`)
      if (p.reglas.length > MAX_RULES) throw new Error(`${where}: demasiadas reglas.`)
      permisos.push({
        espacio: str(p, 'espacio', where, 120, true)!,
        ruta: str(p, 'ruta', where, 1024, true)!,
        reglas: p.reglas.map(parseRule)
      })
    })
  }

  return { version, formatoVersion, cuentas, espacios, plantillas, apariencia, atajos, equipo, permisos }
}

// ---------- Plan (vista previa) ----------

export type SpaceStatus = 'ok' | 'conflicto' | 'faltante' | 'ya' | 'saltear'
export interface PlanSpace {
  index: number
  nombre: string
  ruta: string
  cuenta: string
  color?: string
  status: SpaceStatus
  /** Motivo cuando no se puede importar tal cual. */
  motivo?: string
  /** Nombre del espacio local que choca (solo en conflicto). */
  existente?: string
}
export interface PlanAccount {
  label: string
  action: 'crear' | 'existe'
}
/** Una regla del archivo en la vista previa. `id` = «<grupo>.<regla>» (la interfaz la usa como clave). */
export interface PlanRule {
  id: string
  texto: string
  valida: boolean
  motivo?: string
  draft?: RuleDraft
}
/** Reglas de un espacio del archivo. `espacioIndex` = -1 si el espacio no está en el archivo. */
export interface PlanPermiso {
  espacioIndex: number
  espacio: string
  ruta: string
  reglas: PlanRule[]
}
export interface ImportPlan {
  version: string
  cuentas: PlanAccount[]
  espacios: PlanSpace[]
  plantillas: { nuevas: string[]; existentes: string[]; salteadas: { name: string; reason: string }[] }
  apariencia: boolean
  atajos: number
  equipo: string | null
  permisos: PlanPermiso[]
  /** Reglas en total (válidas e inválidas) y cuántas son válidas. */
  reglas: number
  reglasValidas: number
}

const norm = (p: string): string => p.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()

/**
 * Qué pasaría con cada espacio y plantilla del archivo. `isDir` dice si una carpeta existe en esta PC.
 * Un espacio con el mismo nombre y la misma carpeta ya está en Sloth; con el mismo nombre y otra
 * carpeta es un conflicto (lo decide el usuario). Una carpeta que no existe es «faltante» (se puede elegir otra).
 */
export function buildPlan(
  parsed: ParsedImport,
  accounts: readonly Account[],
  workspaces: readonly Workspace[],
  isDir: (p: string) => boolean,
  localTemplates: unknown
): ImportPlan {
  const localLabels = new Set(accounts.map((a) => a.label.trim().toLowerCase()))
  const cuentas: PlanAccount[] = parsed.cuentas.map((c) => ({
    label: c.label,
    action: localLabels.has(c.label.toLowerCase()) ? 'existe' : 'crear'
  }))
  const known = new Set([...localLabels, ...parsed.cuentas.map((c) => c.label.toLowerCase())])

  const espacios: PlanSpace[] = parsed.espacios.map((e, index) => {
    const base = { index, nombre: e.nombre, ruta: e.ruta, cuenta: e.cuenta, color: e.color }
    if (!known.has(e.cuenta.toLowerCase())) return { ...base, status: 'saltear', motivo: `la cuenta «${e.cuenta}» no está en el archivo` }
    if (e.sinCarpeta) return { ...base, status: 'saltear', motivo: 'es un worktree y el archivo no trae su carpeta' }
    if (!isDir(e.ruta)) return { ...base, status: 'faltante', motivo: 'la carpeta no existe en esta PC' }
    const sameName = workspaces.find((w) => w.name.trim().toLowerCase() === e.nombre.trim().toLowerCase())
    if (sameName) {
      if (norm(sameName.repoPath) === norm(e.ruta)) return { ...base, status: 'ya', motivo: 'ya está en Sloth' }
      return { ...base, status: 'conflicto', existente: sameName.name }
    }
    return { ...base, status: 'ok' }
  })

  const localNames = new Set(
    (templateList(localTemplates) ?? []).map(templateName).filter((n): n is string => Boolean(n)).map((n) => n.toLowerCase())
  )
  const nuevas: string[] = []
  const existentes: string[] = []
  const salteadas: { name: string; reason: string }[] = []
  for (const t of parsed.plantillas) {
    if (localNames.has(t.name.toLowerCase())) existentes.push(t.name)
    else if (!isDir(t.repoPath)) salteadas.push({ name: t.name, reason: 'la carpeta del repo no existe en esta PC' })
    else {
      localNames.add(t.name.toLowerCase())
      nuevas.push(t.name)
    }
  }

  const permisos: PlanPermiso[] = parsed.permisos.map((p, i) => {
    const espacioIndex = parsed.espacios.findIndex((e) => e.nombre === p.espacio && e.ruta === p.ruta)
    return {
      espacioIndex,
      espacio: p.espacio,
      ruta: p.ruta,
      reglas: p.reglas.map((r, j) => ({ id: `${i}.${j}`, texto: r.texto, valida: r.valida, motivo: r.motivo, draft: r.draft }))
    }
  })
  const todas = permisos.flatMap((p) => p.reglas)

  return {
    version: parsed.version,
    cuentas,
    espacios,
    plantillas: { nuevas, existentes, salteadas },
    apariencia: !!parsed.apariencia && Object.keys(parsed.apariencia).length > 0,
    atajos: parsed.atajos ? Object.keys(parsed.atajos).length : 0,
    equipo: parsed.equipo ?? null,
    permisos,
    reglas: todas.length,
    reglasValidas: todas.filter((r) => r.valida).length
  }
}

/**
 * Plantillas nuevas listas para `feat:templates:save` (sin id: se crean). La cuenta se busca por
 * nombre; si no está, queda «sugerida». La función «templates» valida todo de nuevo.
 */
export function templatesToSave(parsed: ParsedImport, plan: ImportPlan, idByLabel: ReadonlyMap<string, string>): Record<string, unknown>[] {
  const nuevas = new Set(plan.plantillas.nuevas.map((n) => n.toLowerCase()))
  return parsed.plantillas
    .filter((t) => nuevas.has(t.name.toLowerCase()))
    .map((t) => ({
      name: t.name,
      repoPath: t.repoPath,
      accountId: (t.cuenta && idByLabel.get(t.cuenta.toLowerCase())) || 'sugerida',
      namePattern: t.namePattern,
      initialPrompt: t.initialPrompt,
      useWorktree: t.useWorktree,
      autoStartClaude: t.autoStartClaude,
      resume: t.resume
    }))
}
