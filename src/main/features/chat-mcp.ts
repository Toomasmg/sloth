import { execFile } from 'node:child_process'
import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import type { FeatureContext } from './context'
import type { ChatData } from './chat-data'
import type { Account } from '../../shared/types'
import type { ChatMcpAccountReg, ChatMcpAsk, ChatMcpView } from '../../shared/chat-mcp'
import { conGrant, debeRegistrar, hashToken, KEY_RE, MCP_LIMITS, modoRiesgoso, parsearConfig, sinGrant, validarCuentas, type McpConfig } from './chat-mcp-core'
import { crearAtencion } from './chat-mcp-atencion'
import { argsAlta, argsBaja, leerRegistro, MCP_SCRIPT_NAME, planificar, type Registro } from './chat-mcp-registro'
import { CHAT_MCP_SCRIPT } from './chat-mcp-script'
import { AVISO_PROVEEDOR_DESCONOCIDO, proveedorDe } from '../proveedores'
import { capacidadesDe, nombreProveedor } from '../../shared/proveedores'
import { hayNode, writeIfChanged } from '../hooks'
import { escribirJsonAtomico } from '../json-file'
import { carpetaFeatures, raizDatos } from '../perfil'

export interface ChatMcpDeps {
  data: ChatData
  isFocused(): boolean
  notify(title: string, body: string): void
}

const CONN_MS = 5000
const MAX_CONEXIONES = 16
const CLI_MS = 30_000
const REINTENTO_MS = 1500

function leerJsonSuave(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

const msgOf = (e: unknown): string => (e instanceof Error && e.message ? e.message.slice(0, 300) : 'Algo salió mal.')

/** Nombre nuevo en cada arranque: otro proceso no puede adelantarse a crearlo. */
function pipePath(userData: string): string {
  const r = randomBytes(12).toString('hex')
  return process.platform === 'win32' ? `\\\\.\\pipe\\sloth-chat-${r}` : join(userData, `chat-mcp-${r}.sock`)
}

function correrClaude(exe: string, args: string[], envCuenta: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      args,
      { env: { ...process.env, ...envCuenta }, windowsHide: true, timeout: CLI_MS, maxBuffer: 256 * 1024, encoding: 'utf8' },
      (err, _stdout, stderr) => {
        if (!err) return resolve()
        const detalle = String(stderr || err.message).trim().split('\n')[0].slice(0, 200)
        reject(new Error(`Claude Code no pudo cambiar su config: ${detalle}`))
      }
    )
  })
}

/**
 * Lado main del MCP del chat: el pipe local (solo con el interruptor prendido), tokens por cuenta y el
 * registro con el CLI de Claude Code. Los canales quedan en la función «chat» (feat:chat:mcp*).
 */
