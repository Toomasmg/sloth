import { app, dialog, shell, type OpenDialogOptions, type SaveDialogOptions } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Feature, FeatureContext } from './context'
import type { Workspace } from '../../shared/types'
import { createAccount } from '../accounts'
import { featuresDir } from './tray-settings'
import { encryptText, MIN_PASSWORD } from './export-crypto'
import { normalizeSupabaseUrl } from './chat-config'
import { normalize, type SlothSettings } from './settings-model'
import {
  buildPlan,
  exportRules,
  exportSpaces,
  exportTemplates,
  FORMAT,
  FORMAT_VERSION,
  fmtKb,
  MAX_FILE_BYTES,
  openEnvelope,
  parseImport,
  readEnvelope,
  sectionSizes,
  templatesToSave,
  type Envelope,
  type ExportDoc,
  type ExportedAppearance,
  type ImportPlan,
  type ParsedImport,
  type ParsedSpace,
  type SectionId
} from './export-import-logic'

/**
 * Llevar la configuración a otra PC (función «export-import»). Exporta y lee un archivo .sloth
 * (JSON, o cifrado con contraseña). NUNCA exporta ni importa tokens, credenciales, sesiones ni
 * la service_role: solo la URL del proyecto de Supabase del equipo. Las reglas de permisos son las de
 * Sloth (permissions.json); una importación nunca escribe en la configuración de Claude.
 */

const templatesFile = (): string => join(featuresDir(), 'templates.json')
const settingsFile = (): string => join(featuresDir(), 'settings.json')
const chatFile = (): string => join(featuresDir(), 'chat.json')
const permissionsFile = (): string => join(featuresDir(), 'permissions.json')

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function readJsonFile(path: string, max = MAX_FILE_BYTES): unknown {
  try {
    if (statSync(path).size > max) return undefined
    return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''))
  } catch {
    return undefined
  }
}

function readTemplates(): unknown {
  return readJsonFile(templatesFile())
}

/** Ajustes ya saneados (los mismos que usa la Configuración). Sin archivo: los de fábrica. */
function readSettings(): SlothSettings {
  return normalize(readJsonFile(settingsFile()))
}

/** Reglas «Permitir siempre» de Sloth (permissions.json). Crudas: exportRules las valida una por una. */
function readSlothRules(): unknown[] {
  const raw = readJsonFile(permissionsFile()) as { rules?: unknown } | undefined
  return Array.isArray(raw?.rules) ? raw!.rules : []
}

