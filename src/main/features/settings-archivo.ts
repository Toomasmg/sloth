import { DEFAULT_SETTINGS, normalize, type SlothSettings } from './settings-model'

type Obj = Record<string, unknown>

const esObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

const RAIZ = new Set<string>([...Object.keys(DEFAULT_SETTINGS), 'version'])
const SECCIONES = ['terminal', 'notify'] as const

/** Lo que una versión más nueva agregó al archivo y esta no conoce: se vuelve a escribir tal cual al guardar. */
export function camposDesconocidos(raw: unknown): Obj {
  if (!esObj(raw)) return {}
  const out: Obj = {}
  for (const [k, v] of Object.entries(raw)) if (!RAIZ.has(k)) out[k] = v
  for (const sec of SECCIONES) {
    const dentro = raw[sec]
    if (!esObj(dentro)) continue
    const conocidas = DEFAULT_SETTINGS[sec] as unknown as Obj
    const extra: Obj = {}
    for (const [k, v] of Object.entries(dentro)) if (!(k in conocidas)) extra[k] = v
    if (Object.keys(extra).length) out[sec] = extra
  }
  return out
}

export interface ArchivoSettings {
  settings: SlothSettings
  resto: Obj
}

export function leerSettings(raw: unknown): ArchivoSettings {
  return { settings: normalize(raw), resto: camposDesconocidos(raw) }
}

/** Lo vigente pisa lo conocido; lo desconocido (raíz, `terminal` y `notify`) se conserva. */
export function armarArchivo(settings: SlothSettings, resto: Obj, version: number): Obj {
  const out: Obj = { ...resto, ...settings, version }
  for (const sec of SECCIONES) {
    const extra = resto[sec]
    if (esObj(extra)) out[sec] = { ...extra, ...settings[sec] }
  }
  return out
}
