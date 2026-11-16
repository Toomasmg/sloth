import { app } from 'electron'
import { createServer, type Server, type Socket } from 'node:net'
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { FeatureContext } from './context'
import type { ChatData } from './chat-data'
import type { Account } from '../../shared/types'
import { convKey, type ChatConvRef } from '../../shared/chat'
import { VIA_CLAUDE_PREFIX, type ChatMcpAccountReg, type ChatMcpAsk, type ChatMcpChoice, type ChatMcpGrant, type ChatMcpOp, type ChatMcpView } from '../../shared/chat-mcp'
import {
  conGrant,
  debeRegistrar,
  envolverContenido,
  MCP_LIMITS,
  parsearConfig,
  parsearPedido,
  permitido,
  resolverConversacion,
  sinGrant,
  Tope,
  validarCuentas,
  validarN,
  validarTexto,
  type ConvCandidata,
  type McpPedido
} from './chat-mcp-core'
import { aplicarRegistro, entradaMcp, MCP_SCRIPT_NAME } from './chat-mcp-registro'
import { CHAT_MCP_SCRIPT } from './chat-mcp-script'
import { hayNode, writeIfChanged } from '../hooks'
import { writeJsonAtomic } from './tray-settings'

export interface ChatMcpDeps {
  data: ChatData
  isFocused(): boolean
  notify(title: string, body: string): void
}

interface Pendiente {
  ask: ChatMcpAsk
  key: string
  promise: Promise<boolean>
  resolve(ok: boolean): void
  timer: ReturnType<typeof setTimeout>
}

const CONN_MS = 5000
const NO_PERMITIDO = 'El usuario no lo permitió (o no respondió a tiempo).'
const APAGADO = 'El chat por Claude está apagado. Se prende en Configuración → Chat.'
const FUERA = 'una terminal fuera de Sloth'
const CUENTA_NO = 'Esta cuenta de Claude no tiene permitido usar el chat. Se elige en Configuración → Chat.'
const KEY_RE = /^(team|dm):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const msgOf = (e: unknown): string => (e instanceof Error && e.message ? e.message.slice(0, 300) : 'Algo salió mal.')

function pipePath(userData: string): string {
  if (process.platform === 'win32') {
    const h = createHash('sha256').update(resolve(userData).toLowerCase()).digest('hex').slice(0, 12)
    return `\\\\.\\pipe\\sloth-chat-${h}`
  }
  return join(userData, 'chat-mcp.sock')
}

