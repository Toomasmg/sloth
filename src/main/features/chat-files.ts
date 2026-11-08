/**
 * Chat v2: adjuntos en el bucket PRIVADO `chat-files` (≤ 10 MB). Ruta: `<team_id>/<uuid>` para canales y
 * `dm/<thread_id>/<uuid>` para mensajes directos (las políticas de la migración 0003 se fijan en eso).
 * Nunca se loguean nombres completos ni contenido.
 */
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatFileRef } from './chat-model'
import { CHAT_LIMITS_V2 } from './chat-model'

export const CHAT_FILES_BUCKET = 'chat-files'

const PATH_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/|dm\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Ruta válida dentro del bucket (la que llega de la UI también se valida). */
export function isChatFilePath(path: unknown): path is string {
  return typeof path === 'string' && path.length <= 300 && PATH_RE.test(path)
}

/**
 * Sube el archivo y devuelve la referencia. `prefix` es `<team_id>` o `dm/<thread_id>`.
 * Si la subida falla, tira Error en español (sin detalles del servidor).
 */
export async function uploadChatFile(
  client: SupabaseClient,
  prefix: string,
  file: { name: string; mime: string; bytes: Buffer }
): Promise<ChatFileRef> {
  const path = `${prefix}/${randomUUID()}`
  if (!isChatFilePath(path)) throw new Error('No se pudo preparar el adjunto.')
  const res = await client.storage.from(CHAT_FILES_BUCKET).upload(path, file.bytes, {
    contentType: file.mime,
    upsert: false,
    cacheControl: '3600'
  })
  if (res.error) throw new Error('No se pudo subir el adjunto.')
  return { path, name: file.name, size: file.bytes.length, mime: file.mime }
}

/** Baja un adjunto (para guardarlo). Revalida ruta y tamaño. */
export async function downloadChatFile(client: SupabaseClient, path: string): Promise<Buffer> {
  if (!isChatFilePath(path)) throw new Error('Ruta de adjunto inválida.')
  const res = await client.storage.from(CHAT_FILES_BUCKET).download(path)
  if (res.error || !res.data) throw new Error('No se pudo bajar el adjunto.')
  if (res.data.size > CHAT_LIMITS_V2.fileBytes) throw new Error('El adjunto pesa demasiado.')
  return Buffer.from(await res.data.arrayBuffer())
}

/** Borra objetos del bucket (best effort; lo llama la app DESPUÉS del borrado lógico del mensaje). */
export async function removeChatFiles(client: SupabaseClient, paths: string[]): Promise<void> {
  const valid = paths.filter(isChatFilePath)
  if (valid.length === 0) return
  await client.storage.from(CHAT_FILES_BUCKET).remove(valid).catch(() => undefined)
}
