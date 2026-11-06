import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Feature, FeatureContext } from './context'
import { isVersion, parseHelpState, whatsNewFor } from './help-core'
import { CHANGELOG } from '../../shared/changelog'

/**
 * Función «help» (lado main): «Novedades» (qué versión vio por última vez el usuario).
 * Canales: feat:help:whatsnew → { current, lastSeen, show, entries }, feat:help:seen(version) → void.
 * Estado: userData/features/help.json, { lastSeen }. Escritura atómica (tmp + rename).
 */
const file = (): string => join(app.getPath('userData'), 'features', 'help.json')

function readLastSeen(): string | null {
  try {
    return parseHelpState(JSON.parse(readFileSync(file(), 'utf8').replace(/^﻿/, ''))).lastSeen
  } catch {
    return null
  }
}

function writeLastSeen(version: string): void {
  const path = file()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ lastSeen: version }, null, 2), 'utf8')
  renameSync(tmp, path)
}

const feature: Feature = {
  name: 'help',
  register(ctx: FeatureContext) {
    ctx.handle('whatsnew', () => {
      const current = app.getVersion()
      const lastSeen = readLastSeen()
      if (lastSeen === null && (ctx.store.accounts.length > 0 || ctx.store.workspaces.length > 0)) {
        // Sin help.json pero con cuentas o espacios: viene de la 0.4 (antes no existía este archivo).
        // Se le muestran las novedades desde la 0.4.0 una vez.
        return whatsNewFor(CHANGELOG, '0.4.0', current)
      }
      if (lastSeen === null) {
        // Primera instalación: se marca la versión actual y no se muestran novedades.
        try {
          writeLastSeen(current)
        } catch (e) {
          ctx.log('help: no se pudo guardar la versión vista', e)
        }
        return { current, lastSeen: null, show: false, entries: [] }
      }
      return whatsNewFor(CHANGELOG, lastSeen, current)
    })

    ctx.handle('seen', (version: unknown) => {
      if (!isVersion(version)) throw new Error('Versión inválida')
      writeLastSeen(version)
    })
  }
}

export default feature
