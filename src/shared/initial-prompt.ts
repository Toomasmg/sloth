// Subcomandos y alias de `claude --help` (2.1.326) más el `help` que suma commander. Commander
// despacha si el primer operando es exactamente uno de estos, aunque venga después de `--`.
export const CLAUDE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'agents',
  'attach',
  'auth',
  'auto-mode',
  'doctor',
  'gateway',
  'help',
  'import',
  'install',
  'kill',
  'logs',
  'mcp',
  'plugin',
  'plugins',
  'purge',
  'respawn',
  'rm',
  'setup-token',
  'stop',
  'ultrareview',
  'update',
  'upgrade',
])

// Una versión más nueva de Claude Code puede sumar subcomandos: una palabra suelta en minúsculas tampoco va como argumento.
const BARE_WORD = /^[a-z][a-z-]*$/

// Subcomandos de `codex --help` (0.164) con sus alias: Codex también los despacha por el primer operando.
export const CODEX_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'a',
  'app',
  'app-server',
  'apply',
  'cloud',
  'completion',
  'debug',
  'doctor',
  'e',
  'exec',
  'features',
  'fork',
  'help',
  'login',
  'logout',
  'mcp',
  'mcp-server',
  'resume',
  'review',
  'sandbox'
])

/** ¿El agente podría tomar este argumento (tal cual se le pasa) como un subcomando? */
export function mightBeSubcommand(arg: string, agente: string = 'claude'): boolean {
  const conocidos = agente === 'codex' ? CODEX_SUBCOMMANDS : CLAUDE_SUBCOMMANDS
  return conocidos.has(arg) || BARE_WORD.test(arg)
}

/** Por qué un primer mensaje no se puede mandar a Claude, o undefined si está bien. */
export function initialPromptProblem(prompt: string): string | undefined {
  if (prompt.trimStart().startsWith('!'))
    return 'El primer mensaje no puede empezar con «!»: Claude Code lo correría como un comando de la terminal.'
  return undefined
}
