/**
 * Chat (datos): la ÚNICA conexión realtime de Sloth. «sloth-inbox» escucha los INSERT y UPDATE de `messages`;
 * Supabase aplica la RLS a cada suscriptor, así que solo llegan los mensajes que el usuario puede ver.
 * Eso tarda ~0,5–2 s, así que además hay un canal privado de Broadcast por conversación (mismo socket)
 * que entrega antes; «sloth-inbox» queda de respaldo. Sin timers propios: el reintento lo hace realtime-js.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export type InboxStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED' | string

export interface InboxHooks {
  /** Fila nueva de `messages` (la que ve el usuario por RLS). */
  onInsert(row: unknown): void
  /** Fila editada o borrada de `messages`. */
  onUpdate(row: unknown): void
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
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (payload: { new?: unknown }) => {
      hooks.onUpdate(payload?.new)
    })
    .subscribe((status: InboxStatus) => hooks.onStatus(status))
  return async () => {
    await client.removeAllChannels()
  }
}

/**
 * Canal PRIVADO de Broadcast de una conversación: Realtime chequea la RLS de realtime.messages
 * (migración 0003) una vez al entrar, así cada mensaje llega sin pasar por la base.
 * `events` mapea cada nombre de evento a su handler, que recibe el payload crudo (lo valida quien lo recibe).
 * Devuelve la función que cierra solo este canal.
 */
export function openTopic(
  client: SupabaseClient,
  topic: string,
  events: Record<string, (payload: unknown) => void>,
  onStatus: (status: InboxStatus) => void
): () => Promise<void> {
  let ch = client.channel(topic, { config: { private: true } })
  for (const [event, handler] of Object.entries(events)) {
    ch = ch.on('broadcast', { event }, (msg: { payload?: unknown }) => {
      handler(msg?.payload)
    })
  }
  ch.subscribe((status: InboxStatus) => onStatus(status))
  return async () => {
    await client.removeChannel(ch)
  }
}
