/**
 * «Probar» un conector en una cuenta: qué se encontró, por qué y qué hacer. Une lo que dijo el system/init de
 * una sesión, lo que cuenta `claude mcp get <servidor>` (el motivo de un fallo) y una consulta mínima de lectura.
 * Módulo puro (lo corre `node --test` con type stripping): sin enums, namespaces ni parameter properties, y los
 * tipos se importan con `type`.
 */
import type { Disponibilidad, ResultadoPrueba } from '../../../shared/tickets'
import { nombreCompleto, type ConectorMcp } from './conector'
import { ACCION_SCHEMA, buildArgs, negadas, parseEnvelope, TOOL_MISSING, type Limites } from './motor'

export const PROBAR_VUELTAS = 6
const CAUSA_MAX = 200
/** Los nombres que se le pasan a `claude mcp get`: sin espacios ni nada que parezca una opción. */
const NOMBRE_SERVIDOR_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/

export const nombreProbable = (nombre: string): boolean => NOMBRE_SERVIDOR_RE.test(nombre)

/** La herramienta de lectura con la que se prueba: la primera de la lista del conector. */
export const herramientaDeProbar = (def: ConectorMcp): string => def.herramientas.lista[0]

export function buildProbarPrompt(def: ConectorMcp): string {
  const t = herramientaDeProbar(def)
  return [
    `Prueba de conexión de solo lectura con ${def.nombre}. No modifiques nada.`,
    `Llamá UNA sola vez a ${t}, pidiendo lo mínimo (un solo resultado o la página más corta que admita). No llames a otra herramienta.`,
    'Respondé SOLO con JSON, sin texto antes ni después y sin bloque de código:',
    '- si la herramienta respondió: {"ok":true}',
    '- si devolvió un error o no se pudo llamar: {"ok":false,"error":"<el motivo que dio, en pocas palabras>"}',
    `Si la herramienta no está disponible en esta sesión, respondé {"ok":false,"error":"${TOOL_MISSING}"}.`
  ].join('\n')
}

export function buildProbarArgs(def: ConectorMcp, model: string, ajenos: readonly string[] = [], limites: Limites = {}): string[] {
  return [
    ...buildArgs(model, { allow: [nombreCompleto(def, herramientaDeProbar(def))], deny: negadas(def), schema: ACCION_SCHEMA, extraDeny: ajenos, ...limites, maxTurns: PROBAR_VUELTAS }),
    '--verbose'
  ]
}

export interface Prueba {
  ok: boolean
  error?: string
}

/**
 * Lo que sale de un error de servidor puede traer una URL con claves, un `Bearer` o un token: se recorta a una línea,
 * se tapan las partes que parecen secretos y de las URL queda solo el origen.
 */
