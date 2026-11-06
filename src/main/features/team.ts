import { app, shell } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Feature, FeatureContext } from './context'
import { accountStatus } from '../accounts'
import { baseEnv } from '../ptys'
import { NoGruvError, resolveClaudeExe } from './gruv-claude'
import {
  buildPeople,
  cleanMapping,
  LOGIN_RE,
  NOT_GRUV,
  PR_URL_RE,
  type GruvPersona,
  type TeamPr,
  type TeamTicket
} from './team-core'
import { fetchGithub } from './team-github'
import { buildTeamArgs, buildTeamPrompt, runTeamClaude } from './team-gruv'

/**
 * Vista «Equipo»: en qué anda cada uno, sin servidor propio. GitHub (gh, solo lectura) se pide al
 * abrir la vista o con «Actualizar»; Gruv (tickets activos de todo el equipo) solo a pedido, porque
 * usa tokens de la cuenta elegida. Nada corre solo con la vista cerrada.
 */

const MODELS = ['haiku', 'sonnet'] as const

interface TeamConfig {
  queryAccountId?: string
  model: (typeof MODELS)[number]
  espacio?: string
  proyecto?: string
  confirmGruv: boolean
}

interface TeamState {
  version: 1
  github: { prs: TeamPr[]; repos: string[]; errors: Record<string, string>; fatal?: string; fetchedAt?: number }
  gruv: {
    tickets: TeamTicket[]
    personas: GruvPersona[]
    fetchedAt?: number
    fetchedBy?: string
    lastRun?: { tokens?: number; costUsd?: number; durationMs?: number }
    lastError?: string
  }
  /** login de GitHub (minúscula) → clave de persona de Gruv, o «-» = no es nadie de Gruv. */
  mapping: Record<string, string>
  config: TeamConfig
}

const emptyState = (): TeamState => ({
  version: 1,
  github: { prs: [], repos: [], errors: {} },
  gruv: { tickets: [], personas: [] },
  mapping: {},
  config: { model: 'haiku', confirmGruv: true }
})

let ctx: FeatureContext
let state: TeamState
let file = ''
let gruvRun: AbortController | null = null
let ghRun: Promise<unknown> | null = null

function load(): TeamState {
  const base = emptyState()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as Partial<TeamState>
    const gh = (raw.github ?? {}) as Partial<TeamState['github']>
    const gr = (raw.gruv ?? {}) as Partial<TeamState['gruv']>
    return {
      version: 1,
      github: {
        prs: Array.isArray(gh.prs) ? gh.prs.filter((p) => p && typeof p.url === 'string' && PR_URL_RE.test(p.url)) : [],
        repos: Array.isArray(gh.repos) ? gh.repos.filter((r) => typeof r === 'string') : [],
        errors: gh.errors && typeof gh.errors === 'object' ? gh.errors : {},
        fatal: typeof gh.fatal === 'string' ? gh.fatal : undefined,
        fetchedAt: typeof gh.fetchedAt === 'number' ? gh.fetchedAt : undefined
      },
      gruv: {
        tickets: Array.isArray(gr.tickets) ? gr.tickets : [],
        personas: Array.isArray(gr.personas) ? gr.personas : [],
        fetchedAt: typeof gr.fetchedAt === 'number' ? gr.fetchedAt : undefined,
        fetchedBy: typeof gr.fetchedBy === 'string' ? gr.fetchedBy : undefined,
        lastRun: gr.lastRun,
        lastError: typeof gr.lastError === 'string' ? gr.lastError : undefined
      },
      mapping: cleanMapping(raw.mapping),
      config: { ...base.config, ...(raw.config ?? {}) }
    }
  } catch {
    return base
  }
}

function save(): void {
  mkdirSync(join(app.getPath('userData'), 'features'), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tmp, file)
}

function snapshot(): unknown {
  const view = buildPeople({
    prs: state.github.prs,
    tickets: state.gruv.tickets,
    personas: state.gruv.personas,
    mapping: state.mapping
  })
  // Personas de Gruv para el selector de «vincular».
  const gruvPeople = view.people.filter((p) => p.inGruv).map((p) => ({ key: p.key, nombre: p.nombre }))
  const authors = new Map<string, { login: string; name?: string }>()
  for (const p of state.github.prs) if (!p.isBot) authors.set(p.login.toLowerCase(), { login: p.login, name: p.authorName })
  return {
    ...view,
    gruvPeople,
    authors: [...authors.values()].sort((a, b) => a.login.localeCompare(b.login)),
    mapping: state.mapping,
    github: { repos: state.github.repos, errors: state.github.errors, fatal: state.github.fatal, fetchedAt: state.github.fetchedAt },
    gruv: {
      fetchedAt: state.gruv.fetchedAt,
      fetchedBy: state.gruv.fetchedBy,
      lastRun: state.gruv.lastRun,
      lastError: state.gruv.lastError,
      running: Boolean(gruvRun)
    },
    githubRunning: Boolean(ghRun),
    config: state.config
  }
}

function changed(): void {
  save()
  ctx.emit('changed', snapshot())
}

// ---------- GitHub ----------
function refreshGithub(): Promise<unknown> {
  if (ghRun) return ghRun
  const dirs = ctx.store.workspaces.map((w) => w.repoPath)
  ghRun = (async () => {
    ctx.emit('changed', snapshot())
    try {
      const r = await fetchGithub(dirs)
      state.github = { prs: r.prs, repos: r.repos, errors: r.errors, fatal: r.fatal, fetchedAt: Date.now() }
    } catch (e) {
      state.github = { ...state.github, fatal: (e as Error).message, fetchedAt: Date.now() }
    } finally {
      ghRun = null
      changed()
    }
    return snapshot()
  })()
  return ghRun
}

