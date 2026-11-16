import type { ChatMcpAsk, ChatMcpGrant, ChatMcpOp } from '../../../../shared/chat-mcp'

export const segundosRestantes = (expiresAt: number, now: number): number => Math.max(0, Math.ceil((expiresAt - now) / 1000))

export const vigentes = (asks: ChatMcpAsk[], now: number): ChatMcpAsk[] => asks.filter((a) => a.expiresAt > now)

const ORDEN: ChatMcpOp[] = ['leer', 'enviar']

export function ordenarGrants(grants: ChatMcpGrant[]): ChatMcpGrant[] {
  return grants
    .map((g) => ({ ...g, ops: ORDEN.filter((o) => g.ops.includes(o)) }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es') || a.conv.id.localeCompare(b.conv.id))
}

export const alternarCuenta = (ids: readonly string[], id: string, on: boolean): string[] =>
  on ? (ids.includes(id) ? [...ids] : [...ids, id]) : ids.filter((x) => x !== id)
