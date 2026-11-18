import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Account, AccountStatus } from '../shared/types'
import { MAX_CUENTAS, motivoNoAgregar, type ProveedorId } from '../shared/proveedores'
import { idPerfilActivo, raizDatos } from './perfil'
import { rutasPerfiles } from './perfiles-fs'
import { logger } from './logger-global'
import { proveedorDe, proveedorExigido } from './proveedores'
import { cuentasEnOtrosPerfiles } from './tope-cuentas'

export function accountsRoot(): string {
  return join(raizDatos(), 'accounts')
}

/** Cada cuenta vive en su propia carpeta: es el CLAUDE_CONFIG_DIR (o CODEX_HOME) de esa cuenta. */
export function createAccount(label: string, proveedor?: string): Account {
  const p = proveedorExigido({ proveedor })
  const id = randomUUID()
  const configDir = join(accountsRoot(), id, p.subcarpetaCuenta)
  mkdirSync(configDir, { recursive: true })
  p.prepararCarpeta(configDir)
  const cuenta: Account = { id, label: label.trim() || 'Cuenta', configDir, createdAt: Date.now() }
  if (proveedor !== undefined) cuenta.proveedor = p.id
  return cuenta
}

/** El tope de cuentas de un agente vale entre todos los perfiles: el login del sistema que lo motiva es uno solo. */
export function motivoNoAgregarCuenta(cuentas: readonly { proveedor?: unknown }[], id: ProveedorId): string | undefined {
  if (MAX_CUENTAS[id] === undefined) return undefined
  const otros = cuentasEnOtrosPerfiles(rutasPerfiles(raizDatos()).carpeta, idPerfilActivo(), id, (m) => logger.aviso('perfiles', m))
  return motivoNoAgregar(cuentas, id, otros)
}

/** Estado de login: lo decide el proveedor de la cuenta sin abrir credenciales. */
export function accountStatus(account: Account): AccountStatus {
  const configDirExists = existsSync(account.configDir)
  const p = proveedorDe(account)
  if (!configDirExists || !p) return { loggedIn: false, configDirExists }
  return { ...p.estadoLogin(account.configDir), configDirExists }
}
