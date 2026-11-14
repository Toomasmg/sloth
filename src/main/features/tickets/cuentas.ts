/**
 * Qué servidores MCP tiene cada cuenta y cuál le sirve a cada conector. Un preset espera un prefijo
 * (p. ej. el conector de claude.ai `mcp__claude_ai_Gruv__`), pero la cuenta puede tener el mismo
 * sistema como MCP propio con otro nombre (`gruv-tomy`): se adapta solo el prefijo, nunca las
 * herramientas. Lo que viene de `system/init` o de Claude es dato no confiable: se valida todo.
 * Módulo puro (lo corre `node --test` con type stripping): sin enums, namespaces ni parameter
 * properties, y los tipos se importan con `type`.
 */
import { CORTO_RE, PREFIJO_RE, type ConectorMcp } from './conector'
import type { CuentaRevisada, Disponibilidad, EstadoMcp, ServidorMcp } from '../../../shared/tickets'

export const REVISAR_MAX = 400
const HERRAMIENTAS_MAX = 150
const SERVIDORES_MAX = 100
const NOMBRE_MAX = 128
const ERROR_MAX = 500
const CUENTAS_MAX = 50
const ESTADOS: readonly EstadoMcp[] = ['connected', 'needs-auth', 'failed', 'pending', 'otro']
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const PALABRAS_FUERA = ['mcp', 'claude', 'com']

export const REVISAR_SCHEMA: object = {
  type: 'object',
  properties: { herramientas: { type: 'array', items: { type: 'string' }, maxItems: REVISAR_MAX } },
  required: ['herramientas']
}

export function buildRevisarPrompt(): string {
  return 'No llames a ninguna herramienta. Devolvé en "herramientas" los nombres completos de todas tus herramientas que empiezan con «mcp__». Si no hay ninguna, devolvé la lista vacía.'
}

/** Como arma Claude Code el prefijo: «claude.ai Atlassian MCP» → `mcp__claude_ai_Atlassian_MCP__`. */
export function prefijoDeServidor(nombre: string): string | undefined {
  if (!nombre || nombre.length > 64) return undefined
  const p = `mcp__${nombre.replace(/[^A-Za-z0-9_-]/g, '_')}__`
  return PREFIJO_RE.test(p) ? p : undefined
}

type Msg = Record<string, unknown>
const esMsg = (v: unknown): v is Msg => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const textos = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const estadoDe = (v: unknown): EstadoMcp => (typeof v === 'string' && v !== 'otro' && ESTADOS.includes(v as EstadoMcp) ? (v as EstadoMcp) : 'otro')
const nombreValido = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= NOMBRE_MAX && !CONTROL.test(v)

function mensajes(stdout: string): Msg[] | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(stdout.trim())
  } catch {
    return undefined
  }
  return (Array.isArray(raw) ? raw : [raw]).filter(esMsg)
}

/**
 * Reparte los nombres completos entre los servidores. Cada uno va al prefijo más largo que calce:
 * `mcp__gruv__x__otra` es del servidor `gruv__x`, no una herramienta `x__otra` de `gruv`.
 */
function repartir(servidores: readonly ServidorMcp[], nombres: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const porLargo = [...servidores].sort((a, b) => b.prefijo.length - a.prefijo.length)
  for (const n of nombres) {
    const s = porLargo.find((x) => n.startsWith(x.prefijo))
    if (!s) continue
    const corto = n.slice(s.prefijo.length)
    if (!CORTO_RE.test(corto)) continue
    const xs = out.get(s.prefijo) ?? []
    if (!xs.includes(corto) && xs.length < HERRAMIENTAS_MAX) xs.push(corto)
    out.set(s.prefijo, xs)
  }
  for (const xs of out.values()) xs.sort()
  return out
}

/**
 * Los servidores del `system/init` de `--output-format json --verbose`. La respuesta de Claude solo
 * completa herramientas de servidores que ya vinieron en init y no las listaron. undefined sin init.
 */
