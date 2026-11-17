import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { SpawnSpec } from '../shared/daemon-protocol'
import { shellLaunch, type ShellFamily } from './claude-launch'
import type { ShellChoice } from './features/settings-model'

export interface PtySpec {
  cwd: string
  env: Record<string, string>
  /** argv de Claude que la shell corre al abrirse (p. ej. ['claude', '--continue']). Sin valor = solo la shell. */
  claude?: string[]
  /** Primer mensaje para Claude (va por variable de entorno o se pega, nunca en la línea de comandos). */
  prompt?: string
  /** Ruta absoluta de claude.exe, si se encontró. */
  claudeExe?: string
}

export { baseEnv } from './claude-launch'
export type { ShellFamily } from './claude-launch'

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
 * Las sesiones PTY viven en el daemon de terminales (src/daemon/core.ts) o, si no hay node, en el
 * backend en proceso (src/main/daemon-client.ts). Acá solo armamos lo que se le manda a spawn.
 * `shell` es la elección de Configuración (solo afecta terminales nuevas: las vivas no se tocan).
 */
export function toSpawnSpec(spec: PtySpec, cols: number, rows: number, shell: ShellChoice): { spawn: SpawnSpec; paste?: string } {
  const bin = resolveShell(shell)
  const launch = shellLaunch(bin.family, spec.claude ? { argv: spec.claude, prompt: spec.prompt, exe: spec.claudeExe } : undefined)
  const spawn = { file: bin.file, args: launch.args, cwd: spec.cwd, env: { ...spec.env, ...launch.env }, cols, rows }
  return { spawn, paste: launch.paste }
}
