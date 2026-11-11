import { useSyncExternalStore } from 'react'
import type { ITheme } from '@xterm/xterm'
import { api } from '../../api'
import { accountColor } from '../../format'
import {
  DEFAULT_SETTINGS,
  SCROLLBACK,
  cloneSettings,
  normalize,
  type SettingsPayload,
  type SettingsSection,
  type ShortcutId,
  type SlothSettings,
  type TerminalSettings,
  type NotifySettings
} from '../../../../main/features/settings-model'

/**
 * Estado de la Configuración en la interfaz (fuera de React, para que lo lean main.tsx y
 * TerminalView sin contexto). Se aplica al <html> al instante y se guarda en main.
 */

const CACHE_KEY = 'sloth.settings.v1'

const readCache = (): SettingsPayload | null => {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<SettingsPayload>
    return {
      settings: normalize(p.settings),
      dark: p.dark !== false,
      loginItemSupported: p.loginItemSupported === true,
      documentsDir: typeof p.documentsDir === 'string' ? p.documentsDir : ''
    }
  } catch {
    return null
  }
}

let state: SettingsPayload =
  readCache() ?? { settings: cloneSettings(DEFAULT_SETTINGS), dark: true, loginItemSupported: false, documentsDir: '' }
const listeners = new Set<() => void>()

function set(next: SettingsPayload): void {
  state = next
  applyToDocument(next)
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(next))
  } catch {
    /* sin storage: no pasa nada */
  }
  listeners.forEach((l) => l())
}

