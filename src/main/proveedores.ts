import type { ProveedorId } from '../shared/proveedores'
import { proveedorIdDe } from '../shared/proveedores'
import { claude } from './proveedor-claude'
import { codex } from './proveedor-codex'
import { copilot } from './proveedor-copilot'
import type { Proveedor } from './proveedor-tipos'

export type { Proveedor }

export const PROVEEDORES: Record<ProveedorId, Proveedor> = { claude, codex, copilot }

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

/** Lo que corre el panel «Terminal» de la cuenta: el login mientras no haya sesión, y el agente normal cuando ya la hay (así no se relanza el login de otra cuenta encima). */
export function argvPanelCuenta(p: Proveedor, sesionIniciada: boolean): string[] {
  return sesionIniciada ? p.argvInteractivo({}) : p.argvLogin()
}
