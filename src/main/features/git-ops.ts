import { spawn } from 'node:child_process'
import { createReadStream, existsSync, openSync, readSync, closeSync, statSync, unlinkSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { git, gitRaw, GitError, PROTECTED, readable, run, validBranchName } from './git-run'

/** Lógica de git/gh de la función «git», sin Electron (se prueba con Node). */

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
export const MAX_FILES = 3000
/** Archivos más grandes que esto no se muestran (aviso). */
export const HUGE_BYTES = 3 * 1024 * 1024
const MAX_LINE_CHARS = 2000

export interface RepoInfo {
  isRepo: boolean
  top?: string
  /** null = HEAD separado. */
  branch?: string | null
  hasHead?: boolean
}

export async function repoInfo(cwd: string): Promise<RepoInfo> {
  const r = await gitRaw(cwd, ['rev-parse', '--is-inside-work-tree', '--show-toplevel'], { timeoutMs: 10000 })
  if (r.code !== 0) return { isRepo: false }
  const [inside, top] = r.stdout.trim().split(/\r?\n/)
  if (inside !== 'true') return { isRepo: false }
  const b = await gitRaw(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: 10000 })
  const h = await gitRaw(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { timeoutMs: 10000 })
  return { isRepo: true, top: top ? resolve(top) : cwd, branch: b.code === 0 ? b.stdout.trim() : null, hasHead: h.code === 0 }
}

export type FileCode = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | 'T' | '??'

export interface FileChange {
  path: string
  orig?: string
  code: FileCode
  /** Las dos letras de porcelain (índice y árbol). */
  xy: string
  add?: number
  del?: number
  binary?: boolean
  huge?: boolean
  /** Tiene cambios en el índice (preparado para el próximo commit). */
  staged?: boolean
}

/** Parsea `git status --porcelain=v1 -z`. */
export function parsePorcelain(out: string): FileChange[] {
  const parts = out.split('\0')
  const files: FileChange[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const xy = entry.slice(0, 2)
    const path = entry.slice(3)
    const f: FileChange = { path, xy, code: codeOf(xy) }
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      f.orig = parts[++i]
    }
    files.push(f)
  }
  return files
}

function codeOf(xy: string): FileCode {
  if (xy === '??' || xy === '!!') return '??'
  const x = xy[0]
  const y = xy[1]
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'U'
  const c = x !== ' ' ? x : y
  return (['M', 'A', 'D', 'R', 'C', 'T'].includes(c) ? c : 'M') as FileCode
}

/** Solo el conteo (para el botón del header): barato. */
export async function changeCount(cwd: string): Promise<number | null> {
  const r = await gitRaw(cwd, ['status', '--porcelain=v1', '-z'], { timeoutMs: 15000 })
  if (r.code !== 0) return null
  return parsePorcelain(r.stdout).length
}

/** Parsea `git diff --numstat -z` (con renombres: "a\td\t\0viejo\0nuevo\0"). */
export function parseNumstat(out: string): Map<string, { add?: number; del?: number; binary: boolean }> {
  const m = new Map<string, { add?: number; del?: number; binary: boolean }>()
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!p) continue
    const t = p.split('\t')
    if (t.length < 3) continue
    let path = t.slice(2).join('\t')
    if (path === '') {
      i++ // viejo
      path = parts[++i] ?? ''
    }
    const binary = t[0] === '-'
    m.set(path, binary ? { binary } : { add: Number(t[0]), del: Number(t[1]), binary })
  }
  return m
}

function fileStats(abs: string): { size: number; binary: boolean; lines: number } | null {
  try {
    const st = statSync(abs)
    if (!st.isFile()) return null
    if (st.size > HUGE_BYTES) return { size: st.size, binary: false, lines: 0 }
    const fd = openSync(abs, 'r')
    try {
      const buf = Buffer.alloc(64 * 1024)
      let lines = 0
      let pos = 0
      let first = true
      let last = 10
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, pos)
        if (n <= 0) break
        if (first && buf.subarray(0, Math.min(n, 8000)).includes(0)) return { size: st.size, binary: true, lines: 0 }
        first = false
        for (let k = 0; k < n; k++) if (buf[k] === 10) lines++
        last = buf[n - 1]
        pos += n
      }
      if (pos > 0 && last !== 10) lines++
      return { size: st.size, binary: false, lines }
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/** Ruta relativa al repo -> absoluta, sin salirse del repo. */
export function insideRepo(top: string, rel: string): string | null {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 1024 || rel.includes('\0')) return null
  const abs = resolve(top, rel)
  const root = resolve(top)
  if (abs !== root && !abs.toLowerCase().startsWith((root + sep).toLowerCase())) return null
  return abs
}

