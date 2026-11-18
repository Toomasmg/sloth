import { loginGhValido, nombrePerfilValido } from './perfiles-core'

export interface IdentidadGh {
  login: string
  nombre?: string
  avatarUrl: string
}

export const HOST_AVATAR = 'avatars.githubusercontent.com'
const MAX_URL = 300
const MAX_STDOUT = 8 * 1024

/** Agrega el tamaño pedido a una URL de avatar ya validada. */
export function urlAvatarConTamano(avatarUrl: string, px: number): string {
  const u = new URL(avatarUrl)
  u.searchParams.set('s', String(px))
  return u.toString()
}

export function avatarValido(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_URL) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.hostname !== HOST_AVATAR || u.username || u.password || u.port) return null
  return u.toString()
}

/** Lo que dice `gh api user` es un dato externo: se valida cada campo y lo que no cierra se ignora o se rechaza. */
export function parsearUsuarioGh(stdout: string): IdentidadGh | null {
  if (typeof stdout !== 'string' || stdout.length > MAX_STDOUT) return null
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const avatarUrl = avatarValido(r.avatar_url)
  if (!loginGhValido(r.login) || !avatarUrl) return null
  const identidad: IdentidadGh = { login: r.login, avatarUrl }
  const nombre = nombrePerfilValido(r.name)
  if (nombre) identidad.nombre = nombre
  return identidad
}
