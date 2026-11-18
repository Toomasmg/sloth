import type { ChatCheck } from '../../shared/chat'
import { esHostSupabase } from '../../shared/chat-text'
import { GITHUB_DESHABILITADO, githubEnSettings } from './chat-auth'
import { checkAnonKey, normalizeSupabaseUrl } from './chat-config'

export interface ValidarDeps {
  supabaseUrl: string
  anonKey: string
  fetch: typeof fetch
  /** Tope de cada pedido (def. 8 s). */
  timeoutMs?: number
  /** Tope de toda la revisión (def. 20 s). */
  totalMs?: number
}

export const CHAT_SCHEMA_ESPERADA = 9

export const TABLAS_ESPERADAS: readonly string[] = [
  'profiles',
  'teams',
  'team_members',
  'team_invite_codes',
  'team_invites',
  'dm_threads',
  'messages',
  'message_reactions',
  'chat_typing_last',
  'chat_rate'
]

/** Funciones que anon no puede ejecutar (por eso 42501 = existe). Los args llevan los nombres reales: con otros, PostgREST da PGRST202 aunque exista. */
export const FUNCIONES_SIN_ANON: readonly { nombre: string; args: Record<string, unknown>; migracion: string }[] = [
  { nombre: 'remove_member', args: { p_team: null, p_user: null }, migracion: '0007' },
  { nombre: 'regenerate_invite_code', args: { p_team: null }, migracion: '0007' },
  { nombre: 'chat_rate_hit', args: { p_kind: null, p_max: null, p_secs: null }, migracion: '0008' },
  { nombre: 'dm_cleared_at', args: { p_thread: null }, migracion: '0008' },
  { nombre: 'dm_writable', args: { p_thread: null }, migracion: '0008' }
]

const TIMEOUT_MS = 8000
const TOTAL_MS = 20000
const MAX_CUERPO = 64 * 1024
const RE_CODIGO = /^[A-Z0-9]{5,8}$/

const ACCION_SQL = 'Pegá supabase/setup.sql en el SQL Editor de Supabase (es seguro repetirlo) y esperá un minuto a que Supabase refresque.'
const ACCION_URL = 'Revisá la URL y la clave en Configuración → Equipo y chat (Project Settings → API en Supabase).'

type Respuesta = { tipo: 'red' } | { tipo: 'timeout' } | { tipo: 'http'; status: number; cuerpo: unknown }

export function codigoSeguro(cuerpo: unknown): string | null {
  if (!cuerpo || typeof cuerpo !== 'object') return null
  const code = (cuerpo as { code?: unknown }).code
  return typeof code === 'string' && RE_CODIGO.test(code) ? code : null
}

async function leerCuerpo(res: Response): Promise<unknown> {
  const reader = res.body?.getReader()
  if (!reader) return undefined
  const partes: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_CUERPO) {
        reader.cancel().catch(() => undefined) // sin esperar: tirar el resto no tiene por qué trabar la revisión
        return undefined
      }
      partes.push(value)
    }
  } catch {
    return undefined // cuerpo cortado: el estado HTTP ya alcanza para decidir
  }
  try {
    return JSON.parse(new TextDecoder().decode(Buffer.concat(partes)))
  } catch {
    return undefined // HTML u otra cosa que no es JSON
  }
}

function crearPedidor(deps: ValidarDeps, base: string): (ruta: string, post?: Record<string, unknown>) => Promise<Respuesta> {
  const total = AbortSignal.timeout(deps.totalMs ?? TOTAL_MS)
  return async (ruta, post) => {
    const headers: Record<string, string> = { apikey: deps.anonKey, accept: 'application/json' }
    if (post) headers['content-type'] = 'application/json'
    try {
      const res = await deps.fetch(`${base}${ruta}`, {
        method: post ? 'POST' : 'GET',
        headers,
        ...(post ? { body: JSON.stringify(post) } : {}),
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS), total])
      })
      return { tipo: 'http', status: res.status, cuerpo: await leerCuerpo(res) }
    } catch (e) {
      const nombre = e instanceof Error ? e.name : ''
      return nombre === 'TimeoutError' || nombre === 'AbortError' ? { tipo: 'timeout' } : { tipo: 'red' }
    }
  }
}

const ok2xx = (r: Respuesta): boolean => r.tipo === 'http' && r.status >= 200 && r.status < 300
const negada = (r: Respuesta): boolean => r.tipo === 'http' && (r.status === 401 || r.status === 403 || codigoSeguro(r.cuerpo) === '42501')
const noExiste = (r: Respuesta, codigo: string): boolean => r.tipo === 'http' && (r.status === 404 || codigoSeguro(r.cuerpo) === codigo)

const lista = (nombres: string[]): string => nombres.join(', ')

