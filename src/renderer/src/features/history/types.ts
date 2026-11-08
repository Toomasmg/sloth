/** Lo que manda main (ver src/main/features/history-core.ts y history.ts). */

export interface FileTouch {
  path: string
  add: number
  del: number
}

export interface SessionRow {
  key: string
  accountId: string
  accountLabel: string
  sessionId: string
  cwd: string
  spaceId: string | null
  spaceKey: string
  spaceName: string
  branch: string
  title: string
  /** ms */
  start: number
  end: number
  messages: number
  tools: number
  files: FileTouch[]
  status: 'ok' | 'int'
}

export type DetailItem =
  | { k: 'msg'; role: 'user' | 'assistant'; text: string }
  | { k: 'tool'; kind: 'read' | 'edit' | 'run' | 'other'; title: string; cmd: string; meta: string; err: boolean; lines: string[] }

export interface SessionInfo extends SessionRow {
  lastAnswer: string
  items: DetailItem[]
}

export interface ListReply {
  sessions: SessionRow[]
  pinned: string[]
  hidden: string[]
}

export interface PrefsReply {
  pinned: string[]
  hidden: string[]
}

/** Resultado de una búsqueda de texto (una coincidencia, por mensaje). */
export interface TextHit {
  accountId: string
  sessionId: string
  role: 'user' | 'assistant'
  before: string
  match: string
  after: string
}

export interface OpenResult {
  wsId?: string
  needsConfirm?: boolean
  wsName?: string
  manualCommand?: string
}
