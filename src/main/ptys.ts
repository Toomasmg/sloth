import { execFileSync } from 'node:child_process'
import type { SpawnSpec } from '../shared/daemon-protocol'

export interface PtySpec {
  cwd: string
  env: Record<string, string>
  args: string[]
}

let shellCache: string | undefined
/** PowerShell 7 si está instalado; si no, Windows PowerShell. */
export function resolveShell(): string {
  if (shellCache) return shellCache
  try {
    execFileSync('where', ['pwsh'], { stdio: 'ignore', windowsHide: true })
    shellCache = 'pwsh.exe'
  } catch {
    shellCache = 'powershell.exe'
  }
  return shellCache
}

/**
 * Entorno limpio para cada terminal: se quitan las variables que harían que Claude use otra
 * cuenta (API keys) o crea que corre anidado dentro de otra sesión de Claude Code.
 */
export function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    const key = k.toUpperCase()
    if (
      key === 'CLAUDECODE' ||
      key.startsWith('CLAUDE_CODE_') ||
      key === 'CLAUDE_CONFIG_DIR' ||
      key === 'ANTHROPIC_API_KEY' ||
      key === 'ANTHROPIC_AUTH_TOKEN' ||
      key.startsWith('ELECTRON_') ||
      key.startsWith('ANTIREA_') ||
      key.startsWith('SLOTH_')
    )
      continue
    env[k] = v
  }
  env.TERM_PROGRAM = 'Sloth'
  return env
}

/**
 * Las sesiones PTY viven en el daemon de terminales (src/daemon/core.ts) o, si no hay node, en el
 * backend en proceso (src/main/daemon-client.ts). Acá solo armamos lo que se le manda a spawn.
 */
export function toSpawnSpec(spec: PtySpec, cols: number, rows: number): SpawnSpec {
  return { file: resolveShell(), args: spec.args, cwd: spec.cwd, env: spec.env, cols, rows }
}
