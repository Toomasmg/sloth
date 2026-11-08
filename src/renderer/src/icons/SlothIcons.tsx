// Generado desde Iconos.dc.html (grilla 24, trazo 1,6, puntas y uniones redondeadas).
// Nodos: círculos rellenos en currentColor. Color = currentColor (lo pone el CSS del contenedor).
import type { ComponentType, ReactNode } from 'react'

export interface SlothIconProps {
  /** Lado en px. Por defecto 16. */
  size?: number
  /** Grosor del trazo en la grilla de 24. Por defecto 1.6 (el del diseño). */
  strokeWidth?: number
  className?: string
  /** Si se pasa, el ícono es una imagen con nombre accesible; si no, se oculta a lectores de pantalla. */
  title?: string
}

function Base({
  size = 16,
  strokeWidth = 1.6,
  className,
  title,
  children
}: SlothIconProps & { children: ReactNode }) {
  const labelled = Boolean(title)
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={labelled ? 'img' : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
      style={{ flex: 'none' }}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  )
}

/** Trabajando */
export function WorkingIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M12 4a8 8 0 1 1-8 8" />
      <circle cx="4" cy="12" r="1.9" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </Base>
  )
}

/** Te espera */
export function WaitingIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M4 12a8 8 0 1 0 16 0a8 8 0 1 0 -16 0" />
      <path d="M12 8v4l2.5 2.5" />
    </Base>
  )
}

/** Pide permiso */
export function PermissionIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M12 3.5l7 3v5c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9v-5z" />
      <path d="M12 8.5v4" />
      <circle cx="12" cy="15.5" r="1.1" fill="currentColor" stroke="none" />
    </Base>
  )
}

/** Listo */
export function DoneIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M4 12a8 8 0 1 0 16 0a8 8 0 1 0 -16 0" />
      <path d="M8.5 12.2l2.4 2.4 4.8-5" />
    </Base>
  )
}

/** Error */
export function ErrorIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M8.7 3.5h6.6l4.7 4.7v6.6l-4.7 4.7H8.7L4 14.8V8.2z" />
      <path d="M9.5 9.5l5 5M14.5 9.5l-5 5" />
    </Base>
  )
}

/** En pausa */
export function IdleIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M19 14.5A7.5 7.5 0 1 1 9.5 5a6 6 0 0 0 9.5 9.5z" />
      <path d="M14.5 4h3l-3 3.5h3" />
    </Base>
  )
}

/** Sloth */
export function SlothMarkIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M3 6.5c5 1.5 12 1.5 18-1" />
      <path d="M10 7.2v4.5M16 6.6v6" />
      <path d="M10.6 11.4c2-1 5.4-.5 6.9 2 1 2 .3 4.7-2.5 5.5-2.5.7-5 0-6.4-1.8" />
      <path d="M4.8 13.6a3.2 3.2 0 1 0 6.4 0a3.2 3.2 0 1 0 -6.4 0" />
      <path d="M6.7 13.6q.6.5 1.2 0M8.6 13.6q.6.5 1.2 0" />
      <circle cx="3" cy="6.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="21" cy="5.5" r="1.4" fill="currentColor" stroke="none" />
    </Base>
  )
}

/** Espacio */
export function SpaceIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M4 7a1.5 1.5 0 0 1 1.5-1.5h13A1.5 1.5 0 0 1 20 7v10a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17z" />
      <path d="M7.5 10l2.5 2.5-2.5 2.5" />
      <path d="M12.5 15h4" />
    </Base>
  )
}

/** Nuevo espacio */
export function NewSpaceIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M20 11V7a1.5 1.5 0 0 0-1.5-1.5h-13A1.5 1.5 0 0 0 4 7v10a1.5 1.5 0 0 0 1.5 1.5H12" />
      <path d="M7.5 9.5l2.5 2.5-2.5 2.5" />
      <path d="M18 15v6M15 18h6" />
    </Base>
  )
}

/** Carpeta */
export function FolderIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M3.5 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </Base>
  )
}

/** Soltar carpeta */
export function DropFolderIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M3.5 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
      <path d="M12 10v5.5M9.8 13.3l2.2 2.2 2.2-2.2" />
    </Base>
  )
}

