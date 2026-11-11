/**
 * Plantillas de espacio: validación, variables y archivo JSON. Sin Electron a propósito
 * (solo node:*), así se prueba con Node y un userData falso.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { NewWorkspaceInput } from '../../shared/types'
import {
  applyVars,
  BRANCH_VARS,
  folderLabel,
  normTicketId,
  SUGGESTED,
  TEMPLATE_COLOR_KEYS,
  TEMPLATE_ICON_KEYS,
  TEMPLATE_VARS,
  TICKET_RE,
  today,
  validBranch,
  varsIn,
  type VarValues
} from '../../shared/templates-shared'

export { applyVars, SUGGESTED, TICKET_RE, today, validBranch, varsIn }

export interface Template {
  id: string
  name: string
  /** Una línea para reconocerla en la lista. */
  description?: string
  /** Clave de TEMPLATE_ICON_KEYS. */
  icon?: string
  /** Clave de TEMPLATE_COLOR_KEYS. */
  color?: string
  /** Carpeta fija (opcional): si falta, se elige al crear el espacio. */
  repoPath?: string
  /** Id de cuenta o «sugerida» (con sesión y la que menos usó en las últimas 5 h). */
  accountId: string
  /** Nombre del espacio; por defecto «{plantilla} {ticket}» o «{plantilla} #{n}». */
  namePattern?: string
  initialPrompt?: string
  useWorktree?: { branchPattern: string }
  autoStartClaude: boolean
  resume: boolean
  /** Cuántos espacios se crearon con esta plantilla (para {n}). */
  counter: number
  createdAt: number
  updatedAt: number
}

export interface TemplateVars {
  /** Ticket ya escrito (TCK-1234). */
  ticket?: string
  /** Carpeta del espacio (si la plantilla no tiene una fija). */
  repoPath?: string
  /** Rama actual del repo, para {rama} cuando no hay rama aparte. */
  currentBranch?: string
}

function fail(msg: string): never {
  throw new Error(msg)
}

export function templateUsesTicket(t: Pick<Template, 'namePattern' | 'initialPrompt' | 'useWorktree'>): boolean {
  return [t.namePattern, t.initialPrompt, t.useWorktree?.branchPattern].some((s) => varsIn(s).some((v) => v === 'ticket' || v === 'ticketmin'))
}

function checkVars(s: string | undefined, where: string, allowed: readonly string[] = TEMPLATE_VARS): void {
  for (const v of varsIn(s))
    if (!allowed.includes(v)) fail(`${where}: variable no válida {${v}}. Usá ${allowed.map((x) => `{${x}}`).join(', ')}.`)
}

export function normTicket(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const malo = 'El ticket solo lleva letras, números, guiones, puntos o _ (p. ej. TCK-1234 o 123).'
  if (typeof raw !== 'string' || raw.length > 40) return fail(malo)
  if (!raw.trim()) return undefined
  return normTicketId(raw) ?? fail(malo)
}

const str = (v: unknown, max: number, label: string, required = false): string | undefined => {
  if (v === undefined || v === null) return required ? fail(`Falta ${label}.`) : undefined
  if (typeof v !== 'string') return fail(`${label}: tiene que ser texto.`)
  const t = v.trim()
  if (!t) return required ? fail(`Falta ${label}.`) : undefined
  if (t.length > max) fail(`${label}: es demasiado largo (máximo ${max}).`)
  return t
}

const pick = <T extends string>(v: unknown, keys: readonly T[], label: string): T | undefined => {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string' || !(keys as readonly string[]).includes(v)) return fail(`${label} inválido.`)
  return v as T
}

/**
 * Valida lo que llega por IPC y arma la plantilla. `accountIds`: cuentas que existen.
 * `prev`: la plantilla que se edita (conserva id, contador, fecha de creación y lo que no vino).
 * La carpeta es opcional; si viene, tiene que existir.
 */