export function servidoresDeSalida(stdout: string): ServidorMcp[] | undefined {
  const msgs = mensajes(stdout)
  const init = msgs?.find((m) => m.type === 'system' && m.subtype === 'init')
  if (!init) return undefined
  const crudos = Array.isArray(init.mcp_servers) ? init.mcp_servers.slice(0, SERVIDORES_MAX) : []
  const leidos: ServidorMcp[] = []
  for (const c of crudos) {
    if (!esMsg(c) || !nombreValido(c.name)) continue
    const prefijo = prefijoDeServidor(c.name)
    if (prefijo) leidos.push({ nombre: c.name, prefijo, estado: estadoDe(c.status) })
  }
  // Dos servidores con el mismo prefijo no se pueden distinguir: habilitar uno habilitaría el otro.
  const servidores = leidos.filter((s) => leidos.filter((x) => x.prefijo === s.prefijo).length === 1)
  const deInit = repartir(servidores, textos(init.tools))
  for (const s of servidores) {
    const xs = deInit.get(s.prefijo)
    if (xs) s.herramientas = xs
    else if (s.estado === 'connected') s.herramientas = []
  }
  const result = msgs?.find((m) => m.type === 'result')
  const so = result?.structured_output
  const faltan = servidores.filter((s) => !s.herramientas)
  if (faltan.length && esMsg(so)) {
    const deClaude = repartir(servidores, textos(so.herramientas).slice(0, REVISAR_MAX))
    for (const s of faltan) {
      const xs = deClaude.get(s.prefijo)
      if (xs?.length) s.herramientas = xs
    }
  }
  return servidores
}

export function revisarCuenta(stdout: string, ahora: number): CuentaRevisada {
  const servidores = servidoresDeSalida(stdout)
  if (!servidores) throw new Error('No entendí la respuesta de Claude.')
  return { revisadaEn: ahora, servidores }
}

const nucleo = (prefijo: string): string => prefijo.replace(/^mcp__/, '').replace(/__$/, '').toLowerCase()

function palabras(def: ConectorMcp): string[] {
  const xs = [...def.id.split('-'), ...def.nombre.toLowerCase().split(/[^a-z0-9]+/), ...nucleo(def.herramientas.prefijo).replace(/^claude_ai_/, '').split('_')]
  return [...new Set(xs.filter((x) => x.length >= 3 && !PALABRAS_FUERA.includes(x)))]
}

const tieneLista = (def: ConectorMcp, s: ServidorMcp): boolean => !s.herramientas || def.herramientas.lista.every((t) => s.herramientas?.includes(t))

/** Los servidores de la cuenta que pueden ser el de este conector. */
export function candidatos(def: ConectorMcp, servidores: readonly ServidorMcp[]): ServidorMcp[] {
  const exacto = servidores.find((s) => s.prefijo === def.herramientas.prefijo)
  if (exacto) return [exacto]
  const ps = palabras(def)
  return servidores.filter((s) => ps.some((p) => nucleo(s.prefijo).includes(p)) && tieneLista(def, s))
}

function tiene(def: ConectorMcp, s: ServidorMcp): Disponibilidad {
  return {
    tipo: 'tiene',
    nombre: s.nombre,
    prefijo: s.prefijo,
    estado: s.estado,
    adaptado: s.prefijo !== def.herramientas.prefijo,
    verificado: Boolean(s.herramientas) && tieneLista(def, s)
  }
}

export function disponibilidad(def: ConectorMcp, cuenta: CuentaRevisada | undefined, elegido?: string): Disponibilidad {
  if (!cuenta) return { tipo: 'sin_revisar' }
  const cs = candidatos(def, cuenta.servidores)
  if (!cs.length) return { tipo: 'falta' }
  const elegida = elegido ? cs.find((s) => s.prefijo === elegido) : undefined
  if (elegida) return tiene(def, elegida)
  const exacto = cs.find((s) => s.prefijo === def.herramientas.prefijo)
  if (exacto) return tiene(def, exacto)
  const verificados = cs.filter((s) => s.herramientas)
  if (verificados.length === 1) return tiene(def, verificados[0])
  if (cs.length === 1) return tiene(def, cs[0])
  return { tipo: 'elegir', opciones: cs.map((s) => ({ nombre: s.nombre, prefijo: s.prefijo, estado: s.estado })) }
}

/** Una copia que llama a las mismas herramientas cortas con el prefijo del servidor de la cuenta. */
export function conPrefijo(def: ConectorMcp, prefijo: string): ConectorMcp {
  if (!PREFIJO_RE.test(prefijo) || prefijo.length > 64) throw new Error('El prefijo tiene que tener la forma mcp__nombre__.')
  return { ...def, herramientas: { ...def.herramientas, prefijo } }
}

export const usable = (d: Disponibilidad): boolean => d.tipo === 'tiene' && d.estado !== 'needs-auth' && d.estado !== 'failed'

/**
 * Por qué la sesión que acaba de correr no pudo leer el conector, o undefined si lo tenía conectado
 * con sus herramientas. Sirve para que una lista vacía no pase por «no hay tickets».
 */
