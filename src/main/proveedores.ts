import type { Capacidades, ProveedorId } from '../shared/proveedores'
import { proveedorIdDe } from '../shared/proveedores'
import { claude } from './proveedor-claude'
import { codex } from './proveedor-codex'

export interface Proveedor {
  id: ProveedorId
  envConfigDir: string
  /** Carpeta de la cuenta dentro de accounts/<id>/. */
  subcarpetaCuenta: string
  /** Archivo del que se lee el email público del login. */
  archivoMeta: string
  /** Relativa al configDir. */
  carpetaHistorial: string
  capacidades: Capacidades
  /** Cómo se instala el agente, para el aviso cuando no está en el PATH. */
  comoInstalar: string
  /** Variables del entorno heredado que no deben llegar a la terminal (la clave viene en mayúsculas). */
  quitarDelEntorno(claveMayus: string): boolean
  envCuenta(configDir: string): Record<string, string>
  resolverExe(env?: NodeJS.ProcessEnv): string | undefined
  argvInteractivo(o: { continuar?: boolean; prompt?: string }): string[]
  /** Lo que corre la terminal de login de la cuenta. */
  argvLogin(): string[]
  /** Sin abrir credenciales: solo lo que el agente deja a la vista (datos públicos o la existencia de un archivo). */
  estadoLogin(configDir: string): { loggedIn: boolean; email?: string }
  /** Deja la carpeta de la cuenta lista antes del primer arranque; nunca pisa lo que ya hay. */
  prepararCarpeta(configDir: string): void
  hayConversacionPrevia(configDir: string, cwd: string): boolean
}

export const PROVEEDORES: Record<ProveedorId, Proveedor> = { claude, codex }

export const AVISO_PROVEEDOR_DESCONOCIDO = 'Esta cuenta es de un agente que esta versión de Sloth no conoce; actualizá Sloth.'

/** undefined si la cuenta es de un agente que esta versión no conoce: quien la use no debe lanzar nada con ella. */
export function proveedorDe(cuenta: { proveedor?: unknown }): Proveedor | undefined {
  const id = proveedorIdDe(cuenta)
  return id === undefined ? undefined : PROVEEDORES[id]
}

/** Para todo lo que lanza un proceso con la cuenta: con un proveedor desconocido no se lanza nada. */
export function proveedorExigido(cuenta: { proveedor?: unknown }): Proveedor {
  const p = proveedorDe(cuenta)
  if (!p) throw new Error(AVISO_PROVEEDOR_DESCONOCIDO)
  return p
}

/** Mismas claves y orden que se armaban antes en accountEnv: base, variable de config del proveedor y SLOTH_ACCOUNT. */
export function armarEnvCuenta(p: Proveedor, cuenta: { configDir: string; label: string }, base: Record<string, string>): Record<string, string> {
  return { ...base, ...p.envCuenta(cuenta.configDir), SLOTH_ACCOUNT: cuenta.label }
}
