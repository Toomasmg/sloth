import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Account, AccountStatus } from '../shared/types'
import { raizDatos } from './perfil'
import { proveedorDe, proveedorExigido } from './proveedores'

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

/** Estado de login: lo decide el proveedor de la cuenta sin abrir credenciales. */
export function accountStatus(account: Account): AccountStatus {
  const configDirExists = existsSync(account.configDir)
  const p = proveedorDe(account)
  if (!configDirExists || !p) return { loggedIn: false, configDirExists }
  return { ...p.estadoLogin(account.configDir), configDirExists }
}
