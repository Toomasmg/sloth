/**
 * «Descubrir herramientas» al armar un conector propio: qué herramientas de un prefijo MCP tiene la
 * cuenta en claude.ai. Se lee del mensaje `system/init` de `--verbose`, que las lista aunque no se
 * pueda llamar a ninguna; si no vinieran ahí, se le pide la lista a Claude como respaldo.
 * Módulo puro (lo corre `node --test` con type stripping).
 */
import { CORTO_RE, PREFIJO_RE } from './conector'
import { servidoresDeSalida } from './cuentas'

const MAX = 150

export const DESCUBRIR_SCHEMA: object = {
  type: 'object',
  properties: { herramientas: { type: 'array', items: { type: 'string' }, maxItems: MAX } },
  required: ['herramientas']
}

export interface Descubiertas {
  herramientas: string[]
  fuente: 'sesion' | 'claude'
  bloqueadas: number
}

export function buildDescubrirArgs(schema: object = DESCUBRIR_SCHEMA, formato: 'json' | 'stream-json' = 'json'): string[] {
  return [
    '-p',
    '--output-format',
    formato,
    '--verbose',
    '--model',
    'haiku',
    // Sin herramientas propias de Claude Code; las MCP siguen listadas en system/init.
    '--tools',
    '',
    // Con allowedTools vacío y el modo default, en -p se rechaza toda llamada MCP salvo las que la cuenta permite en
    // su settings.json (permissions.allow): esas siguen valiendo, porque --setting-sources project,local también
    // escondería los MCP de alcance usuario que hay que descubrir. El prompt es fijo y pide no llamar a ninguna.
    '--allowedTools',
    '',
    '--disallowedTools',
    '',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--permission-mode',
    'default',
    // La respuesta estructurada (StructuredOutput) ya cuenta como un turno.
    '--max-turns',
    '2',
    '--settings',
    JSON.stringify({ disableAllHooks: true }),
    '--json-schema',
    JSON.stringify(schema)
  ]
}

function prefijoValido(prefijo: string): string {
  if (!PREFIJO_RE.test(prefijo)) throw new Error('El prefijo tiene que tener la forma mcp__nombre__.')
  return prefijo
}

export function buildDescubrirPrompt(prefijo: string): string {
  return [
    'No llames a ninguna herramienta.',
    `Devolvé en "herramientas" los nombres completos de las herramientas que tenés disponibles que empiezan con «${prefijoValido(prefijo)}».`,
    'Si no hay ninguna, devolvé la lista vacía.'
  ].join(' ')
}

type Msg = Record<string, unknown>

const esMsg = (v: unknown): v is Msg => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const textos = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

function cortos(prefijo: string, nombres: readonly string[]): string[] {
  const xs = nombres.filter((n) => n.startsWith(prefijo)).map((n) => n.slice(prefijo.length))
  return [...new Set(xs.filter((x) => CORTO_RE.test(x)))].sort().slice(0, MAX)
}

/** Por qué no aparecen herramientas con ese prefijo, según el estado que el system/init le vio al servidor. */
function motivoSinHerramientas(prefijo: string, stdout: string): { causaDelServidor: boolean; texto: string } {
  const s = servidoresDeSalida(stdout)?.find((x) => x.prefijo === prefijo)
  const nombre = s?.nombre ?? prefijo.replace(/^mcp__/, '').replace(/__$/, '')
  if (s?.estado === 'needs-auth')
    return { causaDelServidor: true, texto: `El servidor «${nombre}» pide iniciar sesión: abrí una terminal con esta cuenta, corré /mcp, elegí «${nombre}», autenticalo y volvé a buscar.` }
  if (s?.estado === 'failed')
    return { causaDelServidor: true, texto: `El servidor «${nombre}» no arrancó o no conectó. Corré /mcp en una terminal con esta cuenta para ver el error y volvé a buscar.` }
  if (s?.estado === 'pending') return { causaDelServidor: true, texto: `El servidor «${nombre}» no terminó de conectar a tiempo. Probá de nuevo.` }
  if (s) return { causaDelServidor: false, texto: `El servidor «${nombre}» está en la cuenta, pero no mostró ninguna herramienta.` }
  const deClaudeAi = prefijo.startsWith('mcp__claude_ai_')
  return {
    causaDelServidor: false,
    texto: deClaudeAi
      ? `No encontré herramientas que empiecen con «${prefijo}» en esta cuenta. ¿Está conectado en claude.ai?`
      : `Esta cuenta no tiene un servidor MCP «${nombre}». Agregalo con alcance usuario (claude mcp add --scope user): uno de alcance local o de proyecto solo anda dentro de su carpeta y Sloth consulta desde otra.`
  }
}

export function parseDescubrir(prefijo: string, stdout: string): Descubiertas {
  prefijoValido(prefijo)
  let raw: unknown
  try {
    raw = JSON.parse(stdout.trim())
  } catch {
    throw new Error('No entendí la respuesta de Claude.')
  }
  const msgs = (Array.isArray(raw) ? raw : [raw]).filter(esMsg)
  const result = msgs.find((m) => m.type === 'result')
  const negadas = result?.permission_denials
  const bloqueadas = Array.isArray(negadas) ? negadas.length : 0

  const init = msgs.find((m) => m.type === 'system' && m.subtype === 'init')
  const deSesion = cortos(prefijo, textos(init?.tools))
  // La lista de la sesión vale aunque el resultado sea un error (p. ej. error_max_turns).
  if (deSesion.length) return { herramientas: deSesion, fuente: 'sesion', bloqueadas }

  const motivo = motivoSinHerramientas(prefijo, stdout)
  if (motivo.causaDelServidor) throw new Error(motivo.texto)
  if (!result) throw new Error('La respuesta de Claude no tiene resultado.')
  if (result.is_error === true || (typeof result.subtype === 'string' && result.subtype !== 'success')) {
    const why = typeof result.result === 'string' && result.result ? result.result : String(result.subtype ?? 'error')
    throw new Error(`Claude no pudo completar la consulta: ${why.slice(0, 300)}`)
  }
  const so = result.structured_output
  const deClaude = cortos(prefijo, textos(esMsg(so) ? so.herramientas : undefined))
  if (!deClaude.length) throw new Error(motivo.texto)
  return { herramientas: deClaude, fuente: 'claude', bloqueadas }
}
