import fs from 'node:fs'

/**
 * «Reportar un problema» (lógica pura, sin Electron): filtro de datos personales, armado del cuerpo,
 * URL del issue (host fijo) y lectura solo del final del registro. Pruebas: S\v5-report\test.mts.
 */

export const REPORT_ISSUE_URL = 'https://github.com/Toomasmg/sloth/issues/new'
export const TITLE_MAX = 200
export const BODY_MAX = 6000
/** Tope de la URL prellenada. Por encima, el navegador o GitHub la pueden truncar. */
export const URL_MAX = 8000
export const LOG_LINES = 50
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

export interface ReportFacts {
  sloth: string
  windows: string
  arch: string
  electron: string
  daemon: string
  accounts: number
  workspaces: number
}

/** Cuerpo del issue (markdown). El bloque de registro va al final, en un bloque ``` (ver fitBody). */
export function composeBody(f: ReportFacts, logLines: readonly string[]): string {
  return [
    `**Sloth:** ${f.sloth}`,
    `**Windows:** ${f.windows}`,
    `**Arquitectura:** ${f.arch}`,
    `**Electron:** ${f.electron}`,
    `**Daemon:** ${f.daemon}`,
    `**Cuentas:** ${f.accounts} · **Espacios:** ${f.workspaces}`,
    '',
    '## Qué pasó',
    '',
    '(Contá qué estabas haciendo y qué esperabas que pasara.)',
    '',
    `## Registro (últimas ${logLines.length} líneas)`,
    '```',
    ...logLines,
    '```',
    ''
  ].join('\n')
}

/** Encabezado + apertura del bloque (1), líneas del registro (2) y cierre del bloque (3). */
const LOG_BLOCK = /(^## Registro[^\n]*\n```[^\n]*\n)([\s\S]*?)(\n```)/m

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

/**
 * Últimas `lines` líneas de un archivo, leyendo desde el final por bloques (nunca el archivo entero).
 * Como mucho `maxBytes` del final. Tolerante: si no se puede leer, devuelve [].
 */
export function readLogTail(file: string, lines = LOG_LINES, maxBytes = LOG_MAX_BYTES): string[] {
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