/** Un panel */
export function OnePaneIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M4 7a1.5 1.5 0 0 1 1.5-1.5h13A1.5 1.5 0 0 1 20 7v10a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17z" />
    </Base>
  )
}

/** Dos paneles */
export function TwoPanesIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M4 7a1.5 1.5 0 0 1 1.5-1.5h13A1.5 1.5 0 0 1 20 7v10a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17z" />
      <path d="M12 5.5v13" />
    </Base>
  )
}

/** Cuatro paneles */
export function FourPanesIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M4 7a1.5 1.5 0 0 1 1.5-1.5h13A1.5 1.5 0 0 1 20 7v10a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17z" />
      <path d="M12 5.5v13M4 12h16" />
    </Base>
  )
}

/** Maximizar */
export function MaximizeIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5" />
    </Base>
  )
}

/** Barra lateral */
export function SidebarIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M4 7a1.5 1.5 0 0 1 1.5-1.5h13A1.5 1.5 0 0 1 20 7v10a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17z" />
      <path d="M9.5 5.5v13" />
    </Base>
  )
}

/** Abrir en editor */
export function EditorIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M4 7a1.5 1.5 0 0 1 1.5-1.5h13A1.5 1.5 0 0 1 20 7v10a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17z" />
      <path d="M10 9.5L7.5 12l2.5 2.5M14 9.5l2.5 2.5-2.5 2.5" />
    </Base>
  )
}

/** Enviar a todos */
export function BroadcastIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M7.5 12H18M7.5 11l10-5.5M7.5 13l10 5.5" />
      <circle cx="5.5" cy="12" r="2" fill="currentColor" stroke="none" />
      <circle cx="19.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="19" cy="4.8" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="19" cy="19.2" r="1.6" fill="currentColor" stroke="none" />
    </Base>
  )
}

/** Más */
export function MoreIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <circle cx="6" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </Base>
  )
}

/** Cuenta */
export function AccountIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M8.5 9a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0 -7 0" />
      <path d="M5 19.5c1.2-3 3.9-4.5 7-4.5s5.8 1.5 7 4.5" />
    </Base>
  )
}

/** Agregar cuenta */
export function AddAccountIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M6.5 9a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0 -7 0" />
      <path d="M3.5 19.5c1.1-3 3.6-4.5 6.5-4.5 1.3 0 2.5.3 3.5.8" />
      <path d="M18 13.5v6M15 16.5h6" />
    </Base>
  )
}

/** Mover a otra cuenta */
export function MoveAccountIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M3 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0" />
      <path d="M16 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0" />
      <path d="M9 10h6M13.5 8.5L15 10l-1.5 1.5" />
      <path d="M15 14H9M10.5 12.5L9 14l1.5 1.5" />
    </Base>
  )
}

/** Equipo */
export function TeamIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M6 8.5a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />
      <path d="M3.5 19c.8-2.8 2.8-4.3 5.5-4.3s4.7 1.5 5.5 4.3" />
      <path d="M14 9.5a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0" />
      <path d="M15.5 14.8c2.2 0 4 1.3 4.8 3.7" />
    </Base>
  )
}

/** Chat */
export function ChatIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v6.5a3 3 0 0 1-3 3h-6l-4.5 3.5v-3.5A3 3 0 0 1 4 13.5z" />
      <circle cx="9" cy="10.25" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="10.25" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="10.25" r="1" fill="currentColor" stroke="none" />
    </Base>
  )
}

/** Hilo */
export function ThreadIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M4 6a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H9l-3 2.5V12a2 2 0 0 1-2-2z" />
      <path d="M11 15v1.5a2 2 0 0 0 2 2h4.5" />
      <path d="M16 16.5l2 2-2 2" />
    </Base>
  )
}

/** Mención */
export function MentionIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0zM15.5 12v1.3a2.6 2.6 0 0 0 5.2 0V12a8.7 8.7 0 1 0-3.4 6.9" />
    </Base>
  )
}