export const getSettings = (): SettingsPayload => state
export function subscribeSettings(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
export const useSettings = (): SettingsPayload => useSyncExternalStore(subscribeSettings, getSettings)

let switchTimer: ReturnType<typeof setTimeout> | undefined

/** Atributos que usan los temas: data-theme, data-accent, data-night, data-density y --ui-font-size. */
export function applyToDocument(p: SettingsPayload): void {
  const el = document.documentElement
  const theme = p.dark ? 'dark' : 'light'
  // Transición corta solo al cambiar de tema (no en el arranque); themes.css la apaga con «reducir movimiento».
  if (el.dataset.theme && el.dataset.theme !== theme) {
    el.classList.add('f-settings-switching')
    clearTimeout(switchTimer)
    switchTimer = setTimeout(() => el.classList.remove('f-settings-switching'), 220)
  }
  el.dataset.theme = theme
  el.dataset.accent = p.settings.accent
  if (p.settings.theme === 'noche') el.dataset.night = 'true'
  else delete el.dataset.night
  el.dataset.density = p.settings.density === 'cómoda' ? 'comfortable' : 'compact'
  // Modo liviano: CSS apaga animaciones, sombras y fotos (styles.css). Ver lightMode en el modelo.
  if (p.settings.lightMode) el.dataset.lite = 'true'
  else delete el.dataset.lite
  el.style.setProperty('--ui-font-size', `${p.settings.uiFontSize}px`)
  el.style.colorScheme = p.dark ? 'dark' : 'light'
}

let started = false
/** Aplica lo último conocido ya mismo y confirma con main (con tope de espera para no trabar el arranque). */
export async function initSettings(): Promise<void> {
  if (started) return
  started = true
  applyToDocument(state)
  try {
    api.feat.on('feat:settings:changed', (p: SettingsPayload) => set(p))
  } catch {
    /* sin preload de funciones */
  }
  const fresh = api.feat.invoke<SettingsPayload>('feat:settings:get').then(
    (p) => p && set(p),
    () => undefined
  )
  await Promise.race([fresh, new Promise((r) => setTimeout(r, 700))])
}

/** Cambio parcial. Los mapas (terminal, notify) se fusionan; accountColors y shortcuts: null quita. */
export type SettingsPatch = Partial<Omit<SlothSettings, 'terminal' | 'accountColors' | 'accountPlans' | 'notify' | 'shortcuts'>> & {
  terminal?: Partial<TerminalSettings>
  notify?: Partial<NotifySettings>
  accountPlans?: Record<string, string | null>
  accountColors?: Record<string, string | null>
  shortcuts?: Partial<Record<ShortcutId, string | null>>
}

/** Cambia al instante (vista previa) y después guarda; si main lo rechaza, vuelve atrás. */
export async function updateSettings(patch: SettingsPatch): Promise<void> {
  const prev = state
  const s = cloneSettings(prev.settings)
  const { terminal, accountColors, accountPlans, notify, shortcuts, ...rest } = patch
  Object.assign(s, rest)
  if (terminal) Object.assign(s.terminal, terminal)
  if (notify) Object.assign(s.notify, notify)
  if (accountColors)
    for (const [id, c] of Object.entries(accountColors)) {
      if (c === null) delete s.accountColors[id]
      else s.accountColors[id] = c
    }
  if (accountPlans)
    for (const [id, c] of Object.entries(accountPlans)) {
      if (c === null) delete s.accountPlans[id]
      else s.accountPlans[id] = c
    }
  if (shortcuts)
    for (const [id, c] of Object.entries(shortcuts)) {
      const k = id as ShortcutId
      if (c === null || c === undefined) delete s.shortcuts[k]
      else s.shortcuts[k] = c
    }
  // «Según Windows» lo resuelve main (sabe qué dice Windows); los demás temas se ven ya.
  const dark = s.theme === 'sistema' ? prev.dark : s.theme !== 'claro'
  set({ ...prev, settings: s, dark })
  try {
    set(await api.feat.invoke<SettingsPayload>('feat:settings:set', patch))
  } catch (e) {
    set(prev)
    throw e
  }
}

/** Reemplaza el estado con lo que devuelve main (reset, elegir carpeta…). */
export function replaceSettings(p: SettingsPayload): void {
  set(p)
}

export async function resetSettings(section: SettingsSection): Promise<void> {
  set(await api.feat.invoke<SettingsPayload>('feat:settings:reset', section))
}

/** Abre el diálogo de carpeta en main y guarda la elegida (o no cambia nada si se cancela). */
export async function pickProjectsDir(): Promise<void> {
  set(await api.feat.invoke<SettingsPayload>('feat:settings:pickProjectsDir'))
}

/** Carpeta de proyectos efectiva: la elegida o Documentos. */
export const projectsDirOf = (p: SettingsPayload = state): string => p.settings.projectsDir || p.documentsDir

/* ---------- Terminal ---------- */

const FONT_STACK: Record<TerminalSettings['fontFamily'], string> = {
  'JetBrains Mono': '"JetBrains Mono Variable", "Cascadia Code", Consolas, monospace',
  'Cascadia Code': '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
  Consolas: 'Consolas, "Cascadia Mono", monospace'
}
export const termFontStack = (f: TerminalSettings['fontFamily']): string => FONT_STACK[f]

const CURSOR = { barra: 'bar', bloque: 'block', subrayado: 'underline' } as const

/**
 * Colores de xterm cuando el documento no tiene tokens (tests, primer pintado). Los valores son los
 * mismos tokens de themes.css (--term-*) y de la paleta Sloth; los ANSI siguen la paleta del diseño.
 */
export const TERM_THEME_DARK: ITheme = {
  background: '#12141a',
  foreground: '#c9cdd6',
  cursor: '#8ab4ff',
  cursorAccent: '#12141a',
  selectionBackground: 'rgba(138, 180, 255, 0.3)',
  black: '#2f3444',
  red: '#f87171',
  green: '#5fd4a6',
  yellow: '#f0b45a',
  blue: '#8ab4ff',
  magenta: '#b59cff',
  cyan: '#7fb8e6',
  white: '#cbd5e1',
  brightBlack: '#6f7480',
  brightRed: '#fca5a5',
  brightGreen: '#7fe0b9',
  brightYellow: '#fde68a',
  brightBlue: '#a9c7ff',
  brightMagenta: '#d2c3ff',
  brightCyan: '#a9d6f2',
  brightWhite: '#f8fafc'
}

/** Claro: matices oscurecidos para leerse sobre blanco; «white» pasa a gris (si no, desaparece). */
export const TERM_THEME_LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#1f2430',
  cursor: '#2f6fe0',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(47, 111, 224, 0.2)',
  black: '#1f2430',
  red: '#b91c1c',
  green: '#1a7f57',
  yellow: '#8a5a00',
  blue: '#2f6fe0',
  magenta: '#6f4fd6',
  cyan: '#1d6fa8',
  white: '#5c6474',
  brightBlack: '#6b7280',
  brightRed: '#c42b2b',
  brightGreen: '#13663f',
  brightYellow: '#9a4a06',
  brightBlue: '#2459b8',
  brightMagenta: '#5a3cc0',
  brightCyan: '#16608c',
  brightWhite: '#374151'
}

