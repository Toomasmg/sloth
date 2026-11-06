import { spawn, execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Gruv es un conector de claude.ai («claude.ai Gruv», herramientas `mcp__claude_ai_Gruv__*`):
 * no hay URL ni comando local para hablarle desde afuera. La única vía es Claude Code en modo
 * headless (`claude -p`) con una cuenta que tenga ese conector. Este archivo no importa electron
 * para poder probarlo con Node solo.
 */

export interface GruvTicket {
  id: string
  titulo: string
  estado?: string
  prioridad?: string
  proyecto?: string
  url?: string
}

/** Una columna del tablero de Gruv (de `ver_flujo_tickets`). */
export interface GruvEstado {
  clave: string
  nombre: string
}

export interface RunResult {
  tickets: GruvTicket[]
  /** Estados en el orden de las columnas, si Claude los pudo leer. */
  estados?: GruvEstado[]
  costUsd?: number
  tokens?: number
  durationMs?: number
}

export const TICKET_RE = /^[A-Z][A-Z0-9]*-\d{1,7}$/
export const RUN_TIMEOUT_MS = 120_000
const MAX_TICKETS = 500
const MAX_STDOUT = 4 * 1024 * 1024

/** Solo lectura: lo único que se le permite usar a Claude en la consulta. */
export const READ_TOOLS = [
  'mcp__claude_ai_Gruv__listar_tickets',
  'mcp__claude_ai_Gruv__ver_flujo_tickets',
  'mcp__claude_ai_Gruv__ver_mi_inicio',
  'mcp__claude_ai_Gruv__buscar_persona'
]

/** Claude responde esto cuando la cuenta no tiene el conector de Gruv. */
export const NO_GRUV = 'sin_gruv'
export class NoGruvError extends Error {
  constructor() {
    super('Conectá Gruv en claude.ai con esta cuenta (claude.ai → Configuración → Conectores) y probá de nuevo: Claude no encontró las herramientas de Gruv.')
  }
}
/**
 * Herramientas que escriben en Gruv: se niegan explícitamente por si la cuenta tiene permisos
 * amplios en su settings. (En `-p` lo que no está permitido ya se niega, esto es por las dudas.)
 */
export const WRITE_TOOLS = [
  'mover_ticket',
  'comentar_ticket',
  'editar_ticket',
  'crear_ticket',
  'borrar_ticket',
  'archivar_ticket',
  'asignar_ticket',
  'pedir_ticket',
  'retirar_pedido_ticket',
  'pegar_pr_ticket',
  'tildar_criterio_ticket',
  'agregar_criterios_ticket',
  'borrar_criterio_ticket',
  'cambiar_severidad_ticket',
  'cambiar_talla_ticket',
  'estimar_ticket',
  'corregir_plazo_ticket',
  'pedir_prorroga_ticket',
  'ajustar_tiempo_ticket',
  'actualizar_tickets_en_tanda',
  'mover_ticket_de_espacio',
  'asignar_epica_ticket',
  'crear_vinculo_ticket',
  'borrar_vinculo_ticket',
  'mandar_ticket_al_chat',
  'mandar_mensaje',
  'sumar_al_reloj',
  'corregir_arranque_reloj',
  'cerrar_el_dia',
  'poner_veredicto_de_cierre',
  'guardar_borrador_flujo',
  'publicar_flujo',
  'quitar_estado_flujo'
].map((t) => `mcp__claude_ai_Gruv__${t}`)

export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    estados: {
      type: 'array',
      items: {
        type: 'object',
        properties: { clave: { type: 'string' }, nombre: { type: 'string' } },
        required: ['clave', 'nombre']
      }
    },
    tickets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          titulo: { type: 'string' },
          estado: { type: 'string' },
          prioridad: { type: 'string' },
          proyecto: { type: 'string' },
          url: { type: 'string' }
        },
        required: ['id', 'titulo', 'estado']
      }
    }
  },
  required: ['tickets']
}

export function buildPrompt(assigneeId: string): string {
  const who = assigneeId
    ? `asignado: "${assigneeId}"`
    : 'asignado: <el id de la persona dueña de esta cuenta, que sacás de buscar_persona o ver_mi_inicio>'
  return [
    'Tarea de solo lectura. No modifiques nada en Gruv: no comentes, no muevas, no tildes nada.',
    `1. Llamá a la herramienta de Gruv listar_tickets con ${who} y limite: 100, sin filtrar por estado. Si vuelven 100, seguí con desplazamiento: 100, 200… hasta traer todos (como máximo 300).`,
    '2. Llamá a ver_flujo_tickets (sin tipo) y armá la lista de estados en el orden de las columnas del tablero, sin repetir claves, con la clave y el nombre que se ve.',
    'Respondé SOLO con un JSON, sin texto antes ni después y sin bloque de código, con esta forma:',
    '{"estados":[{"clave":"abierto","nombre":"Abierto"}],"tickets":[{"id":"TCK-1234","titulo":"…","estado":"<clave del estado, p. ej. en_revision>","prioridad":"<severidad, si la da>","proyecto":"<espacio o proyecto, si lo da>","url":"<link al ticket, si lo da>"}]}',
    'Si un campo opcional no viene, no lo pongas. Si no hay tickets, devolvé "tickets":[].',
    `Si no tenés ninguna herramienta de Gruv disponible, respondé exactamente {"error":"${NO_GRUV}","tickets":[]}.`
  ].join('\n')
}

