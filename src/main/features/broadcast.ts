import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Feature, FeatureContext } from './context'

/**
 * Función «broadcast» (lado main). El envío en sí lo hace la interfaz con `ptyWrite` (y la cola de
 * espacios que están trabajando). Acá solo se guardan los «Últimos envíos» para poder repetirlos
 * después de reiniciar Sloth. Ops: list, add(entrada). Archivo: userData/features/broadcast.json.
 */

export interface SentEntry {
  id: string
  /** Epoch ms. */
  time: number
  text: string
  /** Ids de espacio a los que se mandó. */
  ids: string[]
  /** Nombres en el momento del envío (por si el espacio se borra después). */
  names: string[]
}

const MAX_ENTRIES = 6
const MAX_TEXT = 2000
const MAX_IDS = 50

let file = ''
let entries: SentEntry[] = []

function load(): SentEntry[] {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as unknown
    return Array.isArray(raw) ? raw.map(clean).filter((e): e is SentEntry => e !== null).slice(0, MAX_ENTRIES) : []
  } catch {
    return []
  }
}

function save(): void {
  mkdirSync(join(app.getPath('userData'), 'features'), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8')
  renameSync(tmp, file)
}

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length <= max ? v : undefined)

/** Valida una entrada guardada o recibida. Devuelve null si no sirve. */
export function clean(raw: unknown): SentEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const text = str(o.text, MAX_TEXT)?.trim()
  if (!text || typeof o.id !== 'string' || typeof o.time !== 'number') return null
  const ids = Array.isArray(o.ids) ? o.ids.filter((x): x is string => typeof x === 'string').slice(0, MAX_IDS) : []
  const names = Array.isArray(o.names) ? o.names.filter((x): x is string => typeof x === 'string').slice(0, MAX_IDS) : []
  return { id: o.id.slice(0, 64), time: o.time, text, ids, names }
}

const feature: Feature = {
  name: 'broadcast',
  register(c: FeatureContext) {
    file = join(app.getPath('userData'), 'features', 'broadcast.json')
    entries = load()
    c.handle('list', () => entries)
    c.handle('add', (raw: unknown) => {
      const e = clean(raw)
      if (!e) throw new Error('Envío inválido.')
      entries = [e, ...entries.filter((x) => x.id !== e.id)].slice(0, MAX_ENTRIES)
      save()
      return entries
    })
  }
}

export default feature