export interface StatusResult {
  isRepo: boolean
  top?: string
  branch?: string | null
  files: FileChange[]
  truncated?: boolean
}

export async function status(cwd: string): Promise<StatusResult> {
  const info = await repoInfo(cwd)
  if (!info.isRepo || !info.top) return { isRepo: false, files: [] }
  const st = await git(info.top, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeoutMs: 20000 })
  let files = parsePorcelain(st)
  const truncated = files.length > MAX_FILES
  if (truncated) files = files.slice(0, MAX_FILES)
  for (const f of files) f.staged = f.xy[0] !== ' ' && f.xy[0] !== '?' && f.xy[0] !== '!'
  // Las rutas de status son relativas al top del repo; numstat también si se corre desde el top.
  const num = await gitRaw(info.top, ['diff', info.hasHead ? 'HEAD' : EMPTY_TREE, '--numstat', '-z', '-M', '--no-ext-diff'], {
    timeoutMs: 20000
  })
  const stats = num.code === 0 ? parseNumstat(num.stdout) : new Map()
  for (const f of files) {
    const s = stats.get(f.path)
    if (s) {
      f.add = s.add
      f.del = s.del
      f.binary = s.binary
    }
    if (f.code === '??' || (f.code === 'A' && f.add === undefined)) {
      const abs = insideRepo(info.top, f.path)
      const fs = abs ? fileStats(abs) : null
      if (fs) {
        f.binary = fs.binary
        f.huge = fs.size > HUGE_BYTES
        if (!fs.binary && !f.huge) {
          f.add = fs.lines
          f.del = 0
        }
      }
    } else if (f.code !== 'D') {
      const abs = insideRepo(info.top, f.path)
      try {
        if (abs && statSync(abs).size > HUGE_BYTES) f.huge = true
      } catch {
        /* no existe */
      }
    }
  }
  return { isRepo: true, top: info.top, branch: info.branch, files, truncated }
}

export interface DiffLine {
  /** '+', '-', ' ', '@' (hunk), 'h' (cabecera), '\\' (sin salto final). */
  t: string
  s: string
  o?: number
  n?: number
}

export interface DiffResult {
  kind: 'text' | 'binary' | 'huge' | 'empty' | 'missing'
  lines: DiffLine[]
  truncated: boolean
  size?: number
}

function clip(s: string): string {
  return s.length > MAX_LINE_CHARS ? `${s.slice(0, MAX_LINE_CHARS)} …` : s
}

