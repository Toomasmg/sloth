import { execFile, spawn } from 'node:child_process'
import { extractJson, normEstado, NO_GRUV, NoGruvError, WRITE_TOOLS } from './gruv-claude'
import { ACTIVE_ESTADOS, TICKET_ID_RE, type ActiveEstado, type GruvPersona, type TeamTicket } from './team-core'

/**
 * Consulta de solo lectura a Gruv para la vista «Equipo»: los tickets activos de todo el equipo con
 * su responsable. Igual que el tablero, va por Claude headless (`claude -p`) con la cuenta elegida.
 * No importa electron para poder probarlo con Node.
 */

export const TEAM_READ_TOOLS = [
  'mcp__claude_ai_Gruv__listar_tickets',
  'mcp__claude_ai_Gruv__ver_flujo_tickets',
  'mcp__claude_ai_Gruv__buscar_persona',
  'mcp__claude_ai_Gruv__ver_equipo_del_proyecto'
]
export const TEAM_RUN_TIMEOUT_MS = 180_000
const MAX_STDOUT = 4 * 1024 * 1024
const MAX_TICKETS = 400
const MAX_PERSONAS = 200

export interface TeamGruvResult {
  tickets: TeamTicket[]
  personas: GruvPersona[]
  tokens?: number
  costUsd?: number
  durationMs?: number
}

export const TEAM_SCHEMA = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    personas: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, nombre: { type: 'string' } }, required: ['nombre'] }
    },
    tickets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          titulo: { type: 'string' },
          estado: { type: 'string' },
          responsable: { type: 'string' },
          responsable_id: { type: 'string' },
          proyecto: { type: 'string' },
          url: { type: 'string' }
        },
        required: ['id', 'titulo', 'estado']
      }
    }
  },
  required: ['tickets']
}

export interface TeamQuery {
  /** Espacio de Gruv para filtrar los tickets (clave o nombre). Vacío = todos. */
  espacio?: string
  /** Proyecto de Gruv para traer también a quien no tiene tickets (ver_equipo_del_proyecto). */
  proyecto?: string
}

const quote = (s: string): string => JSON.stringify(s.replace(/[\r\n]+/g, ' '))

export function buildTeamPrompt(q: TeamQuery = {}): string {
  const espacio = q.espacio ? `, espacio: ${quote(q.espacio)}` : ''
  const lines = [
    'Tarea de solo lectura. No modifiques nada en Gruv: no comentes, no muevas, no asignes, no tildes nada.',
    `1. Para cada uno de estos estados: ${ACTIVE_ESTADOS.join(', ')}, llamá a la herramienta de Gruv listar_tickets con estado: "<ese estado>", limite: 100${espacio}, SIN filtrar por asignado (quiero los de todo el equipo). Si vuelven 100, seguí con desplazamiento: 100, 200 (como máximo 300 por estado).`,
    q.proyecto
      ? `2. Llamá a ver_equipo_del_proyecto con proyecto: ${quote(q.proyecto)} y armá "personas" con cada integrante (su UUID en id y su nombre).`
      : '2. Armá "personas" con los responsables distintos de esos tickets (id = su UUID si lo da, nombre = como se ve).',
    'Respondé SOLO con un JSON, sin texto antes ni después y sin bloque de código, con esta forma:',
    '{"personas":[{"id":"<uuid>","nombre":"Ana Pérez"}],"tickets":[{"id":"TCK-1234","titulo":"…","estado":"<clave del estado, p. ej. en_revision>","responsable":"<nombre del responsable>","responsable_id":"<uuid del responsable>","proyecto":"<espacio o proyecto, si lo da>","url":"<link al ticket, si lo da>"}]}',
    'Si un ticket no tiene responsable, no pongas responsable ni responsable_id. Si un campo opcional no viene, no lo pongas. Si no hay tickets, devolvé "tickets":[].',
    `Si no tenés ninguna herramienta de Gruv disponible, respondé exactamente {"error":"${NO_GRUV}","tickets":[]}.`
  ]
  return lines.join('\n')
}

export function buildTeamArgs(model: string): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--model',
    model,
    '--tools',
    '',
    '--allowedTools',
    TEAM_READ_TOOLS.join(','),
    '--disallowedTools',
    WRITE_TOOLS.join(','),
    '--no-session-persistence',
    '--settings',
    JSON.stringify({ disableAllHooks: true }),
    '--json-schema',
    JSON.stringify(TEAM_SCHEMA)
  ]
}

const str = (v: unknown, max: number): string | undefined => {
  if (typeof v === 'number') v = String(v)
  if (typeof v !== 'string') return undefined
  const s = v.replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, max) : undefined
}
const UUID_RE = /^[A-Za-z0-9-]{1,64}$/
const isActive = (e: string | undefined): e is ActiveEstado => Boolean(e) && (ACTIVE_ESTADOS as readonly string[]).includes(e!)

