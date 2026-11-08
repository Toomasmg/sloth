import type { AgentStatus, PermissionPrompt } from '../../../../shared/types'

/**
 * Estado de un espacio para la interfaz de Enviar y de Tickets, a partir de lo que manda main:
 * `agents` (estado de la terminal) y `permissions` (pedidos de permiso pendientes).
 */
export type SpaceStatus = 'perm' | 'working' | 'waiting' | 'done' | 'idle' | 'closed'

export function spaceStatus(
  wsId: string,
  agents: Record<string, AgentStatus>,
  permissions: PermissionPrompt[]
): SpaceStatus {
  if (permissions.some((p) => p.workspaceId === wsId)) return 'perm'
  const a = agents[wsId]
  if (a?.state === 'exited') return 'closed'
  if (!a || a.state === 'idle') return 'idle'
  return a.state
}

/** Texto del estado (lo que se ve). «closed» = la terminal ya no está: en pausa. */
export const SPACE_LABEL: Record<SpaceStatus, string> = {
  perm: 'Pide permiso',
  working: 'Trabajando',
  waiting: 'Te espera',
  done: 'Listo',
  idle: 'Listo',
  closed: 'En pausa'
}

/** Clase de chip (color + ícono + texto: nunca solo color). Ver styles.css. */
export const SPACE_CHIP: Record<SpaceStatus, string> = {
  perm: 'chip-perm',
  working: 'chip-working',
  waiting: 'chip-waiting',
  done: 'chip-done',
  idle: 'chip-done',
  closed: 'chip-idle'
}

/** Se le puede mandar un mensaje ahora (o en cola si está trabajando). */
export const canReceive = (s: SpaceStatus): boolean => s !== 'perm' && s !== 'closed'

/** Está libre para recibir: lo que está en cola se manda cuando pasa a esto. */
export const isReady = (s: SpaceStatus): boolean => s === 'waiting' || s === 'done' || s === 'idle'