/** Lee como mucho `limit` líneas de un proceso, cortándolo cuando ya alcanza. */
function streamLines(cwd: string, args: string[], limit: number, timeoutMs = 20000): Promise<{ lines: string[]; more: boolean; code: number; stderr: string }> {
  return new Promise((res, rej) => {
    const child = spawn('git', ['-C', cwd, '-c', 'core.quotepath=false', ...args], {
      windowsHide: true,
      shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1', LC_ALL: 'C' }
    })
    const lines: string[] = []
    let rest = ''
    let more = false
    let stderr = ''
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      child.kill()
      rej(new GitError('git diff tardó demasiado.'))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (more) return
      const parts = (rest + chunk).split('\n')
      rest = parts.pop() ?? ''
      for (const p of parts) {
        if (lines.length >= limit) {
          more = true
          child.kill()
          return
        }
        lines.push(p.replace(/\r$/, ''))
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => {
      if (stderr.length < 4000) stderr += c
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      rej(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (killed && !more) return
      if (!more && rest) {
        if (lines.length >= limit) more = true
        else lines.push(rest.replace(/\r$/, ''))
      }
      res({ lines, more, code: more ? 0 : (code ?? -1), stderr })
    })
  })
}

/** Convierte un diff unificado en líneas con número viejo/nuevo. */
export function parseUnified(raw: string[]): DiffLine[] {
  const out: DiffLine[] = []
  let o = 0
  let n = 0
  let inHunk = false
  for (const l of raw) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l)
    if (m) {
      o = Number(m[1])
      n = Number(m[2])
      inHunk = true
      out.push({ t: '@', s: clip(l) })
      continue
    }
    if (!inHunk || l.startsWith('diff --git')) {
      inHunk = false
      out.push({ t: 'h', s: clip(l) })
      continue
    }
    const c = l[0]
    if (c === '+') out.push({ t: '+', s: clip(l.slice(1)), n: n++ })
    else if (c === '-') out.push({ t: '-', s: clip(l.slice(1)), o: o++ })
    else if (c === '\\') out.push({ t: '\\', s: clip(l) })
    else out.push({ t: ' ', s: clip(l.slice(1)), o: o++, n: n++ })
  }
  return out
}

function readNewFile(abs: string, limit: number): Promise<{ lines: DiffLine[]; more: boolean }> {
  return new Promise((res, rej) => {
    const stream = createReadStream(abs, { encoding: 'utf8', highWaterMark: 64 * 1024 })
    const lines: DiffLine[] = []
    let rest = ''
    let more = false
    let n = 1
    stream.on('data', (chunk) => {
      const parts = (rest + chunk).split('\n')
      rest = parts.pop() ?? ''
      for (const p of parts) {
        if (lines.length >= limit) {
          more = true
          stream.destroy()
          return
        }
        lines.push({ t: '+', s: clip(p.replace(/\r$/, '')), n: n++ })
      }
    })
    stream.on('error', rej)
    stream.on('close', () => {
      if (!more && rest) {
        if (lines.length >= limit) more = true
        else lines.push({ t: '+', s: clip(rest.replace(/\r$/, '')), n: n++ })
      }
      res({ lines, more })
    })
  })
}

export async function diffFile(top: string, file: FileChange, hasHead: boolean, limit: number): Promise<DiffResult> {
  const abs = insideRepo(top, file.path)
  if (!abs) throw new GitError('Ruta fuera del repositorio.')
  let size: number | undefined
  try {
    size = statSync(abs).size
  } catch {
    size = undefined
  }
  if (size !== undefined && size > HUGE_BYTES) return { kind: 'huge', lines: [], truncated: false, size }
  if (file.code === '??') {
    if (size === undefined) return { kind: 'missing', lines: [], truncated: false }
    const st = fileStats(abs)
    if (st?.binary) return { kind: 'binary', lines: [], truncated: false, size }
    if (size === 0) return { kind: 'empty', lines: [], truncated: false, size }
    const r = await readNewFile(abs, limit)
    const header: DiffLine[] = [{ t: 'h', s: `Archivo nuevo sin trackear: ${file.path}` }]
    return { kind: 'text', lines: [...header, ...r.lines], truncated: r.more, size }
  }
  const paths = file.orig ? [file.orig, file.path] : [file.path]
  const r = await streamLines(top, ['diff', hasHead ? 'HEAD' : EMPTY_TREE, '-M', '--no-color', '--no-ext-diff', '--', ...paths], limit + 6)
  if (r.code !== 0 && !r.more) throw new GitError(`git diff falló: ${r.stderr.trim().split(/\r?\n/)[0] ?? ''}`)
  if (r.lines.some((l) => /^Binary files .* differ$/.test(l) || l === 'GIT binary patch'))
    return { kind: 'binary', lines: [], truncated: false, size }
  const lines = parseUnified(r.lines)
  if (lines.length === 0) return { kind: 'empty', lines: [], truncated: false, size }
  return { kind: 'text', lines: lines.slice(0, limit), truncated: r.more || lines.length > limit, size }
}

// ---------- Ramas, base y remoto ----------