/** Reaccionar */
export function ReactIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M4 12a8 8 0 1 0 16 0a8 8 0 1 0 -16 0" />
      <path d="M8.8 14a4 4 0 0 0 6.4 0" />
      <circle cx="9.5" cy="10" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="10" r="1" fill="currentColor" stroke="none" />
    </Base>
  )
}

/** Fijar */
export function PinIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M9 3.5h6l-.8 5.5 3.3 3.3H6.5L9.8 9z" />
      <path d="M12 12.3v8.2" />
    </Base>
  )
}

/** Invitación */
export function InviteIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-.8.8" />
      <path d="M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l.8-.8" />
    </Base>
  )
}

/** Rama */
export function BranchIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M7 4v16" />
      <path d="M7 15c0-4 3-5.5 7-6" />
      <path d="M14 9c1.5-2.5 4-3.5 6.5-3.5-.3 2.6-1.8 4.6-4.4 5.2-1 .2-1.6-.6-2.1-1.7z" />
      <circle cx="7" cy="4" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="7" cy="20" r="1.7" fill="currentColor" stroke="none" />
    </Base>
  )
}

/** Commit */
export function CommitIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M3 12h5.5M15.5 12H21" />
      <path d="M8.5 12a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0 -7 0" />
    </Base>
  )
}

/** Pull request */
export function PullRequestIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M4.5 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
      <path d="M6.5 8v8" />
      <path d="M4.5 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
      <path d="M15.5 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
      <path d="M17.5 16V9.5A2.5 2.5 0 0 0 15 7h-4" />
      <path d="M13 5l-2 2 2 2" />
    </Base>
  )
}

/** Cambios */
export function ChangesIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M6 3.5h8l4 4v13H6z" />
      <path d="M14 3.5v4h4" />
      <path d="M12 9.5v5M9.5 12h5" />
      <path d="M9.5 17h5" />
    </Base>
  )
}

/** Historial */
export function HistoryIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
      <path d="M4 4.5v3.2h3.2" />
      <path d="M12 8.5V12l2.5 1.5" />
    </Base>
  )
}

/** Rama aparte */
export function WorktreeIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M6 4v16" />
      <path d="M6 8c0 3.5 3 5 7 5" />
      <path d="M13 13v7" />
      <circle cx="6" cy="4" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="6" cy="20" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="13" cy="20" r="1.7" fill="currentColor" stroke="none" />
    </Base>
  )
}

/** Plantillas */
export function TemplatesIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M7.5 8a2 2 0 0 1 2-2H18a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H9.5a2 2 0 0 1-2-2z" />
      <path d="M4.5 15V6a2.5 2.5 0 0 1 2.5-2.5h8.5" />
      <path d="M10.5 10.5h6.5M10.5 14h4" />
    </Base>
  )
}

/** Ticket */
export function TicketIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5V10a2 2 0 0 0 0 4v2.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5V14a2 2 0 0 0 0-4z" />
      <path d="M14.5 6.5V8M14.5 11.25v1.5M14.5 16v1.5" />
    </Base>
  )
}

/** Reporte */
export function ReportIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M5.5 4.5h13a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z" />
      <path d="M9 16v-3M12 16V9M15 16v-5" />
    </Base>
  )
}

/** Buscar */
export function SearchIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M4.5 10.5a6 6 0 1 0 12 0a6 6 0 1 0 -12 0" />
      <path d="M15 15l5 5" />
    </Base>
  )
}

/** Ojo (leer o ver sin cambiar nada) */
export function EyeIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z" />
      <path d="M12 9.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 1 0 0-4.4z" />
    </Base>
  )
}

/** Paleta de comandos */
export function PaletteIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M3.5 7A2.5 2.5 0 0 1 6 4.5h12A2.5 2.5 0 0 1 20.5 7v10a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 17z" />
      <path d="M8 11.5a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />
      <path d="M13.2 13.7l2.3 2.3" />
    </Base>
  )
}

/** Configuración */
export function SettingsIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M4 6h9M17 6h3" />
      <path d="M4 12h3M11 12h9" />
      <path d="M4 18h11M19 18h1" />
      <path d="M13 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
      <path d="M7 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
      <path d="M15 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
    </Base>
  )
}

/** Notificaciones */
export function BellIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </Base>
  )
}

