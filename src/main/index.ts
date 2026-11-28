import { app, BrowserWindow, clipboard, dialog, ipcMain, net, powerMonitor, protocol, session, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { pathToFileURL } from 'node:url'
import { normalize, sep } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { homedir, totalmem } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from './store'
import { accountStatus, createAccount, motivoNoAgregarCuenta } from './accounts'
import { hayNode, helperHook, installInto, notifyScriptPath, stateForEvent, writeHookScript, type HookEventPayload } from './hooks'
import { esFalsoFinal, pendientes, registrar as registrarFondo, venceEn, type Fondo } from './segundo-plano-core'
import { baseEnv, toSpawnSpec, type PtySpec } from './ptys'
import { pastePayload } from './shell-args'
import { avisar } from './avisos'
import { avisoPrimerMensajeAMano, destinoPrimerMensaje } from './primer-mensaje'
import { iniciarLogger, logger } from './logger-global'
import { marcarCrashPrevio } from './diag/estado'
import { cerrarSesion, iniciarSesion } from './sesion-marcador'
import { textoSeguro } from './diag/texto-seguro'
import { argvPanelCuenta, armarEnvCuenta, proveedorDe, proveedorExigido, type Proveedor } from './proveedores'
import { NOMBRE_PROVEEDOR, capacidadesDe, esProveedorId, motivoNoAgregar, motivoSinCapacidad } from '../shared/proveedores'
import { lectorLimites, limitesDeCuenta } from './codex-limites'
import type { LecturaLimitesCodex } from '../shared/celular'
import { avisarNotify, desinstalarNotify, prepararNotify } from './codex-notify'
import { entornoDeTerminal } from './hook-env-core'
import { alEventoDeRust, atiendeRust, CANALES_DEL_NUCLEO_EN_RUST, pedirAlNucleo, rustEsDueno } from './rust-features'
import { agentesRust, terminalRemota, terminalesRust } from './nucleo-rust'
import { escucharSesionDeRust } from './features/chat'
import { detectarAgentes, powerShell7Disponible } from './agentes'
import { AVISO_POWERSHELL_7 } from './copilot-exe'
import { initialPromptProblem } from '../shared/initial-prompt'
import { nextAgentState, salidaDeDoneSinHooks, type AgentInput } from './agent-machine'
import { createTerminalBackend, type PendingPermission, type TerminalBackend } from './daemon-client'
import { clipboardForPaste } from './clipboard-paste'
import { createWorktree } from './git'
import { validBranchName } from './features/git-run'
import { normTicketId, TEMPLATE_COLOR_KEYS, validBranch } from '../shared/templates-shared'
import { baseSettingsFor, syncSharedSetup, unshareSetup } from './setup'
import { UsageScanner } from './usage'
import { FEATURES } from './features'
import { registrarActividad } from './features/perfiles'
import { hookTokenDe } from '../daemon/auth'
import { APP_ID } from '../shared/app-id'
import { currentSettings, initialChrome } from './features/settings'
import { validateWorkspacePatch } from './workspace-patch'
import { loadWindowState, trackWindowState } from './window-state'
import { dimValida, idValido, origenConfiable, permisoChromium } from './ipc-guard'
import { zoomFor } from '../shared/zoom-keys'
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
import { cambiandoDePerfil, iniciarPerfiles, marcarCambioDePerfil, raizDatos, rutaPerfil } from './perfil'
import { decidirCierreTerminales, esTerminalPropia, terminalesAjenas } from './perfiles-core'

let win: BrowserWindow | null = null
const windowListeners: ((w: BrowserWindow) => void)[] = []
// Con Rust como dueño del estado (cáscara de Tauri) este proceso no lleva el estado de los agentes ni las terminales:
// los ve en la copia que empuja Rust y le pide los cambios (ver src/main/rust-features.ts).
const enRust = rustEsDueno()
const agents = enRust ? agentesRust : new Map<string, AgentStatus>()

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function setAgent(wsId: string, status: AgentStatus): void {
  agents.set(wsId, status)
  send('agent:status', wsId, status)
}

/** Aplica una entrada del ciclo de vida (agent-machine.ts). Devuelve el estado nuevo, o undefined si no cambió nada. */
function moveAgent(wsId: string, input: AgentInput, extra: { detail?: string; at?: number } = {}): AgentStatus | undefined {
  const state = nextAgentState(agents.get(wsId)?.state, input)
  if (!state) return undefined
  const status = { state, detail: extra.detail, at: extra.at ?? Date.now() }
  setAgent(wsId, status)
  return status
}

const textoLog = (a: unknown[]): string => a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.message : textoSeguro(x))).join(' ')

app.setName('Sloth')
// Sin el AUMID del acceso directo, Windows descarta las notificaciones del sistema en silencio.
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)
// Instancia de prueba al lado de la instalada: otra carpeta de datos = otro lock, otro daemon, otras cuentas.
if (process.env.SLOTH_USER_DATA) app.setPath('userData', process.env.SLOTH_USER_DATA)
const instanciaUnica = app.requestSingleInstanceLock()
if (!instanciaUnica) app.quit()

// Antes de whenReady para que queden registrados también los errores de arranque. La segunda instancia
// (la que cierra enseguida) no toca el log ni el marcador: son de la primera.
const logsDir = join(raizDatos(), 'logs')
let inicioSesion = Date.now()
if (instanciaUnica) {
  iniciarLogger(logsDir)
  const sesion = iniciarSesion(logsDir)
  inicioSesion = sesion.inicio
  marcarCrashPrevio(sesion.crashPrevio)
  logger.info('main', `Sloth ${app.getVersion()} arrancó${sesion.crashPrevio ? ' (la sesión anterior no cerró limpia)' : ''}`)
}

