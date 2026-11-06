/** Una cuenta de Claude: su propio CLAUDE_CONFIG_DIR, con su login y sus settings. */
export interface Account {
  id: string
  label: string
  configDir: string
  createdAt: number
  /** Usar el setup de ~/.claude (skills, agents, hooks, plugins, settings, MCP). Por defecto sí. */
  shareSetup?: boolean
}

export interface AccountStatus {
  loggedIn: boolean
  email?: string
  configDirExists: boolean
}

export interface UsageTotals {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  messages: number
}

export interface AccountUsage {
  last5h: UsageTotals
  today: UsageTotals
  last7d: UsageTotals
  /** Hora del primer mensaje dentro de las últimas 5 h (aprox. inicio de la ventana de límite). */
  windowStart?: number
  scannedAt: number
}

export interface SetupSyncReport {
  linked: string[]
  copied: string[]
  mcpServers: string[]
  skipped: string[]
}

/** Un espacio de trabajo: un repo (o worktree), una cuenta y una PowerShell. */
export interface Workspace {
  id: string
  name: string
  repoPath: string
  /** Carpeta donde arranca la terminal: el repo o el worktree creado. */
  cwd: string
  branch?: string
  accountId: string
  autoStartClaude: boolean
  createdAt: number
  /** Prompt con el que arranca Claude la primera vez (ej: `/ticket TCK-1234`). */
  initialPrompt?: string
  /** Ya se usó el prompt inicial: las próximas veces se retoma la conversación. */
  initialPromptUsed?: boolean
  /** Al reabrir, retomar la última conversación de esa carpeta (`claude --continue`). */
  resume?: boolean
  ticket?: string
}

export interface NewWorkspaceInput {
  name: string
  repoPath: string
  accountId: string
  /** Si viene, se crea un git worktree en esa rama. */
  branch?: string
  autoStartClaude: boolean
  initialPrompt?: string
  resume?: boolean
  ticket?: string
}

export type AgentState = 'idle' | 'working' | 'waiting' | 'done' | 'exited'

export interface AgentStatus {
  state: AgentState
  detail?: string
  at: number
}

export interface AppState {
  accounts: Account[]
  workspaces: Workspace[]
  openPanes: string[]
  agents: Record<string, AgentStatus>
}

export interface PtyChunk {
  seq: number
  data: string
}

export interface PtyStartResult {
  chunks: PtyChunk[]
  upTo: number
  running: boolean
}

/** Id de panel para la terminal de login de una cuenta. */
export const loginPaneId = (accountId: string): string => `login:${accountId}`
export const isLoginPane = (paneId: string): boolean => paneId.startsWith('login:')
export const accountIdFromLoginPane = (paneId: string): string => paneId.slice('login:'.length)

/** Claude pide permiso para usar una herramienta (vía hook PermissionRequest). */
export interface PermissionPrompt {
  id: string
  workspaceId: string
  tool: string
  input: Record<string, unknown>
  suggestions?: unknown[]
  at: number
  expiresAt: number
}
export type PermissionAnswer = 'allow' | 'allowAlways' | 'deny' | 'terminal'

/** Dónde viven las PowerShell: un daemon aparte (sobreviven al cerrar la app) o dentro de main. */
export interface DaemonInfo {
  mode: 'daemon' | 'inprocess'
  pid?: number
  version?: string
  sessions: number
  reason?: string
}

export interface SlothApi {
  getState(): Promise<AppState>
  addAccount(label: string): Promise<Account>
  removeAccount(id: string): Promise<void>
  accountStatuses(): Promise<Record<string, AccountStatus>>
  accountUsage(): Promise<Record<string, AccountUsage>>
  setShareSetup(id: string, share: boolean): Promise<SetupSyncReport | null>
  addWorkspace(input: NewWorkspaceInput): Promise<Workspace>
  removeWorkspace(id: string): Promise<void>
  setOpenPanes(ids: string[]): Promise<void>
  pickFolder(): Promise<string | null>
  ptyStart(id: string, cols: number, rows: number): Promise<PtyStartResult>
  ptyWrite(id: string, data: string): void
  ptyResize(id: string, cols: number, rows: number): void
  ptyKill(id: string): Promise<void>
  clipboardRead(): Promise<string>
  clipboardWrite(text: string): void
  onPtyData(cb: (id: string, chunk: PtyChunk) => void): () => void
  onPtyExit(cb: (id: string, code: number) => void): () => void
  onAgentStatus(cb: (workspaceId: string, status: AgentStatus) => void): () => void
  pendingPermissions(): Promise<PermissionPrompt[]>
  answerPermission(id: string, answer: PermissionAnswer, message?: string): Promise<void>
  onPermission(cb: (p: PermissionPrompt) => void): () => void
  onPermissionResolved(cb: (id: string) => void): () => void
  daemonInfo(): Promise<DaemonInfo>
  shutdownTerminals(): Promise<void>
  /** Órdenes de main a la UI (recargar, abrir/reiniciar panel, traer ventana). */
  onUi(cb: (cmd: import('./features').UiCommand) => void): () => void
  /** Canales de las funciones: solo `feat:<función>:<op>`. */
  feat: {
    invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
    on(channel: string, cb: (...args: any[]) => void): () => void
  }
}