export async function hasRef(cwd: string, ref: string): Promise<boolean> {
  const r = await gitRaw(cwd, ['rev-parse', '--verify', '--quiet', ref], { timeoutMs: 10000 })
  return r.code === 0
}

/** Base por defecto: origin/staging si existe; si no, la rama por defecto del remoto (origin/HEAD). */
export async function defaultBase(cwd: string): Promise<string | null> {
  if (await hasRef(cwd, 'refs/remotes/origin/staging')) return 'staging'
  const r = await gitRaw(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { timeoutMs: 10000 })
  if (r.code === 0) {
    const name = r.stdout.trim().replace(/^refs\/remotes\/origin\//, '')
    if (name) return name
  }
  for (const b of ['main', 'master']) if (await hasRef(cwd, `refs/remotes/origin/${b}`)) return b
  for (const b of ['staging', 'main', 'master']) if (await hasRef(cwd, `refs/heads/${b}`)) return b
  return null
}

/** URL del remoto sin credenciales embebidas. */
export function safeUrl(u: string): string {
  return u.trim().replace(/^(https?:\/\/)[^@/]+@/, '$1')
}

export async function remoteUrl(cwd: string, remote = 'origin'): Promise<string | null> {
  const r = await gitRaw(cwd, ['remote', 'get-url', remote], { timeoutMs: 10000 })
  return r.code === 0 ? safeUrl(r.stdout) : null
}

export async function upstream(cwd: string): Promise<string | null> {
  const r = await gitRaw(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { timeoutMs: 10000 })
  return r.code === 0 ? r.stdout.trim() : null
}

export interface Commit {
  sha: string
  subject: string
}

function parseLog(out: string): Commit[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, ...rest] = l.split('\t')
      return { sha, subject: rest.join('\t') }
    })
}

/** Commits que un push mandaría: los que no están en el upstream (o en ningún remoto si no hay). */
export async function commitsToPush(cwd: string): Promise<Commit[]> {
  if (!(await hasRef(cwd, 'HEAD'))) return []
  const up = await upstream(cwd)
  const args = up ? ['log', '--format=%h%x09%s', '-n', '100', `${up}..HEAD`] : ['log', '--format=%h%x09%s', '-n', '100', 'HEAD', '--not', '--remotes']
  return parseLog(await git(cwd, args, { timeoutMs: 15000 }))
}

/** Commits de la rama que no están en la base (para el PR). */
export async function commitsVsBase(cwd: string, base: string): Promise<Commit[]> {
  const ref = (await hasRef(cwd, `refs/remotes/origin/${base}`)) ? `origin/${base}` : (await hasRef(cwd, `refs/heads/${base}`)) ? base : null
  if (!ref || !(await hasRef(cwd, 'HEAD'))) return []
  return parseLog(await git(cwd, ['log', '--format=%h%x09%s', '-n', '100', `${ref}..HEAD`], { timeoutMs: 15000 }))
}

export function isProtected(branch: string | null | undefined): boolean {
  return !branch || PROTECTED.has(branch)
}

/** Commit de lo que está preparado (índice). Nunca agrega archivos por su cuenta. */
export async function commitStaged(cwd: string, message: string): Promise<string> {
  const info = await repoInfo(cwd)
  if (!info.isRepo || !info.top) throw new GitError('La carpeta no es un repositorio git.')
  if (info.branch === null) throw new GitError('HEAD está separado (detached): creá una rama antes de commitear.')
  if (isProtected(info.branch)) throw new GitError(`No se commitea directo en ${info.branch}. Creá una rama nueva.`)
  const staged = await git(info.top, ['diff', '--cached', '--name-only', '-z'], { timeoutMs: 20000 })
  if (!staged.replace(/\0/g, '').trim()) throw new GitError('No hay archivos preparados. Marcá al menos uno para confirmarlo.')
  const r = await gitRaw(info.top, ['commit', '-F', '-'], { timeoutMs: 120000, input: message })
  if (r.code !== 0) throw new GitError(readable(r, 'git commit'))
  return (await git(info.top, ['rev-parse', '--short', 'HEAD'])).trim()
}

