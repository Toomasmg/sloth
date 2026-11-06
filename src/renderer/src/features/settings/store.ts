import { useSyncExternalStore } from 'react'
import type { ITheme } from '@xterm/xterm'
import { api } from '../../api'
import {
  DEFAULT_SETTINGS,
  cloneSettings,
  normalize,
  type SettingsPayload,
  type SettingsSection,
  type SlothSettings,
  type TerminalSettings
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
    return { settings: normalize(p.settings), dark: p.dark !== false, loginItemSupported: p.loginItemSupported === true }
  } catch {
    return null
  }
}

let state: SettingsPayload = readCache() ?? { settings: cloneSettings(DEFAULT_SETTINGS), dark: true, loginItemSupported: false }
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

/** Atributos que usa themes.css: data-theme, data-density y --ui-font-size. */
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
  el.dataset.density = p.settings.density === 'cómoda' ? 'comfortable' : 'compact'
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

type Patch = Partial<Omit<SlothSettings, 'terminal' | 'accountColors'>> & {
  terminal?: Partial<TerminalSettings>
  accountColors?: Record<string, string | null>
}

/** Cambia al instante (vista previa) y después guarda; si main lo rechaza, vuelve atrás. */
export async function updateSettings(patch: Patch): Promise<void> {
  const prev = state
  const s = cloneSettings(prev.settings)
  const { terminal, accountColors, ...rest } = patch
  Object.assign(s, rest)
  if (terminal) Object.assign(s.terminal, terminal)
  if (accountColors)
    for (const [id, c] of Object.entries(accountColors)) {
      if (c === null) delete s.accountColors[id]
      else s.accountColors[id] = c
    }
  // «sistema» lo resuelve main (sabe qué dice Windows); claro/oscuro se ven ya.
  const dark = s.theme === 'oscuro' ? true : s.theme === 'claro' ? false : prev.dark
  set({ ...prev, settings: s, dark })
  try {
    set(await api.feat.invoke<SettingsPayload>('feat:settings:set', patch))
  } catch (e) {
    set(prev)
    throw e
  }
}

export async function resetSettings(section: SettingsSection): Promise<void> {
  set(await api.feat.invoke<SettingsPayload>('feat:settings:reset', section))
}

/* ---------- Terminal ---------- */

const FONT_STACK: Record<TerminalSettings['fontFamily'], string> = {
  'JetBrains Mono': '"JetBrains Mono Variable", "Cascadia Code", Consolas, monospace',
  'Cascadia Code': '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
  Consolas: 'Consolas, "Cascadia Mono", monospace'
}
export const termFontStack = (f: TerminalSettings['fontFamily']): string => FONT_STACK[f]

const CURSOR = { barra: 'bar', bloque: 'block', subrayado: 'underline' } as const

export const TERM_THEME_DARK: ITheme = {
  background: '#12141a',
  foreground: '#e3ebf0',
  cursor: '#9feaf9',
  cursorAccent: '#12141a',
  selectionBackground: '#2c4a52',
  black: '#2f3444',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#9feaf9',
  white: '#cbd5e1',
  brightBlack: '#6b7385',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#f8fafc'
}

/** Claro (dirección A): matices oscurecidos para leerse sobre blanco; «white» pasa a gris (si no, desaparece). */
export const TERM_THEME_LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#1f2430',
  cursor: '#3b7681',
  cursorAccent: '#ffffff',
  selectionBackground: '#cfe3e7',
  black: '#1f2430',
  red: '#b91c1c',
  green: '#15803d',
  yellow: '#8a5a00',
  blue: '#1d4ed8',
  magenta: '#8b2fc9',
  cyan: '#0e7490',
  white: '#5c6474',
  brightBlack: '#6b7280',
  brightRed: '#c42b2b',
  brightGreen: '#17703a',
  brightYellow: '#9a4a06',
  brightBlue: '#2563eb',
  brightMagenta: '#a21caf',
  brightCyan: '#0b6a83',
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
}

export function termOptions(p: SettingsPayload = state): TermOptions {
  const t = p.settings.terminal
  return {
    fontFamily: termFontStack(t.fontFamily),
    fontSize: t.fontSize,
    lineHeight: t.lineHeight,
    cursorStyle: CURSOR[t.cursorStyle],
    cursorBlink: t.cursorBlink,
    theme: p.dark ? TERM_THEME_DARK : TERM_THEME_LIGHT,
    minimumContrastRatio: p.dark ? 1 : 4.5
  }
}

/* ---------- Colores de cuenta ---------- */

/** Color elegido para la cuenta, o undefined si usa el automático. Para que el núcleo lo use en colorOf. */
export const customAccountColor = (accountId: string | undefined): string | undefined =>
  accountId ? state.settings.accountColors[accountId] : undefined