function sinDatos(): ChatCheck[] {
  const detalle = 'Primero arreglá la conexión.'
  return [
    { id: 'github', estado: 'sin-datos', titulo: 'Login con GitHub', detalle },
    { id: 'tablas', estado: 'sin-datos', titulo: 'Tablas del chat', detalle },
    { id: 'funciones', estado: 'sin-datos', titulo: 'Funciones del chat', detalle },
    { id: 'version', estado: 'sin-datos', titulo: 'Versión del esquema', detalle }
  ]
}

function chequeoHost(host: string): ChatCheck {
  if (esHostSupabase(host)) return { id: 'host', estado: 'ok', titulo: 'Servidor', detalle: `Proyecto de Supabase (${host}).` }
  return {
    id: 'host',
    estado: 'aviso',
    titulo: 'Servidor',
    detalle: `Host propio: ${host}. Sloth le manda la clave pública a ese servidor: confirmá que es el tuyo.`,
    accion: 'Si no es tu servidor, cambiá la URL en Configuración → Equipo y chat.'
  }
}

function chequeoAlcance(r: Respuesta): ChatCheck {
  const titulo = 'Conexión'
  if (r.tipo === 'red') {
    return {
      id: 'alcance',
      estado: 'fallo',
      titulo,
      detalle: 'Sin conexión: no se pudo llegar al servidor.',
      accion: 'Revisá tu internet y la URL. Si el proyecto es del plan gratuito, puede estar pausado: reanudalo desde el panel de Supabase.'
    }
  }
  if (r.tipo === 'timeout') {
    return {
      id: 'alcance',
      estado: 'fallo',
      titulo,
      detalle: 'Supabase no respondió a tiempo.',
      accion: 'Revisá tu internet. Si el proyecto es del plan gratuito, puede estar pausado: reanudalo desde el panel de Supabase.'
    }
  }
  if (r.status === 401 || r.status === 403) {
    return {
      id: 'alcance',
      estado: 'fallo',
      titulo,
      detalle: 'Supabase rechazó la clave.',
      accion: 'Copiá la clave publishable (o anon) de Project Settings → API y pegala de nuevo.'
    }
  }
  if (r.status === 404) {
    return { id: 'alcance', estado: 'fallo', titulo, detalle: 'Esa dirección no responde como un proyecto de Supabase.', accion: ACCION_URL }
  }
  if (!ok2xx(r)) {
    return { id: 'alcance', estado: 'fallo', titulo, detalle: `Supabase respondió con un error (código ${r.status}).`, accion: 'Probá de nuevo en un rato.' }
  }
  return { id: 'alcance', estado: 'ok', titulo, detalle: 'Supabase responde y acepta la clave.' }
}

function chequeoGithub(r: Respuesta): ChatCheck {
  const titulo = 'Login con GitHub'
  const habilitado = r.tipo === 'http' && ok2xx(r) ? githubEnSettings(r.cuerpo) : null
  if (habilitado === true) return { id: 'github', estado: 'ok', titulo, detalle: 'GitHub está habilitado como proveedor de login.' }
  if (habilitado === false) return { id: 'github', estado: 'fallo', titulo, detalle: GITHUB_DESHABILITADO }
  return { id: 'github', estado: 'sin-datos', titulo, detalle: 'No se pudo comprobar si GitHub está habilitado.', accion: 'Probá de nuevo en un rato.' }
}

function chequeoTablas(rs: Respuesta[]): ChatCheck {
  const titulo = 'Tablas del chat'
  const faltan: string[] = []
  const legibles: string[] = []
  const inciertas: string[] = []
  rs.forEach((r, i) => {
    const t = TABLAS_ESPERADAS[i]
    if (ok2xx(r)) legibles.push(t)
    else if (noExiste(r, 'PGRST205')) faltan.push(t)
    else if (!negada(r)) inciertas.push(t)
  })
  if (faltan.length) return { id: 'tablas', estado: 'fallo', titulo, detalle: `Faltan: ${lista(faltan)}.`, accion: ACCION_SQL }
  if (legibles.length) {
    return {
      id: 'tablas',
      estado: 'aviso',
      titulo,
      detalle: `La clave pública puede leer: ${lista(legibles)}. No debería poder.`,
      accion: 'Revisá la migración 0002 (supabase/setup.sql la incluye) y volvé a pegarla en el SQL Editor.'
    }
  }
  if (inciertas.length) {
    return { id: 'tablas', estado: 'sin-datos', titulo, detalle: `No se pudo comprobar: ${lista(inciertas)}.`, accion: 'Probá de nuevo en un rato.' }
  }
  return { id: 'tablas', estado: 'ok', titulo, detalle: `Están las ${TABLAS_ESPERADAS.length} tablas y la clave pública no las lee.` }
}

