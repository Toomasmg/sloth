import { createContext, useContext } from 'react'
import type {
  Account,
  AccountStatus,
  AccountUsage,
  AgentStatus,
  PermissionPrompt,
  Workspace
} from '../../../shared/types'
import type { PaneAction } from '../layout/pane-actions'

/** Lo que cada función ve de la app desde la interfaz. */
export interface UiCtx {
  accounts: Account[]
  workspaces: Workspace[]
  statuses: Record<string, AccountStatus>
  usage: Record<string, AccountUsage>
  agents: Record<string, AgentStatus>
  permissions: PermissionPrompt[]
  openPanes: string[]
  focused: string | null
  maximized: string | null
  openPane(id: string): void
  closePane(id: string): void
  setMaximized(id: string | null): void
  restartPane(id: string): Promise<void>
  /** Vuelve a leer cuentas y espacios de main (después de crear o editar desde una función). */
  reload(): Promise<void>
  /** Abre «Nuevo espacio». `preset.repoPath` precarga la carpeta (p. ej. al soltar una carpeta en la ventana). */
  openNewWorkspace(mode: 'normal' | 'ticket', preset?: NewWorkspacePreset): void
  /**
   * Registra una guarda que se consulta ANTES de que el usuario oculte o reinicie un panel desde su
   * header o su pestaña (no se consulta en `closePane`/`restartPane` programáticos). Si alguna devuelve
   * false (o una promesa de false), la acción se cancela. Devuelve la función para quitarla.
   */
  onBeforeClosePane(guard: PaneGuard): () => void
  notifyError(message: string): void
  /**
   * Acciones de un panel o espacio, ya ordenadas: las del núcleo y las que suman las funciones. Las usan
   * el menú del espacio (clic derecho, «…» del panel, pestaña) y la paleta, así todos muestran lo mismo.
   */
  paneActions(paneId: string): PaneAction[]
  /** `invoke('feat:<función>:<op>', ...)` hacia main. */
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
  /** Escucha `feat:<función>:<evento>` desde main. Devuelve la función para dejar de escuchar. */
  on(channel: string, cb: (...args: any[]) => void): () => void
}

export interface NewWorkspacePreset {
  repoPath?: string
  name?: string
  /** Cuenta preseleccionada (el «+» de cada cuenta en la barra lateral). */
  accountId?: string
}

export type { PaneAction, PaneActionGroup } from '../layout/pane-actions'

/** `action`: qué intenta hacer el usuario con el panel. */
export type PaneGuard = (paneId: string, action: 'hide' | 'restart') => boolean | Promise<boolean>

export const UiContext = createContext<UiCtx | null>(null)

export function useUi(): UiCtx {
  const ctx = useContext(UiContext)
  if (!ctx) throw new Error('useUi fuera de UiContext')
  return ctx
}

/** Acción para la paleta de comandos (Ctrl+K). */
export interface Command {
  id: string
  title: string
  subtitle?: string
  group: string
  keywords?: string
  /** Texto del atajo, solo para mostrar (p. ej. "Ctrl+Shift+F"). */
  shortcut?: string
  /** Ícono opcional para la paleta (p. ej. `<GearSix size={16} />` de Phosphor, con aria-hidden). */
  icon?: React.ReactNode
  run(): void | Promise<void>
}

/**
 * Cada función exporta uno de estos desde `features/<nombre>/index.tsx`. Todos los lugares son
 * opcionales. Que sean livianos: nada de polling con la ventana oculta (ver visibility.ts).
 */
export interface FeatureUi {
  name: string
  /** Chip o botón en la barra de título (lado derecho, antes del estado del daemon). */
  Titlebar?: React.FC
  /** Sección al final del sidebar. */
  Sidebar?: React.FC
  /**
   * Insignias de estado en la cabecera de un panel («3 cambios»), antes de maximizar. Para acciones
   * no: esas van en `paneActions`, que las suma al menú del espacio.
   */
  PaneHeader?: React.FC<{ paneId: string }>
  /** Ítems que la función suma al menú del espacio (y a sus acciones en la paleta). */
  paneActions?(ctx: UiCtx, paneId: string): PaneAction[]
  /** Franja arriba de la terminal de un panel (debajo de la tarjeta de permiso). */
  PaneBanner?: React.FC<{ paneId: string }>
  /** Modales, paneles laterales o la paleta: se montan una sola vez. */
  Global?: React.FC
  /** Comandos que aporta a la paleta. */
  commands?(ctx: UiCtx): Command[]
}
