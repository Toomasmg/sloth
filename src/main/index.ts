import { app, BrowserWindow, clipboard, dialog, ipcMain, net, protocol, shell } from 'electron'
import { pathToFileURL } from 'node:url'
import { normalize, sep } from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir, totalmem } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from './store'
import { accountStatus, createAccount } from './accounts'
import { installInto, stateForEvent, writeHookScript, type HookEventPayload } from './hooks'
import { baseEnv, toSpawnSpec, type PtySpec } from './ptys'
import { createTerminalBackend, type PendingPermission, type TerminalBackend } from './daemon-client'
import { clipboardForPaste } from './clipboard-paste'
import { createWorktree } from './git'
import { normTicketId, TEMPLATE_COLOR_KEYS, validBranch } from '../shared/templates-shared'
import { baseSettingsFor, syncSharedSetup, unshareSetup } from './setup'
import { UsageScanner } from './usage'
import { FEATURES } from './features'
import { currentSettings, initialChrome } from './features/settings'
import { validateWorkspacePatch } from './workspace-patch'
import { loadWindowState, trackWindowState } from './window-state'
import { zoomFor } from './zoom-keys'
import type { FeatureContext } from './features/context'
import type { UiCommand } from '../shared/features'
import {
  accountIdFromLoginPane,
  isLoginPane,
  loginPaneId,
  type Account,
  type AgentStatus,
  type DaemonInfo,
  type NewWorkspaceInput,
  type PermissionPrompt,
  type PtyChunk,
  type RevealTarget,
  type Workspace
} from '../shared/types'

let win: BrowserWindow | null = null
const windowListeners: ((w: BrowserWindow) => void)[] = []
const agents = new Map<string, AgentStatus>()

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function setAgent(wsId: string, status: AgentStatus): void {
  agents.set(wsId, status)
  send('agent:status', wsId, status)
}

app.setName('Sloth')
// Instancia de prueba al lado de la instalada: otra carpeta de datos = otro lock, otro daemon, otras cuentas.
if (process.env.SLOTH_USER_DATA) app.setPath('userData', process.env.SLOTH_USER_DATA)
if (!app.requestSingleInstanceLock()) app.quit()

// Bajo consumo: apagamos lo que Chromium trae y Sloth no usa (renderer de repuesto precargado,
// media, traducción, autocompletado). Menos procesos y menos RAM en PCs modestas.
app.commandLine.appendSwitch(
  'disable-features',
  'SpareRendererForSitePerProcess,MediaRouter,HardwareMediaKeyHandling,GlobalMediaControls,Translate,AutofillServerCommunication'
)
app.commandLine.appendSwitch('disable-background-networking')

