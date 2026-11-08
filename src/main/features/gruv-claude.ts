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

/** Criterio de aceptación de un ticket (si Gruv lo trae). */
export interface GruvCriterio {
  texto: string
  hecho: boolean
}

export interface GruvTicket {
  id: string
  titulo: string
  estado?: string
  prioridad?: string
  proyecto?: string
  url?: string
  /** Nombre de quien tiene el ticket asignado (si lo tiene). */
  responsable?: string
  responsableId?: string
  /** Descripción recortada (la pide la consulta; si Gruv no la trae, no viene). */
  descripcion?: string
  criterios?: GruvCriterio[]
}

/** Una columna del tablero de Gruv (de `ver_flujo_tickets`). */
export interface GruvEstado {
  clave: string
  nombre: string
}

/** La persona dueña de la cuenta que consultó Gruv (de `ver_mi_inicio`). */
export interface GruvYo {
  id?: string
  nombre: string
}

export interface RunResult {
  tickets: GruvTicket[]
  /** Estados en el orden de las columnas, si Claude los pudo leer. */
  estados?: GruvEstado[]
  me?: GruvYo
  costUsd?: number
  tokens?: number
  durationMs?: number
}

export const TICKET_RE = /^[A-Z][A-Z0-9]*-\d{1,7}$/
export const RUN_TIMEOUT_MS = 120_000
const MAX_TICKETS = 250
const MAX_CRITERIOS = 5
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
    yo: {
      type: 'object',
      properties: { id: { type: 'string' }, nombre: { type: 'string' } },
      required: ['nombre']
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
          url: { type: 'string' },
          responsable: { type: 'string' },
          responsable_id: { type: 'string' },
          descripcion: { type: 'string' },
          criterios: {
            type: 'array',
            items: {
              type: 'object',
              properties: { texto: { type: 'string' }, hecho: { type: 'boolean' } },
              required: ['texto', 'hecho']
            }
          }
        },
        required: ['id', 'titulo', 'estado']
      }
    }
  },
  required: ['tickets']
}

/**
 * Lee los tickets de TODO el equipo (no solo los de la cuenta) para que la app pueda separar
 * «Míos», «Del equipo» y «Sin asignar». `assigneeId` fija quién sos si ya se configuró.
 */
export function buildPrompt(assigneeId: string): string {
  const yo = assigneeId
    ? `Tu id en Gruv es "${assigneeId}": usalo en yo.id.`
    : 'Tu id y tu nombre en Gruv los sacás de ver_mi_inicio.'
  return [
    'Tarea de solo lectura. No modifiques nada en Gruv: no comentes, no muevas, no asignes, no tildes nada.',
    `1. Armá "yo" con tu id y tu nombre en Gruv. ${yo}`,
    '2. Llamá a la herramienta de Gruv listar_tickets SIN filtrar por estado ni por asignado (quiero los tickets de todo el equipo), con limite: 100. Si vuelven 100, seguí con desplazamiento: 100, 200… hasta traer todos (como máximo 250).',
    '3. Llamá a ver_flujo_tickets (sin tipo) y armá "estados" con las columnas en su orden, sin repetir claves, con la clave y el nombre que se ven.',
    '"responsable" es el nombre de quien tiene asignado el ticket y "responsable_id" su id; si nadie lo tiene, no pongas ninguno de los dos. "descripcion" es el texto de la descripción en una línea, recortado a 200 caracteres, si la trae. "criterios" son hasta 5 criterios de aceptación, con "texto" (máx. 120 caracteres) y "hecho" (true o false), si los trae.',
    'Respondé SOLO con un JSON, sin texto antes ni después y sin bloque de código, con esta forma:',
    '{"yo":{"id":"<tu id>","nombre":"<tu nombre>"},"estados":[{"clave":"abierto","nombre":"Abierto"}],"tickets":[{"id":"TCK-1234","titulo":"…","estado":"<clave del estado, p. ej. en_revision>","prioridad":"<severidad, si la da>","proyecto":"<espacio o proyecto, si lo da>","url":"<link al ticket, si lo da>","responsable":"<nombre>","responsable_id":"<id>","descripcion":"…","criterios":[{"texto":"…","hecho":false}]}]}',
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
    const resp = o.responsable
    const respName = typeof resp === 'object' && resp ? str((resp as Record<string, unknown>).nombre, 100) : str(resp, 100)
    const respId = str(o.responsable_id ?? o.responsableId ?? (typeof resp === 'object' && resp ? (resp as Record<string, unknown>).id : undefined), 64)
    if (respName && !/^(sin asignar|sin_asignar|nadie|-)$/i.test(respName)) t.responsable = respName
    if (respId && /^[A-Za-z0-9-]{1,64}$/.test(respId) && t.responsable) t.responsableId = respId
    const desc = str(o.descripcion ?? o.description, 400)
    if (desc) t.descripcion = desc
    const criterios = normCriterios(o.criterios)
    if (criterios.length) t.criterios = criterios
    out.set(id, t)
    if (out.size >= MAX_TICKETS) break
  }
  return [...out.values()]
}

/** Criterios de aceptación: máximo 5; un texto suelto cuenta como pendiente. */
export function normCriterios(raw: unknown): GruvCriterio[] {
  if (!Array.isArray(raw)) return []
  const out: GruvCriterio[] = []
  for (const c of raw) {
    if (out.length >= MAX_CRITERIOS) break
    if (typeof c === 'string') {
      const texto = str(c, 160)
      if (texto) out.push({ texto, hecho: false })
    } else if (c && typeof c === 'object') {
      const o = c as Record<string, unknown>
      const texto = str(o.texto ?? o.text ?? o.titulo, 160)
      if (texto) out.push({ texto, hecho: o.hecho === true || o.done === true })
    }
  }
  return out
}

/** «yo»: quién es la persona dueña de la cuenta en Gruv. */
export function normYo(raw: unknown): GruvYo | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const nombre = str(o.nombre ?? o.name, 100)
  if (!nombre) return undefined
  const id = str(o.id, 64)
  return id && /^[A-Za-z0-9-]{1,64}$/.test(id) ? { id, nombre } : { nombre }
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
  const me = normYo((data as { yo?: unknown })?.yo)
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
    me,
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