/** URL del proyecto de Supabase del equipo, sin la key. */
function readTeamUrl(): string | null {
  const raw = readJsonFile(chatFile()) as { config?: { supabaseUrl?: unknown } } | undefined
  const url = raw?.config?.supabaseUrl
  if (typeof url !== 'string') return null
  try {
    return normalizeSupabaseUrl(url)
  } catch {
    return null
  }
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

/** Nombre libre: «X (copia)», «X (copia 2)»… */
function uniqueName(base: string, taken: Set<string>): string {
  let name = `${base} (copia)`
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} (copia ${n})`
  return name
}

export interface Selection {
  espacios: string[]
  plantillas: boolean
  apariencia: boolean
  atajos: boolean
  equipo: boolean
  permisos: boolean
}

export interface ImportGroups {
  espacios: boolean
  plantillas: boolean
  apariencia: boolean
  atajos: boolean
  equipo: boolean
}

export interface ImportChoices {
  grupos: ImportGroups
  /** Por índice del espacio en el archivo: qué hacer si ya hay uno con ese nombre, y carpeta elegida si faltaba. */
  espacios: Record<string, { conflicto?: 'reemplazar' | 'dos' | 'saltear'; carpeta?: string }>
}

export interface ImportResult {
  cuentas: number
  espacios: number
  /**
   * Espacio del archivo (índice) → id del espacio en Sloth, para los que quedaron (creados o ya
   * estaban). Con esto la interfaz arma las reglas que el usuario tildó (feat:permissions:addRules).
   */
  espaciosWs: Record<string, string>
  plantillas: Record<string, unknown>[]
  /** Ajustes que la interfaz aplica con «feat:settings:set» (main ya los filtró contra lo local). */
  ajustes: {
    apariencia?: ExportedAppearance
    accountColors?: Record<string, string>
    accountPlans?: Record<string, string>
    atajos?: Record<string, string>
  }
  saltados: { nombre: string; motivo: string }[]
  notas: string[]
  errores: string[]
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const norm = (p: string): string => p.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
const isBool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)

function parseSelection(raw: unknown): Selection {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    espacios: Array.isArray(o.espacios) ? o.espacios.filter((x): x is string => typeof x === 'string').slice(0, 500) : [],
    plantillas: isBool(o.plantillas, false),
    apariencia: isBool(o.apariencia, false),
    atajos: isBool(o.atajos, false),
    equipo: isBool(o.equipo, false),
    permisos: isBool(o.permisos, false)
  }
}

function parseChoices(raw: unknown): ImportChoices {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const g = (typeof o.grupos === 'object' && o.grupos !== null ? o.grupos : {}) as Record<string, unknown>
  const espacios: ImportChoices['espacios'] = {}
  if (typeof o.espacios === 'object' && o.espacios !== null) {
    for (const [k, v] of Object.entries(o.espacios as Record<string, unknown>)) {
      if (!/^\d{1,4}$/.test(k) || typeof v !== 'object' || v === null) continue
      const c = v as Record<string, unknown>
      const conflicto = c.conflicto === 'reemplazar' || c.conflicto === 'dos' || c.conflicto === 'saltear' ? c.conflicto : undefined
      const carpeta = str(c.carpeta).trim() || undefined
      if (carpeta && carpeta.length > 1024) continue
      espacios[k] = { conflicto, carpeta }
    }
  }
  return {
    grupos: {
      espacios: isBool(g.espacios, true),
      plantillas: isBool(g.plantillas, true),
      apariencia: isBool(g.apariencia, true),
      atajos: isBool(g.atajos, true),
      equipo: isBool(g.equipo, true)
    },
    espacios
  }
}

interface Pending {
  file: string
  at: number
  env?: Extract<Envelope, { kind: 'cifrado' }>
  parsed?: ParsedImport
}

const feature: Feature = {
  name: 'export-import',
  register(ctx: FeatureContext) {
    // Importaciones en vista previa, esperando confirmación (se descartan a los 10 min).
    const pending = new Map<string, Pending>()
    let lastExport: string | null = null
    const prune = (): void => {
      for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60_000) pending.delete(k)
    }
    const plan = (parsed: ParsedImport): ImportPlan =>
      buildPlan(parsed, ctx.store.accounts, ctx.store.workspaces, isDir, readTemplates())

    /** Reglas de Sloth válidas de un espacio (cuenta lo que se exportaría). */
    const rulesOf = (w: Workspace): number => exportRules(readSlothRules(), [w])[0]?.reglas.length ?? 0

    /** Lo que se exportaría con esa selección (sin escribir nada). */
    function buildDoc(sel: Selection): ExportDoc {
      const doc: ExportDoc = { formato: FORMAT, formatoVersion: FORMAT_VERSION, versión: app.getVersion(), exportado: new Date().toISOString() }
      const settings = readSettings()
      const ws = ctx.store.workspaces.filter((w) => sel.espacios.includes(w.id) && ctx.store.accounts.some((a) => a.id === w.accountId))
      if (ws.length) {
        const used = new Set(ws.map((w) => w.accountId))
        doc.cuentas = ctx.store.accounts
          .filter((a) => used.has(a.id))
          .map((a) => {
            const c: NonNullable<ExportDoc['cuentas']>[number] = { label: a.label, shareSetup: a.shareSetup !== false }
            const plan = settings.accountPlans[a.id]
            if (plan) c.plan = plan
            return c
          })
        doc.espacios = exportSpaces(ws, ctx.store.accounts, (id) => settings.accountColors[id])
        if (sel.permisos) {
          const perms = exportRules(readSlothRules(), ws)
          if (perms.length) doc.permisos = perms
        }
      }
      if (sel.plantillas) doc.plantillas = exportTemplates(readTemplates(), ctx.store.accounts)
      if (sel.apariencia) doc.apariencia = { theme: settings.theme, density: settings.density, uiFontSize: settings.uiFontSize, accent: settings.accent }
      if (sel.atajos && Object.keys(settings.shortcuts).length) doc.atajos = { ...settings.shortcuts }
      if (sel.equipo) {
        const url = readTeamUrl()
        if (url) doc.equipo = { supabaseUrl: url }
      }
      return doc
    }

    /** Inventario para armar la selección: espacios (con su cuenta y color) y qué hay en cada grupo. */
    function overview() {
      const settings = readSettings()
      const teamUrl = readTeamUrl()
      const tpl = exportTemplates(readTemplates(), ctx.store.accounts)
      const espacios = ctx.store.workspaces
        .filter((w) => ctx.store.accounts.some((a) => a.id === w.accountId))
        .map((w) => ({
          id: w.id,
          nombre: w.name,
          ruta: w.repoPath,
          cuenta: ctx.store.accounts.find((a) => a.id === w.accountId)?.label ?? '',
          color: settings.accountColors[w.accountId] ?? null,
          colorEspacio: w.color ?? null,
          reglas: rulesOf(w)
        }))
      return {
        espacios,
        plantillas: tpl.length,
        apariencia: { theme: settings.theme, density: settings.density, uiFontSize: settings.uiFontSize, accent: settings.accent },
        atajos: Object.keys(settings.shortcuts).length,
        equipo: teamUrl,
        reglasTotal: espacios.reduce((a, e) => a + e.reglas, 0),
        sesiones: 'no se exportan'
      }
    }

    function enrich(sel: Selection): { json: string; kb: Record<SectionId, number>; total: number } {
      const doc = buildDoc(sel)
      const kb = sectionSizes(doc)
      const total = Object.values(kb).reduce((a, b) => a + b, 0)
      return { json: JSON.stringify(doc, null, 2), kb, total }
    }

    function loadFromText(file: string, text: string): { token: string; file: string; needsPassword?: boolean; version?: string; plan?: ImportPlan } {
      prune()
      const env = readEnvelope(text)
      const token = randomUUID()
      if (env.kind === 'cifrado') {
        pending.set(token, { file, at: Date.now(), env })
        return { token, file, needsPassword: true, version: env.version }
      }
      const parsed = parseImport(env.text)
      pending.set(token, { file, at: Date.now(), parsed })
      return { token, file, plan: plan(parsed) }
    }

    ctx.handle('overview', () => overview())

    ctx.handle('preview', (raw: unknown) => {
      const r = enrich(parseSelection(raw))
      return { json: r.json, kb: r.kb, total: r.total, totalTxt: fmtKb(r.total) }
    })

    ctx.handle('export', async (rawSel: unknown, rawPw: unknown) => {
      const sel = parseSelection(rawSel)
      const pw = typeof rawPw === 'string' && rawPw.length > 0 ? rawPw : undefined
      if (pw !== undefined && pw.length < MIN_PASSWORD) throw new Error(`La contraseña tiene que tener al menos ${MIN_PASSWORD} caracteres.`)
      const hasAny = sel.espacios.length > 0 || sel.plantillas || sel.apariencia || sel.atajos || sel.equipo || sel.permisos
      if (!hasAny) throw new Error('Marcá al menos un grupo para exportar.')
      const win = ctx.window()
      const day = new Date().toISOString().slice(0, 10)
      const opts: SaveDialogOptions = {
        title: 'Exportar configuración de Sloth',
        defaultPath: join(app.getPath('documents'), `sloth-config-${day}.sloth`),
        filters: [{ name: 'Configuración de Sloth', extensions: ['sloth'] }]
      }
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (r.canceled || !r.filePath) return null
      const file = /\.sloth$/i.test(r.filePath) ? r.filePath : `${r.filePath}.sloth`
      const doc = buildDoc(sel)
      const out = pw
        ? { formato: FORMAT, formatoVersion: FORMAT_VERSION, versión: doc.versión, exportado: doc.exportado, ...encryptText(JSON.stringify(doc), pw) }
        : doc
      const text = JSON.stringify(out, null, 2)
      writeAtomic(file, text)
      lastExport = file
      const espacios = doc.espacios?.length ?? 0
      ctx.log(`exportado: ${espacios} espacios${pw ? ' (cifrado)' : ''} → ${file}`)
      return { file, espacios, cifrado: !!pw, kb: Math.round(Buffer.byteLength(text, 'utf8') / 1024) }
    })

    ctx.handle('reveal', () => {
      if (!lastExport || !existsSync(lastExport)) throw new Error('Todavía no exportaste ningún archivo en esta sesión.')
      shell.showItemInFolder(lastExport)
      return true
    })

    ctx.handle('import', async () => {
      prune()
      const win = ctx.window()
      const opts: OpenDialogOptions = {
        title: 'Importar configuración de Sloth',
        properties: ['openFile'],
        filters: [
          { name: 'Configuración de Sloth', extensions: ['sloth', 'json'] }
        ]
      }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      const file = r.canceled ? undefined : r.filePaths[0]
      if (!file) return null
      if (statSync(file).size > MAX_FILE_BYTES) throw new Error('El archivo es demasiado grande para ser una configuración de Sloth.')
      return loadFromText(file, readFileSync(file, 'utf8'))
    })

    // Para soltar un archivo en la ventana: la interfaz manda el contenido (no hay ruta).
    ctx.handle('importText', (rawName: unknown, rawText: unknown) => {
      const text = str(rawText)
      if (!text || text.length > MAX_FILE_BYTES) throw new Error('El archivo no es una configuración de Sloth válida.')
      const name = str(rawName).slice(0, 200) || 'configuración.sloth'
      return loadFromText(name, text)
    })

    ctx.handle('unlock', (token: unknown, rawPw: unknown) => {
      if (typeof token !== 'string' || !pending.has(token)) throw new Error('La vista previa venció: volvé a elegir el archivo.')
      const e = pending.get(token)!
      if (!e.env) throw new Error('Ese archivo ya está abierto.')
      const text = openEnvelope(e.env, str(rawPw))
      const parsed = parseImport(text)
      e.parsed = parsed
      e.env = undefined
      e.at = Date.now()
      return { token, file: e.file, plan: plan(parsed) }
    })

    ctx.handle('pickFolder', async () => {
      const win = ctx.window()
      const opts: OpenDialogOptions = { title: 'Elegí la carpeta del repo en esta PC', properties: ['openDirectory'] }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || !r.filePaths[0]) return null
      return r.filePaths[0]
    })

    ctx.handle('cancel', (token: unknown) => {
      if (typeof token === 'string') pending.delete(token)
    })

    ctx.handle('confirm', async (token: unknown, rawChoices: unknown) => {
      if (typeof token !== 'string' || !pending.has(token)) throw new Error('La vista previa venció: volvé a elegir el archivo.')
      const entry = pending.get(token)!
      if (!entry.parsed) throw new Error('Falta la contraseña del archivo.')
      const parsed = entry.parsed
      pending.delete(token)
      const choices = parseChoices(rawChoices)
      const g = choices.grupos
      const res: ImportResult = { cuentas: 0, espacios: 0, espaciosWs: {}, plantillas: [], ajustes: {}, saltados: [], notas: [], errores: [] }

      // 1) Cuentas que no existen acá: se crean sin sesión (las cuentas nunca traen sesión).
      const idByLabel = new Map<string, string>()
      if (g.espacios) {
        for (const c of parsed.cuentas) {
          if (ctx.store.accounts.some((a) => a.label.trim().toLowerCase() === c.label.trim().toLowerCase())) continue
          try {
            const acc = { ...createAccount(c.label), shareSetup: c.shareSetup }
            ctx.store.addAccount(acc)
            try {
              ctx.prepareAccount(acc)
            } catch (e) {
              ctx.log(`preparar ${acc.label}:`, (e as Error).message)
            }
            res.cuentas++
          } catch (e) {
            res.errores.push(`Cuenta «${c.label}»: ${(e as Error).message}`)
          }
        }
      }
      for (const a of ctx.store.accounts) {
        const k = a.label.trim().toLowerCase()
        if (!idByLabel.has(k)) idByLabel.set(k, a.id)
      }

      // 2) Espacios. Con colores y planes de cuenta que todavía no tenían, los del archivo.
      const colorPatch: Record<string, string> = {}
      const planPatch: Record<string, string> = {}
      const local = readSettings()
      if (g.espacios) {
        for (const c of parsed.cuentas) {
          const id = idByLabel.get(c.label.trim().toLowerCase())
          if (c.plan && id && !local.accountPlans[id]) planPatch[id] = c.plan
        }
        const taken = new Set(ctx.store.workspaces.map((w) => w.name.trim().toLowerCase()))
        const adds: { e: ParsedSpace; index: number; accountId: string; folder: string; same?: Workspace; conflicto?: 'reemplazar' | 'dos' }[] = []
        parsed.espacios.forEach((e, i) => {
          const o = choices.espacios[String(i)] ?? {}
          const accountId = idByLabel.get(e.cuenta.toLowerCase())
          if (!accountId) {
            res.saltados.push({ nombre: e.nombre, motivo: `no se encontró la cuenta «${e.cuenta}»` })
            return
          }
          const folder = o.carpeta ?? e.ruta
          if (!isDir(folder)) {
            res.saltados.push({ nombre: e.nombre, motivo: 'la carpeta no existe en esta PC' })
            return
          }
          const same = ctx.store.workspaces.find((w) => w.name.trim().toLowerCase() === e.nombre.trim().toLowerCase())
          if (same && norm(same.repoPath) === norm(folder)) {
            res.saltados.push({ nombre: e.nombre, motivo: 'ya está en Sloth' })
            res.espaciosWs[String(i)] = same.id
            return
          }
          const conflicto = same ? (o.conflicto ?? 'saltear') : undefined
          if (same && conflicto === 'saltear') {
            res.saltados.push({ nombre: e.nombre, motivo: 'ya tenés un espacio con ese nombre' })
            return
          }
          adds.push({ e, index: i, accountId, folder, same, conflicto: conflicto === 'saltear' ? undefined : conflicto })
        })
        for (const a of adds) {
          let name = a.e.nombre
          try {
            if (a.same && a.conflicto === 'reemplazar') await ctx.removeWorkspace(a.same.id)
            else if (a.same) name = uniqueName(a.e.nombre, taken)
            const ws = await ctx.addWorkspace({
              name,
              repoPath: a.folder,
              accountId: a.accountId,
              autoStartClaude: a.e.autoStartClaude,
              resume: a.e.resume,
              initialPrompt: a.e.initialPrompt,
              ticket: a.e.ticket,
              color: a.e.colorEspacio
            })
            taken.add(ws.name.trim().toLowerCase())
            res.espacios++
            res.espaciosWs[String(a.index)] = ws.id
            if (a.e.color && !local.accountColors[a.accountId]) colorPatch[a.accountId] = a.e.color
          } catch (err) {
            res.errores.push(`Espacio «${a.e.nombre}»: ${(err as Error).message}`)
          }
        }
      }

      // 3) Plantillas (las guarda la interfaz con «feat:templates:save», que las valida).
      if (g.plantillas) {
        const p = plan(parsed)
        res.plantillas = templatesToSave(parsed, p, idByLabel)
      }
      // 4) Apariencia, atajos y colores/planes de cuenta: los aplica la interfaz con «feat:settings:set» (valida ahí).
      if (g.apariencia && parsed.apariencia && Object.keys(parsed.apariencia).length) res.ajustes.apariencia = parsed.apariencia
      if (g.atajos && parsed.atajos) res.ajustes.atajos = parsed.atajos
      if (Object.keys(colorPatch).length) res.ajustes.accountColors = colorPatch
      if (Object.keys(planPatch).length) res.ajustes.accountPlans = planPatch
      // 5) Equipo: la URL no alcanza para conectar (falta la anon key). Se avisa, no se cambia nada.
      if (g.equipo && parsed.equipo) res.notas.push(`La URL del equipo (${parsed.equipo}) no se cambió: cargala en Equipo con tu anon key.`)
      if (!g.equipo && parsed.equipo) res.notas.push('El equipo no se importó (lo elegiste sin marcar).')
      // 6) Reglas de permisos: no se escriben acá. La interfaz manda las tildadas con «feat:permissions:addRules».

      ctx.log(`importado: ${res.cuentas} cuentas, ${res.espacios} espacios, ${res.plantillas.length} plantillas para guardar`)
      ctx.ui({ type: 'reload' })
      return res
    })
  }
}

export default feature
