/**
 * Registro del MCP `sloth` en una cuenta, PURO: qué hay hoy en su .claude.json (solo se lee), qué hay que
 * hacer y los argumentos del CLI oficial (`claude mcp add/remove -s user`), que es el único que lo escribe.
 * Nunca se toca un `sloth` que no haya puesto Sloth.
 */
export const MCP_NAME = 'sloth'
export const MCP_SCRIPT_NAME = 'sloth-chat-mcp.cjs'
export const TOKEN_ENV = 'SLOTH_CHAT_TOKEN'

const HEX64_RE = /^[0-9a-f]{64}$/
const CONTROLES = /[\u0000-\u001F\u007F"]/

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export const normalizarRuta = (p: string): string => p.replace(/\\/g, '/')

export type Registro = { estado: 'ausente' } | { estado: 'ajena' } | { estado: 'nuestra'; script: string; token?: string }

export function esNuestra(v: unknown): boolean {
  if (!isObj(v) || !Array.isArray(v.args)) return false
  const first: unknown = v.args[0]
  return typeof first === 'string' && normalizarRuta(first).endsWith(`/${MCP_SCRIPT_NAME}`)
}

/** Lo que hay hoy en el `mcpServers` de usuario. Un `mcpServers` raro cuenta como ajeno: no se toca. */
export function leerRegistro(json: unknown): Registro {
  if (!isObj(json)) return { estado: 'ajena' }
  const servers = json.mcpServers
  if (servers === undefined) return { estado: 'ausente' }
  if (!isObj(servers)) return { estado: 'ajena' }
  const cur = servers[MCP_NAME]
  if (cur === undefined) return { estado: 'ausente' }
  if (!esNuestra(cur) || !isObj(cur)) return { estado: 'ajena' }
  const script = normalizarRuta(String((cur.args as unknown[])[0]))
  const env = cur.env
  const token = isObj(env) && typeof env[TOKEN_ENV] === 'string' ? env[TOKEN_ENV] : undefined
  return token === undefined ? { estado: 'nuestra', script } : { estado: 'nuestra', script, token }
}

export type Accion = 'nada' | 'conflicto' | 'alta' | 'reemplazo' | 'baja'

/**
 * `hashGuardado` es el del token que el main reconoce para la cuenta. Si el registro tiene otro token (o
 * ninguno, como los de antes), se reemplaza: con ese token el pipe no lo dejaría pasar.
 */
export function planificar(quiere: boolean, actual: Registro, script: string, hashGuardado: string | undefined, hashDe: (token: string) => string): Accion {
  if (actual.estado === 'ajena') return quiere ? 'conflicto' : 'nada'
  if (actual.estado === 'ausente') return quiere ? 'alta' : 'nada'
  if (!quiere) return 'baja'
  const vigente = actual.script === normalizarRuta(script) && actual.token !== undefined && hashGuardado !== undefined && hashDe(actual.token) === hashGuardado
  return vigente ? 'nada' : 'reemplazo'
}

function validarScript(script: string): string {
  const s = normalizarRuta(script)
  const absoluta = /^[A-Za-z]:\//.test(s) || s.startsWith('/')
  if (!absoluta || s.length > 1024 || CONTROLES.test(s) || !s.endsWith(`/${MCP_SCRIPT_NAME}`)) throw new Error('Ruta del script inválida.')
  return s
}

export function argsAlta(script: string, token: string): string[] {
  if (!HEX64_RE.test(token)) throw new Error('Token inválido.')
  return ['mcp', 'add', '-s', 'user', MCP_NAME, '-e', `${TOKEN_ENV}=${token}`, '--', 'node', validarScript(script)]
}

export const argsBaja = (): string[] => ['mcp', 'remove', '-s', 'user', MCP_NAME]
