/**
 * Modelo de la Configuración de Sloth: tipos, valores por defecto y validación estricta.
 * Sin imports de Electron ni de Node: lo usan main (settings.ts), la interfaz y las pruebas.
 */

export type ThemeChoice = 'oscuro' | 'noche' | 'claro' | 'sistema'
export type Density = 'compacta' | 'cómoda'
export type TermFont = 'JetBrains Mono' | 'Cascadia Code' | 'Consolas'
export type CursorShape = 'barra' | 'bloque' | 'subrayado'
export type AccentChoice = 'cielo' | 'hoja' | 'lila' | 'ambar'
export type ShellChoice = 'PowerShell 7' | 'Windows PowerShell' | 'Git Bash' | 'Símbolo del sistema'
export type EditorChoice = 'VS Code' | 'Cursor' | 'Windsurf' | 'Bloc de notas'
export type SoundName = 'Gota' | 'Campana suave' | 'Clic'
export type UpdateChannel = 'estable' | 'beta'
/** Atajos que se pueden cambiar (ids estables: los usa shortcuts.ts y el main los guarda tal cual). */
export type ShortcutId = 'palette' | 'new' | 'sidebar' | 'broadcast' | 'layout' | 'settings' | 'chat' | 'history' | 'rename' | 'help' | 'focus1' | 'focus2' | 'focus3' | 'focus4' | 'broadcastNow' | 'dictado'

export interface TerminalSettings {
  fontSize: number
  fontFamily: TermFont
  lineHeight: number
  cursorStyle: CursorShape
  cursorBlink: boolean
  /** Shell de los espacios nuevos. */
  shell: ShellChoice
  /** Líneas de historial por terminal (scrollback de xterm). */
  scrollback: number
}

/** Qué avisa Sloth. «No molestar» es `SlothSettings.noMolestar`. */
export interface NotifySettings {
  /** Claude termina una tarea. */
  done: boolean
  /** Claude pide permiso. */
  perm: boolean
  /** Mensajes directos y menciones del chat del equipo. */
  team: boolean
  /** Suena al llegar un mensaje ajeno del chat. */
  soundIn: boolean
  /** Suena (más suave) al enviar un mensaje propio del chat. */
  soundOut: boolean
}

/** Opciones de «Dormir espacios inactivos» (minutos; 0 = nunca). */
export const SLEEP_MINUTES = [0, 15, 30, 60, 120] as const
export type SleepMinutes = (typeof SLEEP_MINUTES)[number]

export interface SlothSettings {
  theme: ThemeChoice
  density: Density
  uiFontSize: number
  accent: AccentChoice
  terminal: TerminalSettings
  /** accountId → color de ACCOUNT_PALETTE. Las cuentas sin entrada usan el color automático. */
  accountColors: Record<string, string>
  /** accountId → plan escrito a mano («Pro», «Max»…). Es una etiqueta: Sloth nunca la lee de credenciales. */
  accountPlans: Record<string, string>
  openAtLogin: boolean
  confirmClosePanes: boolean
  /** Reabrir los espacios que estaban abiertos al iniciar (lo aplica la app al arrancar). */
  reopenSpaces: boolean
  /** Dejar las terminales vivas al cerrar la ventana (el daemon sigue corriendo). */
  keepTerminalsAlive: boolean
  /** Preguntar antes de cerrar Sloth con la X si hay terminales corriendo. */
  confirmQuit: boolean
  /** Minutos sin actividad para dormir un espacio (cerrar su Claude y retomarlo al volver). 0 = nunca. */
  sleepAfterMin: SleepMinutes
  /** Editor para «Abrir en editor». */
  editor: EditorChoice
  /** Carpeta de proyectos. Vacía = la carpeta Documentos del usuario. */
  projectsDir: string
  /** Sonido suave al terminar o al pedir permiso. Apagado = «Sin sonido». */
  sounds: boolean
  soundName: SoundName
  /** «No molestar»: silencia sonidos y avisos hasta que se apague. Lo lee también el paquete de permisos. */
  noMolestar: boolean
  notify: NotifySettings
  /** Canal del updater: estable (recomendado) o beta. */
  updateChannel: UpdateChannel
  /**
   * Modo liviano para PCs con pocos recursos: menos efectos (sin animaciones, sombras ni fotos) y menos
   * trabajo en segundo plano (consultas al doble de intervalo, historial de 7 días, scrollback mínimo).
   */
  lightMode: boolean
  /** Atajos personalizados: id → combinación canónica («Ctrl Shift K»). Sin entrada = el por defecto. */
  shortcuts: Partial<Record<ShortcutId, string>>
}

