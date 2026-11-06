import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface TraySettings {
  /** Al cerrar la ventana, ocultarla en la bandeja en vez de salir. Por defecto no. */
  closeToTray: boolean
}

const DEFAULTS: TraySettings = { closeToTray: false }

export const featuresDir = (): string => join(app.getPath('userData'), 'features')
const file = (): string => join(featuresDir(), 'tray.json')

/** Escritura atómica: tmp + rename (nunca queda un JSON a medias). */
export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, path)
}

export function readTraySettings(): TraySettings {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8').replace(/^﻿/, '')) as Partial<TraySettings>
    return { closeToTray: raw.closeToTray === true }
  } catch {
    return { ...DEFAULTS }
  }
}

export function writeTraySettings(s: TraySettings): void {
  writeJsonAtomic(file(), s)
}
