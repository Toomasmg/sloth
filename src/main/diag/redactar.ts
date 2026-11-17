export interface ContextoRedaccion {
  home: string
  userData: string
}

const CLAVES = [
  'token',
  'secret',
  'password',
  'passwd',
  'pwd',
  'api[_-]?key',
  'authorization',
  'cookie',
  'credential',
  'private[_-]?key',
  'access[_-]?key',
  'topic',
  'clave',
  'secreto'
].join('|')

// Todos los cuantificadores están acotados: un texto largo sin forma de secreto no puede disparar backtracking.
const VALOR = [
  '\\\\"[^\\n]{0,500}?\\\\"',
  '"(?:[^"\\\\\\n]|\\\\.){0,2000}"',
  "'[^'\\n]{0,2000}'",
  '(?:Bearer|Basic)\\s{1,20}\\S{1,2000}',
  '[\\\\"\']{0,2}[^\\s"\',;&}\\\\]{1,2000}'
].join('|')

const PARES = new RegExp(`((?:${CLAVES})[\\w.-]{0,40}\\\\?["']?[ \\t]{0,5}[:=][ \\t]{0,5})(?:${VALOR})`, 'gi')

const BLOQUE_CLAVE_INICIO = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g
const BLOQUE_CLAVE_FIN = /-----END [A-Z ]{0,40}PRIVATE KEY-----/g

const TOKENS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sb_(?:secret|publishable)_[A-Za-z0-9_-]{10,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /(?<![\w-])eyJ[\w-]+\.[\w-]+\.[\w-]+/g,
  /sloth-[0-9a-f]{16,}/g
]

const BEARER = /\bBearer\s{1,20}[^\s"'<>,;}]{1,2000}/gi
const BASIC = /\bBasic\s{1,20}[A-Za-z0-9+/=]{8,2000}/gi
const CREDENCIALES_URL = /(:\/\/)[^\s/:@]{1,200}:[^\s/@]{1,200}@/g
const CLAVE_CELU = /([#?&]k=)[^\s&#"']{1,500}/g
const LARGO_OPACO = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}/g
const EMAIL = /[\w.+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,10}\.[A-Za-z]{2,24}/g

const RUTA_WINDOWS = /([A-Za-z]:[\\/]+users[\\/]+)[^\\/\s"'<>|:*?]+/gi
const RUTA_UNIX = /(\/(?:home|Users)\/)[^\\/\s"'<>|:*?]+/g

const escapar = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// El fin con (?![\w.-]) evita que «C:\Users\Ana» se coma el prefijo de «C:\Users\Analia».
function rutaLiteral(ruta: string): RegExp | undefined {
  const partes = ruta.split(/[\\/]+/).filter((p) => p.length > 0)
  if (ruta.length < 3 || partes.length === 0) return undefined
  const inicio = /^[\\/]/.test(ruta) ? '[\\\\/]+' : ''
  return new RegExp(`${inicio}${partes.map(escapar).join('[\\\\/]+')}(?![\\w.-])`, 'gi')
}

function quitarBloquesClave(texto: string): string {
  let salida = ''
  let desde = 0
  BLOQUE_CLAVE_INICIO.lastIndex = 0
  for (;;) {
    const ini = BLOQUE_CLAVE_INICIO.exec(texto)
    if (!ini) return salida + texto.slice(desde)
    salida += texto.slice(desde, ini.index) + '[clave privada]'
    BLOQUE_CLAVE_FIN.lastIndex = ini.index + ini[0].length
    const fin = BLOQUE_CLAVE_FIN.exec(texto)
    // Sin cierre (el texto vino cortado): se tapa todo lo que sigue.
    if (!fin) return salida
    desde = fin.index + fin[0].length
    BLOQUE_CLAVE_INICIO.lastIndex = desde
  }
}

// Cadenas largas con mayúsculas, minúsculas y dígitos: tokens sueltos como el de la clave del celu.
// Un hash de git (solo hex) o un nombre de rama con guiones no entran.
function opaco(s: string): string {
  return /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s) ? '[token]' : s
}

export function redactar(texto: string, ctx: ContextoRedaccion): string {
  let t = texto
  const userData = rutaLiteral(ctx.userData)
  if (userData) t = t.replace(userData, '<userData>')
  const home = rutaLiteral(ctx.home)
  if (home) t = t.replace(home, '~')
  t = t.replace(RUTA_WINDOWS, '$1<usuario>').replace(RUTA_UNIX, '$1<usuario>')
  t = quitarBloquesClave(t)
  for (const re of TOKENS) t = t.replace(re, '[token]')
  t = t
    .replace(BEARER, 'Bearer [token]')
    .replace(BASIC, 'Basic [token]')
    .replace(CREDENCIALES_URL, '$1[redactado]@')
    .replace(CLAVE_CELU, '$1[redactado]')
  t = t.replace(PARES, '$1[redactado]')
  return t.replace(EMAIL, '[email]').replace(LARGO_OPACO, opaco)
}

export function acotar(texto: string, max: number): string {
  if (texto.length <= max) return texto
  let fin = Math.max(0, max)
  const ultimo = fin > 0 ? texto.charCodeAt(fin - 1) : 0
  if (ultimo >= 0xd800 && ultimo <= 0xdbff) fin--
  return `${texto.slice(0, fin)}…[cortado]`
}