/** Actualizar */
export function UpdateIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M19.5 12a7.5 7.5 0 0 1-13 5.1" />
      <path d="M4.5 12a7.5 7.5 0 0 1 13-5.1" />
      <path d="M17.5 3.5v3.4h-3.4" />
      <path d="M6.5 20.5v-3.4h3.4" />
    </Base>
  )
}

/** Ayuda */
export function HelpIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M4 12a8 8 0 1 0 16 0a8 8 0 1 0 -16 0" />
      <path d="M9.6 9.5a2.5 2.5 0 0 1 4.8.8c0 1.7-2.4 2.1-2.4 3.7" />
      <circle cx="12" cy="17" r="1" fill="currentColor" stroke="none" />
    </Base>
  )
}

/** Exportar */
export function ExportIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M12 3.5v11M8 7.5l4-4 4 4" />
      <path d="M4.5 14v4a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4" />
    </Base>
  )
}

/** Atajos */
export function KeyboardIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 18H5a1.5 1.5 0 0 1-1.5-1.5z" />
      <path d="M8 14.5h8" />
      <circle cx="7" cy="10" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10.3" cy="10" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="13.7" cy="10" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="17" cy="10" r="0.9" fill="currentColor" stroke="none" />
    </Base>
  )
}

/** Tema */
export function ThemeIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M4 12a8 8 0 1 0 16 0a8 8 0 1 0 -16 0" />
      <path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor" stroke="none" />
    </Base>
  )
}

/** Sonido */
export function SoundIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M4 9.5h3l4-3.5v12l-4-3.5H4z" />
      <path d="M15 9a4 4 0 0 1 0 6M17.5 6.5a7.5 7.5 0 0 1 0 11" />
    </Base>
  )
}

/** Cerrar */
export function CloseIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Base>
  )
}

/** Copiar */
export function CopyIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.2" />
      <path d="M15.5 8.5V6.2a2 2 0 0 0-2-2H6.2a2 2 0 0 0-2 2v7.3a2 2 0 0 0 2 2h2.3" />
    </Base>
  )
}

/** Editar */
export function PencilIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M4 20l1-4.5L15.5 5a2.1 2.1 0 0 1 3 3L8 18.5z" />
      <path d="M13.5 7l3 3" />
    </Base>
  )
}

/** Borrar */
export function TrashIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M4 7h16M9.5 7V4.8h5V7M6.2 7l.9 12.2h9.8L17.8 7" />
      <path d="M10.2 11v5.2M13.8 11v5.2" />
    </Base>
  )
}

/** Agregar */
export function PlusIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M12 5v14M5 12h14" />
    </Base>
  )
}

/** Desplegar hacia abajo */
export function ChevronDownIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M6 9.5l6 6 6-6" />
    </Base>
  )
}

/** Desplegar hacia la derecha */
export function ChevronRightIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M9.5 6l6 6-6 6" />
    </Base>
  )
}

/** Atrás */
export function ArrowLeftIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </Base>
  )
}

/** Adelante */
export function ArrowRightIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </Base>
  )
}

/** Atención / cuidado */
export function WarningIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M12 4.2l8.6 15.1H3.4z" />
      <path d="M12 10v3.8" />
      <circle cx="12" cy="16.9" r="0.6" fill="currentColor" stroke="none" />
    </Base>
  )
}

/** Listo / marcado */
export function CheckIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Base>
  )
}

/** Reproducir */
export function PlayIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M8 5.5v13l10.5-6.5z" />
    </Base>
  )
}

/** Pausa */
export function PauseIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M8.5 5.5v13M15.5 5.5v13" />
    </Base>
  )
}

/** Actualizar / volver a leer */
export function RefreshIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.5 4.5v4.6h-4.6" />
    </Base>
  )
}

/** Arrastrar para reordenar */
export function GripIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      {[6, 12, 18].flatMap((y) => [9, 15].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.3" fill="currentColor" stroke="none" />))}
    </Base>
  )
}

/** Restaurar (deshacer / volver atrás en una acción) */
export function RestoreIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M9 14.5L4.5 10 9 5.5M4.5 10H14a5.5 5.5 0 0 1 0 11h-3" />
    </Base>
  )
}

