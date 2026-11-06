import type { BrowserWindow } from 'electron'
import type { Store } from '../store'
import type { UsageScanner } from '../usage'
import type { TerminalBackend } from '../daemon-client'
import type { HookEventPayload } from '../hooks'
import type { Account, AgentStatus, NewWorkspaceInput, PtyChunk, Workspace } from '../../shared/types'
import type { UiCommand } from '../../shared/features'

/**
 * Lo que recibe cada función del proceso main. Todo lo que registra queda con su prefijo:
 * `handle('list', fn)` en la función "history" responde al canal `feat:history:list`.
 */
export interface FeatureContext {
  readonly name: string
  readonly store: Store
  readonly usage: UsageScanner
  /** Backend de terminales (daemon o en proceso); espera a que esté listo. */
  backend(): Promise<TerminalBackend>
  /** El backend si ya está listo, sin esperar. */
  terminal(): TerminalBackend | undefined
  window(): BrowserWindow | null
  /** Se llama con la ventana principal cuando se crea (y enseguida si ya existe). */
  onWindow(cb: (win: BrowserWindow) => void): void
  /** Registra `feat:<name>:<op>` (invoke desde la UI). Los argumentos llegan sin validar: validalos. */
  handle(op: string, fn: (...args: any[]) => unknown): void
  /** Manda un evento `feat:<name>:<event>` a la UI. */
  emit(event: string, ...args: unknown[]): void
  /** Órdenes comunes a la UI: recargar estado, abrir o reiniciar un panel, traer la ventana. */
  ui(cmd: UiCommand): void
  onHook(cb: (p: HookEventPayload) => void): void
  onPtyData(cb: (id: string, chunks: PtyChunk[]) => void): void
  onPtyExit(cb: (id: string, code: number) => void): void
  agents(): ReadonlyMap<string, AgentStatus>
  setAgent(wsId: string, status: AgentStatus): void
  /** Mismas validaciones que «Nuevo espacio» (incluye crear worktree si viene branch). */
  addWorkspace(input: NewWorkspaceInput): Promise<Workspace>
  /** Quita un espacio igual que la UI: cierra su terminal, olvida su estado y lo borra del store. */
  removeWorkspace(id: string): Promise<void>
  /** Settings, hooks y setup compartido de la cuenta, antes de abrir Claude con ella. */
  prepareAccount(acc: Account): void
  /** Mata la terminal del panel; la UI la vuelve a abrir (con el spec actual del espacio). */
  restartTerminal(id: string): Promise<void>
  /**
   * Decide el comando de Claude al abrir la terminal de un espacio (p. ej. `claude --resume <id>`).
   * Se prueban en orden; el primero que devuelve algo gana. Si ninguno, el comportamiento normal.
   */
  addClaudeCommandOverride(fn: (ws: Workspace, acc: Account) => string | undefined): void
  log(...args: unknown[]): void
}

export interface Feature {
  name: string
  register(ctx: FeatureContext): void | Promise<void>
  /** Al salir de la app. */
  dispose?(): void
}
