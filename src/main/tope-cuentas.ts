import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { proveedorIdDe, type ProveedorId } from '../shared/proveedores'

const MAX_BYTES_ESTADO = 32 * 1024 * 1024

const codigo = (e: unknown): string | undefined =>
  e && typeof e === 'object' && 'code' in e && typeof e.code === 'string' ? e.code : undefined

/**
 * Cuentas de un agente en el sloth-state.json de los perfiles que no son este, leyendo las carpetas y no el índice:
 * el tope vale aunque el índice esté desarmado, y un perfil borrado (movido a respaldos/) deja de contar solo.
 * Solo lectura. Un estado que no se puede leer no cuenta: bloquear para siempre por un archivo roto es peor.
 */
export function cuentasEnOtrosPerfiles(carpetaPerfiles: string, perfilPropio: string, id: ProveedorId, avisar: (msg: string) => void): number {
  let carpetas: string[]
  try {
    carpetas = readdirSync(carpetaPerfiles, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== perfilPropio).map((d) => d.name)
  } catch (e) {
    if (codigo(e) !== 'ENOENT') avisar(`no pude listar los perfiles para contar cuentas: ${(e as Error).message}`)
    return 0
  }
  let n = 0
  for (const nombre of carpetas) {
    const archivo = join(carpetaPerfiles, nombre, 'sloth-state.json')
    try {
      if (statSync(archivo).size > MAX_BYTES_ESTADO) throw new Error('es demasiado grande')
      const json: unknown = JSON.parse(readFileSync(archivo, 'utf8').replace(/^\uFEFF/, ''))
      const cuentas = typeof json === 'object' && json !== null ? (json as { accounts?: unknown }).accounts : undefined
      if (Array.isArray(cuentas)) n += cuentas.filter((c) => typeof c === 'object' && c !== null && proveedorIdDe(c) === id).length
    } catch (e) {
      if (codigo(e) !== 'ENOENT') avisar(`no pude leer las cuentas del perfil ${nombre}: ${(e as Error).message}`)
    }
  }
  return n
}