// Modo liviano: en PCs con ≤ 8 GB de RAM se apaga la GPU (el proceso GPU solo usa ~90 MB más que
// el render por software, y para terminales de texto no hace falta). SLOTH_GPU=1/0 lo fuerza.
const gpuPref = process.env.SLOTH_GPU
const lowMemory = totalmem() <= 8.5 * 1024 ** 3
if (gpuPref === '0' || (gpuPref !== '1' && lowMemory)) app.disableHardwareAcceleration()

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
  // La ventana se crea antes que nada más: el primer render no espera a daemon, escaneos ni registros.
  // Los handlers de las funciones se registran en este mismo turno (antes de que el renderer pida nada).
  // Trabajo que no hace falta para pintar (setup de cada cuenta, daemon de terminales) va después de mostrar.
  createWindow(() =>
    setTimeout(() => {
      for (const acc of store.accounts) safe('preparar cuenta', () => prepareAccount(acc))
      void backend()
    }, 1500).unref()
  )

  writeHookScript()
  const usage = new UsageScanner()
  const hookListeners: ((p: HookEventPayload) => void)[] = []
  const dataListeners: ((id: string, chunks: PtyChunk[]) => void)[] = []
  const exitListeners: ((id: string, code: number) => void)[] = []
  const writeListeners: ((id: string, data: string) => void)[] = []
  const commandOverrides: ((ws: Workspace, acc: Account) => string | undefined)[] = []
  const safe = (name: string, fn: () => void): void => {
    try {
      fn()
    } catch (e) {
      console.error(`[función] ${name}:`, e)
    }
  }
  const uiCommand = (cmd: UiCommand): void => send('ui:command', cmd)

  /** Evento de hook de Claude → estado del espacio (+ aviso de Windows si la ventana no está enfocada). */
  function onHook(p: HookEventPayload): void {
    for (const l of hookListeners) safe('hook', () => l(p))
    const ws = store.workspace(p.ws)
    if (!ws) return
    const { state, detail } = stateForEvent(p)
    setAgent(ws.id, { state, detail, at: p.at ?? Date.now() })
    // Los avisos de Windows los manda la función «permissions» (respeta «No molestar» y los ajustes).
  }

  const toPrompt = (r: PendingPermission): PermissionPrompt => ({
    id: r.id,
    workspaceId: r.ws,
    tool: r.tool,
    input: r.input,
    suggestions: r.suggestions,
    at: r.at,
    expiresAt: r.expiresAt
  })

  /** Pedido de permiso → tarjeta en la UI. Si el espacio no existe, Claude pregunta en la terminal. */
  function onPermission(r: PendingPermission): void {
    const ws = store.workspace(r.ws)
    if (!ws) {
      term?.answerPermission(r.id, null)
      return
    }
    send('permission:new', toPrompt(r))
  }

  // Las terminales viven en el daemon (sobreviven al cierre) o, si no hay node, dentro de la app.
  let term: TerminalBackend | undefined
  let termPromise: Promise<TerminalBackend> | undefined
  function backend(): Promise<TerminalBackend> {
    if (!termPromise) {
      termPromise = createTerminalBackend({
        userDataDir: app.getPath('userData'),
        appVersion: app.getVersion(),
        resourcesDir: app.isPackaged ? process.resourcesPath : undefined,
        projectRoot: app.isPackaged ? undefined : app.getAppPath(),
        log: (...a: unknown[]) => console.log('[terminales]', ...a)
      }).then(async (b) => {
        term = b
        b.on('data', (id: string, chunks: PtyChunk[]) => {
          send('pty:data', id, chunks)
          for (const l of dataListeners) safe('pty-data', () => l(id, chunks))
        })
        b.on('exit', (id: string, code: number) => {
          send('pty:exit', id, code)
          for (const l of exitListeners) safe('pty-exit', () => l(id, code))
          // Un espacio dormido sigue «Dormido» (su terminal se cerró a propósito).
          if (store.workspace(id) && agents.get(id)?.state !== 'sleeping') setAgent(id, { state: 'exited', at: Date.now() })
        })
        b.on('hook', onHook)
        b.on('permission', onPermission)
        b.on('permission-resolved', (id: string) => send('permission:resolved', id))
        b.on('disconnect', () => {
          // Se perdió el daemon y no se pudo relanzar: el próximo pedido crea otro backend.
          console.warn('[terminales] desconectado del daemon')
          if (term === b) {
            term = undefined
            termPromise = undefined
          }
        })
        // Rehidratar: estado de los agentes que siguieron trabajando con la app cerrada.
        const sessions = await b.list().catch(() => [])
        const running = new Set(sessions.filter((x) => x.running).map((x) => x.id))
        for (const [wsId, ev] of Object.entries(b.lastHookEvents())) {
          if (!store.workspace(wsId) || !running.has(wsId)) continue
          const { state, detail } = stateForEvent(ev)
          setAgent(wsId, { state, detail, at: ev.at ?? Date.now() })
        }
        for (const id of running) if (store.workspace(id) && !agents.has(id)) setAgent(id, { state: 'idle', at: Date.now() })
        for (const r of b.pendingPermissions()) onPermission(r)
        return b
      })
    }
    return termPromise
  }
  /** Nunca arrancamos una terminal con una cuenta que no sea la elegida. */
  function requireAccount(accountId: string): Account {
    const acc = store.account(accountId)
    if (!acc) throw new Error('La cuenta de este espacio ya no existe. Elegí otra cuenta.')
    if (!existsSync(acc.configDir)) throw new Error(`Falta la carpeta de la cuenta «${acc.label}».`)
    return acc
  }

  function accountEnv(acc: Account): Record<string, string> {
    return { ...baseEnv(), CLAUDE_CONFIG_DIR: acc.configDir, SLOTH_ACCOUNT: acc.label }
  }

  /** Si hay alguna terminal abierta con esta cuenta (Claude puede estar escribiendo su .claude.json). */
  function accountBusy(accountId: string): boolean {
    const b = term
    if (!b) return false
    if (b.isRunning(loginPaneId(accountId))) return true
    return store.workspaces.some((w) => w.accountId === accountId && b.isRunning(w.id))
  }

  /** Deja la cuenta lista antes de abrir Claude: settings + hooks y tu setup compartido. */
  function prepareAccount(acc: Account): void {
    installInto(acc.configDir, baseSettingsFor(acc))
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

  /** argv de Claude para la terminal del espacio (la shell lo quota según su sintaxis en ptys.ts). */
  function claudeCommand(ws: Workspace, acc: Account): string[] | undefined {
    // Los reemplazos (p. ej. retomar tras mover de cuenta) se aplican aunque el espacio no abra Claude solo.
    for (const o of commandOverrides) {
      let cmd: string | undefined
      safe('override', () => (cmd = o(ws, acc)))
      if (cmd) return cmd.trim().split(/\s+/)
    }
    if (!ws.autoStartClaude) return undefined
    if (ws.initialPrompt && !ws.initialPromptUsed) {
      store.updateWorkspace(ws.id, { initialPromptUsed: true })
      return ['claude', ws.initialPrompt.replace(/[\r\n]+/g, ' ')]
    }
    if (ws.resume !== false && hasPreviousConversation(acc, ws.cwd)) return ['claude', '--continue']
    return ['claude']
  }

  function specFor(paneId: string, b: TerminalBackend): PtySpec {
    if (isLoginPane(paneId)) {
      const acc = requireAccount(accountIdFromLoginPane(paneId))
      prepareAccount(acc)
      // Primer arranque de Claude con esta carpeta: pide tema y login.
      return { cwd: homedir(), env: accountEnv(acc), claude: ['claude'] }
    }
    const ws = store.workspace(paneId)
    if (!ws) throw new Error('Ese espacio ya no existe.')
    const acc = requireAccount(ws.accountId)
    if (!existsSync(ws.cwd)) throw new Error(`No existe la carpeta ${ws.cwd}`)
    prepareAccount(acc)
    const env = {
      ...accountEnv(acc),
      SLOTH_WS: ws.id,
      SLOTH_HOOK_URL: b.hookUrl,
      SLOTH_TOKEN: b.hookToken
    }
    return { cwd: ws.cwd, env, claude: claudeCommand(ws, acc) }
  }

  ipcMain.handle('state:get', async () => {
    // «Reabrir los espacios»: si está apagado, solo vuelven los paneles cuyas terminales siguen vivas en el daemon.
    let openPanes = store.openPanes
    if (!currentSettings().reopenSpaces) {
      const b = await backend().catch(() => undefined)
      openPanes = b ? openPanes.filter((id) => b.isRunning(id)) : []
    }
    return { accounts: store.accounts, workspaces: store.workspaces, openPanes, agents: Object.fromEntries(agents) }
  })

  ipcMain.handle('permission:pending', () =>
    (term?.pendingPermissions() ?? []).filter((r) => store.workspace(r.ws)).map(toPrompt)
  )

  ipcMain.handle('daemon:info', async (): Promise<DaemonInfo> => {
    const b = await backend()
    const sessions = await b.list().catch(() => [])
    return { ...b.info(), sessions: sessions.filter((x) => x.running).length }
  })

  ipcMain.handle('daemon:shutdown', async () => {
    const b = await backend()
    const sessions = await b.list().catch(() => [])
    await b.shutdown()
    b.dispose()
    term = undefined
    termPromise = undefined
    for (const x of sessions) {
      if (!x.running) continue
      send('pty:exit', x.id, -1)
      if (store.workspace(x.id)) setAgent(x.id, { state: 'exited', at: Date.now() })
    }
  })

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
      installInto(acc.configDir, {})
      return null
    }
    installInto(acc.configDir, baseSettingsFor(acc))
    return syncSharedSetup(acc, !accountBusy(acc.id))
  })

  ipcMain.handle('accounts:remove', async (_e, id: string) => {
    const used = store.workspaces.filter((w) => w.accountId === id)
    if (used.length) throw new Error(`La usan ${used.length} espacio(s): ${used.map((w) => w.name).join(', ')}`)
    await (await backend()).kill(loginPaneId(id))
    store.removeAccount(id)
  })

  ipcMain.handle('accounts:statuses', () =>
    Object.fromEntries(store.accounts.map((a) => [a.id, accountStatus(a)]))
  )

  async function addWorkspace(input: NewWorkspaceInput): Promise<Workspace> {
    const name = String(input?.name ?? '').trim()
    const repoPath = String(input?.repoPath ?? '').trim()
    if (!name) throw new Error('Poné un nombre.')
    if (!repoPath || !existsSync(repoPath) || !statSync(repoPath).isDirectory())
      throw new Error('Elegí una carpeta de repo válida.')
    requireAccount(input.accountId)
    const ticket = input.ticket?.trim() ? normTicketId(input.ticket) : undefined
    if (input.ticket?.trim() && !ticket) throw new Error('El ticket solo lleva letras, números, guiones, puntos o _ (p. ej. PROJ-123 o 123).')
    const initialPrompt = input.initialPrompt?.trim() || undefined
    if (initialPrompt && initialPrompt.length > 4000) throw new Error('El prompt inicial es demasiado largo.')
    const branch = input.branch?.trim() || undefined
    const baseBranch = input.baseBranch?.trim() || undefined
    if (baseBranch && !validBranch(baseBranch)) throw new Error('La rama base no es un nombre válido.')
    const color = input.color === undefined || input.color === null || input.color === '' ? undefined : String(input.color)
    if (color !== undefined && !(TEMPLATE_COLOR_KEYS as readonly string[]).includes(color)) throw new Error('El color del espacio no es válido.')
    const cwd = branch ? await createWorktree(repoPath, branch, baseBranch) : repoPath
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
      ticket,
      ...(color ? { color } : {})
    }
    store.addWorkspace(ws)
    return ws
  }
  ipcMain.handle('workspaces:add', (_e, input: NewWorkspaceInput) => addWorkspace(input))

  ipcMain.handle('workspaces:remove', async (_e, id: string) => {
    // El worktree queda en disco a propósito: puede tener trabajo sin commitear.
    await (await backend()).kill(id)
    agents.delete(id)
    store.removeWorkspace(id)
  })

  // v0.5: renombrar / ícono. Responde con el espacio actualizado (la UI lo reemplaza en su lista).
  ipcMain.handle('workspaces:update', (_e, id: unknown, patch: unknown) => {
    if (typeof id !== 'string' || !store.workspace(id)) throw new Error('Ese espacio ya no existe.')
    const p = validateWorkspacePatch(patch)
    const next: Partial<Workspace> = {}
    if (p.name !== undefined) next.name = p.name
    if (p.icon !== undefined) next.icon = p.icon ?? undefined
    const ws = store.updateWorkspace(id, next)!
    if (p.icon === null) delete ws.icon
    return ws
  })

  // v0.5: abrir la carpeta del espacio. VS Code por su protocolo vscode:// (sin lanzar procesos ni shell).
  ipcMain.handle('workspaces:reveal', async (_e, id: unknown, target: unknown) => {
    const ws = typeof id === 'string' ? store.workspace(id) : undefined
    if (!ws) throw new Error('Ese espacio ya no existe.')
    if (!existsSync(ws.cwd) || !statSync(ws.cwd).isDirectory()) throw new Error(`No existe la carpeta ${ws.cwd}`)
    const t = target as RevealTarget
    if (t === 'folder') {
      const err = await shell.openPath(ws.cwd)
      if (err) throw new Error(err)
    } else if (t === 'vscode') {
      // Editor de Configuración. Bloc de notas (u otro) abre la carpeta en el Explorador.
      const editor = currentSettings().editor
      const scheme = EDITOR_SCHEME[editor]
      if (!scheme) {
        const err = await shell.openPath(ws.cwd)
        if (err) throw new Error(err)
      } else {
        // Cada tramo codificado (rutas con #, ?, espacios o acentos); la letra de unidad queda como está.
        const parts = ws.cwd.split(/[\\/]/).filter(Boolean).map((seg, k) => (k === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
        try {
          await shell.openExternal(`${scheme}://file/${parts.join('/')}/`)
        } catch {
          throw new Error(`No se pudo abrir ${editor}. ¿Está instalado?`)
        }
      }
    } else throw new Error('Destino inválido.')
  })

  ipcMain.handle('ui:openPanes', (_e, ids: string[]) => {
    if (Array.isArray(ids)) store.setOpenPanes(ids.filter((x) => typeof x === 'string'))
  })

  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })

  ipcMain.handle('pty:start', async (_e, id: string, cols: number, rows: number) => {
    const b = await backend()
    // Si ya corre (siguió viva en el daemon), solo se reconecta: no se rearma la cuenta ni el comando.
    const shellChoice = currentSettings().terminal.shell
    const spawn = b.isRunning(id)
      ? toSpawnSpec({ cwd: homedir(), env: {} }, cols, rows, shellChoice)
      : toSpawnSpec(specFor(id, b), cols, rows, shellChoice)
    const result = await b.start(id, spawn)
    if (store.workspace(id) && !agents.has(id)) setAgent(id, { state: 'idle', at: Date.now() })
    return result
  })
  ipcMain.on('pty:write', (_e, id: string, data: string) => {
    term?.write(id, String(data))
    for (const l of writeListeners) safe('pty-write', () => l(id, String(data)))
  })
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => term?.resize(id, cols, rows))
  ipcMain.handle('pty:kill', async (_e, id: string) => {
    await (await backend()).kill(id)
    if (store.workspace(id)) setAgent(id, { state: 'exited', at: Date.now() })
  })

  // Texto, rutas de archivos copiados o una imagen guardada como PNG (src/main/clipboard-paste.ts).
  ipcMain.handle('clipboard:read', () => clipboardForPaste())
  ipcMain.handle('clipboard:write', (_e, text: string) => {
    clipboard.writeText(String(text))
  })

  // Funciones (features): cada una con sus canales feat:<nombre>:<op>.
  for (const f of FEATURES) {
    const ctx: FeatureContext = {
      name: f.name,
      store,
      usage,
      backend,
      terminal: () => term,
      window: () => win,
      onWindow: (cb) => {
        windowListeners.push(cb)
        if (win) safe(f.name, () => cb(win!))
      },
      handle: (op, fn) => {
        ipcMain.handle(`feat:${f.name}:${op}`, (_e, ...args: unknown[]) => fn(...args))
      },
      emit: (event, ...args) => send(`feat:${f.name}:${event}`, ...args),
      ui: uiCommand,
      onHook: (cb) => hookListeners.push(cb),
      onPtyData: (cb) => dataListeners.push(cb),
      onPtyExit: (cb) => exitListeners.push(cb),
      onPtyWrite: (cb) => writeListeners.push(cb),
      agents: () => agents,
      setAgent,
      addWorkspace,
      removeWorkspace: async (id) => {
        await (await backend()).kill(id)
        agents.delete(id)
        store.removeWorkspace(id)
      },
      prepareAccount,
      restartTerminal: async (id) => {
        await (await backend()).kill(id)
        uiCommand({ type: 'restart-pane', id })
      },
      addClaudeCommandOverride: (fn) => commandOverrides.push(fn),
      log: (...a) => console.log(`[${f.name}]`, ...a)
    }
    try {
      await f.register(ctx)
    } catch (e) {
      console.error(`[función ${f.name}] no se pudo registrar:`, e)
    }
  }

  // Al salir: con «Terminales vivas» la conexión se suelta y el daemon sigue; apagado, se cierran sus terminales.
  let quitPrepared = false
  const finishQuit = (b: TerminalBackend | undefined): void => {
    for (const f of FEATURES) safe(f.name, () => f.dispose?.())
    b?.dispose()
  }
  app.on('before-quit', (e) => {
    if (quitPrepared) return
    const b = term
    // En proceso no hay daemon que las conserve: se espera el cierre ordenado igual (ver daemon/shutdown.ts).
    if (b && (!currentSettings().keepTerminalsAlive || b.info().mode === 'inprocess')) {
      e.preventDefault()
      quitPrepared = true
      void Promise.race([b.shutdown(), new Promise((r) => setTimeout(r, 5000))])
        .catch(() => undefined)
        .finally(() => {
          finishQuit(b)
          app.quit()
        })
      return
    }
    quitPrepared = true
    finishQuit(b)
  })
})

