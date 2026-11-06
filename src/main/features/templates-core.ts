/**
 * Plantillas de espacio: validación, variables y archivo JSON. Sin Electron a propósito
 * (solo node:*), así se prueba con Node y un userData falso.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { NewWorkspaceInput } from '../../shared/types'

export const SUGGESTED = 'sugerida'
export const TICKET_RE = /^[A-Z][A-Z0-9]*-\d+$/
const VARS = ['ticket', 'ticketmin', 'fecha', 'n', 'plantilla'] as const
const VAR_RE = /\{([^{}\s]*)\}/g

export interface Template {
  id: string
  name: string
  repoPath: string
  /** Id de cuenta o «sugerida» (con sesión y la que menos usó en las últimas 5 h). */
  accountId: string
  /** Nombre del espacio que se crea; por defecto «{plantilla} {ticket}» o «{plantilla} #{n}». */
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
  ticket?: string
}

const fail = (msg: string): never => {
  throw new Error(msg)
}

/** Fecha local YYYY-MM-DD. */
export function today(d = new Date()): string {
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Variables que aparecen en un texto (para validar y para saber si hay que pedir el ticket). */
export function varsIn(s: string | undefined): string[] {
  if (!s) return []
  return [...s.matchAll(VAR_RE)].map((m) => m[1])
}

export function templateUsesTicket(t: Pick<Template, 'namePattern' | 'initialPrompt' | 'useWorktree'>): boolean {
  return [t.namePattern, t.initialPrompt, t.useWorktree?.branchPattern].some((s) => varsIn(s).some((v) => v === 'ticket' || v === 'ticketmin'))
}

function checkVars(s: string | undefined, where: string): void {
  for (const v of varsIn(s))
    if (!(VARS as readonly string[]).includes(v)) fail(`${where}: variable desconocida {${v}}. Usá {ticket}, {ticketmin}, {fecha}, {n} o {plantilla}.`)
}

export interface VarValues {
  ticket?: string
  fecha: string
  n: number
  plantilla: string
}

/** Reemplaza {ticket}, {ticketmin} (en minúsculas), {fecha}, {n} y {plantilla}. Si usa el ticket y no hay, error. */
export function applyVars(s: string, v: VarValues): string {
  return s.replace(VAR_RE, (whole, name: string) => {
    if (name === 'ticket') return v.ticket ?? fail('Esta plantilla necesita un ticket (TCK-1234).')
    if (name === 'ticketmin') return (v.ticket ?? fail('Esta plantilla necesita un ticket (TCK-1234).')).toLowerCase()
    if (name === 'fecha') return v.fecha
    if (name === 'n') return String(v.n)
    if (name === 'plantilla') return v.plantilla
    return whole
  })
}

/** Nombre de rama válido para git (subconjunto conservador de check-ref-format). */
export function validBranch(b: string): boolean {
  if (!b || b.length > 200) return false
  if (!/^[A-Za-z0-9._/-]+$/.test(b)) return false
  if (b.startsWith('-') || b.startsWith('/') || b.endsWith('/') || b.endsWith('.') || b.endsWith('.lock')) return false
  if (b.includes('..') || b.includes('//') || b.includes('/.') || b === '@') return false
  return true
}

export function normTicket(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw !== 'string' || raw.length > 40) return fail('El ticket tiene que ser tipo TCK-1234.')
  const t = raw.trim().toUpperCase()
  if (!t) return undefined
  if (!TICKET_RE.test(t)) fail('El ticket tiene que ser tipo TCK-1234.')
  return t
}

const str = (v: unknown, max: number, label: string, required = false): string | undefined => {
  if (v === undefined || v === null) return required ? fail(`Falta ${label}.`) : undefined
  if (typeof v !== 'string') return fail(`${label}: tiene que ser texto.`)
  const t = v.trim()
  if (!t) return required ? fail(`Falta ${label}.`) : undefined
  if (t.length > max) fail(`${label}: es demasiado largo (máximo ${max}).`)
  return t
}

/**
 * Valida lo que llega por IPC y arma la plantilla. `accountIds`: cuentas que existen.
 * `prev`: la plantilla que se edita (conserva id, contador y fecha de creación).
 */
