/**
 * Chat v2 (Sloth 0.6): tipos de la API nueva `feat:chat:<op>` y de los eventos. Son el contrato con la
 * interfaz (paquete 11). Viven acá, y no en src/shared/chat.ts, porque ese archivo es del integrador: al
 * integrar, moverlos a shared/chat.ts (ver docs/chat-supabase.md, «Contrato IPC v2»).
 *
 * Solo tipos y constantes: sin Electron ni red.
 */
import type { ChatMessageStatus, ChatProfile, ChatRole } from '../../shared/chat'

/** Conversación. «team» es el alias de 0.5: se resuelve al canal general del equipo. */
export type ChatConv = { kind: 'channel' | 'team' | 'dm'; id: string }

export const CHAT_COLORS = ['blue', 'green', 'coral', 'amber', 'lila', 'gris'] as const
export type ChatColor = (typeof CHAT_COLORS)[number]

/** disponible · ausente · no molestar · invisible (no se muestra en línea a nadie). */
export const CHAT_PRESENCE = ['disponible', 'ausente', 'no_molestar', 'invisible'] as const
export type ChatPresence = (typeof CHAT_PRESENCE)[number]

export const CHAT_REACTIONS = ['visto', 'aprobado', 'mesumo', 'importante', 'idea', 'gracias'] as const
export type ChatReactionKind = (typeof CHAT_REACTIONS)[number]

export const CHAT_MESSAGE_KINDS = ['text', 'file', 'code', 'ticket', 'space', 'pr'] as const
export type ChatMessageKind = (typeof CHAT_MESSAGE_KINDS)[number]

/** Tarjetas: se guardan en messages.payload (jsonb) y la base valida sus claves y formatos. */
export type ChatCard =
  | { kind: 'code'; code: string; lang?: string }
  | { kind: 'ticket'; id: string; title: string; state?: string }
  | { kind: 'space'; name: string; sub?: string; st?: string }
  | { kind: 'pr'; url: string; repo?: string; prKind?: string; num?: string; title?: string; st?: string; chk?: string }

export const CHAT_LIMITS_V2 = {
  body: 4000,
  channelName: 40,
  channelTopic: 200,
  channelDescription: 500,
  displayName: 60,
  handle: 30,
  statusText: 100,
  roleTitle: 60,
  timezone: 64,
  /** Adjunto: tope de la base y del bucket chat-files. */
  fileBytes: 10 * 1024 * 1024,
  fileName: 255,
  /** Foto de perfil: igual que la de equipo. */
  photoBytes: 512 * 1024,
  quoteChars: 140
} as const

export interface ChatChannel {
  id: string
  teamId: string
  name: string
  topic: string
  description: string
  isDefault: boolean
  unread: number
  muted: boolean
  lastMessageAt?: number
  createdAt: number
}

export interface ChatChannelInput {
  name: string
  topic?: string
  description?: string
}

/** Persona con datos de perfil (la lista de equipo, perfiles, presencia). */
export interface ChatPerson {
  id: string
  /** Usuario de GitHub (login, sin @). */
  login: string
  /** @usuario editable de Sloth (^[a-z0-9-]{3,30}$). */
  handle: string
  displayName?: string
  /** Nombre de GitHub. */
  name?: string
  avatarUrl?: string
  /** data:image/... de la foto de perfil (la descarga main; el bucket es privado). */
  photo?: string
  color: ChatColor
  presence: ChatPresence
  statusText?: string
  /** ms epoch; pasado el vencimiento, la interfaz no muestra el estado. */
  statusUntil?: number
  roleTitle?: string
  /** IANA, p. ej. America/Argentina/Buenos_Aires. */
  timezone: string
}

export interface ChatProfilePatch {
  displayName?: string
  handle?: string
  color?: ChatColor
  presence?: ChatPresence
  statusText?: string
  /** null = borrar el vencimiento. */
  statusUntil?: number | null
  roleTitle?: string
  timezone?: string
}

export interface ChatTeamPerson extends ChatPerson {
  role: ChatRole
  joinedAt: number
}

export interface ChatFileRef {
  /** Ruta en el bucket chat-files: <team_id>/<uuid> o dm/<thread_id>/<uuid>. */
  path: string
  name: string
  size: number
  mime: string
}

export interface ChatFile extends ChatFileRef {
  id: string
  messageId: string
  createdAt: number
}

export interface ChatFileUpload {
  name: string
  mime?: string
  /** base64 SIN prefijo data:. */
  base64: string
}

export interface ChatReaction {
  kind: ChatReactionKind
  userIds: string[]
}

export interface ChatQuote {
  id: string
  authorId: string
  /** Primera línea, recortada; «Mensaje borrado» se indica con deleted. */
  text: string
  deleted: boolean
}

export interface ChatMessageFull {
  id: string
  clientId: string
  conv: ChatConv
  author: ChatProfile
  authorId: string
  /** Vacío si el mensaje está borrado. */
  body: string
  createdAt: number
  status: ChatMessageStatus
  kind: ChatMessageKind
  card?: ChatCard
  replyTo?: ChatQuote
  threadRoot?: string
  replyCount: number
  lastReplyAt?: number
  editedAt?: number
  deletedAt?: number
  pinnedAt?: number
  pinnedBy?: string
  reactions: ChatReaction[]
  files: ChatFile[]
}

export interface ChatSendInput {
  conv: ChatConv
  clientId: string
  body?: string
  card?: ChatCard
  replyTo?: string
  threadRoot?: string
  files?: ChatFileRef[]
}

export interface ChatReadMark {
  userId: string
  lastReadAt: number
}

/** Evento `feat:chat:typing`. */
export interface ChatTypingEvent {
  conv: ChatConv
  userId: string
}

/** Evento `feat:chat:presence`: quién está conectado en el equipo y con qué estado. */
export interface ChatPresenceEvent {
  teamId: string
  people: Array<{ userId: string; presence: ChatPresence }>
}

/**
 * Evento INTERNO de main (no va a la interfaz): mensaje nuevo de otra persona, para el aviso de Windows
 * y el permiso de menciones. Se emite siempre (con la ventana en cualquier estado); `muted` dice si esa
 * conversación está silenciada para el usuario.
 */
export interface ChatNoticeEvent {
  teamId: string | null
  conversationId: string
  from: string
  preview: string
  mentionsMe: boolean
  muted: boolean
}

export const convKeyV2 = (c: ChatConv): string => `${c.kind}:${c.id}`
