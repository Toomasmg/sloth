/**
 * Configuración del chat (Supabase propio del equipo): validación de la URL y de la key.
 * Puro, sin Electron (solo node:*): se prueba con Node.
 *
 * Regla de seguridad: Sloth solo acepta la anon / publishable key. La service_role / secret key
 * da acceso total a la base y NUNCA puede entrar a la app: se rechaza con un mensaje claro y sin
 * repetir el valor de la key en ningún error ni log.
 */
import { createHash } from 'node:crypto'
import { isSupabaseHost } from '../../shared/chat'

export interface ChatServerConfig {
  /** Origen normalizado: https://<ref>.supabase.co */
  supabaseUrl: string
  /** Anon / publishable key. Es pública por diseño; la protege la RLS. */
  anonKey: string
  /** La persona marcó en Configuración que es un servidor propio, fuera de supabase.co. */
  selfHosted?: true
}

export interface UrlOptions {
  /** Acepta cualquier host https. Solo para lo que la persona escribió a mano y marcó como servidor propio. */
  selfHosted?: boolean
}

const MAX_KEY_LENGTH = 2048
const MAX_URL_LENGTH = 300
const PUBLISHABLE = /^sb_publishable_[A-Za-z0-9_-]{8,}$/
const JWT_PART = /^[A-Za-z0-9_-]+$/

const SECRET_MSG =
  'Esa es una service_role / secret key. Nunca va en Sloth ni en .sloth/team.json: da acceso total a la base. Usá la anon / publishable key (Project Settings → API).'

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/**
 * Valida y normaliza la URL del proyecto. Solo https, sin usuario, sin query, sin hash, sin ruta y,
 * salvo servidor propio, solo https://<ref>.supabase.co.
 */
export function normalizeSupabaseUrl(raw: unknown, opts: UrlOptions = {}): string {
  if (typeof raw !== 'string') throw new Error('La URL de Supabase tiene que ser texto.')
  const s = raw.trim()
  if (!s || s.length > MAX_URL_LENGTH) throw new Error('La URL de Supabase no es válida.')
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw new Error('La URL de Supabase no es válida. Tiene que ser https://<ref>.supabase.co.')
  }
  if (u.protocol !== 'https:') throw new Error('La URL de Supabase tiene que empezar con https://.')
  if (u.username || u.password) throw new Error('La URL de Supabase no puede llevar usuario ni contraseña.')
  if (u.search || u.hash) throw new Error('La URL de Supabase no puede tener ? ni # al final.')
  if (u.pathname !== '/' && u.pathname !== '') throw new Error('La URL de Supabase no puede tener ruta: va solo la URL del proyecto.')
  if (!u.hostname) throw new Error('La URL de Supabase no tiene dominio.')
  if (!opts.selfHosted && !isSupabaseHost(u.host))
    throw new Error(`Sloth solo acepta proyectos de Supabase (https://<ref>.supabase.co) y «${u.host}» no lo es. Si es un servidor propio de tu equipo, cargalo a mano en Configuración › Chat y marcá «Servidor propio».`)
  return u.origin
}

function decodeJwtPayload(part: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown
    return isObj(obj) ? obj : null
  } catch {
    return null
  }
}

/**
 * Acepta solo una anon key: un JWT con role «anon», o una «sb_publishable_…».
 * Rechaza service_role, «sb_secret_…» y cualquier otra cosa. No verifica la firma (no hace falta
 * para decidir qué clase de key es: lo que importa es que no sea la de servicio).
 */
export function checkAnonKey(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('La anon key tiene que ser texto.')
  const k = raw.trim()
  if (!k) throw new Error('Falta la anon key.')
  if (k.length > MAX_KEY_LENGTH) throw new Error('La key es demasiado larga.')
  if (k.startsWith('sb_secret_')) throw new Error(SECRET_MSG)
  if (k.startsWith('sb_publishable_')) {
    if (!PUBLISHABLE.test(k)) throw new Error('La publishable key no tiene un formato válido.')
    return k
  }
  const parts = k.split('.')
  if (parts.length === 3 && parts.every((p) => p.length > 0 && JWT_PART.test(p))) {
    const payload = decodeJwtPayload(parts[1])
    if (payload?.role === 'service_role') throw new Error(SECRET_MSG)
    if (payload?.role === 'anon') return k
    throw new Error('Esa key no es una anon key (el rol del JWT no es «anon»).')
  }
  throw new Error('No reconozco esa key. Usá la anon / publishable key del proyecto (empieza con eyJ… o sb_publishable_…).')
}

/**
 * Valida {supabaseUrl, anonKey, selfHosted?} (de Configuración o de .sloth/team.json). Las claves que
 * empiezan con «_» o «$» son comentarios y se ignoran; cualquier otra clave desconocida es un error.
 * `selfHosted` solo vale si quien llama lo permite (Configuración), nunca desde un archivo de afuera.
 */
export function parseChatServerConfig(raw: unknown, opts: { allowSelfHosted?: boolean } = {}): ChatServerConfig {
  if (!isObj(raw)) throw new Error('La configuración del chat tiene que ser un objeto con supabaseUrl y anonKey.')
  for (const k of Object.keys(raw)) {
    if (k.startsWith('_') || k.startsWith('$')) continue
    if (k !== 'supabaseUrl' && k !== 'anonKey' && k !== 'selfHosted') throw new Error(`En el chat no conozco la clave «${k}».`)
  }
  if (raw.selfHosted !== undefined && typeof raw.selfHosted !== 'boolean') throw new Error('«selfHosted» tiene que ser true o false.')
  const selfHosted = raw.selfHosted === true
  if (selfHosted && opts.allowSelfHosted === false) throw new Error('Un servidor propio solo se puede cargar a mano en Configuración › Chat.')
  const supabaseUrl = normalizeSupabaseUrl(raw.supabaseUrl, { selfHosted })
  return { supabaseUrl, anonKey: checkAnonKey(raw.anonKey), ...(selfHosted ? { selfHosted: true as const } : {}) }
}

/**
 * La config de chat.json. Una guardada antes de la marca «Servidor propio» con un host fuera de
 * supabase.co ya la había cargado o confirmado la persona: se migra marcada, nunca se descarta.
 */
export function parseSavedChatConfig(raw: unknown): { cfg: ChatServerConfig; migrated: boolean } {
  try {
    return { cfg: parseChatServerConfig(raw), migrated: false }
  } catch (e) {
    if (!isObj(raw) || raw.selfHosted !== undefined) throw e
    return { cfg: parseChatServerConfig({ ...raw, selfHosted: true }), migrated: true }
  }
}

/** Lo que se muestra de la key: primeros 6 y últimos 4 caracteres. */
export function keyPreview(key: string): string {
  if (key.length < 14) return '…'
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}

/** Huella de la key (sha256). Sirve para recordar qué se aceptó sin guardar la key aparte. */
export function keyHash(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}