/** Valida y limpia lo que devolvió Claude (no confiamos en la forma). */
export function normalizeTeam(raw: unknown): { tickets: TeamTicket[]; personas: GruvPersona[] } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const list = Array.isArray(raw) ? raw : Array.isArray(o.tickets) ? (o.tickets as unknown[]) : null
  if (!list) throw new Error('La respuesta no trae una lista de tickets.')
  const tickets = new Map<string, TeamTicket>()
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const t = item as Record<string, unknown>
    const id = str(t.id ?? t.codigo, 20)?.toUpperCase()
    if (!id || !TICKET_ID_RE.test(id)) continue
    const estado = normEstado(t.estado ?? t.status)
    if (!isActive(estado)) continue
    const out: TeamTicket = { id, titulo: str(t.titulo ?? t.title, 300) ?? id, estado }
    const resp = t.responsable
    const respName = typeof resp === 'object' && resp ? str((resp as Record<string, unknown>).nombre, 100) : str(resp, 100)
    const respId = str(t.responsable_id ?? t.responsableId ?? (typeof resp === 'object' && resp ? (resp as Record<string, unknown>).id : undefined), 64)
    if (respName && !/^(sin asignar|sin_asignar|nadie|-)$/i.test(respName)) out.responsable = respName
    if (respId && UUID_RE.test(respId) && respId !== 'sin_asignar') out.responsableId = respId
    const proyecto = str(t.proyecto ?? t.espacio ?? t.project, 80)
    if (proyecto) out.proyecto = proyecto
    const url = str(t.url ?? t.link, 500)
    if (url && /^https?:\/\//i.test(url)) out.url = url
    tickets.set(id, out)
    if (tickets.size >= MAX_TICKETS) break
  }
  const personas = new Map<string, GruvPersona>()
  if (Array.isArray(o.personas)) {
    for (const item of o.personas) {
      if (!item || typeof item !== 'object') continue
      const p = item as Record<string, unknown>
      const nombre = str(p.nombre ?? p.name, 100)
      const id = str(p.id, 64)
      if (!nombre) continue
      const persona: GruvPersona = { nombre }
      if (id && UUID_RE.test(id)) persona.id = id
      personas.set(persona.id ?? nombre.toLowerCase(), persona)
      if (personas.size >= MAX_PERSONAS) break
    }
  }
  return { tickets: [...tickets.values()], personas: [...personas.values()] }
}

/** Interpreta el stdout de `claude -p --output-format json` (mismo sobre que el tablero). */
export function parseTeamOutput(stdout: string): TeamGruvResult {
  const trimmed = stdout.trim()
  let env: Record<string, unknown> | undefined
  try {
    env = JSON.parse(trimmed)
  } catch {
    for (const l of trimmed.split(/\r?\n/).reverse()) {
      try {
        const j = JSON.parse(l)
        if (j && typeof j === 'object' && 'type' in j) {
          env = j
          break
        }
      } catch {
        /* sigue */
      }
    }
  }
  if (Array.isArray(env)) env = (env as unknown[]).reverse().find((m) => (m as { type?: string })?.type === 'result') as Record<string, unknown> | undefined
  if (!env || typeof env !== 'object') throw new Error('No entendí la respuesta de Claude.')
  const result = typeof env.result === 'string' ? env.result : ''
  if (env.is_error === true || (typeof env.subtype === 'string' && env.subtype !== 'success')) {
    const why = result || (typeof env.subtype === 'string' ? env.subtype : 'error')
    throw new Error(`Claude no pudo completar la consulta: ${why.slice(0, 300)}`)
  }
  let data: unknown
  try {
    data = env.structured_output && typeof env.structured_output === 'object' ? env.structured_output : extractJson(result)
  } catch (e) {
    if (/gruv/i.test(result) && /(no (tengo|hay|encuentro|está|dispon)|not (available|found)|sin acceso)/i.test(result)) throw new NoGruvError()
    throw e
  }
  if (data && typeof data === 'object' && (data as { error?: unknown }).error === NO_GRUV) throw new NoGruvError()
  const { tickets, personas } = normalizeTeam(data)
  if (!tickets.length && Array.isArray(env.permission_denials) && env.permission_denials.length)
    throw new Error('Claude no pudo usar las herramientas de Gruv (permiso negado). Probá de nuevo.')
  const usage = env.usage as Record<string, number> | undefined
  const tokens = usage
    ? ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((n, k) => n + (typeof usage[k] === 'number' ? usage[k] : 0), 0)
    : undefined
  return {
    tickets,
    personas,
    tokens,
    costUsd: typeof env.total_cost_usd === 'number' ? env.total_cost_usd : undefined,
    durationMs: typeof env.duration_ms === 'number' ? env.duration_ms : undefined
  }
}

function killTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
  else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* ya terminó */
    }
  }
}

export interface TeamRunOptions {
  exe: string
  args: string[]
  prompt: string
  cwd: string
  env: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
}

/** Corre Claude headless con el prompt por stdin (sin shell). */
export function runTeamClaude(o: TeamRunOptions): Promise<TeamGruvResult> {
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    let done = false
    const ms = o.timeoutMs ?? TEAM_RUN_TIMEOUT_MS
    const child = spawn(o.exe, o.args, { cwd: o.cwd, env: o.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const finish = (e?: Error, r?: TeamGruvResult): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
      if (e) reject(e)
      else resolve(r!)
    }
    const timer = setTimeout(() => {
      killTree(child.pid)
      finish(new Error(`Gruv no respondió en ${Math.round(ms / 1000)} s. Probá de nuevo.`))
    }, ms)
    const onAbort = (): void => {
      killTree(child.pid)
      finish(new Error('Consulta cancelada.'))
    }
    o.signal?.addEventListener('abort', onAbort)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      if (out.length < MAX_STDOUT) out += d
    })
    child.stderr.on('data', (d: string) => {
      if (err.length < 8000) err += d
    })
    child.on('error', (e) => finish(new Error(`No pude abrir Claude: ${e.message}`)))
    child.on('close', (code) => {
      if (done) return
      try {
        finish(undefined, parseTeamOutput(out))
      } catch (e) {
        const extra = code ? ` (salió con código ${code}${err.trim() ? `: ${err.trim().slice(0, 300)}` : ''})` : ''
        finish(e instanceof NoGruvError ? e : new Error(`${(e as Error).message}${extra}`))
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(o.prompt, 'utf8')
  })
}
