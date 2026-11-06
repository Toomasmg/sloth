import { app, dialog, type OpenDialogOptions, type SaveDialogOptions } from 'electron'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Feature, FeatureContext } from './context'
import { createAccount } from '../accounts'
import { featuresDir } from './tray-settings'
import {
  buildExport,
  buildPlan,
  MAX_FILE_BYTES,
  templatesToSave,
  parseImport,
  type ImportPlan,
  type ParsedImport
} from './export-import-logic'

/** Llevar la configuración (cuentas sin sesión, espacios y plantillas) a otra PC. */

const templatesFile = (): string => join(featuresDir(), 'templates.json')

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function readTemplates(): unknown {
  try {
    if (statSync(templatesFile()).size > MAX_FILE_BYTES) return undefined
    return JSON.parse(readFileSync(templatesFile(), 'utf8').replace(/^﻿/, ''))
  } catch {
    return undefined
  }
}

export interface ImportResult {
  cuentas: number
  espacios: number
  errores: string[]
  /**
   * Plantillas nuevas: las guarda la UI con `feat:templates:save` (así la función «templates»
   * las valida y las tiene en memoria; escribir su JSON desde acá se pisaría).
   */
  plantillas: Record<string, unknown>[]
}

const feature: Feature = {
  name: 'export-import',
  register(ctx: FeatureContext) {
    // Importaciones en vista previa, esperando confirmación (se descartan a los 10 min).
    const pending = new Map<string, { parsed: ParsedImport; at: number }>()
    const prune = (): void => {
      for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60_000) pending.delete(k)
    }
    const plan = (parsed: ParsedImport): ImportPlan =>
      buildPlan(parsed, ctx.store.accounts, ctx.store.workspaces, isDir, readTemplates())

    ctx.handle('export', async () => {
      const win = ctx.window()
      const day = new Date().toISOString().slice(0, 10)
      const opts: SaveDialogOptions = {
        title: 'Exportar configuración de Sloth',
        defaultPath: join(app.getPath('documents'), `sloth-config-${day}.json`),
        filters: [{ name: 'Configuración de Sloth', extensions: ['json'] }]
      }
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (r.canceled || !r.filePath) return null
      const data = buildExport(ctx.store.accounts, ctx.store.workspaces, app.getVersion(), readTemplates())
      writeFileSync(r.filePath, JSON.stringify(data, null, 2), 'utf8')
      ctx.log(`exportado: ${data.cuentas.length} cuentas, ${data.espacios.length} espacios → ${r.filePath}`)
      return { file: r.filePath, cuentas: data.cuentas.length, espacios: data.espacios.length }
    })

    ctx.handle('import', async () => {
      prune()
      const win = ctx.window()
      const opts: OpenDialogOptions = {
        title: 'Importar configuración de Sloth',
        properties: ['openFile'],
        filters: [{ name: 'Configuración de Sloth', extensions: ['json'] }]
      }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      const file = r.canceled ? undefined : r.filePaths[0]
      if (!file) return null
      if (statSync(file).size > MAX_FILE_BYTES) throw new Error('El archivo es demasiado grande para ser una configuración de Sloth.')
      const parsed = parseImport(readFileSync(file, 'utf8'))
      const token = randomUUID()
      pending.set(token, { parsed, at: Date.now() })
      return { token, file, plan: plan(parsed) }
    })

    ctx.handle('cancel', (token: unknown) => {
      if (typeof token === 'string') pending.delete(token)
    })

    ctx.handle('confirm', async (token: unknown): Promise<ImportResult> => {
      if (typeof token !== 'string' || !pending.has(token)) throw new Error('La vista previa venció: volvé a elegir el archivo.')
      const { parsed } = pending.get(token)!
      pending.delete(token)
      // El plan se recalcula ahora: puede haber cambiado algo desde la vista previa.
      const p = plan(parsed)
      const result: ImportResult = { cuentas: 0, espacios: 0, plantillas: [], errores: [] }

      for (const c of p.cuentas) {
        if (c.action !== 'crear') continue
        try {
          const src = parsed.cuentas.find((x) => x.label === c.label)!
          const acc = { ...createAccount(c.label), shareSetup: src.shareSetup }
          ctx.store.addAccount(acc)
          try {
            ctx.prepareAccount(acc)
          } catch (e) {
            ctx.log(`preparar ${acc.label}:`, (e as Error).message)
          }
          result.cuentas++
        } catch (e) {
          result.errores.push(`Cuenta «${c.label}»: ${(e as Error).message}`)
        }
      }

      const idByLabel = new Map<string, string>()
      for (const a of ctx.store.accounts) {
        const k = a.label.trim().toLowerCase()
        if (!idByLabel.has(k)) idByLabel.set(k, a.id)
      }

      for (let i = 0; i < p.espacios.length; i++) {
        const pw = p.espacios[i]
        if (pw.action !== 'agregar') continue
        const e = parsed.espacios[i]
        const accountId = idByLabel.get(e.cuenta.toLowerCase())
        if (!accountId) {
          result.errores.push(`Espacio «${e.name}»: no se encontró la cuenta «${e.cuenta}».`)
          continue
        }
        try {
          // Nunca se crean worktrees: si era uno, se usa su carpeta (ya existe) y después se anota la rama.
          const ws = await ctx.addWorkspace({
            name: e.name,
            repoPath: pw.folder,
            accountId,
            autoStartClaude: e.autoStartClaude,
            initialPrompt: e.initialPrompt,
            resume: e.resume,
            ticket: e.ticket
          })
          if (e.branch) ctx.store.updateWorkspace(ws.id, { repoPath: isDir(e.repoPath) ? e.repoPath : pw.folder, branch: e.branch })
          result.espacios++
        } catch (err) {
          result.errores.push(`Espacio «${e.name}»: ${(err as Error).message}`)
        }
      }

      result.plantillas = templatesToSave(parsed, p, idByLabel)

      ctx.log(`importado: ${result.cuentas} cuentas, ${result.espacios} espacios, ${result.plantillas.length} plantillas para guardar`)
      ctx.ui({ type: 'reload' })
      return result
    })
  }
}

export default feature
