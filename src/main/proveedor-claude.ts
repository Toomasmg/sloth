import { resolveClaudeExe } from './features/tickets/claude-run'
import { claudeWithPrompt } from './shell-args'
import type { Proveedor } from './proveedores'

export const claude: Proveedor = {
  id: 'claude',
  nombre: 'Claude Code',
  comando: 'claude',
  envConfigDir: 'CLAUDE_CONFIG_DIR',
  subcarpetaCuenta: 'claude',
  archivoMeta: '.claude.json',
  carpetaHistorial: 'projects',
  quitarDelEntorno: (k) =>
    k === 'CLAUDECODE' ||
    k.startsWith('CLAUDE_CODE_') ||
    k === 'CLAUDE_CONFIG_DIR' ||
    k === 'ANTHROPIC_API_KEY' ||
    k === 'ANTHROPIC_AUTH_TOKEN',
  envCuenta: (configDir) => ({ CLAUDE_CONFIG_DIR: configDir }),
  resolverExe: (env) => resolveClaudeExe(env),
  argvInteractivo: (o) => {
    if (o.prompt) return claudeWithPrompt(o.prompt)
    if (o.resumir) return ['claude', '--resume', o.resumir]
    if (o.continuar) return ['claude', '--continue']
    return ['claude']
  }
}
