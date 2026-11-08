// Tipos (los mismos que devuelve main) y funciones puras de la función «git». Sin Electron ni IPC.

export type FileCode = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | 'T' | '??'

export interface FileChange {
  path: string
  orig?: string
  code: FileCode
  xy: string
  add?: number
  del?: number
  binary?: boolean
  huge?: boolean
  /** Tiene cambios en el índice (preparado). */
  staged?: boolean
}

export interface StatusRes {
  isRepo: boolean
  top?: string
  branch?: string | null
  files: FileChange[]
  truncated?: boolean
  base: string | null
  protected: boolean
}

export interface DiffLine {
  t: string
  s: string
  o?: number
  n?: number
}

export interface DiffRes {
  kind: 'text' | 'binary' | 'huge' | 'empty' | 'missing'
  lines: DiffLine[]
  truncated: boolean
  size?: number
}

export interface SyncRes {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
}

export interface StashRes {
  branch: string
  files: number
}

export interface LocalBranch {
  name: string
  current: boolean
  upstream: string | null
  subject: string
}

export interface RemoteBranch {
  name: string
  subject: string
  hasLocal: boolean
}

export interface BranchesRes {
  local: LocalBranch[]
  remote: RemoteBranch[]
}

export interface LogEntry {
  hash: string
  short: string
  author: string
  date: string
  title: string
  pushed: boolean
}

export interface CommitFile {
  path: string
  add?: number
  del?: number
  binary: boolean
}

export interface Commit {
  sha: string
  subject: string
}

export interface PrRef {
  url: string
  number: number
  state: string
  title: string
}

export interface PrPrep {
  branch: string | null
  base: string | null
  protected: boolean
  pushed: boolean
  upstream: string | null
  unpushed: number
  commits: Commit[]
  existing: PrRef | null
  ghError: string | null
  template: { path: string; body: string } | null
  defaultTitle: string
}

/** Un PR abierto desde esta sesión (se muestra en Ramas). */
export interface SessionPr {
  url: string
  number: number
  from: string
  to: string
}

export const KIND: Record<FileCode, { letter: string; label: string; cls: string; word: string }> = {
  M: { letter: 'M', label: 'Modificado', cls: 'm', word: 'modificado' },
  A: { letter: 'A', label: 'Nuevo', cls: 'a', word: 'nuevo' },
  D: { letter: 'D', label: 'Borrado', cls: 'd', word: 'borrado' },
  R: { letter: 'R', label: 'Renombrado', cls: 'r', word: 'renombrado' },
  C: { letter: 'C', label: 'Copiado', cls: 'r', word: 'copiado' },
  U: { letter: 'U', label: 'En conflicto', cls: 'd', word: 'en conflicto' },
  T: { letter: 'T', label: 'Cambio de tipo', cls: 'm', word: 'cambio de tipo' },
  '??': { letter: '?', label: 'Sin seguimiento', cls: 'q', word: 'nuevo' }
}

export const TITLE_MAX = 72

export function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function fmtSize(n?: number): string {
  if (n === undefined) return ''
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${Math.round(n / 1024)} KB`
}

export function splitPath(p: string): { dir: string; name: string } {
  const i = p.lastIndexOf('/')
  return { dir: p.slice(0, i + 1), name: p.slice(i + 1) }
}

/** Minúsculas y sin tildes: «cambio» encuentra «Cambió». */
export function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** «hace 2 h», «ayer», «hace 3 d»… A partir de ~5 semanas, la fecha. */
export function relTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const min = Math.max(0, Math.round((now - t) / 60000))
  if (min < 1) return 'recién'
  if (min < 60) return `hace ${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `hace ${h} h`
  if (h < 48) return 'ayer'
  const d = Math.round(h / 24)
  if (d < 7) return `hace ${d} d`
  if (d < 35) return `hace ${Math.round(d / 7)} sem`
  return new Date(t).toLocaleDateString('es-AR')
}

export interface SplitRow {
  /** Línea que ocupa todo el ancho (cabecera de hunk, etc.). */
  span?: DiffLine
  l?: DiffLine | null
  r?: DiffLine | null
}

/**
 * Pasa el diff unificado a filas «lado a lado»: los bloques de borrados y agregados seguidos
 * se emparejan uno a uno; lo que sobra queda con el lado vacío.
 */
export function pairRows(lines: DiffLine[]): SplitRow[] {
  const out: SplitRow[] = []
  let i = 0
  while (i < lines.length) {
    const cur = lines[i]
    if (cur.t === ' ') {
      out.push({ l: cur, r: cur })
      i++
    } else if (cur.t === '+' || cur.t === '-') {
      const dels: DiffLine[] = []
      const adds: DiffLine[] = []
      while (i < lines.length && lines[i].t === '-') dels.push(lines[i++])
      while (i < lines.length && lines[i].t === '+') adds.push(lines[i++])
      const m = Math.max(dels.length, adds.length)
      for (let k = 0; k < m; k++) out.push({ l: dels[k] ?? null, r: adds[k] ?? null })
    } else {
      out.push({ span: cur })
      i++
    }
  }
  return out
}

/** Línea de fila → clase CSS según su tipo. */
export function lineClass(t: string): string {
  return t === '+' ? 'add' : t === '-' ? 'del' : t === '@' ? 'hunk' : t === 'h' ? 'head' : 'ctx'
}

/**
 * Mensaje sugerido a partir de los archivos preparados. No llama a ninguna API: es una heurística
 * (tipo de cambio + archivo principal por líneas tocadas). Siempre es editable.
 */
export function suggestMessage(list: { path: string; code: FileCode; add?: number; del?: number }[]): { title: string; body: string } {
  if (list.length === 0) return { title: '', body: '' }
  const isNew = (c: FileCode): boolean => c === 'A' || c === '??'
  const verb = list.every((f) => isNew(f.code))
    ? 'Agrega'
    : list.every((f) => f.code === 'D')
      ? 'Quita'
      : list.every((f) => f.code === 'R')
        ? 'Renombra'
        : 'Actualiza'
  const weight = (f: { add?: number; del?: number }): number => (f.add ?? 0) + (f.del ?? 0)
  const main = list.reduce((a, b) => (weight(b) > weight(a) ? b : a))
  const { dir, name } = splitPath(main.path)
  const stem = name.replace(/\.[^.]+$/, '') || name
  const folder = dir.replace(/\/$/, '').split('/').filter(Boolean).pop()
  const rest = list.length - 1
  let title = `${verb} ${stem}${folder ? ` en ${folder}` : ''}`
  if (rest > 0) title += ` y ${rest === 1 ? '1 archivo más' : `${rest} archivos más`}`
  const chars = [...title]
  if (chars.length > TITLE_MAX) title = `${chars.slice(0, TITLE_MAX - 1).join('').trimEnd()}…`
  const body = list
    .map((f) => {
      const stats = `${f.add !== undefined ? ` +${f.add}` : ''}${f.del !== undefined ? ` −${f.del}` : ''}`
      return `- ${f.path}: ${KIND[f.code].word}${stats ? ` (${stats.trim()})` : ''}`
    })
    .join('\n')
  return { title, body }
}

/** Lo que comparten las pestañas del panel (lo arma el panel principal). */
export interface GitShared {
  wsId: string
  /** Vuelve a leer estado, ramas, stash y sincronización (y refresca el contador del header). */
  reload(): Promise<void>
  /** Mensaje breve de éxito (toast). */
  say(msg: string): void
  /** Error del panel (banner). */
  fail(msg: string): void
  /** PR abierto desde esta sesión. */
  addPr(pr: SessionPr): void
  prs: SessionPr[]
}
