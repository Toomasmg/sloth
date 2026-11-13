/**
 * Invitación completa al chat: un texto que trae servidor, clave publicable y código del equipo, así
 * quien entra lo hace en un paso. Puro (solo node:*): se prueba con Node.
 *
 * El texto pegado es dato no confiable: se valida entero (mismas reglas que Configuración) y lo único
 * que sale de acá es una config de chat válida, un código con el formato de la base y un nombre limpio.
 */
import { CHAT_LIMITS } from '../../shared/chat'
import { checkAnonKey, keyHash, normalizeSupabaseUrl, type ChatServerConfig } from './chat-config'
import { codepoints, parseInviteCode } from './chat-map'

export const INVITE_PREFIX = 'sloth-invitacion:v1.'
/** Lo que se acepta pegar entero (el token más un mensaje alrededor). */
export const MAX_INVITE_TEXT = 8000
/** Largo máximo del token base64url. */
export const MAX_INVITE_TOKEN = 4096

const TOKEN_RE = /sloth-invitacion:v1\.([A-Za-z0-9_-]*)/g
const B64URL_RE = /^[A-Za-z0-9_-]+$/
// Controles y marcas de dirección: un nombre de equipo no las necesita y sirven para disfrazar texto.
const BAD_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/
const KEYS = new Set(['url', 'key', 'code', 'team'])

export interface ChatInvitation {
  cfg: ChatServerConfig
  code: string
  teamName?: string
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

function cleanTeamName(raw: unknown): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') throw new Error('La invitación no es válida: el nombre del equipo tiene que ser texto.')
  const s = raw.trim()
  if (!s || codepoints(s) > CHAT_LIMITS.teamName || BAD_NAME_CHARS.test(s)) throw new Error('La invitación no es válida: el nombre del equipo no es válido.')
  return s
}

/** Arma el texto copiable. Valida todo igual que al leerlo; un nombre de equipo raro se omite. */
export function buildInvitation(cfg: ChatServerConfig, code: string, teamName?: string): string {
  let team: string | undefined
  try {
    team = cleanTeamName(teamName)
  } catch {
    team = undefined
  }
  const body = { url: normalizeSupabaseUrl(cfg.supabaseUrl), key: checkAnonKey(cfg.anonKey), code: parseInviteCode(code), ...(team ? { team } : {}) }
  const token = `${INVITE_PREFIX}${Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')}`
  if (token.length - INVITE_PREFIX.length > MAX_INVITE_TOKEN) throw new Error('La invitación quedó demasiado larga.')
  return token
}

/** ¿El texto parece traer una invitación? Solo mira el prefijo: sirve para ofrecer pegarla. */
export const looksLikeInvitation = (text: unknown): text is string =>
  typeof text === 'string' && text.length <= MAX_INVITE_TEXT && text.includes(INVITE_PREFIX)

/**
 * Lee una invitación. Acepta el token solo o con texto alrededor (como llega por un chat), pero
 * tiene que haber exactamente uno. Rechaza claves desconocidas, http, la secret key y tamaños grandes.
 */
export function parseInvitation(raw: unknown): ChatInvitation {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('Pegá la invitación completa (empieza con sloth-invitacion:).')
  if (raw.length > MAX_INVITE_TEXT) throw new Error('Ese texto es demasiado largo para ser una invitación.')
  const found = [...raw.matchAll(TOKEN_RE)]
  if (found.length === 0) throw new Error('Eso no es una invitación de Sloth. Tiene que empezar con sloth-invitacion:v1.')
  if (found.length > 1) throw new Error('Hay más de una invitación en el texto. Pegá una sola.')
  const token = found[0][1]
  if (!token || !B64URL_RE.test(token)) throw new Error('La invitación está incompleta. Pedí que te la copien de nuevo.')
  if (token.length > MAX_INVITE_TOKEN) throw new Error('La invitación es demasiado larga.')
  let data: unknown
  try {
    data = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
  } catch {
    throw new Error('La invitación está dañada o incompleta. Pedí que te la copien de nuevo.')
  }
  if (!isObj(data)) throw new Error('La invitación está dañada o incompleta. Pedí que te la copien de nuevo.')
  for (const k of Object.keys(data)) if (!KEYS.has(k)) throw new Error('La invitación trae datos que Sloth no conoce. ¿Es de una versión más nueva?')
  let supabaseUrl: string
  try {
    supabaseUrl = normalizeSupabaseUrl(data.url)
  } catch (e) {
    throw new Error(`La invitación no es válida: ${(e as Error).message}`)
  }
  let anonKey: string
  try {
    anonKey = checkAnonKey(data.key)
  } catch (e) {
    throw new Error(`Invitación rechazada. ${(e as Error).message}`)
  }
  let code: string
  try {
    code = parseInviteCode(data.code)
  } catch {
    throw new Error('La invitación no es válida: el código del equipo no tiene el formato correcto.')
  }
  const teamName = cleanTeamName(data.team)
  return { cfg: { supabaseUrl, anonKey }, code, ...(teamName ? { teamName } : {}) }
}

/**
 * Qué hacer con una invitación válida según el estado actual:
 * - confirmNew: no hay chat configurado → mostrar el host y pedir confirmación.
 * - confirmReplace: hay otra config → avisar y pedir confirmación explícita antes de reemplazarla.
 * - signIn: misma config sin sesión → iniciar sesión y canjear después.
 * - redeem: misma config con sesión → canjear directo.
 */
export type InviteDecision = 'confirmNew' | 'confirmReplace' | 'signIn' | 'redeem'

export interface InviteCurrent {
  /** La config activa (su URL y la huella de la key), si hay. */
  active?: { supabaseUrl: string; keyHash: string }
  signedIn: boolean
}

export const sameServer = (cfg: ChatServerConfig, active: { supabaseUrl: string; keyHash: string }): boolean =>
  cfg.supabaseUrl === active.supabaseUrl && keyHash(cfg.anonKey) === active.keyHash

export function decideInvite(inv: ChatInvitation, cur: InviteCurrent): InviteDecision {
  if (!cur.active) return 'confirmNew'
  if (!sameServer(inv.cfg, cur.active)) return 'confirmReplace'
  return cur.signedIn ? 'redeem' : 'signIn'
}