function createWindow(onShown?: () => void): void {
  // Ícono: en el instalado viene en resources/; en desarrollo, en build/.
  const iconPath = [join(process.resourcesPath, 'icon.png'), join(__dirname, '../../build/icon.png')].find((p) =>
    existsSync(p)
  )
  // Tema guardado ANTES de crear la ventana (sin destello) y tamaño/posición de la última vez.
  const chrome = initialChrome()
  const saved = loadWindowState()
  win = new BrowserWindow({
    width: saved.bounds?.width ?? 1500,
    height: saved.bounds?.height ?? 920,
    x: saved.bounds?.x,
    y: saved.bounds?.y,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: chrome.bg,
    show: false,
    title: 'Sloth',
    icon: iconPath,
    autoHideMenuBar: true,
    // Barra de título propia con la marca; Windows dibuja solo los botones de ventana.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: chrome.bg, symbolColor: chrome.symbol, height: 40 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      // Con la ventana minimizada u oculta, Chromium baja timers y dibujo.
      backgroundThrottling: true
    }
  })

  // Links externos al navegador; la ventana nunca navega fuera de la app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  win.webContents.on('before-input-event', (e, input) => {
    const wc = win?.webContents
    const next = wc ? zoomFor(input, wc.getZoomLevel()) : null
    if (!wc || next === null) return
    e.preventDefault()
    wc.setZoomLevel(next)
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadURL('app://ui/index.html')

  // Se muestra cuando ya pintó (la pantalla de carga de index.html), maximizada si quedó así.
  win.once('ready-to-show', () => {
    if (!win) return
    // Con escala de pantalla ≠ 100 %, Electron redondea el tamaño inicial hacia arriba unos px:
    // se reaplica el tamaño guardado para que la ventana no crezca en cada reinicio.
    if (saved.bounds) win.setBounds(saved.bounds)
    if (saved.maximized) win.maximize()
    win.show()
    onShown?.()
  })
  trackWindowState(win)

  win.on('closed', () => (win = null))
  for (const cb of windowListeners) {
    try {
      cb(win)
    } catch (e) {
      console.error('[función] onWindow:', e)
    }
  }
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('window-all-closed', () => app.quit())

/** Editores de «Abrir en editor»: protocolo para abrir una carpeta. Bloc de notas no tiene: usa el Explorador. */
const EDITOR_SCHEME: Record<string, string> = { 'VS Code': 'vscode', Cursor: 'cursor', Windsurf: 'windsurf' }