function chequeoFunciones(rs: Respuesta[]): ChatCheck {
  const titulo = 'Funciones del chat'
  const faltan: string[] = []
  const abiertas: string[] = []
  const inciertas: string[] = []
  rs.forEach((r, i) => {
    const f = FUNCIONES_SIN_ANON[i]
    if (ok2xx(r)) abiertas.push(f.nombre)
    else if (noExiste(r, 'PGRST202')) faltan.push(`${f.nombre} (migración ${f.migracion})`)
    else if (!negada(r)) inciertas.push(f.nombre)
  })
  if (faltan.length) return { id: 'funciones', estado: 'fallo', titulo, detalle: `Faltan: ${lista(faltan)}.`, accion: ACCION_SQL }
  if (abiertas.length) {
    return {
      id: 'funciones',
      estado: 'aviso',
      titulo,
      detalle: `Seguridad: la clave pública pudo ejecutar ${lista(abiertas)}. No debería poder.`,
      accion: 'Volvé a pegar supabase/setup.sql en el SQL Editor para restaurar los permisos.'
    }
  }
  if (inciertas.length) {
    return { id: 'funciones', estado: 'sin-datos', titulo, detalle: `No se pudo comprobar: ${lista(inciertas)}.`, accion: 'Probá de nuevo en un rato.' }
  }
  return { id: 'funciones', estado: 'ok', titulo, detalle: `Están las ${FUNCIONES_SIN_ANON.length} funciones protegidas y la clave pública no las ejecuta.` }
}

function chequeoVersion(r: Respuesta): ChatCheck {
  const titulo = 'Versión del esquema'
  const esperada = CHAT_SCHEMA_ESPERADA
  if (r.tipo === 'http' && ok2xx(r)) {
    const n = r.cuerpo
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 10_000) {
      if (n === esperada) return { id: 'version', estado: 'ok', titulo, detalle: `Esquema al día (versión ${esperada}).` }
      if (n < esperada) {
        return { id: 'version', estado: 'fallo', titulo, detalle: `Tu esquema es el ${n} y esta versión de Sloth espera el ${esperada}.`, accion: ACCION_SQL }
      }
      return {
        id: 'version',
        estado: 'aviso',
        titulo,
        detalle: `Tu esquema es el ${n}, más nuevo que el ${esperada} que conoce esta versión de Sloth.`,
        accion: 'Actualizá Sloth.'
      }
    }
  } else if (r.tipo === 'http' && noExiste(r, 'PGRST202')) {
    return {
      id: 'version',
      estado: 'aviso',
      titulo,
      detalle: 'No encontré chat_schema_version(): falta la migración 0009. Si las tablas y las funciones dieron bien, el resto del chat anda igual.',
      accion: 'Aplicá la migración 0009 (o pegá supabase/setup.sql de nuevo) y esperá un minuto.'
    }
  }
  return { id: 'version', estado: 'sin-datos', titulo, detalle: 'No se pudo leer la versión del esquema.', accion: 'Probá de nuevo en un rato.' }
}

export async function validarChat(deps: ValidarDeps): Promise<ChatCheck[]> {
  let base: string
  try {
    base = normalizeSupabaseUrl(deps.supabaseUrl)
  } catch (e) {
    return [{ id: 'host', estado: 'fallo', titulo: 'Servidor', detalle: e instanceof Error ? e.message : 'La URL de Supabase no es válida.', accion: ACCION_URL }]
  }
  try {
    checkAnonKey(deps.anonKey)
  } catch (e) {
    return [
      {
        id: 'clave',
        estado: 'fallo',
        titulo: 'Clave pública',
        detalle: e instanceof Error ? e.message : 'La clave no es una anon / publishable key.',
        accion: 'Usá la clave publishable (o anon) de Project Settings → API. No se hicieron pedidos al servidor.'
      }
    ]
  }
  const host = chequeoHost(new URL(base).hostname)
  const pedir = crearPedidor(deps, base)
  const alcance = chequeoAlcance(await pedir('/auth/v1/health'))
  if (alcance.estado !== 'ok') return [host, alcance, ...sinDatos()]
  const [github, tablas, funciones, version] = await Promise.all([
    pedir('/auth/v1/settings').then(chequeoGithub),
    Promise.all(TABLAS_ESPERADAS.map((t) => pedir(`/rest/v1/${t}?select=*&limit=0`))).then(chequeoTablas),
    Promise.all(FUNCIONES_SIN_ANON.map((f) => pedir(`/rest/v1/rpc/${f.nombre}`, f.args))).then(chequeoFunciones),
    pedir('/rest/v1/rpc/chat_schema_version', {}).then(chequeoVersion)
  ])
  return [host, alcance, github, tablas, funciones, version]
}