/** Lo que main manda a la interfaz (get, set, reset y el evento «changed»). */
export interface SettingsPayload {
  settings: SlothSettings
  /** Tema efectivo: con «sistema» sigue a Windows. */
  dark: boolean
  /** «Abrir al iniciar Windows» solo se aplica en la app instalada. */
  loginItemSupported: boolean
  /** Carpeta Documentos del usuario (default de la carpeta de proyectos). */
  documentsDir: string
}

export const THEMES: readonly ThemeChoice[] = ['oscuro', 'noche', 'claro', 'sistema']
/** Sugerencias para el plan de cuenta (etiqueta manual, texto libre). */
export const PLAN_SUGGESTIONS: readonly string[] = ['Pro', 'Max', 'Team']
export const MAX_PLAN = 20
export const DENSITIES: readonly Density[] = ['compacta', 'cómoda']
export const TERM_FONTS: readonly TermFont[] = ['JetBrains Mono', 'Cascadia Code', 'Consolas']
export const CURSORS: readonly CursorShape[] = ['barra', 'bloque', 'subrayado']
export const ACCENTS: readonly AccentChoice[] = ['cielo', 'hoja', 'lila', 'ambar']
export const SHELLS: readonly ShellChoice[] = ['PowerShell 7', 'Windows PowerShell', 'Git Bash', 'Símbolo del sistema']
export const EDITORS: readonly EditorChoice[] = ['VS Code', 'Cursor', 'Windsurf', 'Bloc de notas']
export const SOUND_NAMES: readonly SoundName[] = ['Gota', 'Campana suave', 'Clic']
export const UPDATE_CHANNELS: readonly UpdateChannel[] = ['estable', 'beta']
export const SHORTCUT_IDS: readonly ShortcutId[] = ['palette', 'new', 'sidebar', 'broadcast', 'layout', 'settings', 'chat', 'history', 'rename', 'help', 'focus1', 'focus2', 'focus3', 'focus4', 'broadcastNow', 'dictado']

export const UI_FONT = { min: 12, max: 16 } as const
export const TERM_FONT = { min: 11, max: 18 } as const
export const LINE_HEIGHT = { min: 1, max: 1.4, step: 0.05 } as const
export const SCROLLBACK = { min: 1000, max: 20000, step: 500, default: 5000 } as const

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
export const MAX_SHORTCUTS = 32
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_PATH = 260

export const DEFAULT_SETTINGS: SlothSettings = {
  theme: 'oscuro',
  density: 'compacta',
  uiFontSize: 13,
  accent: 'cielo',
  terminal: {
    fontSize: 12.5,
    fontFamily: 'JetBrains Mono',
    lineHeight: 1,
    cursorStyle: 'barra',
    cursorBlink: true,
    shell: 'PowerShell 7',
    scrollback: SCROLLBACK.default
  },
  accountColors: {},
  accountPlans: {},
  openAtLogin: false,
  confirmClosePanes: true,
  reopenSpaces: true,
  keepTerminalsAlive: true,
  confirmQuit: true,
  sleepAfterMin: 0,
  editor: 'VS Code',
  projectsDir: '',
  sounds: false,
  soundName: 'Gota',
  noMolestar: false,
  notify: { done: true, perm: true, team: true, soundIn: true, soundOut: true },
  updateChannel: 'estable',
  lightMode: false,
  shortcuts: {}
}

/** Secciones que se pueden restaurar por separado (`reset`). */
export type SettingsSection = 'apariencia' | 'terminal' | 'cuentas' | 'general' | 'notif' | 'atajos' | 'updates'
export const SECTIONS: readonly SettingsSection[] = ['apariencia', 'terminal', 'cuentas', 'general', 'notif', 'atajos', 'updates']

export const cloneSettings = (s: SlothSettings): SlothSettings => ({
  ...s,
  terminal: { ...s.terminal },
  accountColors: { ...s.accountColors },
  accountPlans: { ...s.accountPlans },
  notify: { ...s.notify },
  shortcuts: { ...s.shortcuts }
})

/* ---------- Atajos: formato canónico «Ctrl Alt Shift Tecla» ---------- */

const MODIFIERS = ['Ctrl', 'Alt', 'Shift'] as const
const KEY_TOKEN = /^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|Enter|Space|Tab|Backspace|Delete|Home|End|PageUp|PageDown|Insert|←|→|↑|↓|,|\.|;|-|=|\/)$/

