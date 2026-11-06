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
 * Estado de login. En Windows Claude Code guarda las credenciales en
 * `<CLAUDE_CONFIG_DIR>/.credentials.json` y los datos de la cuenta en `.claude.json`.
 */
export function accountStatus(account: Account): AccountStatus {
  const configDirExists = existsSync(account.configDir)
  if (!configDirExists) return { loggedIn: false, configDirExists }
  const creds = readJson(join(account.configDir, '.credentials.json')) as
    | { claudeAiOauth?: { accessToken?: string } }
    | undefined
  const meta = readJson(join(account.configDir, '.claude.json')) as
    | { oauthAccount?: { emailAddress?: string } }
    | undefined
  const email = meta?.oauthAccount?.emailAddress
  const loggedIn = Boolean(creds?.claudeAiOauth?.accessToken) || Boolean(email)
  return { loggedIn, email, configDirExists }
}