/** Achicar (salir de pantalla completa) */
export function ArrowsInIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M9 4.5v4.5H4.5M15 4.5V9h4.5M9 19.5V15H4.5M15 19.5V15h4.5" />
    </Base>
  )
}

/** Ocultar */
export function HideIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M3.5 3.5l17 17" />
      <path d="M10.4 6.3A9.7 9.7 0 0 1 12 6c4.8 0 8.2 4.3 9.2 6a12.3 12.3 0 0 1-2.4 2.9M6.7 6.9C4.4 8.4 2.9 10.3 2.8 12c1 1.7 4.4 6 9.2 6 1.5 0 2.9-.4 4.1-1" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </Base>
  )
}

/** Etiqueta */
export function TagIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1.2 1.2 0 0 1 0 1.7l-6.6 6.6a1.2 1.2 0 0 1-1.7 0z" />
      <circle cx="8" cy="8" r="1.2" />
    </Base>
  )
}

/** Servidor (daemon de terminales) */
export function ServerIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <rect x="3.5" y="4" width="17" height="6.5" rx="1.6" />
      <rect x="3.5" y="13.5" width="17" height="6.5" rx="1.6" />
      <path d="M7 7.2h.01M7 16.7h.01" />
    </Base>
  )
}

/** Terminal */
export function TerminalIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.4" />
      <path d="M7 9.5l2.8 2.5L7 14.5M12.8 15h4" />
    </Base>
  )
}

/** Encender / apagar */
export function PowerIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M12 3.5v8" />
      <path d="M7 6.3a7.6 7.6 0 1 0 10 0" />
    </Base>
  )
}

/** Listo (círculo con marca) */
export function CheckCircleIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M8.2 12.4l2.5 2.5 5.1-5.2" />
    </Base>
  )
}

/** Círculo vacío */
export function CircleIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="7.6" />
    </Base>
  )
}

/** Media vuelta de cargando (girar con la clase spin) */
export function SpinnerIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <path d="M12 4a8 8 0 1 1-8 8" />
    </Base>
  )
}

/** Círculo con raya (cerrado) */
export function MinusCircleIcon(props: SlothIconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M8.2 12h7.6" />
    </Base>
  )
}

export const SLOTH_ICONS = {
  Working: WorkingIcon,
  Waiting: WaitingIcon,
  Permission: PermissionIcon,
  Done: DoneIcon,
  Error: ErrorIcon,
  Idle: IdleIcon,
  SlothMark: SlothMarkIcon,
  Space: SpaceIcon,
  NewSpace: NewSpaceIcon,
  Folder: FolderIcon,
  DropFolder: DropFolderIcon,
  OnePane: OnePaneIcon,
  TwoPanes: TwoPanesIcon,
  FourPanes: FourPanesIcon,
  Maximize: MaximizeIcon,
  Sidebar: SidebarIcon,
  Editor: EditorIcon,
  Broadcast: BroadcastIcon,
  More: MoreIcon,
  Account: AccountIcon,
  AddAccount: AddAccountIcon,
  MoveAccount: MoveAccountIcon,
  Team: TeamIcon,
  Chat: ChatIcon,
  Thread: ThreadIcon,
  Mention: MentionIcon,
  React: ReactIcon,
  Pin: PinIcon,
  Invite: InviteIcon,
  Branch: BranchIcon,
  Commit: CommitIcon,
  PullRequest: PullRequestIcon,
  Changes: ChangesIcon,
  History: HistoryIcon,
  Worktree: WorktreeIcon,
  Templates: TemplatesIcon,
  Ticket: TicketIcon,
  Report: ReportIcon,
  Search: SearchIcon,
  Eye: EyeIcon,
  Palette: PaletteIcon,
  Settings: SettingsIcon,
  Bell: BellIcon,
  Update: UpdateIcon,
  Help: HelpIcon,
  Export: ExportIcon,
  Keyboard: KeyboardIcon,
  Theme: ThemeIcon,
  Sound: SoundIcon,
  Close: CloseIcon,
} as const

export type SlothIconName = keyof typeof SLOTH_ICONS

export type SlothIconComponent = ComponentType<SlothIconProps>