export async function createBranch(cwd: string, name: string, base?: string): Promise<void> {
  if (!validBranchName(name) || name.startsWith('+')) throw new GitError('Nombre de rama inválido.')
  if (await hasRef(cwd, `refs/heads/${name}`)) throw new GitError(`Ya existe la rama ${name}.`)
  if (base !== undefined) {
    if (!validBranchName(base) || base.startsWith('+')) throw new GitError('Rama base inválida.')
    if (!(await hasRef(cwd, `refs/heads/${base}`))) throw new GitError(`No encuentro la rama local ${base}.`)
    await git(cwd, ['switch', '-c', name, base], { timeoutMs: 30000 })
    return
  }
  await git(cwd, ['switch', '-c', name], { timeoutMs: 30000 })
}

// ---------- Preparar, sacar y descartar ----------

/** Rutas de un cambio: la original también cuenta cuando es un renombrado. */
function pathsOf(f: FileChange): string[] {
  return f.orig ? [f.orig, f.path] : [f.path]
}

/** Prepara el archivo (incluye su cambio en el árbol: `git add -A -- ruta`). */
export async function stageFile(top: string, f: FileChange): Promise<void> {
  await git(top, ['add', '-A', '--', ...pathsOf(f)], { timeoutMs: 60000 })
}

/** Saca el archivo del índice sin tocar el árbol (`git reset -q -- ruta`). Funciona también sin commits. */
export async function unstageFile(top: string, f: FileChange): Promise<void> {
  await git(top, ['reset', '-q', '--', ...pathsOf(f)], { timeoutMs: 30000 })
}

export async function stageAll(top: string): Promise<void> {
  await git(top, ['add', '-A'], { timeoutMs: 120000 })
}

export async function unstageAll(top: string): Promise<void> {
  await git(top, ['reset', '-q'], { timeoutMs: 60000 })
}

/**
 * Descarta los cambios de un archivo. Para no trackeados borra el archivo (la UI pide confirmación reforzada).
 * Nunca toca nada fuera del repo.
 */
export async function discardFile(top: string, f: FileChange, hasHead: boolean): Promise<void> {
  const abs = insideRepo(top, f.path)
  if (!abs) throw new GitError('Ruta fuera del repositorio.')
  if (f.code === '??') {
    try {
      if (!statSync(abs).isFile()) throw new GitError('Solo se pueden borrar archivos sueltos.')
    } catch (e) {
      if (e instanceof GitError) throw e
      throw new GitError('El archivo ya no existe.')
    }
    unlinkSync(abs)
    return
  }
  if (!hasHead || f.code === 'A') {
    await git(top, ['rm', '-f', '-q', '--', f.path], { timeoutMs: 60000 })
    return
  }
  if (f.orig) {
    await git(top, ['restore', '--source=HEAD', '--staged', '--worktree', '--', f.orig], { timeoutMs: 60000 })
    await git(top, ['rm', '-f', '-q', '--', f.path], { timeoutMs: 60000 })
    return
  }
  await git(top, ['restore', '--source=HEAD', '--staged', '--worktree', '--', f.path], { timeoutMs: 60000 })
}

// ---------- Historial ----------

export interface LogEntry {
  hash: string
  short: string
  title: string
  author: string
  /** Fecha ISO del autor. */
  date: string
  pushed: boolean
}

/** Hashes de commits que todavía no están en el remoto (tope 1000). */
export async function unpushedHashes(cwd: string): Promise<Set<string>> {
  if (!(await hasRef(cwd, 'HEAD'))) return new Set()
  const up = await upstream(cwd)
  const args = up ? ['rev-list', '-n', '1000', `${up}..HEAD`] : ['rev-list', '-n', '1000', 'HEAD', '--not', '--remotes']
  const out = await git(cwd, args, { timeoutMs: 15000 })
  return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))
}

export async function logBranch(cwd: string, limit = 300): Promise<LogEntry[]> {
  if (!(await hasRef(cwd, 'HEAD'))) return []
  const SEP = '\x1f'
  const REC = '\x1e'
  const out = await git(cwd, ['log', '-n', String(limit), `--format=%H${SEP}%h${SEP}%an${SEP}%aI${SEP}%s${REC}`], { timeoutMs: 20000 })
  const pending = await unpushedHashes(cwd)
  return out
    .split(REC)
    .map((r) => r.replace(/^\n+/, ''))
    .filter(Boolean)
    .map((r) => {
      const [hash, short, author, date, ...title] = r.split(SEP)
      return { hash, short, author, date, title: title.join(SEP), pushed: !pending.has(hash) }
    })
}