export interface ParsedCombo {
  ctrl: boolean
  alt: boolean
  shift: boolean
  key: string
}

/** Lee «Ctrl Shift k» o «Ctrl Shift K» → partes. null si no es una combinación válida. */
export function parseCombo(raw: string): ParsedCombo | null {
  const tokens = raw.trim().split(/\s+/).filter(Boolean)
  // Una tecla de función sola (F2) también es una combinación válida.
  if (tokens.length === 1 && /^F(?:[1-9]|1[0-2])$/.test(tokens[0])) return { ctrl: false, alt: false, shift: false, key: tokens[0] }
  if (tokens.length < 2) return null
  const key = tokens[tokens.length - 1].length === 1 ? tokens[tokens.length - 1].toUpperCase() : tokens[tokens.length - 1]
  if (!KEY_TOKEN.test(key)) return null
  const mods = tokens.slice(0, -1)
  const seen = new Set<string>()
  for (const m of mods) {
    const canon = MODIFIERS.find((x) => x.toLowerCase() === m.toLowerCase())
    if (!canon || seen.has(canon)) return null
    seen.add(canon)
  }
  if (!seen.has('Ctrl') && !seen.has('Alt')) return null
  return { ctrl: seen.has('Ctrl'), alt: seen.has('Alt'), shift: seen.has('Shift'), key }
}

/** Forma canónica de una combinación válida, o null. */
export function canonicalCombo(raw: string): string | null {
  const p = parseCombo(raw)
  if (!p) return null
  return [p.ctrl && 'Ctrl', p.alt && 'Alt', p.shift && 'Shift', p.key].filter(Boolean).join(' ')
}

/* ---------- Validación ---------- */

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
  const r = Math.round(Math.round(v / LINE_HEIGHT.step) * LINE_HEIGHT.step * 100) / 100
  if (Math.abs(r - v) > 1e-6 || r < LINE_HEIGHT.min || r > LINE_HEIGHT.max)
    throw new Error(`La altura de línea va de ${LINE_HEIGHT.min} a ${LINE_HEIGHT.max}, en pasos de ${LINE_HEIGHT.step}.`)
  return r
}

function planText(v: unknown): string {
  if (typeof v !== 'string') throw new Error('El plan tiene que ser texto.')
  const t = v.trim()
  if (t.length > MAX_PLAN || /[\u0000-\u001f]/.test(t)) throw new Error(`El plan puede tener hasta ${MAX_PLAN} caracteres.`)
  return t
}

function projectsDir(v: unknown): string {
  if (typeof v !== 'string') throw new Error('La carpeta de proyectos tiene que ser texto.')
  const t = v.trim()
  if (t.length > MAX_PATH || /[\u0000-\u001f]/.test(t)) throw new Error('La carpeta de proyectos no es válida.')
  return t
}

export interface PatchOptions {
  /** Si se pasa, solo se aceptan colores para cuentas que existen (quitar siempre se puede). */
  accountExists?: (id: string) => boolean
}

/**
 * Aplica un cambio parcial validado. Cualquier clave desconocida o valor fuera de rango tira
 * un Error (no se aplica nada a medias). Los mapas son parches: `accountColors` y `shortcuts`
 * asignan con un valor y quitan con null; `terminal` y `notify` se fusionan campo por campo.
 */
