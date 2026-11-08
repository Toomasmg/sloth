import type { PermissionAnswer, PermissionPrompt } from '../../../../shared/types'
import type { DecisionEntry } from '../../../../main/features/permissions'
import type { PermissionRule } from '../../../../main/features/permissions-core'

/**
 * Canal de la función «permissions» hacia main. Todas las respuestas a un pedido pasan por acá:
 * así «Permitir siempre» guarda la regla del espacio y la decisión queda en el historial.
 */

export interface PermissionsList {
  dnd: boolean
  /** «No molestar» también puede venir de la Configuración (ajuste `noMolestar`). */
  dndFromSettings: boolean
  rules: PermissionRule[]
  /** Decisiones de hoy, la más nueva primero. */
  history: DecisionEntry[]
  spaces: Record<string, { name: string; cwd: string; accountId: string }>
}

const invoke = <T = unknown>(op: string, ...args: unknown[]): Promise<T> => window.sloth.feat.invoke<T>(`feat:permissions:${op}`, ...args)

/** Responde a un pedido de permiso (allow, allowAlways = regla del espacio, deny, terminal). */
export function decidePermission(p: PermissionPrompt, answer: PermissionAnswer, message?: string): Promise<void> {
  return invoke<void>('decide', { id: p.id, answer, message })
}

/**
 * «Rechazar y decirle algo a Claude»: rechaza y escribe el texto en la terminal de ese espacio,
 * para que Claude lo lea como si el usuario lo hubiera escrito ahí.
 */
export async function rejectAndTell(p: PermissionPrompt, text: string): Promise<void> {
  const t = text.trim()
  await decidePermission(p, 'deny')
  if (t) window.sloth.ptyWrite(p.workspaceId, `${t}\r`)
}

export const listPermissions = (): Promise<PermissionsList> => invoke<PermissionsList>('list')
export const setRule = (id: string, on: boolean): Promise<void> => invoke<void>('rule:set', id, on)
export const removeRule = (id: string): Promise<void> => invoke<void>('rule:remove', id)
export const undoDecision = (entryId: string): Promise<void> => invoke<void>('undo', entryId)
export const setDnd = (on: boolean): Promise<void> => invoke<void>('dnd', on)
/** Espacio que la UI tiene en pantalla (null si ninguno): así no se avisa de lo que ya se ve. */
export const setFocusedSpace = (wsId: string | null): Promise<void> => invoke<void>('focus', wsId)
