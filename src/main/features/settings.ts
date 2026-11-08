import { app, dialog, nativeTheme, type BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Feature, FeatureContext } from './context'
import {
  applyPatch,
  normalize,
  resetSection,
  resolveDark,
  type SettingsPayload,
  type SlothSettings,
  type ThemeChoice
} from './settings-model'

/**
 * Función «settings» (lado main): guarda la Configuración en userData/features/settings.json,
 * la valida y avisa a la interfaz con `feat:settings:changed`. También aplica lo que es de main:
 * tema nativo (barra de título, diálogos) y «abrir al iniciar Windows».
 */
const file = (): string => join(app.getPath('userData'), 'features', 'settings.json')

/** Escritura atómica: tmp + rename (nunca queda un JSON a medias). */
function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, path)
}

function read(): SlothSettings {
  try {
    return normalize(JSON.parse(readFileSync(file(), 'utf8').replace(/^﻿/, '')))
  } catch {
    return normalize(undefined)
  }
}

/** Colores de la barra de título que dibuja Windows (los botones de ventana), por tema. */
const CHROME = {
  // Igual a --bg del estilo A (theme-a.css) y del claro (themes.css).
  dark: { bg: '#111318', symbol: '#8b93a3' },
  light: { bg: '#f1f2f5', symbol: '#5c6474' }
}

/**
 * Colores de la ventana ANTES de crearla (los usa src/main/index.ts en new BrowserWindow): así no
 * hay un destello oscuro al abrir con tema claro. Sincrónico, nunca tira.
 */
export function initialChrome(): { bg: string; symbol: string; dark: boolean } {
  const s = read()
  nativeTheme.themeSource = themeSource(s.theme)
  const dark = resolveDark(s.theme, nativeTheme.shouldUseDarkColors)
  return { ...(dark ? CHROME.dark : CHROME.light), dark }
}

/** «Según Windows» sigue al sistema en vivo (evento nativeTheme «updated»); los demás fijan el tema. */
const themeSource = (t: ThemeChoice): 'dark' | 'light' | 'system' => (t === 'sistema' ? 'system' : t === 'claro' ? 'light' : 'dark')

let settings: SlothSettings
let ctxRef: FeatureContext | null = null

/** Ajustes vigentes (los lee también la función «permissions» para avisos y «No molestar»). */
export function currentSettings(): SlothSettings {
  return settings ?? read()
}
let lastDark: boolean | null = null

const loginSupported = (): boolean => app.isPackaged && process.platform === 'win32'

function payload(): SettingsPayload {
  return {
    settings,
    dark: resolveDark(settings.theme, nativeTheme.shouldUseDarkColors),
    loginItemSupported: loginSupported(),
    documentsDir: app.getPath('documents')
  }
}

function paintWindow(win: BrowserWindow | null, dark: boolean): void {
  if (!win || win.isDestroyed()) return
  const c = dark ? CHROME.dark : CHROME.light
  try {
    win.setBackgroundColor(c.bg)
    win.setTitleBarOverlay({ color: c.bg, symbolColor: c.symbol })
  } catch {
    /* sin overlay (otra plataforma): no pasa nada */
  }
}

function applyNative(): void {
  nativeTheme.themeSource = themeSource(settings.theme)
  const dark = resolveDark(settings.theme, nativeTheme.shouldUseDarkColors)
  lastDark = dark
  paintWindow(ctxRef?.window() ?? null, dark)
}

function applyLoginItem(): void {
  if (!loginSupported()) return
  try {
    app.setLoginItemSettings({ openAtLogin: settings.openAtLogin })
  } catch (e) {
    ctxRef?.log('[settings] setLoginItemSettings', e)
  }
}

function commit(next: SlothSettings): SettingsPayload {
  const loginChanged = next.openAtLogin !== settings.openAtLogin
  settings = next
  writeJsonAtomic(file(), settings)
  applyNative()
  if (loginChanged) applyLoginItem()
  const p = payload()
  ctxRef?.emit('changed', p)
  return p
}

const feature: Feature = {
  name: 'settings',
  register(ctx) {
    ctxRef = ctx
    settings = read()
    // Lo que diga Windows manda: si el usuario lo apagó desde el Administrador de tareas, se refleja.
    if (loginSupported()) {
      try {
        settings.openAtLogin = app.getLoginItemSettings().openAtLogin
      } catch {
        /* queda lo guardado */
      }
    }
    applyNative()

    ctx.onWindow((win) => paintWindow(win, resolveDark(settings.theme, nativeTheme.shouldUseDarkColors)))

    // Con «sistema», seguir a Windows sin recargar. Sin timers: es un evento del sistema.
    nativeTheme.on('updated', () => {
      const dark = resolveDark(settings.theme, nativeTheme.shouldUseDarkColors)
      if (dark === lastDark) return
      lastDark = dark
      paintWindow(ctx.window(), dark)
      ctx.emit('changed', payload())
    })

    ctx.handle('get', () => payload())
    ctx.handle('set', (patch: unknown) => {
      if (JSON.stringify(patch ?? null).length > 8_192) throw new Error('Cambio demasiado grande.')
      return commit(applyPatch(settings, patch, { accountExists: (id) => !!ctx.store.account(id) }))
    })
    ctx.handle('reset', (section: unknown) => commit(resetSection(settings, section)))
    // Carpeta de proyectos: el diálogo nativo lo abre main; la interfaz solo recibe la ruta elegida.
    ctx.handle('pickProjectsDir', async () => {
      const win = ctx.window()
      const opts = { properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[], title: 'Carpeta de proyectos' }
      const r = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || !r.filePaths[0]) return payload()
      return commit(applyPatch(settings, { projectsDir: r.filePaths[0] }))
    })
  }
}

export default feature