export function applyPatch(current: SlothSettings, patch: unknown, opts: PatchOptions = {}): SlothSettings {
  if (!isObj(patch)) throw new Error('El cambio de configuración tiene que ser un objeto.')
  checkKeys(
    patch,
    [
      'theme', 'density', 'uiFontSize', 'accent', 'terminal', 'accountColors', 'accountPlans', 'openAtLogin', 'confirmClosePanes',
      'reopenSpaces', 'keepTerminalsAlive', 'confirmQuit', 'sleepAfterMin', 'editor', 'projectsDir', 'sounds', 'soundName', 'noMolestar', 'notify', 'updateChannel', 'lightMode', 'shortcuts'
    ],
    ''
  )
  const next = cloneSettings(current)
  if ('theme' in patch) next.theme = oneOf(patch.theme, THEMES, 'El tema')
  if ('density' in patch) next.density = oneOf(patch.density, DENSITIES, 'La densidad')
  if ('uiFontSize' in patch) next.uiFontSize = intIn(patch.uiFontSize, UI_FONT.min, UI_FONT.max, 'El tamaño de letra')
  if ('accent' in patch) next.accent = oneOf(patch.accent, ACCENTS, 'El color de acento')
  if ('openAtLogin' in patch) next.openAtLogin = bool(patch.openAtLogin, '«Abrir al iniciar Windows»')
  if ('confirmClosePanes' in patch) next.confirmClosePanes = bool(patch.confirmClosePanes, '«Confirmar al cerrar»')
  if ('reopenSpaces' in patch) next.reopenSpaces = bool(patch.reopenSpaces, '«Reabrir los espacios»')
  if ('keepTerminalsAlive' in patch) next.keepTerminalsAlive = bool(patch.keepTerminalsAlive, '«Terminales vivas»')
  if ('confirmQuit' in patch) next.confirmQuit = bool(patch.confirmQuit, '«Preguntar antes de cerrar Sloth»')
  if ('sleepAfterMin' in patch) {
    const v = patch.sleepAfterMin
    if (!SLEEP_MINUTES.includes(v as SleepMinutes)) throw new Error(`«Dormir espacios inactivos» tiene que ser ${SLEEP_MINUTES.join(', ')}.`)
    next.sleepAfterMin = v as SleepMinutes
  }
  if ('editor' in patch) next.editor = oneOf(patch.editor, EDITORS, 'El editor')
  if ('projectsDir' in patch) next.projectsDir = projectsDir(patch.projectsDir)
  if ('sounds' in patch) next.sounds = bool(patch.sounds, '«Sonidos»')
  if ('soundName' in patch) next.soundName = oneOf(patch.soundName, SOUND_NAMES, 'El sonido')
  if ('noMolestar' in patch) next.noMolestar = bool(patch.noMolestar, '«No molestar»')
  if ('updateChannel' in patch) next.updateChannel = oneOf(patch.updateChannel, UPDATE_CHANNELS, 'El canal de actualizaciones')
  if ('lightMode' in patch) next.lightMode = bool(patch.lightMode, '«Modo liviano»')
  if ('terminal' in patch) {
    const t = patch.terminal
    if (!isObj(t)) throw new Error('terminal tiene que ser un objeto.')
    checkKeys(t, ['fontSize', 'fontFamily', 'lineHeight', 'cursorStyle', 'cursorBlink', 'shell', 'scrollback'], 'terminal.')
    if ('fontSize' in t) next.terminal.fontSize = intIn(t.fontSize, TERM_FONT.min, TERM_FONT.max, 'El tamaño de la terminal')
    if ('fontFamily' in t) next.terminal.fontFamily = oneOf(t.fontFamily, TERM_FONTS, 'La fuente')
    if ('lineHeight' in t) next.terminal.lineHeight = lineHeight(t.lineHeight)
    if ('cursorStyle' in t) next.terminal.cursorStyle = oneOf(t.cursorStyle, CURSORS, 'El cursor')
    if ('cursorBlink' in t) next.terminal.cursorBlink = bool(t.cursorBlink, 'El parpadeo')
    if ('shell' in t) next.terminal.shell = oneOf(t.shell, SHELLS, 'El shell')
    if ('scrollback' in t) next.terminal.scrollback = intIn(t.scrollback, SCROLLBACK.min, SCROLLBACK.max, 'El historial de la terminal')
  }
  if ('notify' in patch) {
    const n = patch.notify
    if (!isObj(n)) throw new Error('notify tiene que ser un objeto.')
    checkKeys(n, ['done', 'perm', 'team', 'soundIn', 'soundOut'], 'notify.')
    if ('done' in n) next.notify.done = bool(n.done, '«Claude termina una tarea»')
    if ('perm' in n) next.notify.perm = bool(n.perm, '«Claude pide permiso»')
    if ('team' in n) next.notify.team = bool(n.team, '«Mensajes del equipo»')
    if ('soundIn' in n) next.notify.soundIn = bool(n.soundIn, '«Sonido al recibir mensajes»')
    if ('soundOut' in n) next.notify.soundOut = bool(n.soundOut, '«Sonido al enviar mensajes»')
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
  if ('accountPlans' in patch) {
    const pl = patch.accountPlans
    if (!isObj(pl)) throw new Error('accountPlans tiene que ser un objeto.')
    for (const [id, plan] of Object.entries(pl)) {
      if (!ACCOUNT_ID.test(id)) throw new Error('Id de cuenta inválido.')
      if (plan === null || plan === '') {
        delete next.accountPlans[id]
        continue
      }
      if (opts.accountExists && !opts.accountExists(id)) throw new Error('Esa cuenta no existe.')
      next.accountPlans[id] = planText(plan)
    }
    if (Object.keys(next.accountPlans).length > MAX_ACCOUNT_COLORS) throw new Error('Demasiados planes de cuenta.')
  }
  if ('shortcuts' in patch) {
    const s = patch.shortcuts
    if (!isObj(s)) throw new Error('shortcuts tiene que ser un objeto.')
    for (const [id, combo] of Object.entries(s)) {
      if (!SHORTCUT_IDS.includes(id as ShortcutId)) throw new Error(`Atajo desconocido: ${id}.`)
      const key = id as ShortcutId
      if (combo === null) {
        delete next.shortcuts[key]
        continue
      }
      const canon = typeof combo === 'string' ? canonicalCombo(combo) : null
      if (!canon) throw new Error('La combinación de teclas no es válida. Usá Ctrl o Alt, más una tecla.')
      next.shortcuts[key] = canon
    }
    if (Object.keys(next.shortcuts).length > MAX_SHORTCUTS) throw new Error('Demasiados atajos personalizados.')
  }
  return next
}

/** Lee lo guardado en disco con tolerancia: cada campo inválido vuelve a su valor por defecto. */
export function normalize(raw: unknown): SlothSettings {
  const out = cloneSettings(DEFAULT_SETTINGS)
  if (!isObj(raw)) return out
  const src: Record<string, unknown> = raw
  const tryPatch = (p: Record<string, unknown>): void => {
    try {
      Object.assign(out, applyPatch(out, p))
    } catch {
      /* campo inválido: queda el valor por defecto */
    }
  }
  const scalars = [
    'theme', 'density', 'uiFontSize', 'accent', 'openAtLogin', 'confirmClosePanes', 'reopenSpaces', 'keepTerminalsAlive',
    'confirmQuit', 'sleepAfterMin', 'editor', 'projectsDir', 'sounds', 'soundName', 'noMolestar', 'updateChannel', 'lightMode'
  ] as const
  for (const k of scalars) if (k in src) tryPatch({ [k]: src[k] })
  if (isObj(src.terminal)) for (const [k, v] of Object.entries(src.terminal)) tryPatch({ terminal: { [k]: v } })
  if (isObj(src.notify)) for (const [k, v] of Object.entries(src.notify)) tryPatch({ notify: { [k]: v } })
  if (isObj(src.accountColors))
    for (const [id, v] of Object.entries(src.accountColors).slice(0, MAX_ACCOUNT_COLORS)) tryPatch({ accountColors: { [id]: v } })
  if (isObj(src.accountPlans))
    for (const [id, v] of Object.entries(src.accountPlans).slice(0, MAX_ACCOUNT_COLORS)) tryPatch({ accountPlans: { [id]: v } })
  if (isObj(src.shortcuts))
    for (const [id, v] of Object.entries(src.shortcuts).slice(0, MAX_SHORTCUTS)) tryPatch({ shortcuts: { [id]: v } })
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
      next.accent = d.accent
      next.lightMode = d.lightMode
      break
    case 'terminal':
      next.terminal = { ...d.terminal }
      break
    case 'cuentas':
      next.accountColors = {}
      next.accountPlans = {}
      break
    case 'general':
      next.reopenSpaces = d.reopenSpaces
      next.keepTerminalsAlive = d.keepTerminalsAlive
      next.confirmQuit = d.confirmQuit
      next.sleepAfterMin = d.sleepAfterMin
      next.openAtLogin = d.openAtLogin
      next.confirmClosePanes = d.confirmClosePanes
      next.editor = d.editor
      next.projectsDir = d.projectsDir
      break
    case 'notif':
      next.notify = { ...d.notify }
      next.noMolestar = d.noMolestar
      next.sounds = d.sounds
      next.soundName = d.soundName
      break
    case 'atajos':
      next.shortcuts = {}
      break
    case 'updates':
      next.updateChannel = d.updateChannel
      break
    default:
      throw new Error('Sección desconocida.')
  }
  return next
}

/** Tema efectivo: «Oscuro» y «Más oscuro» son siempre oscuros; «Según Windows» sigue al sistema. */
export const resolveDark = (theme: ThemeChoice, systemDark: boolean): boolean =>
  theme === 'sistema' ? systemDark : theme !== 'claro'
