import { app, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Feature, FeatureContext } from './context'
import { writeJsonAtomic } from './tray-settings'
import {
  buildTeamExport,
  planImport,
  readTeamConfig,
  repoKey,
  TEAM_DIR,
  teamFilePath,
  type ExistingTemplate,
  type ImportPlan,
  type TeamLink,
  type TeamSettings
} from './team-config-core'

/**
 * Función «team-config»: configuración compartida en `<repo>/.sloth/team.json` (solo lectura,
 * validación estricta, 256 KB como mucho, nunca se ejecuta nada). Importa las plantillas del equipo
 * sin duplicar (la UI las guarda con `feat:templates:save`, así la función «templates» las valida
 * y las tiene en memoria) y exporta mis plantillas como las del equipo.
 *
 * Ops: scan(extraRepos?), inspect(repo), plan(repo), markImported(repo, hash, mapping),
 * dismiss(repo), settingsDone(repo), exportPreview(repo, input), exportWrite(repo, input, text),
 * openLink(repo, i), repoTemplates(repo). Evento: changed(estados).
 */

interface TeamEntry {
  repoPath: string
  equipo?: string
  /** Hash de las plantillas la última vez que se importaron. */
  importedHash?: string
  /** Nombre en el team.json (minúsculas) → id de la plantilla local. */
  mapping: Record<string, string>
  /** «Ahora no» al aviso de plantillas nuevas: se oculta hasta el próximo cambio. */
  dismissedHash?: string
  /** Ajustes recomendados ya aceptados o descartados. */
  settingsHash?: string
  updatedAt: number
}

interface StateFile {
  version: 1
  teams: Record<string, TeamEntry>
}

export interface TeamStatus {
  repoPath: string
  state: 'ok' | 'invalid'
  error?: string
  equipo?: string
  hash?: string
  /** Plantillas nuevas o con cambios para importar. */
  pending: number
  /** Cuántas plantillas del equipo tenés importadas. */
  imported: number
  total: number
  /** Mostrar el aviso «Hay plantillas nuevas del equipo». */
  notify: boolean
  links: TeamLink[]
  ajustes?: TeamSettings
  settingsPending: boolean
}

const featuresDir = (): string => join(app.getPath('userData'), 'features')
const stateFile = (): string => join(featuresDir(), 'team-config.json')
const templatesFile = (): string => join(featuresDir(), 'templates.json')

function loadState(): StateFile {
  try {
    const raw = JSON.parse(readFileSync(stateFile(), 'utf8').replace(/^﻿/, '')) as Partial<StateFile>
    const teams: Record<string, TeamEntry> = {}
    if (raw && typeof raw.teams === 'object' && raw.teams)
      for (const [k, v] of Object.entries(raw.teams)) {
        if (!v || typeof v !== 'object' || typeof v.repoPath !== 'string') continue
        const mapping: Record<string, string> = {}
        if (v.mapping && typeof v.mapping === 'object') for (const [mk, mv] of Object.entries(v.mapping)) if (typeof mv === 'string') mapping[mk] = mv
        teams[k] = { ...v, mapping }
      }
    return { version: 1, teams }
  } catch {
    if (existsSync(stateFile()))
      try {
        renameSync(stateFile(), `${stateFile()}.roto-${Date.now()}`)
      } catch {
        /* se pisa al guardar */
      }
    return { version: 1, teams: {} }
  }
}

