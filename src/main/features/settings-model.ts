/**
 * Modelo de la Configuración de Sloth: tipos, valores por defecto y validación estricta.
 * Sin imports de Electron ni de Node: lo usan main (settings.ts), la interfaz y las pruebas.
 */

export type ThemeChoice = 'oscuro' | 'claro' | 'sistema'
export type Density = 'compacta' | 'cómoda'
export type TermFont = 'JetBrains Mono' | 'Cascadia Code' | 'Consolas'
export type CursorShape = 'barra' | 'bloque' | 'subrayado'

export interface TerminalSettings {
  fontSize: number
  fontFamily: TermFont
  lineHeight: number
  cursorStyle: CursorShape
  cursorBlink: boolean
}

export interface SlothSettings {
  theme: ThemeChoice
  density: Density
  uiFontSize: number
  terminal: TerminalSettings
  /** accountId → color de ACCOUNT_PALETTE. Las cuentas sin entrada usan el color automático. */
  accountColors: Record<string, string>
  openAtLogin: boolean
  confirmClosePanes: boolean
  /** Sonido suave al terminar o al pedir permiso (v0.5, función «sound»). Apagado por defecto. */
  sounds: boolean
}

/** Lo que main manda a la interfaz (get, set, reset y el evento «changed»). */
export interface SettingsPayload {
  settings: SlothSettings
  /** Tema efectivo: con «sistema» sigue a Windows. */
  dark: boolean
  /** «Abrir al iniciar Windows» solo se aplica en la app instalada. */
  loginItemSupported: boolean
}

export const THEMES: readonly ThemeChoice[] = ['oscuro', 'claro', 'sistema']
export const DENSITIES: readonly Density[] = ['compacta', 'cómoda']
export const TERM_FONTS: readonly TermFont[] = ['JetBrains Mono', 'Cascadia Code', 'Consolas']
export const CURSORS: readonly CursorShape[] = ['barra', 'bloque', 'subrayado']

export const UI_FONT = { min: 12, max: 15 } as const
export const TERM_FONT = { min: 11, max: 18 } as const
export const LINE_HEIGHT = { min: 1, max: 1.4, step: 0.05 } as const

/**
 * Colores de cuenta elegibles: tonos medios que superan 3:1 (contraste de elementos gráficos)
 * tanto sobre el fondo oscuro (#16181f) como sobre el claro (#f7f8fa). Lo verifica la prueba.
 */
export const ACCOUNT_PALETTE: readonly { hex: string; name: string }[] = [
  { hex: '#3b82f6', name: 'Azul' },
  { hex: '#6366f1', name: 'Índigo' },
  { hex: '#8b5cf6', name: 'Violeta' },
  { hex: '#d946ef', name: 'Fucsia' },
  { hex: '#e11d74', name: 'Frambuesa' },
  { hex: '#ef4444', name: 'Rojo' },
  { hex: '#ea580c', name: 'Naranja' },
  { hex: '#b07d10', name: 'Mostaza' },
  { hex: '#159a46', name: 'Verde' },
  { hex: '#0d9488', name: 'Turquesa' },
  { hex: '#0891b2', name: 'Cian' }
]
const PALETTE_SET = new Set(ACCOUNT_PALETTE.map((c) => c.hex))

export const MAX_ACCOUNT_COLORS = 64
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/

export const DEFAULT_SETTINGS: SlothSettings = {
  theme: 'oscuro',
  density: 'compacta',
  uiFontSize: 13,
  terminal: {
    fontSize: 13,
    fontFamily: 'JetBrains Mono',
    lineHeight: 1.15,
    cursorStyle: 'barra',
    cursorBlink: true
  },
  accountColors: {},
  openAtLogin: false,
  confirmClosePanes: true,
  sounds: false
}

export type SettingsSection = 'apariencia' | 'terminal' | 'cuentas' | 'comportamiento'
export const SECTIONS: readonly SettingsSection[] = ['apariencia', 'terminal', 'cuentas', 'comportamiento']

export const cloneSettings = (s: SlothSettings): SlothSettings => ({
  ...s,
  terminal: { ...s.terminal },
  accountColors: { ...s.accountColors }
})

/** Redondea la altura de línea al paso de 0,05 (evita 1.1500000002). */
const roundStep = (n: number): number => Math.round(n / LINE_HEIGHT.step) * LINE_HEIGHT.step
const fix2 = (n: number): number => Math.round(n * 100) / 100

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function checkKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new Error(`Ajuste desconocido: ${where}${k}.`)
}

function oneOf<T extends string>(v: unknown, list: readonly T[], label: string): T {
  if (typeof v !== 'string' || !list.includes(v as T)) throw new Error(`${label} tiene que ser ${list.map((x) => `«${x}»`).join(', ')}.`)
  return v as T
}

function intIn(v: unknown, min: number, max: number, label: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error(`${label} tiene que ser un entero entre ${min} y ${max}.`)
  return v
}

function bool(v: unknown, label: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`${label} tiene que ser sí o no.`)
  return v
}

function lineHeight(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('La altura de línea tiene que ser un número.')
  const r = fix2(roundStep(v))
  if (Math.abs(r - v) > 1e-6 || r < LINE_HEIGHT.min || r > LINE_HEIGHT.max)
    throw new Error(`La altura de línea va de ${LINE_HEIGHT.min} a ${LINE_HEIGHT.max}, en pasos de ${LINE_HEIGHT.step}.`)
  return r
}

