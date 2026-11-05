import { app, BrowserWindow, clipboard, dialog, ipcMain, net, Notification, protocol, shell } from 'electron'
import { pathToFileURL } from 'node:url'
import { normalize, sep } from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from './store'
import { accountStatus, createAccount } from './accounts'
import { HookServer, stateForEvent } from './hooks'
import { baseEnv, PtyManager, type PtySpec } from './ptys'
import { createWorktree } from './git'
import { baseSettingsFor, syncSharedSetup, unshareSetup } from './setup'
import { UsageScanner } from './usage'
import {
  accountIdFromLoginPane,
  isLoginPane,
  loginPaneId,
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

// La UI se sirve por app:// y no por file://: así la fuse GrantFileProtocolExtraPrivileges puede
// quedar apagada, y el renderer no puede leer nada fuera de su carpeta.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

function serveRenderer(): void {
  const root = normalize(join(__dirname, '../renderer'))
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url)
    const file = normalize(join(root, decodeURIComponent(pathname)))
    if (!file.startsWith(root + sep)) return new Response('Prohibido', { status: 403 })
    return net.fetch(pathToFileURL(file).toString())
  })
}

app.whenReady().then(async () => {
  serveRenderer()
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
  const usage = new UsageScanner()

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

  /** Si hay alguna terminal abierta con esta cuenta (Claude puede estar escribiendo su .claude.json). */
  function accountBusy(accountId: string): boolean {
    if (ptys.isRunning(loginPaneId(accountId))) return true
    return store.workspaces.some((w) => w.accountId === accountId && ptys.isRunning(w.id))
  }

  /** Deja la cuenta lista antes de abrir Claude: settings + hooks y tu setup compartido. */
  function prepareAccount(acc: Account): void {
    hooks.installInto(acc.configDir, baseSettingsFor(acc))
    const report = syncSharedSetup(acc, !accountBusy(acc.id))
    if (report.skipped.length) console.warn(`[setup] ${acc.label}:`, report.skipped.join('; '))
  }

  /** Claude guarda cada conversación en projects/<cwd con separadores como '-'>. */
  function hasPreviousConversation(acc: Account, cwd: string): boolean {
    const dir = join(acc.configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
    try {
      return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.jsonl'))
    } catch {
      return false
    }
  }

  const psQuote = (s: string): string => `'${s.replace(/[\r\n]+/g, ' ').replace(/'/g, "''")}'`

  function claudeCommand(ws: Workspace, acc: Account): string | undefined {
    if (!ws.autoStartClaude) return undefined
    if (ws.initialPrompt && !ws.initialPromptUsed) {
      store.updateWorkspace(ws.id, { initialPromptUsed: true })
      return `claude ${psQuote(ws.initialPrompt)}`
    }
    if (ws.resume !== false && hasPreviousConversation(acc, ws.cwd)) return 'claude --continue'
    return 'claude'
  }

  function specFor(paneId: string): PtySpec {
    if (isLoginPane(paneId)) {
      const acc = requireAccount(accountIdFromLoginPane(paneId))
      prepareAccount(acc)
      // Primer arranque de Claude con esta carpeta: pide tema y login.
      return { cwd: homedir(), env: accountEnv(acc), args: ['-NoLogo', '-NoExit', '-Command', 'claude'] }
    }
    const ws = store.workspace(paneId)
    if (!ws) throw new Error('Ese espacio ya no existe.')
    const acc = requireAccount(ws.accountId)
    if (!existsSync(ws.cwd)) throw new Error(`No existe la carpeta ${ws.cwd}`)
    prepareAccount(acc)
    const env = {
      ...accountEnv(acc),
      ANTIREA_WS: ws.id,
      ANTIREA_HOOK_URL: hooks.url,
      ANTIREA_TOKEN: hooks.token
    }
    const args = ['-NoLogo']
    const cmd = claudeCommand(ws, acc)
    if (cmd) args.push('-NoExit', '-Command', cmd)
    return { cwd: ws.cwd, env, args }
  }

  for (const acc of store.accounts) prepareAccount(acc)

  ipcMain.handle('state:get', () => ({
    accounts: store.accounts,
    workspaces: store.workspaces,
    openPanes: store.openPanes,
    agents: Object.fromEntries(agents)
  }))

  ipcMain.handle('accounts:add', (_e, label: string) => {
    const acc = { ...createAccount(String(label ?? '')), shareSetup: true }
    store.addAccount(acc)
    prepareAccount(acc)
    return acc
  })

  ipcMain.handle('accounts:usage', () => usage.scan(store.accounts))

  ipcMain.handle('accounts:setShareSetup', (_e, id: string, share: boolean) => {
    const acc = store.updateAccount(id, { shareSetup: Boolean(share) })
    if (!acc) throw new Error('Esa cuenta ya no existe.')
    if (!acc.shareSetup) {
      unshareSetup(acc)
      hooks.installInto(acc.configDir, {})
      return null
    }
    hooks.installInto(acc.configDir, baseSettingsFor(acc))
    return syncSharedSetup(acc, !accountBusy(acc.id))
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
    const ticket = input.ticket?.trim().toUpperCase() || undefined
    if (ticket && !/^[A-Z][A-Z0-9]*-\d+$/.test(ticket)) throw new Error('El ticket tiene que ser tipo TCK-1234.')
    const initialPrompt = input.initialPrompt?.trim() || undefined
    if (initialPrompt && initialPrompt.length > 4000) throw new Error('El prompt inicial es demasiado largo.')
    const branch = input.branch?.trim() || undefined
    const cwd = branch ? await createWorktree(repoPath, branch) : repoPath
    const ws: Workspace = {
      id: randomUUID(),
      name,
      repoPath,
      cwd,
      branch,
      accountId: input.accountId,
      autoStartClaude: Boolean(input.autoStartClaude) || Boolean(initialPrompt),
      createdAt: Date.now(),
      initialPrompt,
      resume: input.resume !== false,
      ticket
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
  // Ícono: en el instalado viene en resources/; en desarrollo, en build/.
  const iconPath = [join(process.resourcesPath, 'icon.png'), join(__dirname, '../../build/icon.png')].find((p) =>
    existsSync(p)
  )
  win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#16181f',
    title: 'AntiRea',
    icon: iconPath,
    autoHideMenuBar: true,
    // Barra de título propia con la marca; Windows dibuja solo los botones de ventana.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#16181f', symbolColor: '#9aa3b5', height: 40 },
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
  else void win.loadURL('app://ui/index.html')

  win.on('closed', () => (win = null))
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('window-all-closed', () => app.quit())