function readJsonObject(file: string): Record<string, unknown> | undefined {
  const v = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as unknown
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/**
 * Lado main del MCP del chat: el pipe local (solo con el interruptor prendido), permisos, topes y el
 * registro en el .claude.json de cada cuenta. Los canales quedan en la función «chat» (feat:chat:mcp*).
 */
export function registerChatMcp(ctx: FeatureContext, deps: ChatMcpDeps): { dispose(): Promise<void> } {
  const userData = app.getPath('userData')
  const scriptPath = join(userData, MCP_SCRIPT_NAME)
  const infoPath = join(userData, 'chat-mcp.json')
  const cfgPath = join(userData, 'features', 'chat-mcp.json')
  const pipe = pipePath(userData)
  const token = randomBytes(32)

  let cfg = { enabled: false, cuentas: [] as string[], grants: [] as ChatMcpGrant[] }
  try {
    if (existsSync(cfgPath)) cfg = parsearConfig(JSON.parse(readFileSync(cfgPath, 'utf8')))
  } catch (e) {
    ctx.log('chat-mcp: config ilegible, queda apagado:', msgOf(e))
  }

  const topeLeer = new Tope(MCP_LIMITS.leerPorMinuto, 60_000)
  const topeEnviar = new Tope(MCP_LIMITS.enviarPorMinuto, 60_000)
  const pendientes = new Map<string, Pendiente>()
  const regs = new Map<string, ChatMcpAccountReg>()
  let server: Server | undefined

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
      grants: cfg.grants,
      limits: {
        enviarPorMinuto: MCP_LIMITS.enviarPorMinuto,
        leerPorMinuto: MCP_LIMITS.leerPorMinuto,
        maxTexto: MCP_LIMITS.maxTexto,
        maxLeer: MCP_LIMITS.maxLeer
      },
      accounts: ctx.store.accounts.map((a) => regs.get(a.id) ?? { accountId: a.id, label: a.label, state: 'pendiente' }),
      viaColumn: deps.data.viaColumn()
    }
  }

  const emitConfig = (): void => ctx.emit('mcpConfig', view())
  const emitAsks = (): void => ctx.emit('mcpAsks', [...pendientes.values()].map((p) => p.ask))

  function save(): void {
    writeJsonAtomic(cfgPath, { v: 1, enabled: cfg.enabled, cuentas: cfg.cuentas, grants: cfg.grants })
  }

  function writeInfo(): void {
    const tmp = `${infoPath}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ pipe, token: token.toString('hex') }), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, infoPath)
  }


  function sincronizar(acc: Account, baja = false): void {
    const set = (state: ChatMcpAccountReg['state'], detail?: string): void => {
      regs.set(acc.id, detail ? { accountId: acc.id, label: acc.label, state, detail } : { accountId: acc.id, label: acc.label, state })
    }
    try {
      const entrada = !baja && debeRegistrar(cfg, acc.id, existentes()) ? entradaMcp(scriptPath, acc.id) : null
      if (entrada && !hayNode()) return set('sin-node', 'Falta node en el PATH: Claude no puede arrancar el MCP.')
      if (!existsSync(acc.configDir)) return set('error', 'Falta la carpeta de la cuenta.')
      const file = join(acc.configDir, '.claude.json')
      let json: Record<string, unknown> = {}
      if (existsSync(file)) {
        let leido: Record<string, unknown> | undefined
        try {
          leido = readJsonObject(file)
        } catch {
          leido = undefined
        }
        if (!leido) return set('error', 'No se pudo leer el .claude.json de la cuenta; no se tocó.')
        json = leido
      }
      const r = aplicarRegistro(json, entrada)
      if (r.state === 'conflicto') return set('conflicto', 'Ya hay un MCP «sloth» que no puso Sloth; no se tocó.')
      if (!r.json) return set('ok')
      if (ctx.accountBusy(acc.id)) return set('pendiente', 'Se aplica cuando cierres las terminales de esta cuenta.')
      const bak = `${file}.sloth-bak`
      if (existsSync(file) && !existsSync(bak)) copyFileSync(file, bak)
      const tmp = `${file}.sloth-tmp`
      writeFileSync(tmp, JSON.stringify(r.json, null, 2), 'utf8')
      renameSync(tmp, file)
      set('ok')
    } catch (e) {
      set('error', msgOf(e))
    }
  }

  function sincronizarTodas(): void {
    for (const acc of ctx.store.accounts) sincronizar(acc)
    emitConfig()
  }

  ctx.onPrepareAccount((acc) => {
    sincronizar(acc)
    emitConfig()
  })

  ctx.onRemoveAccount((acc) => {
    sincronizar(acc, true)
    if (regs.get(acc.id)?.state !== 'ok') ctx.log('chat-mcp: no se pudo sacar el MCP de la cuenta borrada:', regs.get(acc.id)?.detail ?? '')
    regs.delete(acc.id)
    if (cfg.cuentas.includes(acc.id)) {
      cfg = { ...cfg, cuentas: cfg.cuentas.filter((id) => id !== acc.id) }
      save()
    }
    emitConfig()
  })


  function cerrarPendiente(p: Pendiente, ok: boolean): void {
    clearTimeout(p.timer)
    pendientes.delete(p.ask.id)
    p.resolve(ok)
  }

  function denegarTodos(): void {
    if (pendientes.size === 0) return
    for (const p of [...pendientes.values()]) cerrarPendiente(p, false)
    emitAsks()
  }

  function preguntar(cand: ConvCandidata, op: ChatMcpOp, ws: string, preview?: string): Promise<boolean> {
    // En «enviar» el texto es parte del pedido: aprobar uno no puede aprobar otro texto distinto.
    const key = `${convKey(cand.conv)}|${op}|${preview ?? ''}`
    for (const p of pendientes.values()) if (p.key === key) return p.promise
    if (pendientes.size >= MCP_LIMITS.maxPendientes) return Promise.resolve(false)
    const w = ws ? ctx.store.workspace(ws) : undefined
    const account = w ? ctx.store.account(w.accountId)?.label : undefined
    const ask: ChatMcpAsk = {
      id: randomUUID(),
      op,
      conv: { ...cand.conv },
      nombre: cand.nombre,
      workspace: w?.name ?? FUERA,
      expiresAt: Date.now() + MCP_LIMITS.askMs
    }
    if (account) ask.account = account
    if (preview !== undefined) ask.preview = preview
    let resolveFn: (ok: boolean) => void = () => undefined
    const promise = new Promise<boolean>((r) => (resolveFn = r))
    const p: Pendiente = {
      ask,
      key,
      promise,
      resolve: resolveFn,
      timer: setTimeout(() => {
        cerrarPendiente(p, false)
        emitAsks()
      }, MCP_LIMITS.askMs)
    }
    pendientes.set(ask.id, p)
    emitAsks()
    if (!deps.isFocused()) {
      const que = op === 'enviar' ? 'mandar un mensaje a' : 'leer'
      const donde = cand.tipo === 'directo' ? `@${cand.nombre}` : cand.nombre
      deps.notify('Claude pide permiso', `Para ${que} ${donde}, desde ${ask.workspace}.`)
    }
    return promise
  }

  async function exigirPermiso(cand: ConvCandidata, op: ChatMcpOp, ws: string, preview?: string): Promise<void> {
    if (permitido(cfg, cand.conv, op)) return
    if (!(await preguntar(cand, op, ws, preview))) throw new Error(NO_PERMITIDO)
    if (!cfg.enabled) throw new Error(APAGADO)
  }


  async function atender(pedido: McpPedido, ws: string): Promise<string> {
    if (pedido.op === 'listar') {
      const convs = deps.data.conversaciones().map((c) => ({
        id: convKey(c.conv),
        tipo: c.tipo,
        nombre: c.tipo === 'directo' ? `@${c.nombre}` : c.nombre
      }))
      return envolverContenido('Conversaciones del chat de Sloth. Usá el id en chat_leer y chat_enviar.', convs)
    }
    if (pedido.op === 'leer') {
      const n = validarN(pedido.n)
      const cand = resolverConversacion(pedido.conversacion, deps.data.conversaciones())
      if (!topeLeer.tomar(Date.now())) throw new Error(`Más de ${MCP_LIMITS.leerPorMinuto} lecturas en un minuto. Esperá un poco.`)
      await exigirPermiso(cand, 'leer', ws)
      const msgs = await deps.data.leerUltimos(cand.conv, n)
      const items = msgs
        .filter((m) => !m.notice && m.deletedAt === undefined)
        .map((m) => ({
          autor: `@${m.author.login}`,
          fecha: new Date(m.createdAt).toISOString(),
          texto: m.body,
          viaClaude: m.via === 'claude' || m.body.startsWith(VIA_CLAUDE_PREFIX)
        }))
      return envolverContenido(`Últimos ${items.length} mensajes de ${convKey(cand.conv)}, del más viejo al más nuevo.`, items)
    }
    const texto = validarTexto(pedido.texto)
    const cand = resolverConversacion(pedido.conversacion, deps.data.conversaciones())
    if (!topeEnviar.tomar(Date.now())) throw new Error(`Más de ${MCP_LIMITS.enviarPorMinuto} mensajes en un minuto. Esperá un poco.`)
    await exigirPermiso(cand, 'enviar', ws, texto)
    await deps.data.enviarViaClaude(cand.conv, texto)
    // Sin el nombre: lo eligió una persona y esto vuelve a Claude fuera del bloque de datos.
    return `Enviado a ${convKey(cand.conv)}.`
  }

  async function atenderLinea(linea: string): Promise<{ ok: true; texto: string } | { ok: false; error: string }> {
    let p: ReturnType<typeof parsearPedido>
    try {
      p = parsearPedido(linea)
    } catch {
      return { ok: false, error: 'No autorizado.' }
    }
    const got = Buffer.from(p.token, 'hex')
    if (got.length !== token.length || !timingSafeEqual(got, token)) return { ok: false, error: 'No autorizado.' }
    if (!cfg.enabled) return { ok: false, error: APAGADO }
    if (!debeRegistrar(cfg, p.cuenta, existentes())) return { ok: false, error: CUENTA_NO }
    try {
      return { ok: true, texto: await atender(p.pedido, p.ws) }
    } catch (e) {
      return { ok: false, error: msgOf(e) }
    }
  }

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
      void atenderLinea(buf.slice(0, i)).then((r) => {
        if (!sock.destroyed) sock.end(`${JSON.stringify(r)}\n`)
      })
    })
  }

  function startServer(): void {
    if (server) return
    const s = createServer(onConn)
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
      cfg = { ...cfg, enabled: on }
      save()
      if (on) startServer()
      else {
        denegarTodos()
        await stopServer()
      }
    }
    sincronizarTodas()
    return view()
  })

  ctx.handle('mcpSetAccounts', (raw: unknown): ChatMcpView => {
    cfg = { ...cfg, cuentas: validarCuentas(raw, existentes()) }
    save()
    sincronizarTodas()
    return view()
  })

  ctx.handle('mcpRevoke', (rawKey: unknown, rawOp?: unknown): ChatMcpView => {
    if (typeof rawKey !== 'string' || !KEY_RE.test(rawKey)) throw new Error('Conversación inválida.')
    if (rawOp !== undefined && rawOp !== null && rawOp !== 'leer' && rawOp !== 'enviar') throw new Error('Operación inválida.')
    const op = rawOp === 'leer' || rawOp === 'enviar' ? rawOp : undefined
    const [kind, id] = rawKey.split(':')
    cfg = { ...cfg, ...sinGrant(cfg, `${kind.toLowerCase()}:${id.toLowerCase()}`, op) }
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

  ctx.handle('mcpPending', (): ChatMcpAsk[] => [...pendientes.values()].map((p) => p.ask))

  ctx.handle('mcpAnswer', (rawId: unknown, rawChoice: unknown): void => {
    if (typeof rawId !== 'string' || rawId.length === 0 || rawId.length > 64) throw new Error('Pedido inválido.')
    if (rawChoice !== 'once' && rawChoice !== 'always' && rawChoice !== 'deny') throw new Error('Respuesta inválida.')
    const choice: ChatMcpChoice = rawChoice
    const p = pendientes.get(rawId)
    if (!p) return
    if (choice === 'always') {
      const conv: ChatConvRef = p.ask.conv
      cfg = { ...cfg, ...conGrant(cfg, { conv, nombre: p.ask.nombre }, p.ask.op, Date.now()) }
      save()
      emitConfig()
    }
    cerrarPendiente(p, choice !== 'deny')
    emitAsks()
  })

  return {
    dispose: async (): Promise<void> => {
      denegarTodos()
      await stopServer()
    }
  }
}
