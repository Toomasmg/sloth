/**
 * Chat por Claude: un MCP propio (`sloth`) con el que Claude lee y manda mensajes del chat de Sloth.
 * El script MCP habla con el main por un pipe local. Cada cuenta habilitada tiene su token (llega al script
 * por el env de su registro): el main deriva la cuenta del token. Supabase lo usa solo el main.
 *
 * Canales (feat:chat:<op>):
 *   mcpConfig()                              → ChatMcpView
 *   mcpSetEnabled(on: boolean)               → ChatMcpView
 *   mcpSetAccounts(ids: string[])            → ChatMcpView   (cuentas donde se registra el MCP)
 *   mcpRevoke(accountId: string, convKey: string) → ChatMcpView
 *   mcpRevokeAll()                           → ChatMcpView
 *   mcpPending()                             → ChatMcpAsk[]
 *   mcpAnswer(id: string, choice: ChatMcpChoice) → void
 * Eventos: «mcpAsks» (ChatMcpAsk[]) cuando cambian los pedidos pendientes; «mcpConfig» (ChatMcpView)
 * cuando cambia la config o el estado del registro en las cuentas.
 */
import type { ChatConvRef } from './chat'

export type ChatMcpOp = 'leer' | 'enviar'
/** «always» solo vale para leer: enviar se confirma siempre viendo el texto. */
export type ChatMcpChoice = 'once' | 'always' | 'deny'

/** Permiso permanente de leer una conversación desde una cuenta. */
export interface ChatMcpGrant {
  accountId: string
  conv: ChatConvRef
  nombre: string
  at: number
}

export type ChatMcpRegState = 'revisando' | 'ok' | 'pendiente' | 'conflicto' | 'sin-node' | 'sin-cli' | 'error'

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
  /** Cuenta que pide: sale del token, es lo único verificado del origen. */
  account: string
  /** Espacio que dice la terminal (SLOTH_WS): no verificado, y solo si es de esa cuenta. */
  workspace?: string
  /** Solo en 'enviar': el texto que escribió Claude y se mandaría (ya validado). */
  preview?: string
  expiresAt: number
}

export const VIA_CLAUDE_PREFIX = '[vía Claude] '
