import { app, dialog, nativeTheme, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { escribirJsonAtomico, leerJson, respaldar } from '../json-file'
import { avisar, avisoVersionFutura } from '../avisos'
import { migrar, type EstadoVersion } from '../versionado'
import { armarArchivo, leerSettings, type ArchivoSettings } from './settings-archivo'
import type { Feature, FeatureContext } from './context'
import {
  applyPatch,
  normalize,
  resetSection,
  resolveDark,
  type SettingsPayload,
  type SlothSettings,
  type ThemeChoice
} from '../../shared/settings-model'
import { SURFACE } from '../../shared/surfaces'
import { carpetaFeatures } from '../perfil'

/**
 * Función «settings» (lado main): guarda la Configuración en userData/features/settings.json,
 * la valida y avisa a la interfaz con `feat:settings:changed`. También aplica lo que es de main:
 * tema nativo (barra de título, diálogos) y «abrir al iniciar Windows».
 */
const file = (): string => join(carpetaFeatures(), 'settings.json')

const VERSION_SETTINGS = 1

let soloLectura = false
let futura = false
let porRespaldar = false
let resto: Record<string, unknown> = {}

interface Lectura extends ArchivoSettings {
  estado: EstadoVersion
}

// Solo devuelve: los flags del módulo los asigna read(), así una consulta (initialChrome) no los toca.
const validar = (v: unknown): Lectura | undefined => {
  const r = migrar(v, {}, VERSION_SETTINGS)
  if (r.estado === 'invalida') return undefined
  return { ...leerSettings(r.datos), estado: r.estado }
}

const sinArchivo = (): Lectura => ({ settings: normalize(undefined), resto: {}, estado: 'actual' })

function read(): SlothSettings {
  const l = leerJson(file(), { validar, porDefecto: sinArchivo }).valor
  futura = l.estado === 'futura'
  soloLectura = futura
  porRespaldar = l.estado === 'migrado'
  resto = l.resto
  if (futura) avisoVersionFutura(file())
  return l.settings
}

function guardar(): void {
  if (soloLectura) {
    if (futura) avisoVersionFutura(file())
    return
  }
  if (porRespaldar) {
    try {
      respaldar(file())
      porRespaldar = false
    } catch (e) {
      soloLectura = true
      avisar(`No pude respaldar settings.json antes de actualizarlo (${e instanceof Error ? e.message : String(e)}); no voy a guardar cambios hasta que reinicies Sloth.`)
      return
    }
  }
  escribirJsonAtomico(file(), armarArchivo(settings, resto, VERSION_SETTINGS))
}

/** Colores de la barra de título que dibuja Windows (los botones de ventana): el fondo es el --surface del tema (src/shared/surfaces.ts). */
const CHROME = {
  dark: { bg: SURFACE.dark, symbol: '#8b93a3' },
  night: { bg: SURFACE.night, symbol: '#8b93a3' },
  light: { bg: SURFACE.light, symbol: '#5c6474' }
}
const chromeFor = (theme: ThemeChoice, dark: boolean): { bg: string; symbol: string } =>
  !dark ? CHROME.light : theme === 'noche' ? CHROME.night : CHROME.dark

/**
 * Colores de la ventana ANTES de crearla (los usa src/main/index.ts en new BrowserWindow): así no
 * hay un destello oscuro al abrir con tema claro. Sincrónico, nunca tira.
 */
export function initialChrome(): { bg: string; symbol: string; dark: boolean } {
  try {
    const s = settings ?? leerJson(file(), { validar, porDefecto: sinArchivo, soloConsulta: true }).valor.settings
    nativeTheme.themeSource = themeSource(s.theme)
    const dark = resolveDark(s.theme, nativeTheme.shouldUseDarkColors)
    return { ...chromeFor(s.theme, dark), dark }
  } catch (e) {
    console.warn('[settings] no se pudo leer el tema antes de abrir la ventana:', e instanceof Error ? e.message : e)
    return { ...CHROME.dark, dark: true }
  }
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
  const c = chromeFor(settings.theme, dark)
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
  guardar()
  applyNative()
  if (loginChanged) applyLoginItem()
  const p = payload()
  ctxRef?.emit('changed', p)
  return p
}

/** Cambia la configuración desde main (mismas validaciones que la UI) y avisa a la ventana. */
export function patchSettings(patch: Partial<SlothSettings>): void {
  commit(applyPatch(settings, patch))
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