let errorMostrado = false
// Un throw dentro de estos handlers mata el proceso sin diálogo, peor que no haber registrado nada.
function sinLanzar(fn: () => void): void {
  try {
    fn()
  } catch (e) {
    console.error('[diagnóstico] falló el registro de un error:', e)
  }
}
process.on('uncaughtException', (e) =>
  sinLanzar(() => {
    logger.error('main', e)
    if (errorMostrado) return
    errorMostrado = true
    dialog.showErrorBox('Sloth tuvo un error inesperado', 'Quedó registrado en el log. Podés copiar el diagnóstico desde la paleta (Ctrl+K).')
  })
)
process.on('unhandledRejection', (e) =>
  sinLanzar(() => {
    // Con un listener propio Node deja de imprimir el rechazo: en desarrollo lo seguimos viendo en la consola.
    if (!app.isPackaged) console.error(e)
    logger.error('main', e)
  })
)
app.on('render-process-gone', (_e, _wc, d) =>
  sinLanzar(() => {
    if (d.reason !== 'clean-exit') logger.error('renderer', `se cayó el proceso de la ventana (${d.reason}, código ${d.exitCode})`)
  })
)
app.on('child-process-gone', (_e, d) =>
  sinLanzar(() => {
    if (d.reason !== 'clean-exit') logger.error('proceso-hijo', `se cayó ${d.type}${d.name ? ` ${d.name}` : ''} (${d.reason}, código ${d.exitCode})`)
  })
)

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
  // La segunda instancia sigue unos instantes después de app.quit(): no puede llegar a la migración de perfiles ni a nada que escriba.
  if (!instanciaUnica) return
  // Con perfiles ya creados que no se pueden usar no hay un lugar seguro donde trabajar (la raíz quedó congelada): se avisa y no se toca nada.
  const arranque = iniciarPerfiles()
  if (arranque.bloqueado) {
    cerrarSesion(logsDir, inicioSesion)
    dialog.showErrorBox('Sloth no puede abrir tus perfiles', `${arranque.bloqueado}

No toqué ninguno de tus datos. Cerrá otras copias de Sloth, revisá que ningún antivirus tenga esos archivos y volvé a abrir Sloth.`)
    app.exit(1)
    return
  }
  serveRenderer()
  const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
  session.defaultSession.setPermissionRequestHandler((_wc, permiso, cb, d) => cb(permisoChromium(permiso, origenConfiable(d.requestingUrl, devUrl), 'mediaTypes' in d ? d.mediaTypes : undefined)))
  session.defaultSession.setPermissionCheckHandler((_wc, permiso, origin, d) =>
    permisoChromium(permiso, origenConfiable(d.requestingUrl ?? origin, devUrl), 'mediaType' in d && d.mediaType ? [d.mediaType] : undefined)
  )
  const store = new Store()
  // La ventana se crea antes que nada más: el primer render no espera a daemon, escaneos ni registros.
  // Los handlers de las funciones se registran en este mismo turno (antes de que el renderer pida nada).
  // Trabajo que no hace falta para pintar (setup de cada cuenta, daemon de terminales) va después de mostrar.
  createWindow(() =>
    setTimeout(() => {
      // Con Rust como dueño, Rust prepara las cuentas y se conecta al daemon por su cuenta.
      if (enRust) return void backend()
      for (const acc of store.accounts) safe('preparar cuenta', () => prepareAccount(acc))
      void backend()
    }, 1500).unref()
  )

  writeHookScript()
  const usage = new UsageScanner()
  const hookListeners: ((p: HookEventPayload) => void)[] = []
  const fondos = new Map<string, Fondo>()
  const dataListeners: ((id: string, chunks: PtyChunk[]) => void)[] = []
  const exitListeners: ((id: string, code: number) => void)[] = []
  const writeListeners: ((id: string, data: string) => void)[] = []
  const prepareListeners: ((acc: Account) => void)[] = []
  const removeListeners: ((acc: Account) => void)[] = []
  const commandOverrides: ((ws: Workspace, acc: Account) => string | undefined)[] = []
  // Las funciones que en Tauri atiende Rust no pueden sumar un reemplazo acá: piden retomar por `pty:resumeOnce`.
  const retomarUnaVez = new Map<string, { sessionId: string; accountId: string }>()
  commandOverrides.push((ws, acc) => {
    const r = retomarUnaVez.get(ws.id)
    if (!r || r.accountId !== acc.id) return undefined
    retomarUnaVez.delete(ws.id)
    return `claude --resume ${r.sessionId}`
  })
  /** Primer mensaje que no se pudo pasar como argumento: se pega en el primer SessionStart del espacio. */
  const pendingPaste = new Map<string, { text: string; until: number }>()
  const safe = (name: string, fn: () => void): void => {
    try {
      fn()
    } catch (e) {
      console.error(`[función] ${name}:`, e)
      logger.error(name, e)
    }
  }
  const uiCommand = (cmd: UiCommand): void => send('ui:command', cmd)

  /** Evento de hook de Claude → estado del espacio (+ aviso de Windows si la ventana no está enfocada). */
  function onHook(p: HookEventPayload): void {
    const ahora = Date.now()
    registrarFondo(fondos, p, ahora)
    const n = pendientes(fondos, p.ws, ahora)
    // Con un shell de fondo corriendo, terminar el turno no es «terminó» ni «te espera»: no se avisa.
    if (esFalsoFinal(p, n)) p = { ...p, enFondo: n }
    for (const l of hookListeners) safe('hook', () => l(p))
    if (p.event === 'SessionStart') pasteInitialPrompt(p.ws)
    const ws = store.workspace(p.ws)
    if (!ws) return
    const { state, detail } = p.enFondo
      ? { state: 'working' as const, detail: p.enFondo === 1 ? 'Shell en segundo plano' : `${p.enFondo} shells en segundo plano` }
      : stateForEvent(p)
    const status = moveAgent(ws.id, { hook: state }, { detail, at: p.at ?? ahora })
    if (status && p.enFondo) {
      const vence = venceEn(fondos, ws.id, ahora)
      // Si el aviso del shell nunca llega, no queda «trabajando» para siempre.
      if (vence !== null)
        setTimeout(() => {
          if (agents.get(ws.id) === status) setAgent(ws.id, { state: 'done', at: Date.now() })
        }, vence - ahora + 1000).unref()
    }
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
  // El daemon es uno para todos los perfiles: las que ya corrían y no son de un espacio de este perfil no se tocan ni se escuchan.
  const ajenas = new Set<string>()
  const esAjena = (id: string): boolean => ajenas.has(id)
  let term: TerminalBackend | undefined
  let termPromise: Promise<TerminalBackend> | undefined
  function backend(): Promise<TerminalBackend> {
    if (enRust && !termPromise) {
      // Lo que pasa en las terminales ya lo atendió Rust (UI, agentes, permisos): acá solo llega a las funciones.
      const b = terminalRemota
      term = b
      b.on('data', (id: string, chunks: PtyChunk[]) => {
        for (const l of dataListeners) safe('pty-data', () => l(id, chunks))
      })
      b.on('exit', (id: string, code: number) => {
        for (const l of exitListeners) safe('pty-exit', () => l(id, code))
      })
      b.on('hook', (p: HookEventPayload) => {
        for (const l of hookListeners) safe('hook', () => l(p))
      })
      b.on('write', (id: string, data: string) => {
        for (const l of writeListeners) safe('pty-write', () => l(id, data))
      })
      termPromise = Promise.resolve(b)
    }
    if (!termPromise) {
      termPromise = createTerminalBackend({
        userDataDir: raizDatos(),
        appVersion: app.getVersion(),
        resourcesDir: app.isPackaged ? process.resourcesPath : undefined,
        projectRoot: app.isPackaged ? undefined : app.getAppPath(),
        log: (...a: unknown[]) => {
          console.log('[terminales]', ...a)
          logger.info('terminales', textoLog(a))
        }
      }).then(async (b) => {
        term = b
        b.on('data', (id: string, chunks: PtyChunk[]) => {
          if (esAjena(id)) return
          send('pty:data', id, chunks)
          for (const l of dataListeners) safe('pty-data', () => l(id, chunks))
        })
        b.on('exit', (id: string, code: number) => {
          if (esAjena(id)) {
            ajenas.delete(id)
            return
          }
          send('pty:exit', id, code)
          for (const l of exitListeners) safe('pty-exit', () => l(id, code))
          // Un espacio dormido sigue «Dormido» (su terminal se cerró a propósito).
          if (store.workspace(id)) moveAgent(id, 'exit')
        })
        b.on('hook', (p: HookEventPayload) => {
          if (!esAjena(p.ws)) onHook(p)
        })
        b.on('permission', onPermission)
        b.on('permission-resolved', (id: string) => send('permission:resolved', id))
        b.on('disconnect', () => {
          // Se perdió el daemon y no se pudo relanzar: el próximo pedido crea otro backend.
          console.warn('[terminales] desconectado del daemon')
          logger.aviso('terminales', 'desconectado del daemon')
          if (term === b) {
            term = undefined
            termPromise = undefined
          }
        })
        // Rehidratar: estado de los agentes que siguieron trabajando con la app cerrada.
        const sessions = await b.list().catch(() => [])
        const running = new Set(sessions.filter((x) => x.running).map((x) => x.id))
        const propia = (id: string): boolean => esTerminalPropia(id, (x) => store.workspace(x) !== undefined, (x) => store.account(x) !== undefined)
        for (const id of terminalesAjenas(sessions, propia)) ajenas.add(id)
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
    const p = proveedorExigido(acc)
    return armarEnvCuenta(p, acc, baseEnv(p.quitarDelEntorno))
  }

  /** Si hay alguna terminal abierta con esta cuenta (Claude puede estar escribiendo su .claude.json). */
  function accountBusy(accountId: string): boolean {
    const b = term
    if (!b) return false
    if (b.isRunning(loginPaneId(accountId))) return true
    return store.workspaces.some((w) => w.accountId === accountId && b.isRunning(w.id))
  }

  // Leer los límites de Codex lanza su app-server, que puede renovar el token de la cuenta: con una terminal abierta de la
  // misma cuenta (o sin saber todavía cuáles hay, porque el backend no arrancó) no se lanza.
  lectorLimites.conectarPermiso((id) => {
    const a = store.account(id)
    if (!a || a.limitesExperimentales !== true) return 'apagada'
    return term && !accountBusy(id) ? 'ok' : 'en-uso'
  })

  const setupAvisados = new Set<string>()

  /** Deja la cuenta lista antes de abrir Claude: settings + hooks y tu setup compartido. */
  function prepareAccount(acc: Account): void {
    if (enRust) {
      pedirAlNucleo('prepareAccount', acc.id).catch((e: unknown) => logger.error('preparar cuenta', e))
      return
    }
    // Una cuenta de un agente que esta versión no conoce no se toca: ni hooks ni setup de Claude en su carpeta.
    const p = proveedorDe(acc)
    if (!p) return
    p.prepararCarpeta(acc.configDir)
    if (p.id === 'codex' && p.capacidades.avisoTurno) safe('notify', () => ajustarNotify(acc))
    // Los hooks y el setup compartido son de Claude Code: con otro agente ni se escriben.
    if (!p.capacidades.hooks) return
    installInto(acc.configDir, baseSettingsFor(acc))
    const report = syncSharedSetup(acc, !accountBusy(acc.id))
    if (report.skipped.length) {
      // Cada terminal que arranca con la cuenta vuelve a dar el mismo motivo: se avisa una vez por cuenta y causa.
      const motivo = report.skipped.join('; ')
      const clave = `${acc.id}|${motivo}`
      if (!setupAvisados.has(clave)) {
        setupAvisados.add(clave)
        console.warn(`[setup] ${acc.label}:`, motivo)
        // Sin el label: la gente le pone su nombre y el diagnóstico se comparte.
        logger.aviso('setup', `cuenta ${store.accounts.indexOf(acc) + 1}: ${motivo}`)
      }
    }
    for (const l of prepareListeners) safe('preparar cuenta', () => l(acc))
  }

  if (enRust)
    alEventoDeRust('rust.cuentaPreparada', (a) => {
      const acc = typeof a === 'object' && a !== null ? store.account((a as Account).id) : undefined
      const p = acc && proveedorDe(acc)
      if (!acc || !p) return
      if (p.id === 'codex' && p.capacidades.avisoTurno) safe('notify', () => ajustarNotify(acc))
      for (const l of prepareListeners) safe('preparar cuenta', () => l(acc))
    })

  /** Con el aviso activado deja el `notify` de Sloth en la cuenta; apagado, saca el que puso Sloth. Devuelve el motivo si no quedó como se pidió. */
  function ajustarNotify(acc: Account): string | undefined {
    let motivo: string | undefined
    if (acc.avisoDeTurno === true) {
      try {
        // Sin config.toml queda el de siempre (con el almacén de credenciales en archivo), no uno que solo tenga el notify.
        proveedorExigido(acc).prepararCarpeta(acc.configDir)
        motivo = helperHook() ? prepararNotify(acc.configDir, helperHook()!.exe, 'notify') : prepararNotify(acc.configDir, hayNode() ? 'node' : undefined, notifyScriptPath())
      } catch (e) {
        motivo = `No pude preparar la carpeta de la cuenta de Codex (${(e as NodeJS.ErrnoException).code ?? 'error'}).`
      }
    } else {
      motivo = desinstalarNotify(acc.configDir)
    }
    if (motivo) avisarNotify(motivo)
    return motivo
  }

  function hasPreviousConversation(acc: Account, cwd: string): boolean {
    return proveedorExigido(acc).hayConversacionPrevia(acc.configDir, cwd)
  }

  function pasteInitialPrompt(wsId: string): void {
    const s = pendingPaste.get(wsId)
    if (!s) return
    pendingPaste.delete(wsId)
    // Recién acá se gasta: si Sloth se cerró antes de pegarlo, la próxima terminal lo vuelve a intentar.
    if (store.workspace(wsId)) store.updateWorkspace(wsId, { initialPromptUsed: true })
    const name = store.workspace(wsId)?.name ?? 'un espacio'
    if (Date.now() > s.until) return avisar(`Claude tardó en arrancar en «${name}» y no le pegué el primer mensaje: escribilo a mano.`)
    // Sin Enter: si Claude se cerró en el medio, el texto queda en la línea de la shell sin ejecutarse.
    setTimeout(() => {
      void backend().then((b) => b.write(wsId, pastePayload(s.text)))
    }, 1500)
  }

  /** argv de Claude para la terminal del espacio (la shell lo quota según su sintaxis en ptys.ts). */
  function claudeCommand(ws: Workspace, acc: Account): string[] | undefined {
    const p = proveedorExigido(acc)
    // Los reemplazos (p. ej. retomar tras mover de cuenta) escriben comandos de `claude`: con otro agente no corren.
    if (p.capacidades.overrideClaude) {
      for (const o of commandOverrides) {
        let cmd: string | undefined
        safe('override', () => (cmd = o(ws, acc)))
        if (cmd) return cmd.trim().split(/\s+/)
      }
    }
    if (!ws.autoStartClaude) return undefined
    // Un «!» inicial Claude Code lo correría como comando de la terminal: ese prompt no se manda.
    if (ws.initialPrompt && !ws.initialPromptUsed && !initialPromptProblem(ws.initialPrompt)) return p.argvInteractivo({ prompt: ws.initialPrompt })
    return p.argvInteractivo({ continuar: ws.resume !== false && hasPreviousConversation(acc, ws.cwd) })
  }

  /** Con Claude, un exe que no se encuentra sigue como siempre (la shell lo busca). Con otro agente es un error claro: nunca cae a `claude`. */
  function exeDe(p: Proveedor): string | undefined {
    const exe = p.resolverExe()
    if (exe === undefined && p.id !== 'claude') throw new Error(`No encontré ${NOMBRE_PROVEEDOR[p.id]} en el PATH. Instalalo con: ${p.comoInstalar}`)
    return exe
  }

  function specFor(paneId: string, b: TerminalBackend): PtySpec {
    if (isLoginPane(paneId)) {
      const acc = requireAccount(accountIdFromLoginPane(paneId))
      const p = proveedorExigido(acc)
      prepareAccount(acc)
      // Primer arranque con esta carpeta: Claude pide tema y login; Codex corre `codex login` solo si todavía no hay sesión.
      const exe = exeDe(p)
      return { cwd: homedir(), env: accountEnv(acc), claude: argvPanelCuenta(p, p.estadoLogin(acc.configDir).loggedIn), claudeExe: exe }
    }
    const ws = store.workspace(paneId)
    if (!ws) throw new Error('Ese espacio ya no existe.')
    const acc = requireAccount(ws.accountId)
    const p = proveedorExigido(acc)
    if (!existsSync(ws.cwd)) throw new Error(`No existe la carpeta ${ws.cwd}`)
    prepareAccount(acc)
    const env = entornoDeTerminal(accountEnv(acc), p.capacidades, acc.avisoDeTurno === true, ws.id, () => ({ url: b.hookUrl, token: hookTokenDe(b.hookToken, ws.id) }))
    const claude = claudeCommand(ws, acc)
    return { cwd: ws.cwd, env, claude, claudeExe: claude ? exeDe(p) : undefined }
  }

  // Un iframe o una página que se cuele en la ventana no puede mandar pedidos al núcleo: solo vale el origen de la app.
  const desdeLaApp = (e: { senderFrame?: { url: string } | null }): boolean => origenConfiable(e.senderFrame?.url, devUrl)
  function handle<A extends unknown[]>(canal: string, fn: (e: IpcMainInvokeEvent, ...args: A) => unknown): void {
    if (enRust && CANALES_DEL_NUCLEO_EN_RUST.has(canal)) return
    ipcMain.handle(canal, (e, ...args) => {
      if (!desdeLaApp(e)) throw new Error('Pedido de un origen no permitido.')
      return fn(e, ...(args as A))
    })
  }
  function on<A extends unknown[]>(canal: string, fn: (e: IpcMainEvent, ...args: A) => void): void {
    if (enRust && CANALES_DEL_NUCLEO_EN_RUST.has(canal)) return
    ipcMain.on(canal, (e, ...args) => {
      if (desdeLaApp(e)) fn(e, ...(args as A))
    })
  }

  handle('state:get', async () => {
    // «Reabrir los espacios»: si está apagado, solo vuelven los paneles cuyas terminales siguen vivas en el daemon.
    let openPanes = store.openPanes
    if (!currentSettings().reopenSpaces) {
      const b = await backend().catch(() => undefined)
      openPanes = b ? openPanes.filter((id) => b.isRunning(id)) : []
    }
    return { accounts: store.accounts, workspaces: store.workspaces, openPanes, agents: Object.fromEntries(agents), soloLectura: store.soloLectura }
  })

  handle('permission:pending', () =>
    (term?.pendingPermissions() ?? []).filter((r) => store.workspace(r.ws)).map(toPrompt)
  )

  handle('daemon:info', async (): Promise<DaemonInfo> => {
    const b = await backend()
    const sessions = await b.list().catch(() => [])
    return { ...b.info(), sessions: sessions.filter((x) => x.running).length }
  })

  handle('daemon:shutdown', async () => {
    const b = await backend()
    const sessions = await b.list().catch(() => [])
    await b.shutdown()
    b.dispose()
    term = undefined
    termPromise = undefined
    for (const x of sessions) {
      if (!x.running) continue
      send('pty:exit', x.id, -1)
      if (store.workspace(x.id)) moveAgent(x.id, 'exit')
    }
  })

  handle('accounts:agentes', () => detectarAgentes())

  handle('accounts:add', async (_e, label: unknown, proveedor?: unknown) => {
    if (typeof label !== 'string' || label.length > 80) throw new Error('El nombre de la cuenta tiene que ser un texto de hasta 80 caracteres.')
    if (proveedor !== undefined && !esProveedorId(proveedor)) throw new Error('Agente inválido.')
    store.exigirEscritura()
    const motivo = proveedor === undefined ? undefined : motivoNoAgregarCuenta(store.accounts, proveedor)
    if (motivo) throw new Error(motivo)
    if (proveedor === 'copilot' && !(await powerShell7Disponible())) throw new Error(AVISO_POWERSHELL_7)
    const nueva = createAccount(label, proveedor)
    const acc = { ...nueva, shareSetup: proveedorExigido(nueva).capacidades.setupCompartido }
    store.addAccount(acc)
    prepareAccount(acc)
    return acc
  })

  handle('accounts:usage', () => usage.scan(store.accounts))

  handle('accounts:setShareSetup', (_e, id: unknown, share: unknown) => {
    if (!idValido(id) || typeof share !== 'boolean') throw new Error('Pedido inválido.')
    const previa = store.accounts.find((a) => a.id === id)
    if (previa && !proveedorExigido(previa).capacidades.setupCompartido) throw new Error(motivoSinCapacidad(previa, 'setupCompartido'))
    const acc = store.updateAccount(id, { shareSetup: share })
    if (!acc) throw new Error('Esa cuenta ya no existe.')
    proveedorExigido(acc)
    if (!acc.shareSetup) {
      unshareSetup(acc)
      installInto(acc.configDir, {})
      return null
    }
    installInto(acc.configDir, baseSettingsFor(acc))
    return syncSharedSetup(acc, !accountBusy(acc.id))
  })

  handle('accounts:setLimitesExperimentales', (_e, id: unknown, activo: unknown) => {
    if (!idValido(id) || typeof activo !== 'boolean') throw new Error('Pedido inválido.')
    const cuenta = store.account(id)
    if (!cuenta) throw new Error('Esa cuenta ya no existe.')
    if (capacidadesDe(cuenta)?.limitesExperimental !== true) throw new Error(motivoSinCapacidad(cuenta, 'limitesExperimental'))
    store.exigirEscritura()
    store.updateAccount(id, { limitesExperimentales: activo })
    // Al apagar y prender se prueba de nuevo: ni la caché ni la espera tras un fallo sobreviven al switch.
    lectorLimites.olvidar(id)
  })

  handle('accounts:setAvisoDeTurno', (_e, id: unknown, activo: unknown) => {
    if (!idValido(id) || typeof activo !== 'boolean') throw new Error('Pedido inválido.')
    const cuenta = store.account(id)
    if (!cuenta) throw new Error('Esa cuenta ya no existe.')
    const p = proveedorExigido(cuenta)
    if (p.id !== 'codex' || !p.capacidades.avisoTurno) throw new Error(motivoSinCapacidad(cuenta, 'avisoTurno') ?? 'Esta cuenta no usa el aviso de «terminó» de Codex.')
    store.exigirEscritura()
    const acc = store.updateAccount(id, { avisoDeTurno: activo })
    if (!acc) throw new Error('Esa cuenta ya no existe.')
    const motivo = ajustarNotify(acc)
    // Si no se pudo activar vuelve a apagado: no queda un switch prendido que no hace nada.
    if (motivo && activo) {
      store.updateAccount(id, { avisoDeTurno: false })
      throw new Error(motivo)
    }
  })

  // De a una cuenta: Ajustes muestra cada una apenas llega, sin esperar a las demás.
  handle('accounts:limitesCodex', async (_e, id: unknown): Promise<LecturaLimitesCodex> => {
    if (!idValido(id)) throw new Error('Pedido inválido.')
    // Hasta que el backend no arranca no se sabe qué terminales hay abiertas.
    await backend().catch(() => undefined)
    const cuenta = store.account(id)
    if (!cuenta || cuenta.limitesExperimentales !== true) return { tipo: 'sin-dato' }
    return limitesDeCuenta(cuenta, true)
  })

  handle('accounts:remove', async (_e, id: unknown) => {
    if (!idValido(id)) throw new Error('Pedido inválido.')
    const used = store.workspaces.filter((w) => w.accountId === id)
    if (used.length) throw new Error(`La usan ${used.length} espacio(s): ${used.map((w) => w.name).join(', ')}`)
    store.exigirEscritura()
    await (await backend()).kill(loginPaneId(id))
    const acc = store.account(id)
    if (acc) for (const l of removeListeners) safe('borrar cuenta', () => l(acc))
    store.removeAccount(id)
  })

  handle('accounts:statuses', () =>
    Object.fromEntries(store.accounts.map((a) => [a.id, accountStatus(a)]))
  )

  // Las funciones de Rust que tocan la config de una cuenta (el MCP del chat) preguntan antes si tiene terminales abiertas.
  // `conocidas` es false hasta que el backend arranca y reporta las que sobrevivieron en el daemon.
  handle('pty:cuentaOcupada', async (_e, id?: unknown) => {
    if (id !== undefined && id !== null && !idValido(id)) throw new Error('Pedido inválido.')
    const b = await backend().catch(() => undefined)
    const conocidas = !!b && term !== undefined
    return { conocidas, ocupada: typeof id === 'string' ? !conocidas || accountBusy(id) : false }
  })

  async function addWorkspace(input: NewWorkspaceInput): Promise<Workspace> {
    store.exigirEscritura()
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
    const promptProblem = initialPrompt ? initialPromptProblem(initialPrompt) : undefined
    if (promptProblem) throw new Error(promptProblem)
    const branch = input.branch?.trim() || undefined
    if (branch && !validBranchName(branch)) throw new Error('La rama no es un nombre válido.')
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
  handle('workspaces:add', (_e, input: unknown) => {
    if (typeof input !== 'object' || input === null || !idValido((input as { accountId?: unknown }).accountId)) throw new Error('Pedido inválido.')
    return addWorkspace(input as NewWorkspaceInput)
  })

  handle('workspaces:remove', async (_e, id: unknown) => {
    if (!idValido(id)) throw new Error('Pedido inválido.')
    store.exigirEscritura()
    // El worktree queda en disco a propósito: puede tener trabajo sin commitear.
    await (await backend()).kill(id)
    agents.delete(id)
    store.removeWorkspace(id)
  })

  // v0.5: renombrar / ícono. Responde con el espacio actualizado (la UI lo reemplaza en su lista).
  handle('workspaces:update', (_e, id: unknown, patch: unknown) => {
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
  handle('workspaces:reveal', async (_e, id: unknown, target: unknown) => {
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

  handle('ui:openPanes', (_e, ids: string[]) => {
    if (Array.isArray(ids)) store.setOpenPanes(ids.filter((x) => typeof x === 'string'))
  })

  handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })

  handle('pty:start', async (_e, id: unknown, cols: unknown, rows: unknown) => {
    if (!idValido(id) || !dimValida(cols) || !dimValida(rows)) throw new Error('Pedido inválido.')
    const b = await backend()
    if (esAjena(id)) throw new Error('Esa terminal es de otro perfil.')
    // Si ya corre (siguió viva en el daemon), solo se reconecta: no se rearma la cuenta ni el comando.
    const shellChoice = currentSettings().terminal.shell
    const running = b.isRunning(id)
    const spec: PtySpec = running ? { cwd: homedir(), env: {} } : specFor(id, b)
    const { spawn, paste } = toSpawnSpec(spec, cols, rows, shellChoice)
    const result = await b.start(id, spawn)
    tamPc.set(id, { cols, rows })
    const ws = running ? undefined : store.workspace(id)
    if (ws) registrarActividad({ t: Date.now(), tipo: 'espacio', espacio: ws.name })
    if (ws?.initialPrompt && !ws.initialPromptUsed && spec.claude?.includes('--')) {
      const acc = store.account(ws.accountId)
      const p = acc && proveedorDe(acc)
      const destino = destinoPrimerMensaje(p ? p.capacidades.hooks : true, paste)
      if (destino === 'pegar' && paste) pendingPaste.set(id, { text: paste, until: Date.now() + 2 * 60 * 1000 })
      else {
        store.updateWorkspace(id, { initialPromptUsed: true })
        if (destino === 'a-mano' && p) avisar(avisoPrimerMensajeAMano(NOMBRE_PROVEEDOR[p.id], ws.name))
      }
    }
    if (store.workspace(id)) moveAgent(id, 'start')
    return result
  })
  // Las terminales siguen siendo de este proceso: las funciones que atiende Rust las consultan por estos canales.
  handle('pty:running', async (_e, id: unknown) => {
    if (!idValido(id)) throw new Error('Pedido inválido.')
    return (await backend()).isRunning(id)
  })
  handle('pty:resumeOnce', (_e, wsId: unknown, accountId: unknown, sessionId: unknown) => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!idValido(wsId) || !idValido(accountId) || typeof sessionId !== 'string' || !uuid.test(sessionId)) throw new Error('Pedido inválido.')
    if (!store.workspace(wsId)) throw new Error('Ese espacio ya no existe.')
    retomarUnaVez.set(wsId, { sessionId, accountId })
  })
  // El tamaño que le dio la PC a cada terminal: el celu la muestra igual y, si la achica, después la devuelve a este.
  const tamPc = new Map<string, { cols: number; rows: number }>()
  const escribirPty = (id: string, data: string): void => {
    term?.write(id, data)
    for (const l of writeListeners) safe('pty-write', () => l(id, data))
    // Un agente sin hooks (Codex) no manda nada que lo saque de «terminó» al empezar otro turno. Lo que escribís en su
    // terminal sí: vuelve a «idle» (no a «working», que no se puede saber) y el próximo aviso de terminó suena de nuevo.
    const ws = store.workspace(id)
    const acc = ws && store.account(ws.accountId)
    if (acc && salidaDeDoneSinHooks(agents.get(id)?.state, capacidadesDe(acc)?.hooks !== false, data)) moveAgent(id, { hook: 'idle' })
  }
  on('pty:write', (_e, id: unknown, data: unknown) => {
    if (!idValido(id) || typeof data !== 'string' || esAjena(id)) return
    escribirPty(id, data)
  })
  on('pty:resize', (_e, id: unknown, cols: unknown, rows: unknown) => {
    if (!idValido(id) || !dimValida(cols) || !dimValida(rows) || esAjena(id)) return
    tamPc.set(id, { cols, rows })
    term?.resize(id, cols, rows)
  })
  handle('pty:kill', async (_e, id: unknown) => {
    if (!idValido(id)) throw new Error('Pedido inválido.')
    const b = await backend()
    if (esAjena(id)) throw new Error('Esa terminal es de otro perfil.')
    await b.kill(id)
    if (store.workspace(id)) moveAgent(id, 'exit')
  })

  // Texto, rutas de archivos copiados o una imagen guardada como PNG (src/main/clipboard-paste.ts).
  handle('clipboard:read', () => clipboardForPaste())
  handle('clipboard:write', (_e, text: unknown) => clipboard.writeText(String(text)))

  async function cerrarTerminalesAjenas(): Promise<number> {
    const b = await backend()
    let cerradas = 0
    for (const id of [...ajenas]) {
      try {
        await b.kill(id)
        ajenas.delete(id)
        cerradas++
      } catch (e) {
        logger.error('perfiles', e)
      }
    }
    return cerradas
  }

  // Como el cierre que conserva las terminales, pero sin pasar por el cierre de ventana (bandeja, confirmaciones).
  async function reiniciarPorPerfil(): Promise<void> {
    if (enRust) await pedirAlNucleo('cambioDePerfil')
    marcarCambioDePerfil()
    marcarCierreLimpio()
    quitPrepared = true
    const b = term
    if (b?.info().mode === 'inprocess') await Promise.race([b.shutdown(), new Promise((r) => setTimeout(r, 5000))]).catch(() => undefined)
    finishQuit(b)
    app.relaunch()
    app.exit(0)
  }

  // Funciones (features): cada una con sus canales feat:<nombre>:<op>.
  if (atiendeRust('chat')) {
    alEventoDeRust('aviso', (texto) => {
      if (typeof texto === 'string' && texto.length > 0 && texto.length <= 2000) avisar(texto)
    })
    safe('sesión del chat de Rust', () => escucharSesionDeRust((e) => logger.error('rust', e)))
  }
  if (enRust) {
    // Canales internos (la interfaz no los alcanza): Rust pregunta el comando de un espacio y avisa antes de borrar una cuenta.
    ipcMain.handle('nucleo:comando', (_e, ws: Workspace, acc: Account) => {
      for (const o of commandOverrides) {
        let cmd: string | undefined
        safe('override', () => (cmd = o(ws, acc)))
        if (cmd) return cmd
      }
      return null
    })
    ipcMain.handle('nucleo:cuentaBorrada', (_e, acc: Account) => {
      for (const l of removeListeners) safe('borrar cuenta', () => l(acc))
    })
  }
  const ctxRust = {
    writePty: (id: string, data: string): void => void pedirAlNucleo('write', id, data).catch((e: unknown) => logger.error('pty-write', e)),
    resizePty: (id: string, cols: number, rows: number): void => void pedirAlNucleo('resize', id, cols, rows).catch((e: unknown) => logger.error('pty-resize', e)),
    setAgent: (id: string, st: AgentStatus): void => {
      // Quien lo fija lo lee enseguida (dormir y despertar): queda ya en la copia y Rust lo confirma.
      agentesRust.set(id, st)
      pedirAlNucleo('setAgent', id, st).catch((e: unknown) => logger.error('agentes', e))
    }
  }
  for (const f of FEATURES) {
    if (atiendeRust(f.name)) continue
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
        handle(`feat:${f.name}:${op}`, (_e, ...args: unknown[]) => fn(...args))
      },
      emit: (event, ...args) => send(`feat:${f.name}:${event}`, ...args),
      ui: uiCommand,
      onHook: (cb) => hookListeners.push(cb),
      onPtyData: (cb) => dataListeners.push(cb),
      onPtyExit: (cb) => exitListeners.push(cb),
      onPtyWrite: (cb) => writeListeners.push(cb),
      writePty: (id, data) => {
        if (enRust) return ctxRust.writePty(id, data)
        if (!esAjena(id)) escribirPty(id, data)
      },
      ptySize: (id) => (enRust ? terminalesRust.tam.get(id) : tamPc.get(id)) ?? null,
      resizePty: (id, cols, rows) => {
        if (enRust) return ctxRust.resizePty(id, cols, rows)
        if (!esAjena(id)) term?.resize(id, cols, rows)
      },
      agents: () => agents,
      setAgent: enRust ? ctxRust.setAgent : setAgent,
      addWorkspace: enRust ? (input) => pedirAlNucleo<Workspace>('addWorkspace', input) : addWorkspace,
      removeWorkspace: async (id) => {
        if (enRust) return void (await pedirAlNucleo('removeWorkspace', id))
        store.exigirEscritura()
        await (await backend()).kill(id)
        agents.delete(id)
        store.removeWorkspace(id)
      },
      prepareAccount,
      accountBusy,
      terminalesAjenas: () => (enRust ? [...terminalesRust.ajenas] : [...ajenas]),
      cerrarTerminalesAjenas: enRust ? () => pedirAlNucleo<number>('cerrarAjenas') : cerrarTerminalesAjenas,
      reiniciarPorPerfil,
      onPrepareAccount: (cb) => prepareListeners.push(cb),
      onRemoveAccount: (cb) => removeListeners.push(cb),
      restartTerminal: async (id) => {
        await (await backend()).kill(id)
        uiCommand({ type: 'restart-pane', id })
      },
      addClaudeCommandOverride: (fn) => commandOverrides.push(fn),
      log: (...a) => {
        console.log(`[${f.name}]`, ...a)
        logger.info(f.name, textoLog(a))
      }
    }
    try {
      await f.register(ctx)
    } catch (e) {
      console.error(`[función ${f.name}] no se pudo registrar:`, e)
      logger.error(f.name, e)
    }
  }

  // El proceso de apoyo de Tauri retiene los pedidos de la UI que llegaron antes de que se registraran los canales, y
  // Rust espera a que las funciones fijen su estado inicial antes de entregar `state:get`.
  app.emit('main-listo')
  if (enRust) pedirAlNucleo('listo').catch((e: unknown) => logger.error('rust', e))

  /** De a una: node-pty en Windows no soporta cerrar varias a la vez (ver daemon/shutdown.ts). */
  async function cerrarTerminalesPropias(b: TerminalBackend): Promise<void> {
    const ids = [...store.workspaces.map((w) => w.id), ...store.accounts.map((a) => loginPaneId(a.id))]
    for (const id of ids) {
      if (!b.isRunning(id)) continue
      await b.kill(id).catch((e: unknown) => logger.error('perfiles', e))
    }
  }

  // Al salir: con «Terminales vivas» la conexión se suelta y el daemon sigue; apagado, se cierran sus terminales.
  let quitPrepared = false
  const finishQuit = (b: TerminalBackend | undefined): void => {
    for (const f of FEATURES) safe(f.name, () => f.dispose?.())
    b?.dispose()
  }
  // Se marca limpio apenas se decide cerrar: el instalador del updater o el apagado de Windows pueden matar
  // el proceso durante la espera del shutdown, y eso no es un cierre inesperado.
  const marcarCierreLimpio = (): void => {
    if (instanciaUnica) cerrarSesion(logsDir, inicioSesion)
  }
  // Windows no emite before-quit al apagar, reiniciar o cerrar sesión: solo estos dos avisos.
  powerMonitor.on('shutdown', marcarCierreLimpio)
  app.on('before-quit', (e) => {
    if (quitPrepared) return
    marcarCierreLimpio()
    if (enRust) {
      // Rust decide qué pasa con las terminales (conservarlas, cerrar las de este perfil o apagar el daemon).
      e.preventDefault()
      quitPrepared = true
      void Promise.race([pedirAlNucleo('cerrar'), new Promise((r) => setTimeout(r, 5000))])
        .catch((err: unknown) => logger.error('cierre', err))
        .finally(() => {
          finishQuit(undefined)
          app.quit()
        })
      return
    }
    const b = term
    // En proceso no hay daemon que las conserve: se espera el cierre ordenado igual (ver daemon/shutdown.ts).
    // Al cambiar de perfil el daemon las conserva para cuando se vuelva. Con terminales de otros perfiles
    // vivas, «Terminales vivas» apagado cierra solo las de este perfil: el daemon sigue con las de los demás.
    const cierre = decidirCierreTerminales({
      conservar: currentSettings().keepTerminalsAlive || cambiandoDePerfil(),
      enProceso: b?.info().mode === 'inprocess',
      hayAjenas: ajenas.size > 0
    })
    if (b && cierre !== 'conservar') {
      e.preventDefault()
      quitPrepared = true
      const cerrar = cierre === 'apagar' ? b.shutdown() : cerrarTerminalesPropias(b)
      void Promise.race([cerrar, new Promise((r) => setTimeout(r, 5000))])
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

  // Solo en desarrollo: el instalado nunca carga la interfaz desde una URL del entorno.
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
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

  win.on('session-end', () => cerrarSesion(logsDir, inicioSesion))
  win.on('closed', () => (win = null))
  for (const cb of windowListeners) {
    try {
      cb(win)
    } catch (e) {
      console.error('[función] onWindow:', e)
      logger.error('onWindow', e)
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
