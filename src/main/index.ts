import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, shell } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from './store'
import { accountStatus, createAccount } from './accounts'
import { HookServer, stateForEvent } from './hooks'
import { baseEnv, PtyManager, type PtySpec } from './ptys'
import { createWorktree } from './git'
import {
  accountIdFromLoginPane,
  isLoginPane,
  type Account,
  type AgentStatus,
  type NewWorkspaceInput,
  type Workspace
} from '../shared/types'

let win: BrowserWindow | null = null
const agents = new Map<string, AgentStatus>()

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function setAgent(wsId: string, status: AgentStatus): void {
  agents.set(wsId, status)
  send('agent:status', wsId, status)
}

app.setName('AntiRea')
if (!app.requestSingleInstanceLock()) app.quit()

app.whenReady().then(async () => {
  const store = new Store()

  const hooks = new HookServer((p) => {
    const ws = store.workspace(p.ws)
    if (!ws) return
    const { state, detail } = stateForEvent(p)
    setAgent(ws.id, { state, detail, at: Date.now() })
    if ((state === 'done' || state === 'waiting') && win && !win.isFocused() && Notification.isSupported()) {
      new Notification({
        title: `${ws.name}`,
        body: state === 'done' ? 'Claude terminó.' : detail || 'Claude necesita tu atención.'
      }).show()
    }
  })
  await hooks.start()
  for (const acc of store.accounts) hooks.installInto(acc.configDir)

  const ptys = new PtyManager(
    (id, chunk) => send('pty:data', id, chunk),
    (id, code) => {
      send('pty:exit', id, code)
      if (store.workspace(id)) setAgent(id, { state: 'exited', at: Date.now() })
    }
  )

  /** Nunca arrancamos una terminal con una cuenta que no sea la elegida. */
  function requireAccount(accountId: string): Account {
    const acc = store.account(accountId)
    if (!acc) throw new Error('La cuenta de este espacio ya no existe. Elegí otra cuenta.')
    if (!existsSync(acc.configDir)) throw new Error(`Falta la carpeta de la cuenta «${acc.label}».`)
    return acc
  }

  function accountEnv(acc: Account): Record<string, string> {
    return { ...baseEnv(), CLAUDE_CONFIG_DIR: acc.configDir, ANTIREA_ACCOUNT: acc.label }
  }

  function specFor(paneId: string): PtySpec {
    if (isLoginPane(paneId)) {
      const acc = requireAccount(accountIdFromLoginPane(paneId))
      // Primer arranque de Claude con esta carpeta: pide tema y login.
      return { cwd: homedir(), env: accountEnv(acc), args: ['-NoLogo', '-NoExit', '-Command', 'claude'] }
    }
    const ws = store.workspace(paneId)
    if (!ws) throw new Error('Ese espacio ya no existe.')
    const acc = requireAccount(ws.accountId)
    if (!existsSync(ws.cwd)) throw new Error(`No existe la carpeta ${ws.cwd}`)
    const env = {
      ...accountEnv(acc),
      ANTIREA_WS: ws.id,
      ANTIREA_HOOK_URL: hooks.url,
      ANTIREA_TOKEN: hooks.token
    }
    const args = ['-NoLogo']
    if (ws.autoStartClaude) args.push('-NoExit', '-Command', 'claude')
    return { cwd: ws.cwd, env, args }
  }

  ipcMain.handle('state:get', () => ({
    accounts: store.accounts,
    workspaces: store.workspaces,
    openPanes: store.openPanes,
    agents: Object.fromEntries(agents)
  }))

  ipcMain.handle('accounts:add', (_e, label: string) => {
    const acc = createAccount(String(label ?? ''))
    hooks.installInto(acc.configDir)
    store.addAccount(acc)
    return acc
  })

  ipcMain.handle('accounts:remove', (_e, id: string) => {
    const used = store.workspaces.filter((w) => w.accountId === id)
    if (used.length) throw new Error(`La usan ${used.length} espacio(s): ${used.map((w) => w.name).join(', ')}`)
    ptys.kill(`login:${id}`)
    store.removeAccount(id)
  })

  ipcMain.handle('accounts:statuses', () =>
    Object.fromEntries(store.accounts.map((a) => [a.id, accountStatus(a)]))
  )

  ipcMain.handle('workspaces:add', async (_e, input: NewWorkspaceInput) => {
    const name = String(input?.name ?? '').trim()
    const repoPath = String(input?.repoPath ?? '').trim()
    if (!name) throw new Error('Poné un nombre.')
    if (!repoPath || !existsSync(repoPath) || !statSync(repoPath).isDirectory())
      throw new Error('Elegí una carpeta de repo válida.')
    requireAccount(input.accountId)
    const branch = input.branch?.trim() || undefined
    const cwd = branch ? await createWorktree(repoPath, branch) : repoPath
    const ws: Workspace = {
      id: randomUUID(),
      name,
      repoPath,
      cwd,
      branch,
      accountId: input.accountId,
      autoStartClaude: Boolean(input.autoStartClaude),
      createdAt: Date.now()
    }
    store.addWorkspace(ws)
    return ws
  })

  ipcMain.handle('workspaces:remove', (_e, id: string) => {
    // El worktree queda en disco a propósito: puede tener trabajo sin commitear.
    ptys.kill(id)
    agents.delete(id)
    store.removeWorkspace(id)
  })

  ipcMain.handle('ui:openPanes', (_e, ids: string[]) => {
    if (Array.isArray(ids)) store.setOpenPanes(ids.filter((x) => typeof x === 'string'))
  })

  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })

  ipcMain.handle('pty:start', (_e, id: string, cols: number, rows: number) => {
    const result = ptys.start(id, () => specFor(id), cols, rows)
    if (store.workspace(id) && !agents.has(id)) setAgent(id, { state: 'idle', at: Date.now() })
    return result
  })
  ipcMain.on('pty:write', (_e, id: string, data: string) => ptys.write(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => ptys.resize(id, cols, rows))
  ipcMain.handle('pty:kill', (_e, id: string) => {
    ptys.kill(id)
    if (store.workspace(id)) setAgent(id, { state: 'exited', at: Date.now() })
  })

  ipcMain.handle('clipboard:read', () => clipboard.readText())
  ipcMain.on('clipboard:write', (_e, text: string) => clipboard.writeText(String(text)))

  app.on('before-quit', () => {
    ptys.killAll()
    hooks.stop()
  })

  createWindow()
})

function createWindow(): void {
  win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0f1115',
    title: 'AntiRea',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  // Links externos al navegador; la ventana nunca navega fuera de la app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))

  win.on('closed', () => (win = null))
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('window-all-closed', () => app.quit())