export interface TermOptions {
  fontFamily: string
  fontSize: number
  lineHeight: number
  cursorStyle: 'bar' | 'block' | 'underline'
  cursorBlink: boolean
  theme: ITheme
  /** En claro, xterm sube el contraste de colores pensados para fondo oscuro (p. ej. los de Claude). */
  minimumContrastRatio: number
  /** Líneas de historial de cada terminal. */
  scrollback: number
}

/**
 * Lee un token CSS del tema aplicado. Vacío (tests, sin CSS) o si el tema del documento no es el
 * que pide `p`: se usa la constante de siempre.
 */
function themeToken(name: string, dark: boolean): string | undefined {
  if (typeof document === 'undefined') return undefined
  const el = document.documentElement
  if (el.dataset.theme !== (dark ? 'dark' : 'light')) return undefined
  const v = getComputedStyle(el).getPropertyValue(name).trim()
  return v || undefined
}

/**
 * El tema de xterm sale de los tokens del tema aplicado (--term-*, y el acento para el cursor), así que
 * cambia con el tema y con el color de acento. Los ANSI quedan como la paleta de arriba.
 */
function termTheme(dark: boolean): ITheme {
  const base = dark ? TERM_THEME_DARK : TERM_THEME_LIGHT
  const background = themeToken('--term-bg', dark) ?? base.background
  return {
    ...base,
    background,
    foreground: themeToken('--term-fg', dark) ?? base.foreground,
    cursor: themeToken('--accent', dark) ?? themeToken('--term-cursor', dark) ?? base.cursor,
    cursorAccent: background,
    selectionBackground: themeToken('--term-selection', dark) ?? base.selectionBackground
  }
}

export function termOptions(p: SettingsPayload = state): TermOptions {
  const t = p.settings.terminal
  return {
    fontFamily: termFontStack(t.fontFamily),
    fontSize: t.fontSize,
    lineHeight: t.lineHeight,
    cursorStyle: CURSOR[t.cursorStyle],
    cursorBlink: t.cursorBlink,
    theme: termTheme(p.dark),
    minimumContrastRatio: p.dark ? 1 : 4.5,
    // En modo liviano, el historial de cada terminal es el mínimo.
    scrollback: p.settings.lightMode ? SCROLLBACK.min : t.scrollback
  }
}

/* ---------- Colores de cuenta ---------- */

/** Color elegido para la cuenta, o undefined si usa el automático. Para que el núcleo lo use en colorOf. */
export const customAccountColor = (accountId: string | undefined): string | undefined =>
  accountId ? state.settings.accountColors[accountId] : undefined

/**
 * Color de identidad de una cuenta: el elegido en Configuración o, si no hay, el automático por
 * posición. Es LA función que usan App (colorOf), broadcast y el tablero de Gruv.
 */
export const resolveAccountColor = (accountId: string | undefined, index: number, p: SettingsPayload = state): string =>
  (accountId ? p.settings.accountColors[accountId] : undefined) ?? accountColor(index)
