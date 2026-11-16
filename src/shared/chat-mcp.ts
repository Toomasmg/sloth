/**
 * Chat por Claude: un MCP propio (`sloth`) con el que Claude lee y manda mensajes del chat de Sloth.
 * El script MCP habla con el main por un pipe local autenticado con un token; Supabase lo usa solo el main.
 *
 * Canales (feat:chat:<op>):
 *   mcpConfig()                              → ChatMcpView
 *   mcpSetEnabled(on: boolean)               → ChatMcpView
 *   mcpSetAccounts(ids: string[])            → ChatMcpView   (cuentas donde se registra el MCP)
 *   mcpRevoke(convKey: string, op?: ChatMcpOp) → ChatMcpView   (sin op, saca el permiso entero)
 *   mcpRevokeAll()                           → ChatMcpView
 *   mcpPending()                             → ChatMcpAsk[]
 *   mcpAnswer(id: string, choice: ChatMcpChoice) → void
 * Eventos: «mcpAsks» (ChatMcpAsk[]) cuando cambian los pedidos pendientes; «mcpConfig» (ChatMcpView)
 * cuando cambia la config o el estado del registro en las cuentas.
 */
import type { ChatConvRef } from './chat'

export type ChatMcpOp = 'leer' | 'enviar'
export type ChatMcpChoice = 'once' | 'always' | 'deny'

export interface ChatMcpGrant {
  conv: ChatConvRef
  nombre: string
  ops: ChatMcpOp[]
  at: number
}

export type ChatMcpRegState = 'ok' | 'pendiente' | 'conflicto' | 'sin-node' | 'error'

export interface ChatMcpAccountReg {
  accountId: string
  label: string
  state: ChatMcpRegState
  detail?: string
}

export interface ChatMcpView {
  enabled: boolean
  /** Ids de las cuentas elegidas (solo las que existen). Con el interruptor prendido, el MCP va solo en estas. */
  cuentas: string[]
  grants: ChatMcpGrant[]
  limits: { enviarPorMinuto: number; leerPorMinuto: number; maxTexto: number; maxLeer: number }
  accounts: ChatMcpAccountReg[]
  /** El servidor tiene la 0005: la marca va en columna; si no, como prefijo en el texto. */
  viaColumn: boolean
}

export interface ChatMcpAsk {
  id: string
  op: ChatMcpOp
  conv: ChatConvRef
  nombre: string
  /** Nombre del espacio que pide, o 'una terminal fuera de Sloth'. */
  workspace: string
  account?: string
  /** Solo en 'enviar': el texto que se mandaría (ya validado). */
  preview?: string
  expiresAt: number
}

export const VIA_CLAUDE_PREFIX = '[vía Claude] '