const SHA = /^[0-9a-f]{7,40}$/

export interface CommitFile {
  path: string
  add?: number
  del?: number
  binary: boolean
}

export async function commitFiles(cwd: string, sha: string): Promise<CommitFile[]> {
  if (!SHA.test(sha)) throw new GitError('Commit inválido.')
  const out = await git(cwd, ['show', '--numstat', '-z', '--format=', '-M', '--no-ext-diff', sha], { timeoutMs: 20000 })
  return [...parseNumstat(out)].map(([path, s]) => ({ path, add: s.add, del: s.del, binary: s.binary }))
}

// ---------- Subir, traer y ramas ----------

export interface SyncInfo {
  upstream: string | null
  /** Commits que faltan subir. */
  ahead: number
  /** Commits que faltan bajar. */
  behind: number
}

export async function syncInfo(cwd: string): Promise<SyncInfo> {
  const up = await upstream(cwd)
  if (!up) {
    const ahead = (await hasRef(cwd, 'HEAD')) ? (await unpushedHashes(cwd)).size : 0
    return { upstream: null, ahead, behind: 0 }
  }
  const r = await gitRaw(cwd, ['rev-list', '--left-right', '--count', `HEAD...${up}`], { timeoutMs: 15000 })
  if (r.code !== 0) return { upstream: up, ahead: 0, behind: 0 }
  const [a, b] = r.stdout.trim().split(/\s+/).map((n) => Number(n) || 0)
  return { upstream: up, ahead: a ?? 0, behind: b ?? 0 }
}

