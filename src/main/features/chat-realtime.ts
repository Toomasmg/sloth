/**
 * Chat (datos): Realtime de Supabase en el proceso main.
 *  - Inbox: UNA conexión lógica «sloth-inbox» con cambios de Postgres (mensajes, canales, perfiles). Supabase
 *    aplica la RLS a cada suscriptor: solo llegan las filas que el usuario puede ver.
 *  - Presencia y «está escribiendo»: canales PRIVADOS por equipo (`team:<id>`) y por DM (`dm:<id>`), sin tablas.
 *    Las políticas chat_rt_* de la migración 0003 dejan entrar solo a miembros del equipo / participantes.
 *    Quien está «invisible» no se anuncia (no hace track). Nunca se manda contenido de mensajes por presencia.
 * Sin timers propios: el reintento lo hace realtime-js.
 */
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import type { ChatConv, ChatPresence, ChatTypingEvent, ChatPresenceEvent } from './chat-model'

export type InboxStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED' | string

export interface InboxHooks {
  /** Fila nueva de `messages` (la que ve el usuario por RLS). */
  onInsert(row: unknown): void
  /** Fila cambiada de `messages` (edición, borrado lógico, fijado, contadores, reacciones). */
  onUpdate(row: unknown): void
  /** Cambió un canal (alta o renombre): hay que recargar las listas. */
  onChannelChange(): void
  /** Cambió un perfil visible (nombre, foto, estado). */
  onProfileChange(row: unknown): void
  onStatus(status: InboxStatus): void
}

/**
 * Abre el canal de la bandeja. Devuelve la función que lo cierra (quita todos los canales del cliente).
 * Es el único canal de cambios de Postgres del proceso main.
 */
export function openInbox(client: SupabaseClient, hooks: InboxHooks): () => Promise<void> {
  client
    .channel('sloth-inbox')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p: { new?: unknown }) => hooks.onInsert(p?.new))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (p: { new?: unknown }) => hooks.onUpdate(p?.new))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'team_channels' }, () => hooks.onChannelChange())
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, (p: { new?: unknown }) => hooks.onProfileChange(p?.new))
    .subscribe((status: InboxStatus) => hooks.onStatus(status))
  return async () => {
    await client.removeAllChannels()
  }
}

// ---------- presencia y «escribiendo» ----------

/** Un tema de realtime: `team:<id>` (presencia del equipo) o `dm:<id>` (solo «escribiendo»). */
export interface TopicSpec {
  topic: string
  /** Estado con el que me anuncio. Sin valor, no me anuncio (p. ej. en DMs). «invisible» tampoco se anuncia. */
  trackAs?: ChatPresence
}

export interface TeamRealtimeHooks {
  onPresence(ev: ChatPresenceEvent): void
  onTyping(ev: ChatTypingEvent): void
}

export interface TeamRealtime {
  /** Deja suscritos exactamente estos temas (agrega los nuevos, quita los que sobran). */
  sync(specs: TopicSpec[]): void
  /** Avisa que estoy escribiendo en una conversación del tema. */
  typing(topic: string, conv: ChatConv): void
  close(): Promise<void>
}

const TEAM_PREFIX = 'team:'

export function teamTopic(teamId: string): string {
  return `${TEAM_PREFIX}${teamId}`
}

export function dmTopic(threadId: string): string {
  return `dm:${threadId}`
}

/** Controlador de presencia y «escribiendo». Una instancia por sesión. */
export function openTeamRealtime(client: SupabaseClient, meId: string, hooks: TeamRealtimeHooks): TeamRealtime {
  const channels = new Map<string, RealtimeChannel>()
  const trackedAs = new Map<string, ChatPresence | undefined>()

  const create = (spec: TopicSpec): RealtimeChannel => {
    const ch = client.channel(spec.topic, { config: { private: true, presence: { key: meId }, broadcast: { self: false } } })
    if (spec.topic.startsWith(TEAM_PREFIX)) {
      const teamId = spec.topic.slice(TEAM_PREFIX.length)
      ch.on('presence', { event: 'sync' }, () => {
        const state = ch.presenceState() as Record<string, Array<{ presence?: unknown }>>
        const people: ChatPresenceEvent['people'] = []
        for (const [userId, metas] of Object.entries(state)) {
          const p = metas[0]?.presence
          const presence: ChatPresence = p === 'ausente' || p === 'no_molestar' ? p : 'disponible'
          people.push({ userId, presence })
        }
        hooks.onPresence({ teamId, people })
      })
    }
    ch.on('broadcast', { event: 'typing' }, (msg: { payload?: unknown }) => {
      const p = msg.payload as { conv?: unknown; userId?: unknown } | undefined
      if (!p || typeof p.userId !== 'string' || !p.conv || typeof p.conv !== 'object') return
      const conv = p.conv as { kind?: unknown; id?: unknown }
      if (typeof conv.id !== 'string' || (conv.kind !== 'channel' && conv.kind !== 'team' && conv.kind !== 'dm')) return
      if (p.userId === meId) return
      hooks.onTyping({ conv: { kind: conv.kind, id: conv.id }, userId: p.userId })
    })
    ch.subscribe((status: string) => {
      const track = trackedAs.get(spec.topic)
      if (status === 'SUBSCRIBED' && track && track !== 'invisible') {
        void ch.track({ presence: track }).catch(() => undefined)
      }
    })
    return ch
  }

  return {
    sync(specs: TopicSpec[]): void {
      const want = new Set(specs.map((s) => s.topic))
      for (const [topic, ch] of channels) {
        if (!want.has(topic)) {
          channels.delete(topic)
          trackedAs.delete(topic)
          void client.removeChannel(ch).catch(() => undefined)
        }
      }
      for (const spec of specs) {
        const prev = trackedAs.get(spec.topic)
        trackedAs.set(spec.topic, spec.trackAs)
        const existing = channels.get(spec.topic)
        if (!existing) {
          channels.set(spec.topic, create(spec))
        } else if (prev !== spec.trackAs) {
          // Cambió mi estado: lo vuelvo a anunciar (o dejo de anunciarme si es invisible).
          if (spec.trackAs && spec.trackAs !== 'invisible') void existing.track({ presence: spec.trackAs }).catch(() => undefined)
          else void existing.untrack().catch(() => undefined)
        }
      }
    },
    typing(topic: string, conv: ChatConv): void {
      const ch = channels.get(topic)
      if (!ch) return
      void ch.send({ type: 'broadcast', event: 'typing', payload: { conv, userId: meId } }).catch(() => undefined)
    },
    async close(): Promise<void> {
      const all = [...channels.values()]
      channels.clear()
      trackedAs.clear()
      await Promise.all(all.map((ch) => client.removeChannel(ch).catch(() => undefined)))
    }
  }
}