export interface PatchOptions {
  /** Si se pasa, solo se aceptan colores para cuentas que existen (quitar siempre se puede). */
  accountExists?: (id: string) => boolean
}

/**
 * Aplica un cambio parcial validado. Cualquier clave desconocida o valor fuera de rango tira
 * un Error (no se aplica nada a medias). `accountColors` es un parche: color = asignar, null = quitar.
 */
export function applyPatch(current: SlothSettings, patch: unknown, opts: PatchOptions = {}): SlothSettings {
  if (!isObj(patch)) throw new Error('El cambio de configuración tiene que ser un objeto.')
  checkKeys(patch, ['theme', 'density', 'uiFontSize', 'terminal', 'accountColors', 'openAtLogin', 'confirmClosePanes', 'sounds'], '')
  const next = cloneSettings(current)
  if ('theme' in patch) next.theme = oneOf(patch.theme, THEMES, 'El tema')
  if ('density' in patch) next.density = oneOf(patch.density, DENSITIES, 'La densidad')
  if ('uiFontSize' in patch) next.uiFontSize = intIn(patch.uiFontSize, UI_FONT.min, UI_FONT.max, 'El tamaño de letra')
  if ('openAtLogin' in patch) next.openAtLogin = bool(patch.openAtLogin, '«Abrir al iniciar Windows»')
  if ('confirmClosePanes' in patch) next.confirmClosePanes = bool(patch.confirmClosePanes, '«Confirmar al cerrar»')
  if ('sounds' in patch) next.sounds = bool(patch.sounds, '«Sonidos»')
  if ('terminal' in patch) {
    const t = patch.terminal
    if (!isObj(t)) throw new Error('terminal tiene que ser un objeto.')
    checkKeys(t, ['fontSize', 'fontFamily', 'lineHeight', 'cursorStyle', 'cursorBlink'], 'terminal.')
    if ('fontSize' in t) next.terminal.fontSize = intIn(t.fontSize, TERM_FONT.min, TERM_FONT.max, 'El tamaño de la terminal')
    if ('fontFamily' in t) next.terminal.fontFamily = oneOf(t.fontFamily, TERM_FONTS, 'La fuente')
    if ('lineHeight' in t) next.terminal.lineHeight = lineHeight(t.lineHeight)
    if ('cursorStyle' in t) next.terminal.cursorStyle = oneOf(t.cursorStyle, CURSORS, 'El cursor')
    if ('cursorBlink' in t) next.terminal.cursorBlink = bool(t.cursorBlink, 'El parpadeo')
  }
  if ('accountColors' in patch) {
    const c = patch.accountColors
    if (!isObj(c)) throw new Error('accountColors tiene que ser un objeto.')
    for (const [id, color] of Object.entries(c)) {
      if (!ACCOUNT_ID.test(id)) throw new Error('Id de cuenta inválido.')
      if (color === null) {
        delete next.accountColors[id]
        continue
      }
      if (typeof color !== 'string' || !PALETTE_SET.has(color.toLowerCase())) throw new Error('Ese color no está en la paleta.')
      if (opts.accountExists && !opts.accountExists(id)) throw new Error('Esa cuenta no existe.')
      next.accountColors[id] = color.toLowerCase()
    }
    if (Object.keys(next.accountColors).length > MAX_ACCOUNT_COLORS) throw new Error('Demasiados colores de cuenta.')
  }
  return next
}

/** Lee lo guardado en disco con tolerancia: cada campo inválido vuelve a su valor por defecto. */
export function normalize(raw: unknown): SlothSettings {
  const out = cloneSettings(DEFAULT_SETTINGS)
  if (!isObj(raw)) return out
  const tryPatch = (p: Record<string, unknown>): void => {
    try {
      const n = applyPatch(out, p)
      Object.assign(out, n)
    } catch {
      /* campo inválido: queda el valor por defecto */
    }
  }
  for (const k of ['theme', 'density', 'uiFontSize', 'openAtLogin', 'confirmClosePanes', 'sounds'] as const) if (k in raw) tryPatch({ [k]: raw[k] })
  if (isObj(raw.terminal))
    for (const [k, v] of Object.entries(raw.terminal)) tryPatch({ terminal: { [k]: v } })
  if (isObj(raw.accountColors))
    for (const [id, v] of Object.entries(raw.accountColors).slice(0, MAX_ACCOUNT_COLORS)) tryPatch({ accountColors: { [id]: v } })
  return out
}

/** Vuelve una sección a sus valores por defecto (lo demás queda igual). */
export function resetSection(current: SlothSettings, section: unknown): SlothSettings {
  const next = cloneSettings(current)
  const d = DEFAULT_SETTINGS
  switch (section) {
    case 'apariencia':
      next.theme = d.theme
      next.density = d.density
      next.uiFontSize = d.uiFontSize
      break
    case 'terminal':
      next.terminal = { ...d.terminal }
      break
    case 'cuentas':
      next.accountColors = {}
      break
    case 'comportamiento':
      next.openAtLogin = d.openAtLogin
      next.confirmClosePanes = d.confirmClosePanes
      next.sounds = d.sounds
      break
    default:
      throw new Error('Sección desconocida.')
  }
  return next
}

/** Tema efectivo: «sistema» depende de lo que diga Windows. */
export const resolveDark = (theme: ThemeChoice, systemDark: boolean): boolean =>
  theme === 'oscuro' ? true : theme === 'claro' ? false : systemDark
