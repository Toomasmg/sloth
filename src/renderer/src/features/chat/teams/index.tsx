import type { ChatInvite, ChatTeam, ChatThread } from '../../../../../shared/chat'

/**
 * Piezas de equipos del chat (T10). Las monta el drawer de chat (T9). STUBS v0.5: no cambiar las props.
 * Todas son modales o paneles dentro del drawer; Escape cierra; usan useUi().invoke('feat:chat:…').
 */

/** Crear (sin `team`) o editar (con `team`, solo owner/admin) nombre, descripción y foto (con recorte). */
export function TeamEditor(_props: { team?: ChatTeam; onClose(): void; onSaved(team: ChatTeam): void }): React.JSX.Element | null {
  return null
}

/** Invitar por usuario de GitHub y mostrar/copiar/regenerar el código (owner/admin). */
export function InviteDialog(_props: { team: ChatTeam; onClose(): void }): React.JSX.Element | null {
  return null
}

/** Entrar a un equipo con un código. */
export function JoinByCode(_props: { onClose(): void; onJoined(team: ChatTeam): void }): React.JSX.Element | null {
  return null
}

/** Invitaciones pendientes (aceptar / rechazar). Se muestra arriba de la lista si hay. */
export function InvitesList(_props: { invites: ChatInvite[]; onJoined(team: ChatTeam): void }): React.JSX.Element | null {
  return null
}

/** Miembros del equipo: avatar, login, rol; «Escribirle» abre DM; owner/admin pueden sacar members; «Salir del equipo». */
export function MembersPanel(_props: { team: ChatTeam; onClose(): void; onOpenDm(thread: ChatThread): void; onLeft(): void }): React.JSX.Element | null {
  return null
}
