import fs from 'node:fs'

/**
 * «Reportar un problema» (lógica pura, sin Electron): filtro de datos personales, armado del cuerpo,
 * URL del issue (host fijo) y lectura solo del final del registro.
 */

export const REPORT_ISSUE_URL = 'https://github.com/Toomasmg/sloth/issues/new'
export const TITLE_MIN = 8
export const TITLE_MAX = 200
export const BODY_MAX = 6000
/** Tope de la URL prellenada. Por encima, el navegador o GitHub la pueden truncar. */
export const URL_MAX = 8000
/** Límites del formulario (para que el cuerpo entre en BODY_MAX aun sin registro). */
export const WHAT_MAX = 1500
export const EXPECT_MAX = 800
export const STEP_MAX = 200
export const STEPS_MAX = 8
/** Registro: últimos minutos y tope de líneas. */
export const LOG_MINUTES = 30
export const LOG_KEEP = 40
/** Cuántas líneas (y bytes) del final del registro se leen antes de filtrar por tiempo. */
export const LOG_READ_LINES = 400
export const LOG_MAX_BYTES = 64 * 1024

export interface SanitizeContext {
  /** Carpeta personal (os.homedir()). Se reemplaza por %USERPROFILE%. */
  home: string
  /** Nombre de usuario de Windows (os.userInfo().username). */
  username: string
  /** Nombre de la PC (os.hostname()). */
  hostname: string
  /** Ids de cuentas de Sloth: aparecen en rutas y en el registro. */
  accountIds?: readonly string[]
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Una ruta como regex: los separadores \ y / dan igual, sin distinguir mayúsculas. */
function pathRe(p: string): RegExp | null {
  const parts = p.split(/[\\/]+/).filter(Boolean).map(escapeRe)
  if (parts.length === 0) return null
  return new RegExp(`${parts.join('[\\\\/]+')}(?![A-Za-z0-9_])`, 'gi')
}

const TOKEN_RES: RegExp[] = [
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]+/g,
  /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]+/g,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{30,}/g,
  /(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{30,}/g,
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
  /(?<![A-Za-z0-9])sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g,
  /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9_-]+/g
]

/**
 * Quita lo personal de un texto. Orden: rutas, correos, tokens conocidos, pares clave=valor,
 * UUID, hex y base64 largos, nombre de usuario y de PC, cuentas, IPs.
 * Lo que se reemplaza: rutas de usuario → C:\Users\<usuario> (o %USERPROFILE%), correos → <email>,
 * tokens → <token>, UUID → <id>, hex ≥ 32 → <hex>, base64 ≥ 40 con letras y dígitos → <clave>,
 * ids de cuenta y carpetas accounts\<x> → <cuenta>, PC → <pc>, IPv4 (salvo 127.0.0.1) → <ip>.
 */
