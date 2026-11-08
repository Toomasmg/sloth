/**
 * Chat (datos): fotos de equipo. Bucket PRIVADO `team-photos`, ruta `<team_id>/<uuid>.<ext>`.
 * Validación ANTES de subir: largo del base64, tamaño y bytes mágicos (webp, png, jpeg).
 * La foto vuelve a la UI como data: URL (el bucket no es público). Nunca se loguean bytes.
 */
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CHAT_LIMITS } from '../../shared/chat'

export const PHOTO_BUCKET = 'team-photos'
export type PhotoKind = 'webp' | 'png' | 'jpeg'

const MIME: Record<PhotoKind, string> = { webp: 'image/webp', png: 'image/png', jpeg: 'image/jpeg' }
const EXT: Record<PhotoKind, string> = { webp: 'webp', png: 'png', jpeg: 'jpg' }
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/
/** Ruta que se acepta de la base: <uuid>/<uuid>.(webp|png|jpg). */
const PATH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|png|jpg)$/i

export interface Photo {
  bytes: Buffer
  kind: PhotoKind
}

/** Tipo real de la imagen según sus primeros bytes. null si no es webp, png ni jpeg. */
export function sniffPhoto(b: Uint8Array): PhotoKind | null {
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return 'webp'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a)
    return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  return null
}

/**
 * Decodifica y valida la foto que manda la UI (base64 SIN prefijo). Tira Error en español.
 * `maxBytes` es el tope ya recortado (CHAT_LIMITS.photoBytes).
 */
export function decodePhotoBase64(raw: unknown, maxBytes: number = CHAT_LIMITS.photoBytes): Photo {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('La foto no es válida.')
  // Corte temprano: el base64 de más de maxBytes ni se decodifica.
  if (raw.length > Math.ceil(maxBytes / 3) * 4) throw new Error(`La foto pesa más de ${Math.round(maxBytes / 1024)} KB.`)
  if (raw.length % 4 !== 0 || !B64_RE.test(raw)) throw new Error('La foto no es válida.')
  const bytes = Buffer.from(raw, 'base64')
  if (bytes.length === 0) throw new Error('La foto no es válida.')
  if (bytes.length > maxBytes) throw new Error(`La foto pesa más de ${Math.round(maxBytes / 1024)} KB.`)
  const kind = sniffPhoto(bytes)
  if (!kind) throw new Error('La foto tiene que ser webp, png o jpeg.')
  return { bytes, kind }
}

/** Ruta válida dentro del bucket (la que viene de la base también se valida). */
export function isPhotoPath(path: unknown): path is string {
  return typeof path === 'string' && path.length <= 200 && PATH_RE.test(path)
}

/** Caché en memoria path → data URL con tope (LRU simple sobre Map). */
export class PhotoCache {
  private readonly map = new Map<string, string>()
  private readonly max: number

  constructor(max: number) {
    this.max = max
  }

  get(path: string): string | undefined {
    const v = this.map.get(path)
    if (v !== undefined) {
      this.map.delete(path)
      this.map.set(path, v)
    }
    return v
  }

  set(path: string, dataUrl: string): void {
    this.map.delete(path)
    this.map.set(path, dataUrl)
    while (this.map.size > this.max) {
      const first = this.map.keys().next()
      if (first.done) break
      this.map.delete(first.value)
    }
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}

/** Sube la foto a `<teamId>/<uuid>.<ext>` y devuelve la ruta. Tira Error si no se pudo. */
export async function uploadTeamPhoto(client: SupabaseClient, teamId: string, photo: Photo): Promise<string> {
  const path = `${teamId}/${randomUUID()}.${EXT[photo.kind]}`
  const res = await client.storage.from(PHOTO_BUCKET).upload(path, photo.bytes, {
    contentType: MIME[photo.kind],
    upsert: false,
    cacheControl: '3600'
  })
  if (res.error) throw new Error('No se pudo subir la foto.')
  return path
}

/** Borra una foto (best effort: un fallo no es fatal). */
export async function removeTeamPhoto(client: SupabaseClient, path: string): Promise<void> {
  if (!isPhotoPath(path)) return
  await client.storage.from(PHOTO_BUCKET).remove([path]).catch(() => undefined)
}

/** Baja la foto y la devuelve como data: URL. Revalida tipo y tamaño por bytes. */
export async function downloadTeamPhoto(client: SupabaseClient, path: string): Promise<string> {
  if (!isPhotoPath(path)) throw new Error('Ruta de foto inválida.')
  const res = await client.storage.from(PHOTO_BUCKET).download(path)
  if (res.error || !res.data) throw new Error('No se pudo bajar la foto.')
  if (res.data.size > CHAT_LIMITS.photoBytes) throw new Error('La foto pesa demasiado.')
  const bytes = Buffer.from(await res.data.arrayBuffer())
  const kind = sniffPhoto(bytes)
  if (!kind) throw new Error('La foto no es una imagen válida.')
  return `data:${MIME[kind]};base64,${bytes.toString('base64')}`
}

// ---------- foto de perfil (Chat v2): bucket PRIVADO profile-photos, ruta <user_id>/<uuid>.<ext> ----------

export const PROFILE_PHOTO_BUCKET = 'profile-photos'
const PROFILE_PATH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|png|jpg)$/i

/** Ruta válida dentro del bucket de perfiles. */
export function isProfilePhotoPath(path: unknown): path is string {
  return typeof path === 'string' && path.length <= 200 && PROFILE_PATH_RE.test(path)
}

/** Sube la foto propia a `<userId>/<uuid>.<ext>`. La ruta se guarda después con set_profile_photo. */
export async function uploadProfilePhoto(client: SupabaseClient, userId: string, photo: Photo): Promise<string> {
  const path = `${userId}/${randomUUID()}.${EXT[photo.kind]}`
  const res = await client.storage.from(PROFILE_PHOTO_BUCKET).upload(path, photo.bytes, {
    contentType: MIME[photo.kind],
    upsert: false,
    cacheControl: '3600'
  })
  if (res.error) throw new Error('No se pudo subir la foto.')
  return path
}

/** Borra una foto de perfil (best effort). */
export async function removeProfilePhoto(client: SupabaseClient, path: string): Promise<void> {
  if (!isProfilePhotoPath(path)) return
  await client.storage.from(PROFILE_PHOTO_BUCKET).remove([path]).catch(() => undefined)
}

/** Baja la foto de perfil como data: URL. Revalida tamaño y tipo por bytes. */
export async function downloadProfilePhoto(client: SupabaseClient, path: string): Promise<string> {
  if (!isProfilePhotoPath(path)) throw new Error('Ruta de foto inválida.')
  const res = await client.storage.from(PROFILE_PHOTO_BUCKET).download(path)
  if (res.error || !res.data) throw new Error('No se pudo bajar la foto.')
  if (res.data.size > CHAT_LIMITS.photoBytes) throw new Error('La foto pesa demasiado.')
  const bytes = Buffer.from(await res.data.arrayBuffer())
  const kind = sniffPhoto(bytes)
  if (!kind) throw new Error('La foto no es una imagen válida.')
  return `data:${MIME[kind]};base64,${bytes.toString('base64')}`
}