export function limpiarCausa(texto: string, max = CAUSA_MAX): string {
  const limpio = texto
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 ***')
    .replace(/\b([\w-]*(?:api[_-]?key|token|secret|password|passwd)[\w-]*)\s*[:=]\s*\S+/gi, '$1=***')
    .replace(/(https?:\/\/)[^\s/?#"']*@/gi, '$1')
    .replace(/(https?:\/\/[^\s/?#"']+)[^\s"']*/gi, '$1')
    .replace(/\b[A-Za-z0-9_+/=.~-]{32,}\b/g, '***')
    .replace(/\s+/g, ' ')
    .trim()
  return limpio.length > max ? `${limpio.slice(0, max - 1)}…` : limpio
}

/** Lee la respuesta de la consulta mínima. Tira lo mismo que parseEnvelope (sobre con error, sin JSON…). */
export function parseProbar(def: ConectorMcp, stdout: string): Prueba {
  const { data } = parseEnvelope(def, stdout)
  const o = (data && typeof data === 'object' ? data : {}) as { ok?: unknown; error?: unknown }
  if (o.ok === true) return { ok: true }
  return { ok: false, error: limpiarCausa(typeof o.error === 'string' && o.error.trim() ? o.error : 'sin motivo') }
}

export interface DatosMcp {
  /** «usuario», «local» o «proyecto»: dónde se definió el servidor. */
  alcance?: string
  /** «Issue:» de `claude mcp get`: por qué no conectó. */
  motivo?: string
}

const ALCANCES: [RegExp, string][] = [
  [/^user\b/i, 'usuario'],
  [/^local\b/i, 'local'],
  [/^project\b/i, 'proyecto']
]

/** Solo Scope e Issue de `claude mcp get`: el resto (URL, cabeceras, variables) puede traer credenciales y no se lee. */
export function datosDeMcpGet(stdout: string): DatosMcp {
  const out: DatosMcp = {}
  for (const l of stdout.split(/\r?\n/)) {
    const m = /^\s*(Scope|Issue):\s*(.+)$/.exec(l)
    if (!m) continue
    if (m[1] === 'Scope') out.alcance = ALCANCES.find(([re]) => re.test(m[2].trim()))?.[1]
    else out.motivo = limpiarCausa(m[2])
  }
  return out
}

export type ResultadoDePrueba = Prueba | { plazoS: number } | { cayo: string }

export interface EntradaDiagnostico {
  def: ConectorMcp
  /** El nombre de la cuenta, tal como la ve la persona. */
  cuenta: string
  d: Disponibilidad
  /** Si la revisión de la cuenta falló (no se pudo ni abrir Claude): por qué. */
  errorRevision?: string
  datos?: DatosMcp
  /** La consulta mínima, si se llegó a hacer. */
  prueba?: ResultadoDePrueba
  ms: number
}

const esClaudeAi = (def: ConectorMcp): boolean => def.herramientas.prefijo.startsWith('mcp__claude_ai_')

function sobreAlcance(datos?: DatosMcp): string {
  return datos?.alcance !== undefined && datos.alcance !== 'usuario'
    ? ` Está definido con alcance ${datos.alcance}: Sloth consulta desde otra carpeta y no lo ve; agregalo con alcance usuario (claude mcp add --scope user).`
    : ''
}

export function diagnosticar(e: EntradaDiagnostico): ResultadoPrueba {
  const { def, cuenta, d, datos, prueba, ms } = e
  const n = def.nombre
  const r = (estado: ResultadoPrueba['estado'], mensaje: string, causa?: string, queHacer?: string): ResultadoPrueba => ({
    estado,
    mensaje,
    ...(causa ? { causa } : {}),
    ...(queHacer ? { queHacer } : {}),
    ms
  })
  if (d.tipo === 'sin_revisar')
    return r('error', `No se pudo revisar la cuenta «${cuenta}».`, e.errorRevision, 'Revisá que la cuenta tenga la sesión iniciada y probá de nuevo.')
  if (d.tipo === 'falta') {
    if (d.parecido)
      return r('sin-herramientas', `«${d.parecido.nombre}» no tiene todas las herramientas de ${n}.`, `Le faltan: ${d.parecido.faltan.join(', ')}.`, `Copiá ${n} como conector propio y ajustá sus herramientas, o agregalas al servidor.`)
    return r(
      'sin-herramientas',
      `La cuenta «${cuenta}» no tiene el servidor MCP de ${n}.`,
      undefined,
      esClaudeAi(def)
        ? `Conectá ${n} en claude.ai con esa cuenta (Configuración → Conectores) y probá de nuevo.`
        : 'Agregalo en esa cuenta con alcance usuario (claude mcp add --scope user) y probá de nuevo. Un servidor de alcance local o de proyecto solo anda dentro de su carpeta: Sloth consulta desde otra.'
    )
  }
  if (d.tipo === 'elegir')
    return r('error', `La cuenta «${cuenta}» tiene más de un servidor que puede ser ${n}.`, undefined, 'Elegí cuál usa Sloth en «Conectores por cuenta».')
  const s = `«${d.nombre}»`
  if (d.estado === 'needs-auth')
    return r(
      'necesita-sesion',
      `El servidor ${s} pide iniciar sesión.`,
      datos?.motivo,
      d.nombre.startsWith('claude.ai ')
        ? `Volvé a autorizar ${n} en claude.ai con la cuenta «${cuenta}» y probá de nuevo.`
        : `Abrí Claude Code con la cuenta «${cuenta}», corré /mcp, elegí ${s} y autenticalo; después tocá Probar.`
    )
  if (d.estado === 'failed')
    return r('error', `No se pudo conectar a ${s}.`, datos?.motivo ?? 'Claude Code no dijo por qué.', `Corré /mcp con la cuenta «${cuenta}» para ver el error.${sobreAlcance(datos)}`)
  if (d.estado !== 'connected')
    return r(
      'error',
      `${s} no terminó de conectar a tiempo.`,
      datos?.motivo ?? 'Todavía figuraba conectando (pending).',
      'Probá de nuevo. Si sigue igual, corré /mcp con esa cuenta: puede estar esperando que lo autentiques o arrancar lento.'
    )
  if (!d.verificado) return r('sin-herramientas', `${s} conectó, pero no se le vieron las herramientas de ${n}.`, undefined, 'Tocá «Revisar» y probá de nuevo.')
  const t = herramientaDeProbar(def)
  if (prueba === undefined) return r('conectado', `${s} está conectado y tiene las herramientas de ${n}.`)
  if ('plazoS' in prueba)
    return r('error', `${s} está conectado, pero ${t} tardó más de ${prueba.plazoS} s en responder.`, undefined, 'Probá de nuevo. Si es un servidor propio, revisá que no esté lento o colgado.')
  if ('cayo' in prueba) return r('error', `${s} está conectado, pero la consulta de prueba falló.`, prueba.cayo, 'Probá de nuevo o corré /mcp con esa cuenta.')
  if (prueba.ok) return r('conectado', `${s} está conectado y respondió a una consulta de prueba (${Math.max(1, Math.round(ms / 1000))} s).`)
  if (prueba.error === TOOL_MISSING)
    return r('sin-herramientas', `${s} conectó, pero la herramienta ${t} no está disponible en esta sesión.`, undefined, `Revisá que el servidor exponga ${t}, o ajustá las herramientas del conector.`)
  return r('error', `${s} conectó, pero ${t} devolvió un error.`, prueba.error, 'Revisá el servidor o tus permisos en el sistema de tickets, y probá de nuevo.')
}
