import {
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Account, SetupSyncReport } from '../shared/types'

/** Tu setup de siempre. */
export const userClaudeDir = (): string => join(homedir(), '.claude')
const userClaudeJson = (): string => join(homedir(), '.claude.json')

/**
 * Carpetas que se comparten con un junction (no necesita permisos de admin en Windows):
 * lo que cambies en ~/.claude se ve al instante en todas las cuentas.
 */
const SHARED_DIRS = ['skills', 'agents', 'commands', 'hooks', 'plugins', 'output-styles']
/** Archivos que se copian en cada sincronización. */
const COPIED_FILES = ['CLAUDE.md', 'statusline-command.sh', 'statusline.py']

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.sloth-tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, path)
}

const norm = (p: string): string => resolve(p).replace(/[\\/]+$/, '').toLowerCase()

/** Si `path` es un enlace que apunta a `target`. */
function isLinkTo(path: string, target: string): boolean {
  try {
    if (!lstatSync(path).isSymbolicLink()) return false
    return norm(readlinkSync(path)) === norm(target)
  } catch {
    return false
  }
}

/** settings.json base para la cuenta: el tuyo si comparte setup; si no, el propio de la cuenta. */
export function baseSettingsFor(account: Account): Record<string, unknown> | undefined {
  if (account.shareSetup === false) return undefined
  return readJsonObject(join(userClaudeDir(), 'settings.json')) ?? {}
}

/**
 * Enlaza o copia tu setup dentro de la carpeta de la cuenta. No toca el login ni nada que la
 * cuenta ya tenga como carpeta propia.
 * `allowMcpWrite` debe ser false si Claude está corriendo con esta cuenta: él también escribe ese archivo.
 */
export function syncSharedSetup(account: Account, allowMcpWrite: boolean): SetupSyncReport {
  const report: SetupSyncReport = { linked: [], copied: [], mcpServers: [], skipped: [] }
  const src = userClaudeDir()
  if (account.shareSetup === false || !existsSync(src) || !existsSync(account.configDir)) return report

  for (const name of SHARED_DIRS) {
    const from = join(src, name)
    const to = join(account.configDir, name)
    if (!existsSync(from)) continue
    if (isLinkTo(to, from)) {
      report.linked.push(name)
      continue
    }
    if (existsSync(to) || isBrokenLink(to)) {
      report.skipped.push(`${name} (la cuenta ya tiene la suya)`)
      continue
    }
    try {
      symlinkSync(from, to, 'junction')
      report.linked.push(name)
    } catch (e) {
      report.skipped.push(`${name} (${(e as Error).message})`)
    }
  }

  for (const name of COPIED_FILES) {
    const from = join(src, name)
    if (!existsSync(from)) continue
    try {
      copyFileSync(from, join(account.configDir, name))
      report.copied.push(name)
    } catch (e) {
      report.skipped.push(`${name} (${(e as Error).message})`)
    }
  }

  // MCP de usuario: viven en ~/.claude.json; se agregan los que falten, sin pisar los de la cuenta.
  const userMcp = readJsonObject(userClaudeJson())?.mcpServers
  if (userMcp && typeof userMcp === 'object') {
    if (!allowMcpWrite) {
      report.skipped.push('MCP (Claude está abierto con esta cuenta; se sincroniza al próximo arranque)')
    } else {
      const file = join(account.configDir, '.claude.json')
      const exists = existsSync(file)
      const acc = exists ? readJsonObject(file) : {}
      if (!acc) {
        report.skipped.push('MCP (.claude.json de la cuenta ilegible)')
      } else {
        const current = (acc.mcpServers ?? {}) as Record<string, unknown>
        const added = Object.keys(userMcp).filter((k) => !(k in current))
        if (added.length) {
          acc.mcpServers = { ...current, ...Object.fromEntries(added.map((k) => [k, (userMcp as Record<string, unknown>)[k]])) }
          writeJsonAtomic(file, acc)
        }
        report.mcpServers = Object.keys({ ...current, ...(userMcp as object) })
      }
    }
  }
  return report
}

function isBrokenLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** Deshace lo que comparte Sloth: quita los junctions hacia ~/.claude. Los MCP agregados quedan. */
export function unshareSetup(account: Account): void {
  const src = userClaudeDir()
  for (const name of SHARED_DIRS) {
    const to = join(account.configDir, name)
    if (isLinkTo(to, join(src, name))) rmSync(to, { recursive: false, force: true })
  }
}