export function problemaEnSesion(def: ConectorMcp, prefijoUsado: string, sesion: readonly ServidorMcp[] | undefined): Disponibilidad | undefined {
  if (!sesion) return undefined
  const s = sesion.find((x) => x.prefijo === prefijoUsado)
  if (!s) return { tipo: 'falta' }
  if (s.herramientas && !tieneLista(def, s)) return { tipo: 'falta' }
  const d = tiene(def, s)
  if (s.estado === 'connected' && d.tipo === 'tiene' && d.verificado) return undefined
  return d
}

export function mensajeCuenta(def: ConectorMcp, d: Disponibilidad, cuenta: string, otras: readonly string[]): string | undefined {
  const n = def.nombre
  const esClaudeAi = def.herramientas.prefijo.startsWith('mcp__claude_ai_')
  if (d.tipo === 'sin_revisar') return undefined
  if (d.tipo === 'falta') {
    const base = esClaudeAi
      ? `Conectá ${n} en claude.ai con la cuenta «${cuenta}» (claude.ai → Configuración → Conectores) y tocá «Volver a revisar».`
      : `La cuenta «${cuenta}» no tiene el servidor MCP de ${n}. Agregalo en esa cuenta y tocá «Volver a revisar».`
    return otras.length ? `${base} Lo tiene: ${otras.map((o) => `«${o}»`).join(', ')}.` : base
  }
  if (d.tipo === 'elegir') return `La cuenta «${cuenta}» tiene más de un servidor que puede ser ${n}. Elegí cuál en los ajustes de Tickets.`
  const deClaudeAi = d.nombre.startsWith('claude.ai ')
  if (d.estado === 'needs-auth')
    return deClaudeAi
      ? `${n} necesita que lo vuelvas a autorizar en claude.ai con la cuenta «${cuenta}».`
      : `Abrí una terminal con la cuenta «${cuenta}», corré /mcp y autenticá «${d.nombre}».`
  if (d.estado === 'failed') return `El servidor «${d.nombre}» de la cuenta «${cuenta}» no arrancó. Revisalo con /mcp en una terminal de esa cuenta.`
  if (usable(d) && d.verificado && d.estado !== 'pending') return undefined
  // Un MCP propio que queda pending suele estar esperando que lo autentiquen.
  const auth = deClaudeAi ? '' : ' Si pide autenticarse, abrí una terminal con esa cuenta y corré /mcp.'
  return `«${d.nombre}» no respondió a tiempo en la cuenta «${cuenta}».${auth} Podés probar igual o tocar «Volver a revisar».`
}

function sanearServidor(v: unknown): ServidorMcp | undefined {
  if (!esMsg(v) || !nombreValido(v.nombre)) return undefined
  if (typeof v.prefijo !== 'string' || v.prefijo.length > 64 || !PREFIJO_RE.test(v.prefijo)) return undefined
  if (typeof v.estado !== 'string' || !ESTADOS.includes(v.estado as EstadoMcp)) return undefined
  const s: ServidorMcp = { nombre: v.nombre, prefijo: v.prefijo, estado: v.estado as EstadoMcp }
  if (Array.isArray(v.herramientas)) s.herramientas = [...new Set(textos(v.herramientas).filter((t) => CORTO_RE.test(t)))].slice(0, HERRAMIENTAS_MAX)
  return s
}

/** tickets-cuentas.json `{ version: 1, cuentas }`. null si no tiene esa forma (se respalda y se empieza de cero). */
export function sanearCache(raw: unknown): Record<string, CuentaRevisada> | null {
  if (!esMsg(raw) || raw.version !== 1 || !esMsg(raw.cuentas)) return null
  const out: Record<string, CuentaRevisada> = {}
  for (const [id, c] of Object.entries(raw.cuentas).slice(0, CUENTAS_MAX)) {
    if (!id || id.length > 64 || id === '__proto__' || !esMsg(c)) continue
    if (typeof c.revisadaEn !== 'number' || !Number.isFinite(c.revisadaEn) || !Array.isArray(c.servidores)) continue
    const servidores = c.servidores.slice(0, SERVIDORES_MAX).flatMap((s) => sanearServidor(s) ?? [])
    const r: CuentaRevisada = { revisadaEn: c.revisadaEn, servidores }
    if (typeof c.error === 'string' && c.error) r.error = c.error.slice(0, ERROR_MAX)
    out[id] = r
  }
  return out
}