// ---------- Gruv ----------
async function refreshGruv(rawAccount: unknown): Promise<unknown> {
  if (gruvRun) throw new Error('Ya hay una consulta a Gruv en curso.')
  const accountId = typeof rawAccount === 'string' && rawAccount.length < 100 && rawAccount ? rawAccount : state.config.queryAccountId
  const acc = accountId ? ctx.store.account(accountId) : undefined
  if (!acc) throw new Error('Elegí la cuenta con la que se consulta Gruv.')
  if (!accountStatus(acc).loggedIn) throw new Error(`La cuenta «${acc.label}» no tiene sesión iniciada.`)
  const exe = resolveClaudeExe()
  if (!exe) throw new Error('No encontré el ejecutable de Claude Code (claude.exe) en el PATH.')
  const cwd = join(app.getPath('userData'), 'features', 'team-run')
  mkdirSync(cwd, { recursive: true })
  const ac = new AbortController()
  gruvRun = ac
  ctx.emit('changed', snapshot())
  try {
    const r = await runTeamClaude({
      exe,
      args: buildTeamArgs(state.config.model),
      prompt: buildTeamPrompt({ espacio: state.config.espacio, proyecto: state.config.proyecto }),
      cwd,
      env: { ...baseEnv(), CLAUDE_CONFIG_DIR: acc.configDir },
      signal: ac.signal
    })
    state.gruv = {
      tickets: r.tickets,
      personas: r.personas,
      fetchedAt: Date.now(),
      fetchedBy: acc.id,
      lastRun: { tokens: r.tokens, costUsd: r.costUsd, durationMs: r.durationMs }
    }
    state.config.queryAccountId = acc.id
    return { count: r.tickets.length, people: r.personas.length, tokens: r.tokens }
  } catch (e) {
    const msg = e instanceof NoGruvError ? `«${acc.label}»: ${e.message}` : (e as Error).message
    state.gruv.lastError = msg
    throw new Error(msg)
  } finally {
    gruvRun = null
    changed()
  }
}

// ---------- validación ----------
function text(v: unknown, max: number, name: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') throw new Error(`${name} no es válido.`)
  const s = v.replace(/\s+/g, ' ').trim()
  if (s.length > max) throw new Error(`${name} es demasiado largo (máx. ${max}).`)
  return s || undefined
}

function setConfig(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') throw new Error('Configuración inválida.')
  const p = raw as Record<string, unknown>
  const c = state.config
  if ('queryAccountId' in p) {
    const id = p.queryAccountId
    if (id !== undefined && id !== null && id !== '' && (typeof id !== 'string' || !ctx.store.account(id))) throw new Error('Esa cuenta no existe.')
    c.queryAccountId = (id as string) || undefined
  }
  if ('model' in p) {
    if (!MODELS.includes(p.model as (typeof MODELS)[number])) throw new Error('Modelo inválido.')
    c.model = p.model as (typeof MODELS)[number]
  }
  if ('espacio' in p) c.espacio = text(p.espacio, 80, 'El espacio de Gruv')
  if ('proyecto' in p) c.proyecto = text(p.proyecto, 80, 'El proyecto de Gruv')
  if ('confirmGruv' in p) c.confirmGruv = p.confirmGruv !== false
  changed()
  return snapshot()
}

/** Vincula un login de GitHub con una persona de Gruv (null = automático, «-» = no es de Gruv). */
function setMapping(rawLogin: unknown, rawKey: unknown): unknown {
  if (typeof rawLogin !== 'string' || !LOGIN_RE.test(rawLogin)) throw new Error('Login de GitHub inválido.')
  const login = rawLogin.toLowerCase()
  if (rawKey === null || rawKey === undefined || rawKey === '') delete state.mapping[login]
  else {
    if (typeof rawKey !== 'string' || rawKey.length > 200) throw new Error('Persona inválida.')
    if (rawKey !== NOT_GRUV) {
      const view = buildPeople({ prs: [], tickets: state.gruv.tickets, personas: state.gruv.personas, mapping: {} })
      if (!view.people.some((p) => p.key === rawKey)) throw new Error('Esa persona no está en lo último que trajo Gruv.')
    }
    state.mapping[login] = rawKey
  }
  changed()
  return snapshot()
}

async function openPr(raw: unknown): Promise<boolean> {
  if (typeof raw !== 'string' || !PR_URL_RE.test(raw)) throw new Error('Ese link no es de un PR de GitHub.')
  await shell.openExternal(raw)
  return true
}

const feature: Feature = {
  name: 'team',
  register(c) {
    ctx = c
    file = join(app.getPath('userData'), 'features', 'team.json')
    state = load()
    c.handle('state', () => snapshot())
    c.handle('refreshGithub', () => refreshGithub())
    c.handle('refreshGruv', (acc: unknown) => refreshGruv(acc))
    c.handle('cancelGruv', () => {
      gruvRun?.abort()
      return true
    })
    c.handle('setConfig', (p: unknown) => setConfig(p))
    c.handle('setMapping', (login: unknown, key: unknown) => setMapping(login, key))
    c.handle('openPr', (url: unknown) => openPr(url))
  },
  dispose() {
    gruvRun?.abort()
  }
}

export default feature
