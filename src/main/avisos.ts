import { basename } from 'node:path'

let pendientes: string[] = []
const oyentes = new Set<() => void>()

export function avisar(texto: string): void {
  if (pendientes.includes(texto)) return
  pendientes.push(texto)
  for (const f of oyentes) f()
}

export function avisoArchivoApartado(original: string, apartado: string): void {
  avisar(
    `Encontré un archivo de configuración dañado (${basename(original)}); lo guardé como ${basename(apartado)} y seguí con valores por defecto.`
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
