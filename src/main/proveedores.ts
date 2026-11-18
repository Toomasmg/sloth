import type { ProveedorId } from '../shared/proveedores'
import { proveedorIdDe } from '../shared/proveedores'
import { claude } from './proveedor-claude'

export interface Proveedor {
  id: ProveedorId
  /** Para la interfaz genérica, p. ej. «Claude Code». */
  nombre: string
  /** Binario que corre la terminal. */
  comando: string
  envConfigDir: string
  /** Carpeta de la cuenta dentro de accounts/<id>/. */
  subcarpetaCuenta: string
  /** Archivo del que se lee el email público del login. */
  archivoMeta: string
  /** Relativa al configDir. */
  carpetaHistorial: string
  /** Variables del entorno heredado que no deben llegar a la terminal (la clave viene en mayúsculas). */
  quitarDelEntorno(claveMayus: string): boolean
  envCuenta(configDir: string): Record<string, string>
  resolverExe(env?: NodeJS.ProcessEnv): string | undefined
  argvInteractivo(o: { continuar?: boolean; resumir?: string; prompt?: string }): string[]
}

export const PROVEEDORES: Record<ProveedorId, Proveedor> = { claude }

export function proveedorDe(cuenta: { proveedor?: unknown }): Proveedor {
  return PROVEEDORES[proveedorIdDe(cuenta)]
}
