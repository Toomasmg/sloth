/**
 * Alta y baja PURA del MCP `sloth` en el .claude.json de una cuenta. Nunca toca otros servidores ni
 * otras claves, y nunca pisa un `sloth` que no haya puesto Sloth.
 */
export const MCP_NAME = 'sloth'
export const MCP_SCRIPT_NAME = 'sloth-chat-mcp.cjs'

export interface McpEntry {
  type: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export const CUENTA_ARG = '--cuenta'

/** El id de la cuenta va fijo en los args: el pipe lo usa para rechazar pedidos de cuentas no habilitadas. */
export function entradaMcp(scriptPath: string, accountId: string): McpEntry {
  return { type: 'stdio', command: 'node', args: [scriptPath.replace(/\\/g, '/'), CUENTA_ARG, accountId], env: {} }
}

export function esNuestra(v: unknown): boolean {
  if (!isObj(v) || !Array.isArray(v.args)) return false
  const first: unknown = v.args[0]
  return typeof first === 'string' && first.replace(/\\/g, '/').endsWith(`/${MCP_SCRIPT_NAME}`)
}

function mismaEntrada(v: unknown, e: McpEntry): boolean {
  if (!isObj(v) || v.type !== e.type || v.command !== e.command) return false
  if (!Array.isArray(v.args) || v.args.length !== e.args.length || v.args.some((a, i) => a !== e.args[i])) return false
  const env = v.env
  if (!isObj(env)) return false
  const keys = Object.keys(env)
  return keys.length === Object.keys(e.env).length && keys.every((k) => env[k] === e.env[k])
}

/** Con `entrada` null, desregistra. `json` viene solo si hay que escribir, y es una copia: la entrada no se toca. */
export function aplicarRegistro(json: Record<string, unknown>, entrada: McpEntry | null): { json?: Record<string, unknown>; state: 'ok' | 'conflicto' } {
  const servers = json.mcpServers
  if (servers !== undefined && !isObj(servers)) return { state: 'conflicto' }
  const cur = servers?.[MCP_NAME]
  if (entrada === null) {
    if (!servers || !esNuestra(cur)) return { state: 'ok' }
    const copia = JSON.parse(JSON.stringify(json)) as Record<string, unknown>
    delete (copia.mcpServers as Record<string, unknown>)[MCP_NAME]
    return { json: copia, state: 'ok' }
  }
  if (cur !== undefined && !esNuestra(cur)) return { state: 'conflicto' }
  if (mismaEntrada(cur, entrada)) return { state: 'ok' }
  const copia = JSON.parse(JSON.stringify(json)) as Record<string, unknown>
  copia.mcpServers = { ...(isObj(copia.mcpServers) ? copia.mcpServers : {}), [MCP_NAME]: { ...entrada, args: [...entrada.args], env: { ...entrada.env } } }
  return { json: copia, state: 'ok' }
}
