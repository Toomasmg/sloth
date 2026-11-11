/**
 * Protocolo entre la app (cliente) y el daemon de terminales de Sloth.
 * Transporte: named pipe de Windows, un mensaje JSON por línea ("\n").
 * Este archivo solo tiene tipos y constantes: se puede importar desde cualquier proceso.
 */
import type { PtyChunk, PtyStartResult } from './types'

/** Se sube si cambia el protocolo de forma incompatible (va en el nombre del pipe). */
export const DAEMON_PROTOCOL_VERSION = 1

/** Eventos de Claude Code que llegan por /hook (fire-and-forget). */
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SessionEnd'] as const
export type HookEventName = (typeof HOOK_EVENTS)[number]

export interface HookEventPayload {
  ws: string
  event: HookEventName
  tool?: string
  message?: string
  notificationType?: string
  /** Momento en que lo recibió el servidor de hooks (ms). */
  at?: number
}

/** Pedido de permiso de Claude (hook PermissionRequest) esperando respuesta desde la UI. */
export interface PendingPermission {
  id: string
  ws: string
  tool: string
  input: Record<string, unknown>
  suggestions?: unknown[]
  at: number
  expiresAt: number
}

export interface SpawnSpec {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
}

export interface SessionInfo {
  id: string
  running: boolean
  exitCode?: number
}

// ---------- Cliente -> daemon ----------

export interface HelloMsg {
  t: 'hello'
  token: string
  clientVersion: string
}
export interface StartMsg {
  t: 'start'
  rid: number
  id: string
  spawn: SpawnSpec
}
export interface WriteMsg {
  t: 'write'
  id: string
  data: string
}
export interface ResizeMsg {
  t: 'resize'
  id: string
  cols: number
  rows: number
}
export interface KillMsg {
  t: 'kill'
  rid: number
  id: string
}
export interface ListMsg {
  t: 'list'
  rid: number
}
export interface ShutdownMsg {
  t: 'shutdown'
  rid: number
}
export interface PermissionAnswerMsg {
  t: 'permission-answer'
  reqId: string
  /** Objeto `decision` de Claude Code (ej. {behavior:'allow'}) o null = que pregunte en la terminal. */
  decision: object | null
}

export type ClientMessage =
  | HelloMsg
  | StartMsg
  | WriteMsg
  | ResizeMsg
  | KillMsg
  | ListMsg
  | ShutdownMsg
  | PermissionAnswerMsg

// ---------- Daemon -> cliente ----------

export interface HelloOkMsg {
  t: 'hello-ok'
  version: string
  pid: number
  hookUrl: string
  hookToken: string
  sessions: SessionInfo[]
  lastHookEvents: Record<string, HookEventPayload>
  permissions: PendingPermission[]
  protocol?: number
}
export interface ReplyMsg {
  t: 'reply'
  rid: number
  ok: boolean
  /** start -> PtyStartResult ; list -> SessionInfo[] ; kill/shutdown -> nada. */
  result?: PtyStartResult | SessionInfo[] | null
  error?: string
}
/** Salida agrupada (como mucho un mensaje cada ~16 ms por sesión), seq por chunk. */
export interface DataMsg {
  t: 'data'
  id: string
  chunks: PtyChunk[]
}
export interface ExitMsg {
  t: 'exit'
  id: string
  code: number
}
export interface HookMsg {
  t: 'hook'
  event: HookEventPayload
}
export interface PermissionMsg {
  t: 'permission'
  req: PendingPermission
}
export interface PermissionResolvedMsg {
  t: 'permission-resolved'
  id: string
}

export type DaemonMessage =
  | HelloOkMsg
  | ReplyMsg
  | DataMsg
  | ExitMsg
  | HookMsg
  | PermissionMsg
  | PermissionResolvedMsg