export function sanitizeTemplate(raw: unknown, accountIds: Set<string>, prev?: Template, now = Date.now()): Template {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Plantilla inválida.')
  const r = raw as Record<string, unknown>
  const name = str(r.name, 80, 'el nombre', true)!
  const description = str(r.description, 140, 'la descripción')
  const icon = pick(r.icon, TEMPLATE_ICON_KEYS, 'El ícono') ?? prev?.icon ?? 'rama'
  const color = pick(r.color, TEMPLATE_COLOR_KEYS, 'El color') ?? prev?.color ?? 'cielo'
  const repoPath = str(r.repoPath, 1000, 'la carpeta')
  if (repoPath !== undefined && (!isAbsolute(repoPath) || !existsSync(repoPath) || !statSync(repoPath).isDirectory()))
    fail('Elegí una carpeta válida para la plantilla.')
  const accountId = str(r.accountId, 100, 'la cuenta') ?? SUGGESTED
  if (accountId !== SUGGESTED && !accountIds.has(accountId)) fail('Esa cuenta ya no existe.')
  const namePattern = str(r.namePattern, 120, 'el nombre del espacio')
  const initialPrompt = str(r.initialPrompt, 4000, 'el primer mensaje')
  let useWorktree: Template['useWorktree']
  if (r.useWorktree !== undefined && r.useWorktree !== null && r.useWorktree !== false) {
    if (typeof r.useWorktree !== 'object') fail('Rama aparte inválida.')
    const bp = str((r.useWorktree as Record<string, unknown>).branchPattern, 200, 'el patrón de rama', true)!
    checkVars(bp, 'Rama', BRANCH_VARS)
    const sample = applyVars(bp, { ticket: 'TCK-1', fecha: today(new Date(now)), n: 1, plantilla: name })
    if (!validBranch(sample)) fail(`La rama «${sample}» no es un nombre válido para git.`)
    useWorktree = { branchPattern: bp }
  }
  checkVars(namePattern, 'Nombre del espacio')
  checkVars(initialPrompt, 'Primer mensaje')
  if (r.autoStartClaude !== undefined && typeof r.autoStartClaude !== 'boolean') fail('autoStartClaude inválido.')
  if (r.resume !== undefined && typeof r.resume !== 'boolean') fail('resume inválido.')
  return {
    id: prev?.id ?? randomUUID(),
    name,
    description,
    icon,
    color,
    repoPath,
    accountId,
    namePattern,
    initialPrompt,
    useWorktree,
    autoStartClaude: r.autoStartClaude !== undefined ? r.autoStartClaude !== false : (prev?.autoStartClaude ?? true),
    resume: r.resume !== undefined ? r.resume !== false : (prev?.resume ?? true),
    counter: prev?.counter ?? 0,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now
  }
}

/**
 * Arma el NewWorkspaceInput a partir de la plantilla (con la cuenta ya resuelta).
 * La carpeta sale de la plantilla o de `vars.repoPath` (la que se eligió al crear).
 */
export function buildInput(t: Template, vars: TemplateVars, accountId: string, now = new Date()): { input: NewWorkspaceInput; n: number } {
  const ticket = normTicket(vars.ticket)
  const repoPath = t.repoPath ?? vars.repoPath
  if (!repoPath) fail('Elegí la carpeta del espacio.')
  if (templateUsesTicket(t) && !ticket) fail('Esta plantilla necesita un ticket (TCK-1234).')
  const n = t.counter + 1
  const base: VarValues = { ticket, fecha: today(now), n, plantilla: t.name, carpeta: folderLabel(repoPath) }
  const branch = t.useWorktree ? applyVars(t.useWorktree.branchPattern, base) : undefined
  if (branch !== undefined && !validBranch(branch)) fail(`La rama «${branch}» no es un nombre válido para git.`)
  const rama = branch ?? vars.currentBranch ?? ''
  const full: VarValues = { ...base, rama }
  const pattern = t.namePattern ?? (templateUsesTicket(t) ? '{plantilla} {ticket}' : '{plantilla} #{n}')
  const name = applyVars(pattern, full).trim().slice(0, 120)
  if (!name) fail('El nombre del espacio quedó vacío.')
  const initialPrompt = t.initialPrompt ? applyVars(t.initialPrompt, full) : undefined
  if (initialPrompt && initialPrompt.length > 4000) fail('El primer mensaje es demasiado largo.')
  return {
    n,
    input: {
      name,
      repoPath,
      accountId,
      branch,
      autoStartClaude: t.autoStartClaude,
      initialPrompt,
      resume: t.resume,
      ticket
    }
  }
}

/** La cuenta sugerida: con sesión iniciada y la que menos usó en las últimas 5 h. */
export function pickSuggested(accounts: { id: string }[], loggedIn: (id: string) => boolean, used5h: (id: string) => number): string | undefined {
  const logged = accounts.filter((a) => loggedIn(a.id))
  const pool = logged.length ? logged : accounts
  return [...pool].sort((a, b) => used5h(a.id) - used5h(b.id))[0]?.id
}