/** Valida los estados de `ver_flujo_tickets` (sin «cerrado», que no va al tablero). */
export function normalizeEstados(raw: unknown): GruvEstado[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out = new Map<string, GruvEstado>()
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue
    const o = e as Record<string, unknown>
    const clave = normEstado(o.clave ?? o.key ?? o.estado)
    if (!clave || !/^[a-z0-9_]{1,40}$/.test(clave) || clave === 'cerrado' || out.has(clave)) continue
    out.set(clave, { clave, nombre: str(o.nombre ?? o.name, 40) ?? clave.replace(/_/g, ' ') })
    if (out.size >= 20) break
  }
  return out.size ? [...out.values()] : undefined
}

export function buildArgs(model: string): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--model',
    model,
    // Sin herramientas propias de Claude Code (Bash, Edit, Read…): solo las de Gruv permitidas.
    '--tools',
    '',
    '--allowedTools',
    READ_TOOLS.join(','),
    '--disallowedTools',
    WRITE_TOOLS.join(','),
    '--no-session-persistence',
    // Sin hooks: los de Sloth esperan un espacio y el de permisos bloquearía la consulta.
    '--settings',
    JSON.stringify({ disableAllHooks: true }),
    '--json-schema',
    JSON.stringify(OUTPUT_SCHEMA)
  ]
}

const str = (v: unknown, max: number): string | undefined => {
  if (typeof v === 'number') v = String(v)
  if (typeof v !== 'string') return undefined
  const s = v.replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, max) : undefined
}

export function normEstado(v: unknown): string | undefined {
  const s = str(v, 40)
  return s
    ? s
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[\s-]+/g, '_')
    : undefined
}

/** Valida y limpia lo que devolvió Claude (no confiamos en la forma). */
export function normalizeTickets(raw: unknown): GruvTicket[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { tickets?: unknown }).tickets)
      ? (raw as { tickets: unknown[] }).tickets
      : null
  if (!list) throw new Error('La respuesta no trae una lista de tickets.')
  const out = new Map<string, GruvTicket>()
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const id = str(o.id ?? o.codigo ?? o.clave, 20)?.toUpperCase()
    if (!id || !TICKET_RE.test(id)) continue
    const titulo = str(o.titulo ?? o.title ?? o.nombre, 300) ?? id
    const estado = normEstado(o.estado ?? o.status)
    if (estado === 'cerrado') continue
    const url = str(o.url ?? o.link, 500)
    const t: GruvTicket = { id, titulo }
    if (estado) t.estado = estado
    const prioridad = str(o.prioridad ?? o.priority, 20)
    if (prioridad) t.prioridad = prioridad
    const proyecto = str(o.proyecto ?? o.project, 80)
    if (proyecto) t.proyecto = proyecto
    if (url && /^https?:\/\//i.test(url)) t.url = url
    out.set(id, t)
    if (out.size >= MAX_TICKETS) break
  }
  return [...out.values()]
}

/** Saca el primer JSON (objeto o lista) de un texto, aunque venga con ```json o texto alrededor. */
export function extractJson(text: string): unknown {
  const t = text.trim()
  try {
    return JSON.parse(t)
  } catch {
    /* sigue */
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t)
  if (fence) {
    try {
      return JSON.parse(fence[1].trim())
    } catch {
      /* sigue */
    }
  }
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']']
  ]) {
    const a = t.indexOf(open)
    const b = t.lastIndexOf(close)
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1))
      } catch {
        /* sigue */
      }
    }
  }
  throw new Error('Claude no devolvió un JSON válido.')
}

