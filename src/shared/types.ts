/** Una cuenta de Claude: su propio CLAUDE_CONFIG_DIR, con su login y sus settings. */
export interface Account {
  id: string
  label: string
  configDir: string
  createdAt: number
}

export interface AccountStatus {
  loggedIn: boolean
  email?: string
  configDirExists: boolean
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
}

export interface NewWorkspaceInput {
  name: string
  repoPath: string
  accountId: string
  /** Si viene, se crea un git worktree en esa rama. */
  branch?: string
  autoStartClaude: boolean
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

export interface AntiReaApi {
  getState(): Promise<AppState>
  addAccount(label: string): Promise<Account>
  removeAccount(id: string): Promise<void>
  accountStatuses(): Promise<Record<string, AccountStatus>>
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
}
