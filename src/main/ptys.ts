import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { SpawnSpec } from '../shared/daemon-protocol'
import type { ShellChoice } from './features/settings-model'
import { shellArgs, type ShellFamily } from './shell-args'

export { shellArgs, type ShellFamily }

export interface PtySpec {
  cwd: string
  env: Record<string, string>
  /** argv de Claude que la shell corre al abrirse (p. ej. ['claude', '--continue']). Sin valor = solo la shell. */
  claude?: string[]
}

const GIT_BASH_PATHS = ['C:\\Program Files\\Git\\bin\\bash.exe']

let pwshFound: boolean | undefined
function hasPwsh(): boolean {
  if (pwshFound === undefined) {
    try {
      execFileSync('where', ['pwsh'], { stdio: 'ignore', windowsHide: true })
      pwshFound = true
    } catch {
      pwshFound = false
    }
  }
  return pwshFound
}

/**
 * Ejecutable de la shell elegida en Configuración › Terminal. Si no está instalada (pwsh o Git Bash),
 * cae a PowerShell: primero PowerShell 7 si existe, si no Windows PowerShell.
 */
export function resolveShell(choice: ShellChoice): { file: string; family: ShellFamily } {
  if (choice === 'Windows PowerShell') return { file: 'powershell.exe', family: 'ps' }
  if (choice === 'Símbolo del sistema') return { file: 'cmd.exe', family: 'cmd' }
  if (choice === 'Git Bash') {
    const bash = GIT_BASH_PATHS.find((p) => existsSync(p))
    if (bash) return { file: bash, family: 'posix' }
  }
  return hasPwsh() ? { file: 'pwsh.exe', family: 'ps' } : { file: 'powershell.exe', family: 'ps' }
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
  // cmd.exe busca primero en la carpeta actual: sin esto, un claude.cmd que venga en el repo se ejecuta solo.
  env.NoDefaultCurrentDirectoryInExePath = '1'
  return env
}

/**
 * Las sesiones PTY viven en el daemon de terminales (src/daemon/core.ts) o, si no hay node, en el
 * backend en proceso (src/main/daemon-client.ts). Acá solo armamos lo que se le manda a spawn.
 * `shell` es la elección de Configuración (solo afecta terminales nuevas: las vivas no se tocan).
 */
export function toSpawnSpec(spec: PtySpec, cols: number, rows: number, shell: ShellChoice): SpawnSpec {
  const bin = resolveShell(shell)
  return { file: bin.file, args: shellArgs(bin.family, spec.claude), cwd: spec.cwd, env: spec.env, cols, rows }
}
