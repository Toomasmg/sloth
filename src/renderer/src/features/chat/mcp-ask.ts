import type { ChatMcpAsk, ChatMcpGrant } from '../../../../shared/chat-mcp'

export const segundosRestantes = (expiresAt: number, now: number): number => Math.max(0, Math.ceil((expiresAt - now) / 1000))

export const vigentes = (asks: ChatMcpAsk[], now: number): ChatMcpAsk[] => asks.filter((a) => a.expiresAt > now)

export const ordenarGrants = (grants: ChatMcpGrant[]): ChatMcpGrant[] =>
  [...grants].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es') || a.accountId.localeCompare(b.accountId) || a.conv.id.localeCompare(b.conv.id))

export const alternarCuenta = (ids: readonly string[], id: string, on: boolean): string[] =>
  on ? (ids.includes(id) ? [...ids] : [...ids, id]) : ids.filter((x) => x !== id)