/** Plantillas guardadas (solo lectura; las escribe la función «templates»). */
function readTemplates(): ExistingTemplate[] {
  try {
    if (statSync(templatesFile()).size > 2 * 1024 * 1024) return []
    const data = JSON.parse(readFileSync(templatesFile(), 'utf8').replace(/^﻿/, '')) as { templates?: unknown }
    return Array.isArray(data.templates)
      ? (data.templates as ExistingTemplate[]).filter((t) => t && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.repoPath === 'string')
      : []
  } catch {
    return []
  }
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function repoArg(p: unknown): string {
  if (typeof p !== 'string' || !p.trim() || p.length > 1000) throw new Error('Repo inválido.')
  const r = p.trim()
  if (!isAbsolute(r) || !isDir(r)) throw new Error('Esa carpeta no existe.')
  return r
}

const feature: Feature = {
  name: 'team-config',
  register(ctx: FeatureContext) {
    let st = loadState()
    const save = (): void => writeJsonAtomic(stateFile(), st)
    const entry = (repo: string): TeamEntry => (st.teams[repoKey(repo)] ??= { repoPath: repo, mapping: {}, updatedAt: Date.now() })

    const statusOf = (repo: string): TeamStatus | null => {
      const r = readTeamConfig(repo)
      if (r.kind === 'none') return null
      const base = { repoPath: repo, pending: 0, imported: 0, total: 0, notify: false, links: [], settingsPending: false }
      if (r.kind === 'invalid') return { ...base, state: 'invalid', error: r.error }
      const e = st.teams[repoKey(repo)]
      const plan = planImport(r.config, repo, readTemplates(), e?.mapping ?? {})
      const pending = plan.items.filter((i) => !i.error && i.action !== 'same').length
      return {
        ...base,
        state: 'ok',
        equipo: r.config.equipo,
        hash: r.hash,
        pending,
        imported: plan.items.filter((i) => i.action === 'same' || i.action === 'update').length,
        total: r.config.plantillas.length,
        notify: pending > 0 && e?.dismissedHash !== r.hash,
        links: r.config.links,
        ajustes: r.config.ajustes,
        settingsPending: Boolean(r.settingsHash) && e?.settingsHash !== r.settingsHash
      }
    }

    /** Repos a revisar: los de los espacios + los que ya tienen entrada (onboarding, exportar). */
    const repos = (extra: string[] = []): string[] => {
      const seen = new Map<string, string>()
      for (const p of [...ctx.store.workspaces.map((w) => w.repoPath), ...Object.values(st.teams).map((t) => t.repoPath), ...extra])
        if (p && isDir(p) && !seen.has(repoKey(p))) seen.set(repoKey(p), p)
      return [...seen.values()].slice(0, 30)
    }

    let last: TeamStatus[] = []
    const scan = (extra: string[] = []): TeamStatus[] => {
      last = repos(extra)
        .map(statusOf)
        .filter((s): s is TeamStatus => s !== null)
      ctx.emit('changed', last)
      return last
    }

    ctx.handle('scan', (extra: unknown) => {
      const list = Array.isArray(extra) ? extra.filter((x): x is string => typeof x === 'string' && x.length <= 1000 && isAbsolute(x)).slice(0, 5) : []
      return scan(list)
    })

    ctx.handle('inspect', (repo: unknown) => {
      const r = repoArg(repo)
      return statusOf(r)
    })

    ctx.handle('plan', (repo: unknown): ImportPlan => {
      const r = repoArg(repo)
      const cfg = readTeamConfig(r)
      if (cfg.kind === 'none') throw new Error('Ese repo no tiene .sloth/team.json.')
      if (cfg.kind === 'invalid') throw new Error(`.sloth/team.json: ${cfg.error}`)
      return planImport(cfg.config, r, readTemplates(), st.teams[repoKey(r)]?.mapping ?? {})
    })

    ctx.handle('markImported', (repo: unknown, hash: unknown, mapping: unknown) => {
      const r = repoArg(repo)
      if (typeof hash !== 'string' || !/^[0-9a-f]{16}$/.test(hash)) throw new Error('Datos inválidos.')
      if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error('Datos inválidos.')
      const cfg = readTeamConfig(r)
      if (cfg.kind !== 'ok') throw new Error('El archivo del equipo cambió o ya no es válido; volvé a intentar.')
      const keys = new Set(cfg.config.plantillas.map((t) => t.name.toLowerCase()))
      const ids = new Set(readTemplates().map((t) => t.id))
      const e = entry(r)
      for (const [k, id] of Object.entries(mapping as Record<string, unknown>))
        if (keys.has(k) && typeof id === 'string' && ids.has(id)) e.mapping[k] = id
      // Solo queda «al día» si se importó justo esta versión del archivo.
      if (hash === cfg.hash) e.importedHash = hash
      e.equipo = cfg.config.equipo
      e.repoPath = r
      e.updatedAt = Date.now()
      save()
      return scan()
    })

    ctx.handle('dismiss', (repo: unknown) => {
      const r = repoArg(repo)
      const cfg = readTeamConfig(r)
      if (cfg.kind !== 'ok') return scan()
      entry(r).dismissedHash = cfg.hash
      save()
      return scan()
    })

    ctx.handle('settingsDone', (repo: unknown) => {
      const r = repoArg(repo)
      const cfg = readTeamConfig(r)
      if (cfg.kind === 'ok' && cfg.settingsHash) {
        entry(r).settingsHash = cfg.settingsHash
        save()
      }
      return scan()
    })

    ctx.handle('repoTemplates', (repo: unknown) => {
      const r = repoArg(repo)
      const k = repoKey(r)
      const current = readTeamConfig(r)
      return {
        templates: readTemplates()
          .filter((t) => repoKey(t.repoPath) === k || repoKey(t.repoPath).startsWith(k + (process.platform === 'win32' ? '\\' : '/')))
          .map((t) => t.name),
        current: current.kind === 'ok' ? { equipo: current.config.equipo, links: current.config.links, ajustes: current.config.ajustes } : null,
        exists: current.kind !== 'none'
      }
    })

    const exportInput = (input: unknown): Parameters<typeof buildTeamExport>[2] => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Datos inválidos.')
      const i = input as Record<string, unknown>
      return { equipo: i.equipo, links: i.links, ajustes: i.ajustes, include: i.include }
    }

    ctx.handle('exportPreview', (repo: unknown, input: unknown) => {
      const r = repoArg(repo)
      const out = buildTeamExport(r, readTemplates(), exportInput(input))
      return { text: out.text, skipped: out.skipped, count: out.config.plantillas.length, path: teamFilePath(r), exists: existsSync(teamFilePath(r)) }
    })

    ctx.handle('exportWrite', (repo: unknown, input: unknown, shown: unknown) => {
      const r = repoArg(repo)
      const out = buildTeamExport(r, readTemplates(), exportInput(input))
      // Se escribe exactamente lo que el usuario vio y confirmó.
      if (out.text !== shown) throw new Error('Tus plantillas cambiaron mientras mirabas la vista previa. Revisala de nuevo.')
      const dir = join(r, TEAM_DIR)
      mkdirSync(dir, { recursive: true })
      const target = teamFilePath(r)
      const tmp = `${target}.${process.pid}.tmp`
      writeFileSync(tmp, out.text, 'utf8')
      renameSync(tmp, target)
      // Lo mío ya es «del equipo»: queda mapeado para no duplicarse al importar.
      const e = entry(r)
      const byName = new Map(readTemplates().map((t) => [t.name.toLowerCase(), t.id]))
      for (const t of out.config.plantillas) {
        const id = byName.get(t.name.toLowerCase())
        if (id) e.mapping[t.name.toLowerCase()] = id
      }
      e.equipo = out.config.equipo
      const after = readTeamConfig(r)
      e.importedHash = after.kind === 'ok' ? after.hash : undefined
      e.updatedAt = Date.now()
      save()
      ctx.log(`team.json escrito en ${target} (${out.config.plantillas.length} plantillas)`)
      scan()
      return { path: target }
    })

    ctx.handle('openLink', async (repo: unknown, index: unknown) => {
      const r = repoArg(repo)
      const cfg = readTeamConfig(r)
      if (cfg.kind !== 'ok' || typeof index !== 'number' || !Number.isInteger(index)) throw new Error('Link inválido.')
      const link = cfg.config.links[index]
      if (!link || !link.url.startsWith('https://')) throw new Error('Link inválido.')
      await shell.openExternal(link.url)
    })

    // Primera revisión al iniciar (después, la UI pide otra al volver la ventana visible).
    try {
      scan()
    } catch (e) {
      ctx.log('scan inicial falló', e)
    }
    ctx.handle('last', () => last)
  }
}

export default feature