export function sanitizeTemplate(raw: unknown, accountIds: Set<string>, prev?: Template, now = Date.now()): Template {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Plantilla inválida.')
  const r = raw as Record<string, unknown>
  const name = str(r.name, 80, 'el nombre', true)!
  const repoPath = str(r.repoPath, 1000, 'la carpeta del repo', true)!
  if (!isAbsolute(repoPath) || !existsSync(repoPath) || !statSync(repoPath).isDirectory()) fail('Elegí una carpeta de repo válida.')
  const accountId = str(r.accountId, 100, 'la cuenta', true)!
  if (accountId !== SUGGESTED && !accountIds.has(accountId)) fail('Esa cuenta ya no existe.')
  const namePattern = str(r.namePattern, 120, 'el nombre del espacio')
  const initialPrompt = str(r.initialPrompt, 4000, 'el prompt inicial')
  let useWorktree: Template['useWorktree']
  if (r.useWorktree !== undefined && r.useWorktree !== null && r.useWorktree !== false) {
    if (typeof r.useWorktree !== 'object') fail('Worktree inválido.')
    const bp = str((r.useWorktree as Record<string, unknown>).branchPattern, 200, 'el patrón de rama', true)!
    checkVars(bp, 'Rama')
    const sample = applyVars(bp, { ticket: 'TCK-1', fecha: today(new Date(now)), n: 1, plantilla: name })
    if (!validBranch(sample)) fail(`La rama «${sample}» no es un nombre válido para git.`)
    useWorktree = { branchPattern: bp }
  }
  checkVars(namePattern, 'Nombre del espacio')
  checkVars(initialPrompt, 'Prompt inicial')
  if (r.autoStartClaude !== undefined && typeof r.autoStartClaude !== 'boolean') fail('autoStartClaude inválido.')
  if (r.resume !== undefined && typeof r.resume !== 'boolean') fail('resume inválido.')
  return {
    id: prev?.id ?? randomUUID(),
    name,
    repoPath,
    accountId,
    namePattern,
    initialPrompt,
    useWorktree,
    autoStartClaude: r.autoStartClaude !== false,
    resume: r.resume !== false,
    counter: prev?.counter ?? 0,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now
  }
}

/** Arma el NewWorkspaceInput a partir de la plantilla (con la cuenta ya resuelta). */
export function buildInput(t: Template, vars: TemplateVars, accountId: string, now = new Date()): { input: NewWorkspaceInput; n: number } {
  const ticket = normTicket(vars.ticket)
  const n = t.counter + 1
  const v: VarValues = { ticket, fecha: today(now), n, plantilla: t.name }
  const pattern = t.namePattern ?? (templateUsesTicket(t) ? '{plantilla} {ticket}' : '{plantilla} #{n}')
  const name = applyVars(pattern, v).trim().slice(0, 120)
  if (!name) fail('El nombre del espacio quedó vacío.')
  let branch: string | undefined
  if (t.useWorktree) {
    branch = applyVars(t.useWorktree.branchPattern, v)
    if (!validBranch(branch)) fail(`La rama «${branch}» no es un nombre válido para git.`)
  }
  const initialPrompt = t.initialPrompt ? applyVars(t.initialPrompt, v) : undefined
  if (initialPrompt && initialPrompt.length > 4000) fail('El prompt inicial es demasiado largo.')
  return {
    n,
    input: {
      name,
      repoPath: t.repoPath,
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
}

const isTemplate = (x: unknown): x is Template => {
  const t = x as Template
  return Boolean(t) && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.repoPath === 'string' && typeof t.accountId === 'string'
}

/** El JSON de plantillas (escritura atómica: tmp + rename). */
export class TemplateFile {
  private list: Template[]
  private readonly file: string
  constructor(file: string) {
    this.file = file
    this.list = this.load()
  }

  private load(): Template[] {
    if (!existsSync(this.file)) return []
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8').replace(/^﻿/, '')) as Partial<FileShape>
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
    const data: FileShape = { version: 1, templates: this.list }
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }

  all(): Template[] {
    return this.list.map((t) => ({ ...t, useWorktree: t.useWorktree ? { ...t.useWorktree } : undefined }))
  }

  get(id: unknown): Template | undefined {
    return typeof id === 'string' ? this.list.find((t) => t.id === id) : undefined
  }

  /** Crea (sin id) o actualiza (con id existente). */
  save(raw: unknown, accountIds: Set<string>): Template {
    const id = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined
    const prev = id !== undefined ? this.get(id) : undefined
    if (id !== undefined && id !== null && id !== '' && !prev) fail('Esa plantilla ya no existe.')
    const t = sanitizeTemplate(raw, accountIds, prev)
    if (this.list.some((x) => x.id !== t.id && x.name.toLowerCase() === t.name.toLowerCase())) fail(`Ya hay una plantilla «${t.name}».`)
    if (!prev && this.list.length >= 200) fail('Demasiadas plantillas.')
    this.list = prev ? this.list.map((x) => (x.id === t.id ? t : x)) : [...this.list, t]
    this.persist()
    return t
  }

  remove(id: unknown): void {
    if (!this.get(id)) fail('Esa plantilla ya no existe.')
    this.list = this.list.filter((t) => t.id !== id)
    this.persist()
  }

  setCounter(id: string, n: number): void {
    this.list = this.list.map((t) => (t.id === id ? { ...t, counter: Math.max(t.counter, n) } : t))
    this.persist()
  }
}
