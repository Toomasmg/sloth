import type { FeatureContext } from './context'
import type { ChatAuth, ChatProfile, ChatSnapshot } from '../../shared/chat'

/**
 * Datos del chat (equipos, DMs, mensajes, no leídos, realtime, fotos, avisos). Contrato entre
 * chat.ts (T2: config + login) y este archivo (T8). STUB v0.5: lo completa T8.
 */

/** Lo que chat.ts (T2) le da a la parte de datos. */
export interface ChatCoreHandle {
  /** Cliente de Supabase CON sesión iniciada, o null. Es un SupabaseClient: castealo con `as SupabaseClient`. */
  client(): unknown
  me(): ChatProfile | null
  auth(): ChatAuth
}

export type ChatDataPart = Omit<ChatSnapshot, 'auth'>

export interface ChatData {
  /** Estado actual para armar ChatSnapshot (chat.ts le suma `auth`). */
  part(): ChatDataPart
  /** chat.ts lo llama al quedar con sesión y ventana: carga listas y abre UNA conexión realtime. */
  start(): Promise<void>
  /** Al cerrar sesión, cambiar de config o cerrarse la ventana: cierra realtime y vacía cachés en memoria. */
  stop(): Promise<void>
}

export const EMPTY_PART: ChatDataPart = { connection: 'off', teams: [], threads: [], invites: [], unreadTotal: 0 }

/**
 * Registra los canales de datos (messages, send, markRead, createTeam, … ver shared/chat.ts) con
 * `ctx.handle` y devuelve el controlador. `onChange()` = «recalculá y emití feat:chat:snapshot».
 */
export function registerChatData(_ctx: FeatureContext, _core: ChatCoreHandle, _onChange: () => void): ChatData {
  return {
    part: () => EMPTY_PART,
    start: async () => {},
    stop: async () => {}
  }
}
