import { app } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Account, Workspace } from '../shared/types'

interface PersistedState {
  version: 1
  accounts: Account[]
  workspaces: Workspace[]
  openPanes: string[]
}

const EMPTY: PersistedState = { version: 1, accounts: [], workspaces: [], openPanes: [] }

export class Store {
  private state: PersistedState
  private readonly file: string

  constructor() {
    mkdirSync(app.getPath('userData'), { recursive: true })
    this.file = join(app.getPath('userData'), 'antirea-state.json')
    this.state = this.load()
  }

  private load(): PersistedState {
    if (!existsSync(this.file)) return structuredClone(EMPTY)
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PersistedState>
      return {
        version: 1,
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
        workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [],
        openPanes: Array.isArray(parsed.openPanes) ? parsed.openPanes : []
      }
    } catch {
      // Archivo corrupto: lo guardamos aparte en vez de pisarlo en silencio.
      renameSync(this.file, `${this.file}.corrupt-${Date.now()}`)
      return structuredClone(EMPTY)
    }
  }

  /** Escritura atómica: tmp + rename, así un corte no deja el JSON a medias. */
  private save(): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }

  get accounts(): Account[] {
    return this.state.accounts
  }
  get workspaces(): Workspace[] {
    return this.state.workspaces
  }
  get openPanes(): string[] {
    return this.state.openPanes
  }

  account(id: string): Account | undefined {
    return this.state.accounts.find((a) => a.id === id)
  }
  workspace(id: string): Workspace | undefined {
    return this.state.workspaces.find((w) => w.id === id)
  }

  addAccount(account: Account): void {
    this.state.accounts.push(account)
    this.save()
  }
  updateAccount(id: string, patch: Partial<Omit<Account, 'id' | 'configDir'>>): Account | undefined {
    const acc = this.account(id)
    if (!acc) return undefined
    Object.assign(acc, patch)
    this.save()
    return acc
  }
  updateWorkspace(id: string, patch: Partial<Omit<Workspace, 'id'>>): Workspace | undefined {
    const ws = this.workspace(id)
    if (!ws) return undefined
    Object.assign(ws, patch)
    this.save()
    return ws
  }
  removeAccount(id: string): void {
    this.state.accounts = this.state.accounts.filter((a) => a.id !== id)
    this.save()
  }
  addWorkspace(ws: Workspace): void {
    this.state.workspaces.push(ws)
    this.save()
  }
  removeWorkspace(id: string): void {
    this.state.workspaces = this.state.workspaces.filter((w) => w.id !== id)
    this.state.openPanes = this.state.openPanes.filter((p) => p !== id)
    this.save()
  }
  setOpenPanes(ids: string[]): void {
    this.state.openPanes = ids
    this.save()
  }
}
