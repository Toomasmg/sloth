/**
 * Variables de entorno de cada `claude -p` de tickets que no dependen de la cuenta. Módulo puro (lo corre
 * `node --test` con type stripping): sin enums, namespaces ni parameter properties.
 */

/** Los conectores de claude.ai llevan este prefijo; los demás servidores MCP son de la cuenta (`claude mcp add`). */
export const PREFIJO_CLAUDE_AI = 'mcp__claude_ai_'

export interface EntornoConsulta {
  env: Record<string, string>
  /** La sesión corre sin los conectores de claude.ai: su system/init no los trae. */
  sinClaudeAi: boolean
}

/**
 * `prefijo` es el del servidor que va a usar la consulta; sin él (revisar, descubrir) la sesión ve todo.
 *
 * Un MCP propio lento puede tardar más que el tope por defecto de Claude Code en arrancar, y con el tope de salida por defecto
 * (25.000 tokens) una página grande de tickets se rechaza: por eso MCP_TIMEOUT y MAX_MCP_OUTPUT_TOKENS.
 *
 * Claude Code en modo -p ya no espera a que conecten los servidores MCP de la cuenta (alcance usuario o proyecto): arma la
 * lista de herramientas del primer turno antes, el system/init los muestra `pending` y sin herramientas, y el modelo
 * contesta que no tiene el conector. Probado con claude 2.1.332 contra un servidor http local: 4 de 4 consultas quedaban
 * `pending` y con MCP_CONNECTION_NONBLOCKING=false 4 de 4 conectaban. Los de claude.ai ya tienen su propia espera previa,
 * así que con ellos no se toca. Una versión que no conozca la variable la ignora.
 */
export function entornoConsulta(prefijo?: string): EntornoConsulta {
  const base = { MCP_TIMEOUT: '30000', MAX_MCP_OUTPUT_TOKENS: '50000' }
  if (prefijo !== undefined && prefijo.startsWith(PREFIJO_CLAUDE_AI)) return { env: base, sinClaudeAi: false }
  // Conectar todos los de claude.ai solo para no usarlos demora cada consulta; si la variable no existe en esta versión, el init los trae igual.
  const propio = { ...base, MCP_CONNECTION_NONBLOCKING: 'false' }
  return prefijo === undefined ? { env: propio, sinClaudeAi: false } : { env: { ...propio, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }, sinClaudeAi: true }
}
