import { join } from 'node:path'
import { escribirJsonAtomico, esObjeto, leerJson } from '../json-file'
import { carpetaFeatures } from '../perfil'

export interface TraySettings {
  /** Al cerrar la ventana, ocultarla en la bandeja en vez de salir. Por defecto no. */
  closeToTray: boolean
}

const DEFAULTS: TraySettings = { closeToTray: false }

export const featuresDir = (): string => carpetaFeatures()
const file = (): string => join(featuresDir(), 'tray.json')


export function readTraySettings(): TraySettings {
  return leerJson(file(), {
    validar: (v) => (esObjeto(v) ? { closeToTray: v.closeToTray === true } : undefined),
    porDefecto: () => ({ ...DEFAULTS })
  }).valor
}

export function writeTraySettings(s: TraySettings): void {
  escribirJsonAtomico(file(), s)
}