/** Interpreta el stdout de `claude -p --output-format json`. */
export function parseClaudeOutput(stdout: string): RunResult {
  let env: Record<string, unknown> | undefined
  const trimmed = stdout.trim()
  try {
    env = JSON.parse(trimmed)
  } catch {
    // Puede venir alguna línea de aviso antes: probamos línea por línea desde el final.
    const lines = trimmed.split(/\r?\n/).reverse()
    for (const l of lines) {
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
  if (!env || typeof env !== 'object') throw new Error('No entendí la respuesta de Claude.')
  if (Array.isArray(env)) {
    // stream/verbose: lista de mensajes; nos quedamos con el resultado.
    const r = (env as unknown[]).reverse().find((m) => (m as { type?: string })?.type === 'result')
    if (!r) throw new Error('La respuesta de Claude no tiene resultado.')
    env = r as Record<string, unknown>
  }
  const result = typeof env.result === 'string' ? env.result : ''
  if (env.is_error === true || (typeof env.subtype === 'string' && env.subtype !== 'success')) {
    const why = result || (typeof env.subtype === 'string' ? env.subtype : 'error')
    throw new Error(`Claude no pudo completar la consulta: ${why.slice(0, 300)}`)
  }
  const structured = env.structured_output
  let data: unknown
  try {
    data = structured && typeof structured === 'object' ? structured : extractJson(result)
  } catch (e) {
    // Texto suelto en vez de JSON: si habla de que no tiene Gruv, lo decimos claro.
    if (/gruv/i.test(result) && /(no (tengo|hay|encuentro|está|dispon)|not (available|found)|sin acceso)/i.test(result))
      throw new NoGruvError()
    throw e
  }
  if (data && typeof data === 'object' && (data as { error?: unknown }).error === NO_GRUV) throw new NoGruvError()
  const denied = env.permission_denials
  const tickets = normalizeTickets(data)
  // Sin tickets y con herramientas de Gruv negadas o inexistentes: no es «no tenés tickets».
  if (!tickets.length && Array.isArray(denied) && denied.length) {
    throw new Error('Claude no pudo usar las herramientas de Gruv (permiso negado). Probá de nuevo.')
  }
  const estados = normalizeEstados((data as { estados?: unknown })?.estados)
  const usage = env.usage as Record<string, number> | undefined
  const tokens = usage
    ? ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce(
        (n, k) => n + (typeof usage[k] === 'number' ? usage[k] : 0),
        0
      )
    : undefined
  return {
    tickets,
    estados,
    costUsd: typeof env.total_cost_usd === 'number' ? env.total_cost_usd : undefined,
    tokens,
    durationMs: typeof env.duration_ms === 'number' ? env.duration_ms : undefined
  }
}

let exeCache: string | undefined
/**
 * Busca el ejecutable real de Claude (sin shell): `claude.exe` en el PATH o en ~/.local/bin,
 * o el que apunta el shim `claude.cmd` de npm.
 */
export function resolveClaudeExe(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (exeCache && existsSync(exeCache)) return exeCache
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
  const candidates: string[] = []
  for (const d of dirs) candidates.push(join(d, 'claude.exe'))
  candidates.push(join(homedir(), '.local', 'bin', 'claude.exe'))
  for (const c of candidates) {
    if (existsSync(c)) return (exeCache = c)
  }
  for (const d of dirs) {
    const shim = join(d, 'claude.cmd')
    if (!existsSync(shim)) continue
    try {
      const txt = readFileSync(shim, 'utf8')
      const m = /"%dp0%\\([^"]+?\.exe)"/i.exec(txt)
      if (m) {
        const exe = join(dirname(shim), m[1])
        if (existsSync(exe)) return (exeCache = exe)
      }
      const js = /"%dp0%\\([^"]+?\.(?:c?js))"/i.exec(txt)
      if (js) {
        const exe = join(dirname(shim), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
        if (existsSync(exe)) return (exeCache = exe)
      }
    } catch {
      /* sigue */
    }
  }
  return undefined
}

function killTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* ya terminó */
    }
  }
}

export interface RunOptions {
  exe: string
  args: string[]
  prompt: string
  cwd: string
  env: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
}

/** Corre Claude headless con el prompt por stdin. Rechaza con un mensaje legible. */
export function runClaude(o: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    let done = false
    const child = spawn(o.exe, o.args, { cwd: o.cwd, env: o.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const finish = (e?: Error, r?: RunResult): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
      if (e) reject(e)
      else resolve(r!)
    }
    const timer = setTimeout(() => {
      killTree(child.pid)
      finish(new Error(`Gruv no respondió en ${Math.round((o.timeoutMs ?? RUN_TIMEOUT_MS) / 1000)} s. Probá de nuevo.`))
    }, o.timeoutMs ?? RUN_TIMEOUT_MS)
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
        finish(undefined, parseClaudeOutput(out))
      } catch (e) {
        const extra = code ? ` (salió con código ${code}${err.trim() ? `: ${err.trim().slice(0, 300)}` : ''})` : ''
        finish(new Error(`${(e as Error).message}${extra}`))
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(o.prompt, 'utf8')
  })
}
