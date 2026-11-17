import { basename } from 'node:path'
import { logger } from './logger-global'

let pendientes: string[] = []
const oyentes = new Set<() => void>()

export function avisar(texto: string): void {
  if (pendientes.includes(texto)) return
  pendientes.push(texto)
  logger.aviso('avisos', texto)
  for (const f of oyentes) f()
}

export function avisoArchivoApartado(original: string, apartado: string): void {
  avisar(
    `Encontré un archivo de configuración dañado (${basename(original)}); lo guardé como ${basename(apartado)} y seguí con valores por defecto.`
  )
}

export function avisoSoloLectura(archivo: string, motivo: string): void {
  avisar(
    `${basename(archivo)} ${motivo}. Sigo con valores por defecto y no voy a guardar cambios en ese archivo hasta que reinicies Sloth (el archivo queda como está, en ${archivo}).`
  )
}

/** Devuelve los avisos pendientes y los olvida: cada uno se muestra una sola vez. */
export function tomarAvisos(): string[] {
  const r = pendientes
  pendientes = []
  return r
}

export function alAvisar(f: () => void): () => void {
  oyentes.add(f)
  return () => oyentes.delete(f)
}