export function registerChatMcp(ctx: FeatureContext, deps: ChatMcpDeps): { dispose(): Promise<void> } {
  const userData = raizDatos()
  const scriptPath = join(userData, MCP_SCRIPT_NAME)
  const infoPath = join(userData, 'chat-mcp.json')
  const cfgPath = join(carpetaFeatures(), 'chat-mcp.json')
  const pipe = pipePath(userData)

  try {
    rmSync(infoPath, { force: true })
  } catch (e) {
    ctx.log('chat-mcp: no se pudo borrar el chat-mcp.json anterior:', msgOf(e))
  }

  let cfg: McpConfig = { enabled: false, cuentas: [], grants: [], tokens: {} }
  try {
    if (existsSync(cfgPath)) cfg = parsearConfig(JSON.parse(readFileSync(cfgPath, 'utf8')))
  } catch (e) {
    ctx.log('chat-mcp: config ilegible, queda apagado:', msgOf(e))
  }

  const regs = new Map<string, ChatMcpAccountReg>()
  const colas = new Map<string, Promise<void>>()
  let server: Server | undefined
  let reintento: ReturnType<typeof setTimeout> | undefined

  try {
    writeIfChanged(scriptPath, CHAT_MCP_SCRIPT)
  } catch (e) {
    ctx.log('chat-mcp: no se pudo escribir el script:', msgOf(e))
  }

  const existentes = (): string[] => ctx.store.accounts.map((a) => a.id)

  function view(): ChatMcpView {
    const ids = existentes()
    return {
      enabled: cfg.enabled,
      cuentas: cfg.cuentas.filter((id) => ids.includes(id)),
      grants: cfg.grants.filter((g) => ids.includes(g.accountId)),
      limits: {
        enviarPorMinuto: MCP_LIMITS.enviarPorMinuto,
        leerPorMinuto: MCP_LIMITS.leerPorMinuto,
        maxTexto: MCP_LIMITS.maxTexto,
        maxLeer: MCP_LIMITS.maxLeer
      },
      accounts: ctx.store.accounts.map((a) => regs.get(a.id) ?? { accountId: a.id, label: a.label, state: 'revisando' }),
      viaColumn: deps.data.viaColumn()
    }
  }

  const emitConfig = (): void => ctx.emit('mcpConfig', view())

  function save(): void {
    escribirJsonAtomico(cfgPath, { v: 2, enabled: cfg.enabled, cuentas: cfg.cuentas, grants: cfg.grants, tokens: cfg.tokens })
  }

  /** El token deja de valer en el acto; sacarlo de la config de la cuenta puede esperar. */
  function invalidarToken(accountId: string): boolean {
    if (!(accountId in cfg.tokens)) return false
    const tokens = { ...cfg.tokens }
    delete tokens[accountId]
    cfg = { ...cfg, tokens }
    return true
  }

  function writeInfo(): void {
    const tmp = `${infoPath}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ pipe }), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, infoPath)
  }

  function leerActual(acc: Account): Registro | undefined {
    const file = join(acc.configDir, '.claude.json')
    if (!existsSync(file)) return { estado: 'ausente' }
    try {
      return leerRegistro(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')))
    } catch {
      return undefined
    }
  }

  async function sincronizar(acc: Account, baja: boolean): Promise<void> {
    const set = (state: ChatMcpAccountReg['state'], detail?: string): void => {
      regs.set(acc.id, detail ? { accountId: acc.id, label: acc.label, state, detail } : { accountId: acc.id, label: acc.label, state })
    }
    const p = proveedorDe(acc)
    if (!p) return set('error', AVISO_PROVEEDOR_DESCONOCIDO)
    // Registrar el MCP es escribir el .claude.json de la cuenta: con otro agente no se toca nada.
    if (!p.capacidades.chatMcp) return set('no-soportado', `Esta cuenta es de ${nombreProveedor(acc)}: el chat con MCP todavía no está disponible.`)
    const quiere = !baja && debeRegistrar(cfg, acc.id, existentes())
    if (!quiere && invalidarToken(acc.id)) save()
    if (!existsSync(acc.configDir)) return set('error', 'Falta la carpeta de la cuenta.')
    const actual = leerActual(acc)
    if (!actual) return set('error', 'No se pudo leer el .claude.json de la cuenta; no se tocó.')
    const accion = planificar(quiere, actual, scriptPath, cfg.tokens[acc.id], hashToken)
    if (accion === 'nada') return set('ok')
    if (accion === 'conflicto') return set('conflicto', 'Ya hay un MCP «sloth» que no puso Sloth; no se tocó.')
    if (quiere && !hayNode()) return set('sin-node', 'Falta node en el PATH: Claude no puede arrancar el MCP.')
    const exe = p.resolverExe()
    if (!exe) return set('sin-cli', 'No encontré Claude Code (claude.exe) en el PATH; no se tocó nada.')
    // Al arrancar, las terminales que sobrevivieron en el daemon todavía no se conocen: se espera a que las reporte.
    try {
      await ctx.backend()
    } catch {
      return set('pendiente', 'Todavía no se sabe si hay terminales abiertas con esta cuenta. Se reintenta solo.')
    }
    if (!ctx.terminal() || ctx.accountBusy(acc.id)) return set('pendiente', 'Se aplica cuando cierres las terminales de esta cuenta.')
    if (accion !== 'baja' && invalidarToken(acc.id)) save()
    if (accion === 'baja' || accion === 'reemplazo') await correrClaude(exe, argsBaja(), p.envCuenta(acc.configDir))
    if (accion === 'baja') return set('ok')
    const token = randomBytes(32).toString('hex')
    await correrClaude(exe, argsAlta(scriptPath, token), p.envCuenta(acc.configDir))
    // El hash se guarda recién con el registro hecho: hasta ahí, ningún token de esta cuenta vale.
    cfg = { ...cfg, tokens: { ...cfg.tokens, [acc.id]: hashToken(token) } }
    save()
    set('ok')
  }

  function programar(acc: Account, baja = false): Promise<void> {
    const next = (colas.get(acc.id) ?? Promise.resolve())
      .then(() => sincronizar(acc, baja))
      .catch((e: unknown) => {
        regs.set(acc.id, { accountId: acc.id, label: acc.label, state: 'error', detail: msgOf(e) })
      })
      .then(emitConfig)
    colas.set(acc.id, next)
    return next
  }

  const sincronizarTodas = (): Promise<void[]> => Promise.all(ctx.store.accounts.map((a) => programar(a)))

  ctx.onPrepareAccount((acc) => void programar(acc))

  ctx.onRemoveAccount((acc) => {
    invalidarToken(acc.id)
    cfg = { ...cfg, cuentas: cfg.cuentas.filter((id) => id !== acc.id), ...sinGrant(cfg, acc.id) }
    save()
    void programar(acc, true).then(() => {
      if (regs.get(acc.id)?.state !== 'ok' && regs.get(acc.id)?.state !== 'no-soportado') ctx.log('chat-mcp: no se pudo sacar el MCP de la cuenta borrada:', regs.get(acc.id)?.detail ?? '')
      regs.delete(acc.id)
      colas.delete(acc.id)
      emitConfig()
    })
  })

  ctx.onPtyExit(() => {
    if (reintento) return
    reintento = setTimeout(() => {
      reintento = undefined
      for (const acc of ctx.store.accounts) if (regs.get(acc.id)?.state === 'pendiente') void programar(acc)
    }, REINTENTO_MS)
    reintento.unref()
  })

  const atencion = crearAtencion({
    config: () => cfg,
    existentes,
    conversaciones: () => deps.data.conversaciones(),
    leerUltimos: (conv, n) => deps.data.leerUltimos(conv, n),
    enviar: async (conv, texto) => {
      await deps.data.enviarViaClaude(conv, texto)
    },
    viaColumn: () => deps.data.viaColumn(),
    espacio: (id) => ctx.store.workspace(id),
    etiquetaCuenta: (id) => ctx.store.account(id)?.label,
    guardarGrant: (accountId, conv, nombre) => {
      cfg = { ...cfg, ...conGrant(cfg, accountId, { conv, nombre }, Date.now()) }
      save()
      emitConfig()
    },
    modoRiesgoso: (cuenta, ws) => {
      const acc = ctx.store.account(cuenta)
      if (!acc) return null
      const archivos = [join(acc.configDir, 'settings.json')]
      const w = ws ? ctx.store.workspace(ws) : undefined
      if (w?.accountId === cuenta) archivos.push(join(w.cwd, '.claude', 'settings.json'), join(w.cwd, '.claude', 'settings.local.json'))
      return modoRiesgoso(...archivos.map(leerJsonSuave))
    },
    pedidosCambiaron: (asks) => ctx.emit('mcpAsks', asks),
    avisar: (ask, donde) => {
      if (deps.isFocused()) return
      const que = ask.op === 'enviar' ? 'mandar un mensaje a' : 'leer'
      deps.notify('Claude pide permiso', `Para ${que} ${donde}, desde la cuenta ${ask.account}.`)
    },
    now: () => Date.now(),
    nuevoId: () => randomUUID()
  })

  function onConn(sock: Socket): void {
    sock.setEncoding('utf8')
    let buf = ''
    let leida = false
    const timer = setTimeout(() => sock.destroy(), CONN_MS)
    sock.on('error', () => sock.destroy())
    sock.on('data', (d: string) => {
      if (leida) return
      buf += d
      if (buf.length > MCP_LIMITS.maxLinea) {
        clearTimeout(timer)
        sock.destroy()
        return
      }
      const i = buf.indexOf('\n')
      if (i < 0) return
      leida = true
      clearTimeout(timer)
      void atencion.atenderLinea(buf.slice(0, i)).then((r) => {
        if (!sock.destroyed) sock.end(`${JSON.stringify(r)}\n`)
      })
    })
  }

  function startServer(): void {
    if (server) return
    const s = createServer(onConn)
    s.maxConnections = MAX_CONEXIONES
    s.on('error', (e) => {
      ctx.log('chat-mcp: el canal local falló:', msgOf(e))
      if (server === s) server = undefined
    })
    if (process.platform !== 'win32') rmSync(pipe, { force: true })
    s.listen(pipe, () => {
      try {
        if (process.platform !== 'win32') chmodSync(pipe, 0o600)
        writeInfo()
      } catch (e) {
        ctx.log('chat-mcp: no se pudo preparar el canal local:', msgOf(e))
      }
    })
    server = s
  }

  function stopServer(): Promise<void> {
    const s = server
    server = undefined
    try {
      rmSync(infoPath, { force: true })
    } catch (e) {
      ctx.log('chat-mcp: no se pudo borrar chat-mcp.json:', msgOf(e))
    }
    if (!s) return Promise.resolve()
    return new Promise((r) => s.close(() => r()))
  }

  if (cfg.enabled) startServer()

  ctx.handle('mcpConfig', (): ChatMcpView => view())

  ctx.handle('mcpSetEnabled', async (on: unknown): Promise<ChatMcpView> => {
    if (typeof on !== 'boolean') throw new Error('Valor inválido.')
    if (on !== cfg.enabled) {
      cfg = on ? { ...cfg, enabled: true } : { ...cfg, enabled: false, tokens: {} }
      save()
      if (on) startServer()
      else {
        atencion.denegarTodos()
        await stopServer()
      }
    }
    void sincronizarTodas()
    return view()
  })

  ctx.handle('mcpSetAccounts', (raw: unknown): ChatMcpView => {
    const cuentas = validarCuentas(raw, existentes())
    for (const id of cuentas) {
      const acc = ctx.store.account(id)
      if (acc && capacidadesDe(acc)?.chatMcp !== true) throw new Error(`La cuenta «${acc.label}» es de ${nombreProveedor(acc)}: el chat con MCP todavía no está disponible.`)
    }
    cfg = { ...cfg, cuentas }
    for (const id of Object.keys(cfg.tokens)) if (!cuentas.includes(id)) invalidarToken(id)
    save()
    void sincronizarTodas()
    return view()
  })

  ctx.handle('mcpRevoke', (rawAccount: unknown, rawKey: unknown): ChatMcpView => {
    if (typeof rawAccount !== 'string' || rawAccount.length === 0 || rawAccount.length > 64) throw new Error('Cuenta inválida.')
    if (typeof rawKey !== 'string' || !KEY_RE.test(rawKey)) throw new Error('Conversación inválida.')
    const [kind, id] = rawKey.split(':')
    cfg = { ...cfg, ...sinGrant(cfg, rawAccount, `${kind.toLowerCase()}:${id.toLowerCase()}`) }
    save()
    emitConfig()
    return view()
  })

  ctx.handle('mcpRevokeAll', (): ChatMcpView => {
    cfg = { ...cfg, grants: [] }
    save()
    emitConfig()
    return view()
  })

  ctx.handle('mcpPending', (): ChatMcpAsk[] => atencion.pendientes())

  ctx.handle('mcpAnswer', (rawId: unknown, rawChoice: unknown): void => {
    if (typeof rawId !== 'string' || rawId.length === 0 || rawId.length > 64) throw new Error('Pedido inválido.')
    if (rawChoice !== 'once' && rawChoice !== 'always' && rawChoice !== 'deny') throw new Error('Respuesta inválida.')
    atencion.responder(rawId, rawChoice)
  })

  return {
    dispose: async (): Promise<void> => {
      if (reintento) clearTimeout(reintento)
      atencion.denegarTodos()
      await stopServer()
    }
  }
}
