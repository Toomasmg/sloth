import { app, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Feature, FeatureContext } from './context'
import { buildPeople, LOGIN_RE, NADIE, PR_URL_RE, personasDe, ticketsActivos, type TeamTicket } from './team-core'
import { adoptarLegado, avisoSoloLectura, cargarTeam, mappingDe, type MotivoSoloLectura, type TeamState } from './team-estado'
import { fetchGithub } from './team-github'
import { alCambiarTickets, ticketsParaEquipo, type TicketsParaEquipo } from './tickets'

/**
 * Vista «Equipo»: en qué anda cada uno, sin servidor propio. GitHub (gh, solo lectura) se pide al
 * abrir la vista o con «Actualizar». Los tickets son los del conector activo de Tickets: Equipo no
 * los guarda ni los consulta por su cuenta. Nada corre solo con la vista cerrada.
 */

let ctx: FeatureContext
let state: TeamState
let file = ''
let ghRun: Promise<unknown> | null = null
/** team.json es de una versión más nueva de Sloth o no se pudo leer: no se pisa. */
let soloLectura: MotivoSoloLectura | null = null
let offTickets: (() => void) | null = null

function escribir(destino: string, texto: string): void {
  const tmp = `${destino}.tmp`
  writeFileSync(tmp, texto, 'utf8')
  renameSync(tmp, destino)
}

function load(): TeamState {
  soloLectura = null
  let texto: string | null = null
  try {
    texto = readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      soloLectura = 'ilegible'
      ctx.log(`team: no pude leer team.json, no lo voy a pisar: ${(e as Error).message}`)
    }
  }
  const r = cargarTeam(texto)
  if (r.kind === 'corrupto') {
    const aparte = `${file}.corrupto-${Date.now()}`
    try {
      renameSync(file, aparte)
      ctx.log(`team: team.json dañado, lo guardé en ${aparte}`)
    } catch (e) {
      soloLectura = 'sin-respaldo'
      ctx.log(`team: team.json dañado y no pude respaldarlo: ${(e as Error).message}`)
    }
  } else if (r.kind === 'futuro') {
    soloLectura = 'futuro'
    ctx.log('team: team.json es de una versión más nueva de Sloth, no lo voy a pisar')
  } else if (r.kind === 'ok' && r.migrado && texto !== null) {
    const bak = `${file}.v1.bak`
    try {
      if (!existsSync(bak)) escribir(bak, texto)
      state = r.state
      save()
    } catch (e) {
      soloLectura = 'sin-respaldo'
      ctx.log(`team: no pude respaldar team.json antes de migrarlo: ${(e as Error).message}`)
    }
  }
  return r.state
}

function save(): void {
  if (soloLectura) return
  mkdirSync(join(app.getPath('userData'), 'features'), { recursive: true })
  escribir(file, JSON.stringify(state, null, 2))
}

function delConector(): { tp: TicketsParaEquipo; tickets: TeamTicket[] } {
  const tp = ticketsParaEquipo()
  return { tp, tickets: tp.conector ? ticketsActivos(tp.tickets, tp.estados) : [] }
}

/** Mapeo del conector activo; la primera vez que hay uno se le pasa el mapeo de antes, con respaldo. */
function mappingActivo(conectorId: string | null): Record<string, string> {
  if (!conectorId) return {}
  if (!soloLectura && Object.keys(state.mapping).length > 0) {
    const bak = `${file}.v2.bak`
    try {
      if (!existsSync(bak)) escribir(bak, readFileSync(file, 'utf8'))
      if (adoptarLegado(state, conectorId)) save()
    } catch (e) {
      ctx.log(`team: no pude respaldar team.json antes de pasar el mapeo al conector: ${(e as Error).message}`)
    }
  }
  return mappingDe(state, conectorId)
}

function snapshot(): unknown {
  const { tp, tickets } = delConector()
  const mapping = mappingActivo(tp.conector?.id ?? null)
  const view = buildPeople({ prs: state.github.prs, tickets, personas: personasDe(tickets), mapping })
  // Personas del conector para el selector de «vincular».
  const personasConector = view.people.filter((p) => p.enConector).map((p) => ({ key: p.key, nombre: p.nombre }))
  const authors = new Map<string, { login: string; name?: string }>()
  for (const p of state.github.prs) if (!p.isBot) authors.set(p.login.toLowerCase(), { login: p.login, name: p.authorName })
  return {
    ...view,
    personasConector,
    authors: [...authors.values()].sort((a, b) => a.login.localeCompare(b.login)),
    mapping,
    github: { repos: state.github.repos, errors: state.github.errors, fatal: state.github.fatal, fetchedAt: state.github.fetchedAt },
    tickets: {
      conector: tp.conector,
      fetchedAt: tp.fetchedAt,
      fetchedBy: tp.fetchedBy,
      lastRun: tp.lastRun,
      lastError: tp.lastError,
      running: tp.running,
      model: tp.model,
      confirmar: tp.confirmar,
      carpetas: tp.carpetas
    },
    githubRunning: Boolean(ghRun),
    aviso: soloLectura ? avisoSoloLectura(soloLectura) : undefined,
    veniaDeGruv: state.veniaDeGruv
  }
}

function changed(): void {
  save()
  ctx.emit('changed', snapshot())
}

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

/** Vincula un login de GitHub con una persona del conector (null = automático, «-» = no es del conector). */
function setMapping(rawLogin: unknown, rawKey: unknown): unknown {
  if (typeof rawLogin !== 'string' || !LOGIN_RE.test(rawLogin)) throw new Error('Login de GitHub inválido.')
  const login = rawLogin.toLowerCase()
  if (soloLectura) throw new Error(avisoSoloLectura(soloLectura))
  const conectorId = delConector().tp.conector?.id
  if (!conectorId) throw new Error('Elegí un conector en Tickets para vincular personas.')
  const mapping = mappingActivo(conectorId)
  if (rawKey === null || rawKey === undefined || rawKey === '') delete mapping[login]
  else {
    if (typeof rawKey !== 'string' || rawKey.length > 200) throw new Error('Persona inválida.')
    if (rawKey !== NADIE) {
      const { tickets } = delConector()
      const view = buildPeople({ prs: [], tickets, personas: personasDe(tickets), mapping: {} })
      if (!view.people.some((p) => p.key === rawKey)) throw new Error('Esa persona no está en lo último que trajo el conector.')
    }
    mapping[login] = rawKey
  }
  state.mappings[conectorId] = mapping
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
    offTickets = alCambiarTickets(() => ctx.emit('changed', snapshot()))
    c.handle('state', () => snapshot())
    c.handle('refreshGithub', () => refreshGithub())
    c.handle('setMapping', (login: unknown, key: unknown) => setMapping(login, key))
    c.handle('openPr', (url: unknown) => openPr(url))
  },
  dispose() {
    offTickets?.()
    offTickets = null
  }
}

export default feature
