/**
 * Lógica pura de exportar/importar la configuración (sin electron: se prueba con Node).
 * El archivo NUNCA lleva configDir, ids internos, credenciales, tokens ni transcripts.
 */
import type { Account, Workspace } from '../../shared/types'

export const FORMAT = 'sloth-config'
export const MAX_FILE_BYTES = 2 * 1024 * 1024

export interface ExportedAccount {
  label: string
  shareSetup: boolean
}
export interface ExportedWorkspace {
  name: string
  repoPath: string
  /** Solo en espacios con worktree: la carpeta del worktree (sin ella no se puede importar). */
  carpeta?: string
  branch?: string
  cuenta: string
  autoStartClaude: boolean
  initialPrompt?: string
  resume: boolean
  ticket?: string
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
export interface ExportFile {
  formato: typeof FORMAT
  versión: string
  exportado: string
  cuentas: ExportedAccount[]
  espacios: ExportedWorkspace[]
  plantillas?: ExportedTemplate[]
}

export function buildExport(
  accounts: readonly Account[],
  workspaces: readonly Workspace[],
  version: string,
  templates: unknown
): ExportFile {
  const labelOf = new Map(accounts.map((a) => [a.id, a.label]))
  const out: ExportFile = {
    formato: FORMAT,
    versión: version,
    exportado: new Date().toISOString(),
    cuentas: accounts.map((a) => ({ label: a.label, shareSetup: a.shareSetup !== false })),
    espacios: workspaces
      .filter((w) => labelOf.has(w.accountId))
      .map((w) => {
        const e: ExportedWorkspace = {
          name: w.name,
          repoPath: w.repoPath,
          cuenta: labelOf.get(w.accountId)!,
          autoStartClaude: Boolean(w.autoStartClaude),
          resume: w.resume !== false
        }
        if (w.branch) {
          e.branch = w.branch
          if (w.cwd && w.cwd !== w.repoPath) e.carpeta = w.cwd
        }
        if (w.initialPrompt) e.initialPrompt = w.initialPrompt
        if (w.ticket) e.ticket = w.ticket
        return e
      })
  }
  const list = templateList(templates)
  if (list) {
    out.plantillas = list.flatMap((t) => {
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
  return out
}

// ---------- Validación a mano (no hay zod en deps) ----------

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

function str(o: Record<string, unknown>, key: string, where: string, max: number, required: boolean): string | undefined {
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

function bool(o: Record<string, unknown>, key: string, def: boolean): boolean {
  const v = o[key]
  return typeof v === 'boolean' ? v : def
}

export interface ParsedImport {
  version: string
  cuentas: ExportedAccount[]
  espacios: ExportedWorkspace[]
  plantillas: ExportedTemplate[]
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

export function parseImport(text: string): ParsedImport {
  let data: unknown
  try {
    data = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    throw new Error('El archivo no es un JSON válido.')
  }
  if (!isObj(data) || data.formato !== FORMAT) throw new Error('No es una configuración exportada de Sloth (falta formato «sloth-config»).')
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
    cuentas.push({ label, shareSetup: bool(a, 'shareSetup', true) })
  })

  const espacios: ExportedWorkspace[] = rawWs.map((w, i) => {
    const where = `Espacio ${i + 1}`
    if (!isObj(w)) throw new Error(`${where}: formato inválido.`)
    const e: ExportedWorkspace = {
      name: str(w, 'name', where, 120, true)!,
      repoPath: str(w, 'repoPath', where, 1024, true)!,
      cuenta: str(w, 'cuenta', where, 80, true)!,
      autoStartClaude: bool(w, 'autoStartClaude', true),
      resume: bool(w, 'resume', true)
    }
    const carpeta = str(w, 'carpeta', where, 1024, false)
    const branch = str(w, 'branch', where, 250, false)
    const initialPrompt = str(w, 'initialPrompt', where, 4000, false)
    const ticket = str(w, 'ticket', where, 40, false)
    if (carpeta) e.carpeta = carpeta
    if (branch) e.branch = branch
    if (initialPrompt) e.initialPrompt = initialPrompt
    if (ticket) e.ticket = ticket
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
  return {
    version: typeof data['versión'] === 'string' ? (data['versión'] as string) : '?',
    cuentas,
    espacios,
    plantillas
  }
}

// ---------- Plan (vista previa) ----------

export interface PlanAccount {
  label: string
  action: 'crear' | 'existe'
}
export interface PlanWorkspace {
  name: string
  folder: string
  cuenta: string
  branch?: string
  action: 'agregar' | 'saltear'
  reason?: string
}
export interface ImportPlan {
  version: string
  cuentas: PlanAccount[]
  espacios: PlanWorkspace[]
  plantillas: { nuevas: string[]; existentes: string[]; salteadas: { name: string; reason: string }[] }
}

const norm = (p: string): string => p.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()

/**
 * Qué se crearía. `isDir` dice si una carpeta existe en esta PC. Una cuenta del archivo que ya
 * existe acá con el mismo nombre se reutiliza; un espacio con el mismo nombre y carpeta se saltea.
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
  const taken = new Set(workspaces.map((w) => `${w.name.trim().toLowerCase()}|${norm(w.cwd)}`))

  const espacios: PlanWorkspace[] = parsed.espacios.map((e) => {
    const folder = e.branch ? (e.carpeta ?? '') : e.repoPath
    const base = { name: e.name, folder, cuenta: e.cuenta, branch: e.branch }
    const skip = (reason: string): PlanWorkspace => ({ ...base, action: 'saltear', reason })
    if (!known.has(e.cuenta.toLowerCase())) return skip(`la cuenta «${e.cuenta}» no está en el archivo`)
    if (e.branch && !e.carpeta) return skip('es un worktree y el archivo no trae su carpeta')
    if (!isDir(folder)) return skip(e.branch ? 'la carpeta del worktree no existe en esta PC' : 'la carpeta no existe en esta PC')
    const key = `${e.name.toLowerCase()}|${norm(folder)}`
    if (taken.has(key)) return skip('ya está en Sloth')
    taken.add(key)
    return { ...base, action: 'agregar' }
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
  return { version: parsed.version, cuentas, espacios, plantillas: { nuevas, existentes, salteadas } }
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
