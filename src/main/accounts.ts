import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Account, AccountStatus } from '../shared/types'

export function accountsRoot(): string {
  return join(app.getPath('userData'), 'accounts')
}

/** Cada cuenta vive en su propia carpeta: es el CLAUDE_CONFIG_DIR de esa cuenta. */
export function createAccount(label: string): Account {
  const id = randomUUID()
  const configDir = join(accountsRoot(), id, 'claude')
  mkdirSync(configDir, { recursive: true })
  return { id, label: label.trim() || 'Cuenta', configDir, createdAt: Date.now() }
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
  if (!configDirExists) return { loggedIn: false, configDirExists }
  const meta = readJson(join(account.configDir, '.claude.json')) as
    | { oauthAccount?: { emailAddress?: string; accountUuid?: string } }
    | undefined
  const email = meta?.oauthAccount?.emailAddress
  const loggedIn = Boolean(email || meta?.oauthAccount?.accountUuid)
  return { loggedIn, email, configDirExists }
}