interface FileShape {
  version: 1
  templates: Template[]
  /** Plantilla predeterminada del Nuevo espacio. */
  defaultId?: string | null
}

const isTemplate = (x: unknown): x is Template => {
  const t = x as Template
  return Boolean(t) && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.accountId === 'string'
}

const uniqName = (base: string, list: Template[]): string => {
  const norm = (s: string): string => s.trim().toLowerCase()
  let n = base.slice(0, 80)
  let k = 2
  while (list.some((t) => norm(t.name) === norm(n))) {
    const suffix = ` (${k})`
    n = base.slice(0, 80 - suffix.length) + suffix
    k++
  }
  return n
}

/** El JSON de plantillas (escritura atómica: tmp + rename). */
export class TemplateFile {
  private list: Template[]
  private def: string | null = null
  private readonly file: string
  constructor(file: string) {
    this.file = file
    this.list = this.load()
  }

  private load(): Template[] {
    if (!existsSync(this.file)) return []
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8').replace(/^﻿/, '')) as Partial<FileShape>
      this.def = typeof data.defaultId === 'string' ? data.defaultId : null
      return Array.isArray(data.templates)
        ? data.templates.filter(isTemplate).map((t) => ({ ...t, counter: Number.isFinite(t.counter) ? t.counter : 0 }))
        : []
    } catch {
      // Archivo roto: se aparta (no se pisa) y se arranca vacío.
      try {
        renameSync(this.file, `${this.file}.roto-${Date.now()}`)
      } catch {
        /* sin permisos: se pisa al guardar */
      }
      return []
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    const data: FileShape = { version: 1, templates: this.list, defaultId: this.def }
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }

  all(): Template[] {
    return this.list.map((t) => ({ ...t, useWorktree: t.useWorktree ? { ...t.useWorktree } : undefined }))
  }

  get(id: unknown): Template | undefined {
    return typeof id === 'string' ? this.list.find((t) => t.id === id) : undefined
  }

  defaultId(): string | null {
    return this.def && this.get(this.def) ? this.def : null
  }

  /** Crea (sin id) o actualiza (con id existente). */
  save(raw: unknown, accountIds: Set<string>): Template {
    const id = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined
    const prev = id !== undefined ? this.get(id) : undefined
    if (id !== undefined && id !== null && id !== '' && !prev) fail('Esa plantilla ya no existe.')
    const t = sanitizeTemplate(raw, accountIds, prev)
    if (this.list.some((x) => x.id !== t.id && x.name.trim().toLowerCase() === t.name.toLowerCase())) fail(`Ya hay una plantilla «${t.name}».`)
    if (!prev && this.list.length >= 200) fail('Demasiadas plantillas.')
    this.list = prev ? this.list.map((x) => (x.id === t.id ? t : x)) : [...this.list, t]
    this.persist()
    return t
  }

  remove(id: unknown): void {
    if (!this.get(id)) fail('Esa plantilla ya no existe.')
    this.list = this.list.filter((t) => t.id !== id)
    if (this.def === id) this.def = null
    this.persist()
  }

  /** Copia con id nuevo, contador en cero y siempre mía (no del equipo). */
  duplicate(id: unknown, now = Date.now()): Template {
    const src = this.get(id)
    if (!src) fail('Esa plantilla ya no existe.')
    const copy: Template = {
      ...src,
      id: randomUUID(),
      name: uniqName(`Copia de ${src.name}`, this.list),
      useWorktree: src.useWorktree ? { ...src.useWorktree } : undefined,
      counter: 0,
      createdAt: now,
      updatedAt: now
    }
    if (this.list.length >= 200) fail('Demasiadas plantillas.')
    this.list = [...this.list, copy]
    this.persist()
    return copy
  }

  setDefault(id: unknown): void {
    if (id !== null && !this.get(id)) fail('Esa plantilla ya no existe.')
    this.def = typeof id === 'string' ? id : null
    this.persist()
  }

  setCounter(id: string, n: number): void {
    this.list = this.list.map((t) => (t.id === id ? { ...t, counter: Math.max(t.counter, n) } : t))
    this.persist()
  }

  /** Cuenta un espacio más creado con la plantilla (para {n}). */
  bump(id: unknown): void {
    const t = this.get(id)
    if (!t) fail('Esa plantilla ya no existe.')
    this.setCounter(t.id, t.counter + 1)
  }
}
