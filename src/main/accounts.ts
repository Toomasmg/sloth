import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Account, AccountStatus } from '../shared/types'
import { raizDatos } from './perfil'
import { proveedorDe, proveedorExigido } from './proveedores'

export function accountsRoot(): string {
  return join(raizDatos(), 'accounts')
}

/** Cada cuenta vive en su propia carpeta: es el CLAUDE_CONFIG_DIR de esa cuenta. */
export function createAccount(label: string, proveedor?: string): Account {
  const p = proveedorExigido({ proveedor })
  const id = randomUUID()
  const configDir = join(accountsRoot(), id, p.subcarpetaCuenta)
  mkdirSync(configDir, { recursive: true })
  const cuenta: Account = { id, label: label.trim() || 'Cuenta', configDir, createdAt: Date.now() }
  if (proveedor !== undefined) cuenta.proveedor = p.id
  return cuenta
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return undefined
  }
}

/**
 * Estado de login, leído SOLO de `.claude.json` (datos públicos de la cuenta: email).
 * Sloth nunca abre `.credentials.json` ni toca tokens: el login lo maneja Claude Code.
 */
export function accountStatus(account: Account): AccountStatus {
  const configDirExists = existsSync(account.configDir)
  const p = proveedorDe(account)
  if (!configDirExists || !p) return { loggedIn: false, configDirExists }
  const meta = readJson(join(account.configDir, p.archivoMeta)) as
    | { oauthAccount?: { emailAddress?: string; accountUuid?: string } }
    | undefined
  const email = meta?.oauthAccount?.emailAddress
  const loggedIn = Boolean(email || meta?.oauthAccount?.accountUuid)
  return { loggedIn, email, configDirExists }
}