/** Trae el remoto solo si avanza limpio (`git pull --ff-only`). Nunca combina ni reescribe. */
export async function pullFF(cwd: string): Promise<string> {
  const info = await repoInfo(cwd)
  if (!info.isRepo || !info.top) throw new GitError('No es un repositorio git.')
  if (info.branch === null) throw new GitError('HEAD está separado: no hay rama que traer.')
  if (!(await upstream(info.top))) throw new GitError('La rama no tiene remoto asociado. Subila primero con «Subir».')
  const r = await gitRaw(info.top, ['pull', '--ff-only'], { timeoutMs: 120000 })
  if (r.code !== 0) throw new GitError(readable(r, 'git pull'))
  return (r.stdout + r.stderr).trim()
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

export async function localBranches(cwd: string): Promise<LocalBranch[]> {
  const out = await git(cwd, ['for-each-ref', '--format=%(HEAD)%09%(refname)%09%(upstream:short)%09%(contents:subject)', 'refs/heads/'], { timeoutMs: 15000 })
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [head, ref, up, subject] = l.split('\t')
      return { name: ref.replace(/^refs\/heads\//, ''), current: head === '*', upstream: up || null, subject: subject ?? '' }
    })
}

export async function remoteBranches(cwd: string, locals: LocalBranch[]): Promise<RemoteBranch[]> {
  const out = await git(cwd, ['for-each-ref', '--format=%(refname)%09%(contents:subject)', 'refs/remotes/origin/'], { timeoutMs: 15000 })
  const have = new Set(locals.map((l) => l.name))
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [ref, subject] = l.split('\t')
      return { name: ref.replace(/^refs\/remotes\/origin\//, ''), subject: subject ?? '' }
    })
    .filter((b) => b.name !== 'HEAD')
    .map((b) => ({ ...b, hasLocal: have.has(b.name) }))
}

/** Cambia de rama. Si es remota sin copia local, crea la local siguiendo origin. */
export async function switchBranch(cwd: string, name: string, remote: boolean): Promise<void> {
  if (!validBranchName(name) || name.startsWith('+')) throw new GitError('Nombre de rama inválido.')
  const info = await repoInfo(cwd)
  if (!info.isRepo || !info.top) throw new GitError('No es un repositorio git.')
  if (info.branch === name) return
  if (!remote || (await hasRef(info.top, `refs/heads/${name}`))) {
    await git(info.top, ['switch', name], { timeoutMs: 60000 })
    return
  }
  if (!(await hasRef(info.top, `refs/remotes/origin/${name}`))) throw new GitError(`No encuentro la rama ${name} en origin.`)
  await git(info.top, ['switch', '-c', name, '--track', `origin/${name}`], { timeoutMs: 60000 })
}

// ---------- Stash (solo el que crea Sloth) ----------

const STASH_TAG = 'sloth-stash|'

export interface StashEntry {
  sha: string
  ref: string
  branch: string
  files: number
}

/** El stash que guardó Sloth (si hay): se reconoce por su mensaje, así sobrevive a reiniciar la app. */
export async function findStash(cwd: string): Promise<StashEntry | null> {
  if (!(await hasRef(cwd, 'refs/stash'))) return null
  const out = await git(cwd, ['stash', 'list', '--format=%H%x09%gd%x09%gs'], { timeoutMs: 15000 })
  for (const line of out.split('\n')) {
    const [sha, ref, subject = ''] = line.split('\t')
    if (!sha || !subject.includes(STASH_TAG)) continue
    const m = /sloth-stash\|([^|]*)\|/.exec(subject)
    const tracked = await git(cwd, ['stash', 'show', '--name-only', sha], { timeoutMs: 15000 })
    let untracked = 0
    if (await hasRef(cwd, `${sha}^3`)) {
      untracked = (await git(cwd, ['ls-tree', '-r', '--name-only', `${sha}^3`], { timeoutMs: 15000 })).split('\n').filter(Boolean).length
    }
    return { sha, ref, branch: m?.[1] ?? '', files: tracked.split('\n').filter(Boolean).length + untracked }
  }
  return null
}

export async function stashPush(cwd: string): Promise<void> {
  const info = await repoInfo(cwd)
  if (!info.isRepo || !info.top) throw new GitError('No es un repositorio git.')
  if (await findStash(info.top)) throw new GitError('Ya hay cambios guardados en el stash. Restauralos antes de guardar otros.')
  const branch = info.branch ?? 'HEAD separado'
  await git(info.top, ['stash', 'push', '-u', '-m', `${STASH_TAG}${branch}|${new Date().toISOString()}`], { timeoutMs: 60000 })
  if (!(await findStash(info.top))) throw new GitError('No había cambios para guardar.')
}

/** Aplica el stash de Sloth y solo lo borra si se aplicó sin conflictos. */
export async function stashRestore(cwd: string): Promise<void> {
  const info = await repoInfo(cwd)
  if (!info.isRepo || !info.top) throw new GitError('No es un repositorio git.')
  const s = await findStash(info.top)
  if (!s) throw new GitError('No hay cambios guardados en el stash.')
  const r = await gitRaw(info.top, ['stash', 'apply', s.sha], { timeoutMs: 120000 })
  if (r.code !== 0) throw new GitError(`${readable(r, 'git stash apply')} El stash sigue guardado.`)
  const again = await findStash(info.top)
  if (again) await git(info.top, ['stash', 'drop', again.ref], { timeoutMs: 30000 })
}

// ---------- gh ----------

export async function ghStatus(): Promise<{ installed: boolean; version: string }> {
  try {
    const r = await run('gh', ['--version'], { timeoutMs: 8000 })
    if (r.code !== 0) return { installed: false, version: '' }
    return { installed: true, version: r.stdout.split('\n')[0]?.trim() ?? '' }
  } catch {
    return { installed: false, version: '' }
  }
}

/** Argumentos exactos del push (sin --force nunca). */
export function pushArgs(branch: string): string[] {
  return ['push', '-u', 'origin', branch]
}

export async function push(cwd: string, branch: string): Promise<string> {
  if (!validBranchName(branch) || branch.startsWith('+')) throw new GitError('Rama inválida.')
  const info = await repoInfo(cwd)
  if (info.branch !== branch) throw new GitError(`La rama actual cambió (ahora es ${info.branch ?? 'HEAD separado'}). Volvé a revisar.`)
  if (isProtected(branch)) throw new GitError(`No se pushea directo a ${branch} desde Sloth.`)
  if (!(await remoteUrl(cwd))) throw new GitError('El repo no tiene remoto «origin».')
  const r = await gitRaw(cwd, pushArgs(branch), { timeoutMs: 120000 })
  if (r.code !== 0) throw new GitError(readable(r, 'git push'))
  return (r.stderr + r.stdout).trim()
}

// ---------- PR (gh) ----------

const TEMPLATE_CANDIDATES = [
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'PULL_REQUEST_TEMPLATE.md',
  'pull_request_template.md',
  'docs/pull_request_template.md',
  'docs/PULL_REQUEST_TEMPLATE.md'
]

export function readTemplate(top: string): { path: string; body: string } | null {
  for (const rel of TEMPLATE_CANDIDATES) {
    const abs = join(top, rel)
    try {
      if (!existsSync(abs)) continue
      const st = statSync(abs)
      if (!st.isFile()) continue
      const fd = openSync(abs, 'r')
      try {
        const buf = Buffer.alloc(Math.min(st.size, 64 * 1024))
        const n = readSync(fd, buf, 0, buf.length, 0)
        return { path: rel, body: buf.subarray(0, n).toString('utf8').replace(/^﻿/, '') }
      } finally {
        closeSync(fd)
      }
    } catch {
      /* sigue */
    }
  }
  return null
}

export interface PrRef {
  url: string
  number: number
  state: string
  title: string
}

export const GITHUB_PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+\/?$/

export async function prView(cwd: string, branch: string): Promise<PrRef | null> {
  const r = await run('gh', ['pr', 'view', branch, '--json', 'url,number,state,title'], { cwd, timeoutMs: 20000 })
  if (r.code !== 0) {
    if (/no (open )?pull requests? found|could not find/i.test(r.stderr)) return null
    throw new GitError(readable(r, 'gh pr view'))
  }
  try {
    const j = JSON.parse(r.stdout) as PrRef
    return typeof j.url === 'string' ? j : null
  } catch {
    return null
  }
}

export interface PrInput {
  base: string
  head: string
  title: string
  body: string
}

/** Argumentos exactos de `gh pr create` (el cuerpo va por stdin con --body-file -). */
export function prCreateArgs(p: PrInput): string[] {
  return ['pr', 'create', '--base', p.base, '--head', p.head, '--title', p.title, '--body-file', '-']
}

export function validatePr(p: unknown): PrInput {
  const o = p as Partial<PrInput>
  if (!o || typeof o !== 'object') throw new GitError('Datos del PR inválidos.')
  if (!validBranchName(o.base) || o.base.startsWith('+')) throw new GitError('Rama base inválida.')
  if (!validBranchName(o.head) || o.head.startsWith('+')) throw new GitError('Rama inválida.')
  if (o.base === o.head) throw new GitError('La rama y la base son la misma.')
  if (typeof o.title !== 'string' || !o.title.trim() || o.title.length > 300) throw new GitError('El título es obligatorio (máx. 300).')
  if (typeof o.body !== 'string' || o.body.length > 60000) throw new GitError('Cuerpo inválido (máx. 60 000 caracteres).')
  return { base: o.base, head: o.head, title: o.title.trim(), body: o.body }
}

export async function createPr(cwd: string, p: PrInput): Promise<string> {
  const info = await repoInfo(cwd)
  if (info.branch !== p.head) throw new GitError(`La rama actual cambió (ahora es ${info.branch ?? 'HEAD separado'}).`)
  const existing = await prView(cwd, p.head)
  if (existing && existing.state === 'OPEN') return existing.url
  const r = await run('gh', prCreateArgs(p), { cwd, timeoutMs: 60000, input: p.body })
  if (r.code !== 0) throw new GitError(readable(r, 'gh pr create'))
  const m = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(r.stdout + '\n' + r.stderr)
  if (!m) throw new GitError(`gh no devolvió el link del PR: ${r.stdout.trim().slice(0, 200)}`)
  return m[0]
}
