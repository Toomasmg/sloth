/**
 * Issues de GitHub con `gh` y la sesión de la persona: arma los argumentos y lee la salida, sin
 * pasar por Claude. No corre nada: recibe quién corre `gh`.
 * Módulo puro (lo corre `node --test` con type stripping): sin enums, namespaces ni parameter
 * properties, y los tipos se importan con `type`.
 */
import type { Accion, Detalle, Ticket, Yo } from '../../../shared/tickets'
import type { ConectorGh } from './conector'
import github from './conectores/github'
import { idValido, normComentarios, type AccionInput } from './motor'

export interface GhOut {
  code: number
  stdout: string
  stderr: string
  missing?: boolean
  timedOut?: boolean
}

export type GhRun = (args: string[], input?: string) => Promise<GhOut>

export const REPO_RE = /^(?![-.])[A-Za-z0-9_.-]{1,100}\/(?![-.])[A-Za-z0-9_.-]{1,100}$/
export const NUM_RE = /^[1-9]\d{0,6}$/
export const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

const PRIORIDAD_RE = /^(p[0-4]|prio(ridad)?[:/ ].+|priority[:/ ].+)$/i
// Lo mismo que `isAuthError` de team-github, que no se puede importar acá (usa child_process).
const AUTH_RE = /gh auth login|not logged in|authentication required|HTTP 401|Bad credentials|GH_TOKEN/i
// eslint-disable-next-line no-control-regex
const CONTROLES = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g
const NO_ENTIENDO = 'gh devolvió algo que no entiendo.'

type Obj = Record<string, unknown>

const esObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

/** En una línea, sin caracteres de control ni de dirección, cortado a `max`. */
function linea(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.slice(0, max * 4).replace(CONTROLES, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
  return s || undefined
}

export function repoValido(v: unknown): string {
  if (typeof v !== 'string' || !REPO_RE.test(v)) throw new Error('El repo de GitHub tiene que ser tipo dueño/repo.')
  return v
}

/** El repo guardado al listar el issue: el detalle y las escrituras nunca van a otro. */
function repoDelIssue(t: Pick<Ticket, 'proyecto'>): string {
  if (typeof t.proyecto !== 'string' || !REPO_RE.test(t.proyecto)) throw new Error('No sé de qué repo es este issue: actualizá GitHub Issues.')
  return t.proyecto
}

function numero(v: unknown): string {
  if (typeof v !== 'string' || !NUM_RE.test(v)) throw new Error('El issue tiene que ser un número.')
  return v
}

function login(v: unknown): string {
  if (typeof v !== 'string' || !LOGIN_RE.test(v)) throw new Error('Ese usuario de GitHub no es válido.')
  return v
}

async function correr(run: GhRun, args: string[], input?: string): Promise<string> {
  const r = await run(args, input)
  if (r.missing) throw new Error(github.faltaConector.mensaje)
  if (r.timedOut) throw new Error('gh tardó demasiado.')
  if (r.code !== 0) {
    if (AUTH_RE.test(r.stderr)) throw new Error('gh no tiene sesión iniciada: corré `gh auth login`.')
    const primera = r.stderr
      .split(/\r?\n/)
      .map((l) => linea(l, 200))
      .find(Boolean)
    throw new Error(primera ?? `gh terminó con código ${r.code}.`)
  }
  return r.stdout
}

function json(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    throw new Error(NO_ENTIENDO)
  }
}

function urlDeGithub(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > 500 || !v.startsWith('https://github.com/')) return undefined
  try {
    const u = new URL(v)
    return u.protocol === 'https:' && u.hostname === 'github.com' ? u.href : undefined
  } catch {
    return undefined
  }
}

function prioridadDe(labels: unknown): string | undefined {
  if (!Array.isArray(labels)) return undefined
  for (const l of labels) {
    const n = esObj(l) ? l.name : undefined
    if (typeof n === 'string' && n.length <= 20 && n === linea(n, 20) && PRIORIDAD_RE.test(n)) return n
  }
  return undefined
}

function asignadoDe(assignees: unknown): string | undefined {
  if (!Array.isArray(assignees)) return undefined
  for (const a of assignees) {
    const l = esObj(a) ? a.login : undefined
    if (typeof l === 'string' && LOGIN_RE.test(l)) return l
  }
  return undefined
}

export async function ghYo(run: GhRun): Promise<Yo> {
  const l = (await correr(run, ['api', 'user', '--jq', '.login'])).trim()
  if (!LOGIN_RE.test(l)) throw new Error(NO_ENTIENDO)
  return { id: l, nombre: l }
}

export async function ghLista(run: GhRun, def: ConectorGh, repo: string): Promise<Ticket[]> {
  const r = repoValido(repo)
  const data = json(
    await correr(run, ['issue', 'list', '--repo', r, '--state', 'open', '--limit', '200', '--json', 'number,title,assignees,labels,url,body'])
  )
  if (!Array.isArray(data)) throw new Error(NO_ENTIENDO)
  const out: Ticket[] = []
  for (const x of data) {
    if (!esObj(x) || typeof x.number !== 'number') continue
    const id = idValido(def, String(x.number))
    if (!id) continue
    const t: Ticket = { id, titulo: linea(x.title, 300) ?? id, estado: 'abierto', proyecto: r }
    const url = urlDeGithub(x.url)
    if (url) t.url = url
    const asignado = asignadoDe(x.assignees)
    if (asignado) {
      t.responsable = asignado
      t.responsableId = asignado
    }
    const prioridad = prioridadDe(x.labels)
    if (prioridad) t.prioridad = prioridad
    const descripcion = linea(x.body, 200)
    if (descripcion) t.descripcion = descripcion
    out.push(t)
  }
  return out
}

export async function ghDetalle(run: GhRun, t: Pick<Ticket, 'id' | 'proyecto'>): Promise<Detalle> {
  const r = repoDelIssue(t)
  const data = json(await correr(run, ['issue', 'view', numero(t.id), '--repo', r, '--json', 'comments']))
  if (!esObj(data)) throw new Error(NO_ENTIENDO)
  const comentarios = Array.isArray(data.comments)
    ? data.comments.filter(esObj).map((c) => ({
        autor: esObj(c.author) ? linea(c.author.login, 80) : undefined,
        cuerpo: c.body,
        fecha: c.createdAt
      }))
    : []
  return { criterios: [], comentarios: normComentarios(comentarios), minutos: null }
}

export async function ghAccion(run: GhRun, t: Pick<Ticket, 'proyecto'>, a: Accion, i: AccionInput, me: Yo | undefined): Promise<void> {
  const r = repoDelIssue(t)
  const id = numero(i.ticket)
  switch (a) {
    case 'estado':
      if (i.estado === 'cerrado') await correr(run, ['issue', 'close', id, '--repo', r])
      else if (i.estado === 'abierto') await correr(run, ['issue', 'reopen', id, '--repo', r])
      else throw new Error('Ese estado no está en el flujo de GitHub Issues.')
      return
    case 'tomar':
      await correr(run, ['issue', 'edit', id, '--repo', r, '--add-assignee', login(i.persona)])
      return
    case 'soltar':
      await correr(run, ['issue', 'edit', id, '--repo', r, '--remove-assignee', login(me?.id)])
      return
    case 'comentar':
      if (typeof i.cuerpo !== 'string' || !i.cuerpo.trim()) throw new Error('El comentario está vacío.')
      // El cuerpo va por stdin: nunca como argumento.
      await correr(run, ['issue', 'comment', id, '--repo', r, '--body-file', '-'], i.cuerpo)
      return
    default:
      throw new Error('GitHub no permite esa acción desde Sloth.')
  }
}
