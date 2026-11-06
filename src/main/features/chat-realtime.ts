/**
 * Chat (datos): la ÚNICA conexión realtime de Sloth. Un canal, escucha los INSERT de `messages`;
 * Supabase aplica la RLS a cada suscriptor, así que solo llegan los mensajes que el usuario puede ver.
 * Sin timers propios: el reintento lo hace realtime-js.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export type InboxStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED' | string

export interface InboxHooks {
  /** Fila nueva de `messages` (la que ve el usuario por RLS). */
  onInsert(row: unknown): void
  onStatus(status: InboxStatus): void
}

/**
 * Abre el canal. Devuelve la función que lo cierra (quita todos los canales del cliente).
 * Es el único canal del proceso main.
 */
export function openInbox(client: SupabaseClient, hooks: InboxHooks): () => Promise<void> {
  client
    .channel('sloth-inbox')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload: { new?: unknown }) => {
      hooks.onInsert(payload?.new)
    })
    .subscribe((status: InboxStatus) => hooks.onStatus(status))
  return async () => {
    await client.removeAllChannels()
  }
}