export function sanitize(text: string, ctx: SanitizeContext): string {
  let s = String(text)

  const home = pathRe(ctx.home)
  if (home) s = s.replace(home, '%USERPROFILE%')
  s = s.replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`<>|]+/gi, 'C:\\Users\\<usuario>')
  s = s.replace(/\/(home|Users)\/[^/\s"'`<>|]+/g, '/$1/<usuario>')

  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '<email>')

  for (const re of TOKEN_RES) s = s.replace(re, '<token>')
  s = s.replace(/Bearer[ \t]+\S+/gi, 'Bearer <token>')
  s = s.replace(
    /(\b[\w.-]*(?:token|password|passwd|secret|api[_-]?key)["']?[ \t]*[=:][ \t]*["']?)[^\s"'&;,]+/gi,
    '$1<token>'
  )

  // Antes que los UUID: la carpeta de una cuenta se llama con su id.
  s = s.replace(/([\\/])accounts([\\/])[^\\/\s"'`<>|]+/gi, '$1accounts$2<cuenta>')
  for (const id of ctx.accountIds ?? []) {
    if (id.length >= 4) s = s.replace(new RegExp(escapeRe(id), 'gi'), '<cuenta>')
  }

  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
  s = s.replace(/(?<![A-Za-z0-9])[0-9a-f]{32,}(?![A-Za-z0-9])/gi, '<hex>')
  // Con «/» (base64 estándar, p. ej. claves de AWS) se exige mayúscula, minúscula y dígito, así no
  // se come rutas largas.
  s = s.replace(/(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g, (m) =>
    /\d/.test(m) && /[A-Za-z]/.test(m) && (!m.includes('/') || (/[a-z]/.test(m) && /[A-Z]/.test(m))) ? '<clave>' : m
  )

  // Como palabra suelta: «PC» no tiene que comerse «PCB», ni «ana» la palabra «ventana».
  const word = (w: string): RegExp => new RegExp(String.raw`(?<![\p{L}\p{N}])${escapeRe(w)}(?![\p{L}\p{N}])`, 'giu')
  if (ctx.username.length >= 3) s = s.replace(word(ctx.username), '<usuario>')
  if (ctx.hostname.length >= 2) s = s.replace(word(ctx.hostname), '<pc>')

  s = s.replace(/(?<![\d.])(?!127\.0\.0\.1(?![\d.]))(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g, '<ip>')
  return s
}

export type ReportType = 'error' | 'idea' | 'otra'
export const REPORT_TYPES: Record<ReportType, string> = { error: 'Error', idea: 'Idea', otra: 'Otra cosa' }

export interface ReportForm {
  type: ReportType
  title: string
  what: string
  expect: string
  steps: string[]
}

/** Datos del sistema, uno por línea (ya sin sanitizar: el llamador pasa todo por sanitize). */
export function systemLines(f: {
  sloth: string
  windows: string
  arch: string
  electron: string
  daemon: string
  accounts: number
  workspaces: number
}): string[] {
  return [
    `Sloth ${f.sloth}`,
    `Windows ${f.windows} · ${f.arch}`,
    `Electron ${f.electron}`,
    `Daemon: ${f.daemon}`,
    `Cuentas: ${f.accounts} · Espacios: ${f.workspaces}`
  ]
}

/**
 * Cuerpo del issue (markdown). `sys` y `logs` son null si el usuario no los quiere incluir. El bloque
 * de registro va al final, en un bloque ``` (ver fitBody).
 */
export function composeBody(f: ReportForm, sys: readonly string[] | null, logs: readonly string[] | null): string {
  const steps = f.steps.map((s) => s.trim()).filter(Boolean)
  const out: string[] = [
    `**Tipo:** ${REPORT_TYPES[f.type]}`,
    '',
    '## Qué pasó',
    f.what.trim() || '(sin completar)',
    '',
    '## Qué esperaba',
    f.expect.trim() || '(sin completar)',
    '',
    '## Pasos para reproducirlo',
    ...(steps.length ? steps.map((s, i) => `${i + 1}. ${s}`) : ['(sin pasos)'])
  ]
  if (sys) out.push('', '## Sistema', ...sys.map((l) => `- ${l}`))
  if (logs) {
    out.push('', `## Registro (últimos ${LOG_MINUTES} minutos)`)
    if (logs.length) out.push('```', ...logs, '```')
    else out.push('(sin registros recientes)')
  }
  return out.join('\n') + '\n'
}

/** Abre el bloque del registro (1), sus líneas (2) y cierra (3). */
const LOG_BLOCK = /(^## Registro[^\n]*\n```\n)([\s\S]*?)(\n```)/m

/**
 * Deja el cuerpo en `max` caracteres recortando SOLO las líneas más viejas del registro.
 * El texto del usuario no se toca. Devuelve null si ni sin registro entra.
 */
export function fitBody(body: string, max = BODY_MAX): string | null {
  if (body.length <= max) return body
  const m = LOG_BLOCK.exec(body)
  if (!m) return null
  const head = body.slice(0, m.index) + m[1]
  const tail = body.slice(m.index + m[0].length)
  let lines = m[2] === '' ? [] : m[2].split('\n')
  let out = body
  while (out.length > max && lines.length > 0) {
    lines = lines.slice(1)
    out = head + lines.join('\n') + m[3] + tail
  }
  return out.length <= max ? out : null
}

/** Título y cuerpo ya sanitizados → URL de «nuevo issue» en el host fijo. */
export function buildIssueUrl(title: string, body: string): string {
  return `${REPORT_ISSUE_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
}

/** true solo para una URL armada por buildIssueUrl (mismo host y ruta fijos, tamaño acotado). */
export function isIssueUrl(u: unknown): u is string {
  return typeof u === 'string' && u.length <= URL_MAX && u.startsWith(`${REPORT_ISSUE_URL}?`)
}

const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/

/**
 * Líneas de los últimos `minutes` minutos (según la marca de tiempo al inicio de cada línea del
 * registro del daemon), como mucho `keep` líneas. Las líneas sin marca siguen a la anterior.
 */
export function recentLines(lines: readonly string[], now: number, minutes = LOG_MINUTES, keep = LOG_KEEP): string[] {
  const since = now - minutes * 60_000
  const out: string[] = []
  let inWindow = false
  for (const l of lines) {
    const m = TS_RE.exec(l)
    if (m) inWindow = Date.parse(m[1]) >= since
    if (inWindow) out.push(l)
  }
  return out.slice(-keep)
}

/**
 * Últimas `lines` líneas de un archivo, leyendo desde el final por bloques (nunca el archivo entero).
 * Como mucho `maxBytes` del final. Tolerante: si no se puede leer, devuelve [].
 */
export function readLogTail(file: string, lines = LOG_READ_LINES, maxBytes = LOG_MAX_BYTES): string[] {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return []
  }
  try {
    const size = fs.fstatSync(fd).size
    const limit = Math.min(size, maxBytes)
    const CHUNK = 8192
    const parts: Buffer[] = []
    let pos = size
    let read = 0
    let newlines = 0
    while (pos > 0 && read < limit) {
      const len = Math.min(CHUNK, pos, limit - read)
      pos -= len
      const buf = Buffer.alloc(len)
      const n = fs.readSync(fd, buf, 0, len, pos)
      const got = buf.subarray(0, n)
      parts.unshift(got)
      read += n
      for (const b of got) if (b === 0x0a) newlines++
      if (newlines >= lines + 1) break
    }
    const arr = Buffer.concat(parts).toString('utf8').split(/\r?\n/)
    if (pos > 0) arr.shift()
    if (arr.length > 0 && arr[arr.length - 1] === '') arr.pop()
    return arr.slice(-lines)
  } finally {
    fs.closeSync(fd)
  }
}
