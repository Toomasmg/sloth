/**
 * Chat por Claude: lo que hace el main con cada línea que llega por el pipe, PURO (todo lo de afuera entra
 * por `AtencionDeps`). La cuenta sale del token; el espacio que manda la terminal solo se muestra.
 */
import { convKey, type ChatConvRef } from '../../shared/chat'
import { VIA_CLAUDE_PREFIX, type ChatMcpAsk, type ChatMcpChoice, type ChatMcpOp } from '../../shared/chat-mcp'
import {
  cuentaDelToken,
  debeRegistrar,
  envolverContenido,
  limpiarNombre,
  MCP_LIMITS,
  parsearPedido,
  permitido,
  resolverConversacion,
  Tope,
  validarN,
  validarTexto,
  type ConvCandidata,
  type McpConfig,
  type McpPedido
} from './chat-mcp-core'

export const NO_AUTORIZADO = 'No autorizado.'
export const NO_PERMITIDO = 'El usuario no lo permitió (o no respondió a tiempo).'
export const APAGADO = 'El chat por Claude está apagado. Se prende en Configuración → Chat.'
export const CUENTA_NO = 'Esta cuenta de Claude no tiene permitido usar el chat. Se elige en Configuración → Chat.'

export interface MsgLeido {
  author: { login: string }
  body: string
  createdAt: number
  deletedAt?: number
  notice?: unknown
  via?: 'claude'
}

export interface AtencionDeps {
  config(): McpConfig
  existentes(): readonly string[]
  conversaciones(): ConvCandidata[]
  leerUltimos(conv: ChatConvRef, n: number): Promise<MsgLeido[]>
  enviar(conv: ChatConvRef, texto: string): Promise<void>
  viaColumn(): boolean
  espacio(id: string): { name: string; accountId: string } | undefined
  etiquetaCuenta(id: string): string | undefined
  /** «Siempre» en un pedido de leer: el main lo guarda en la config. */
  guardarGrant(accountId: string, conv: ChatConvRef, nombre: string): void
  pedidosCambiaron(asks: ChatMcpAsk[]): void
  avisar(ask: ChatMcpAsk, donde: string): void
  now(): number
  nuevoId(): string
  askMs?: number
}

export type Respuesta = { ok: true; texto: string } | { ok: false; error: string }

interface Pendiente {
  ask: ChatMcpAsk
  cuenta: string
  key: string
  promise: Promise<boolean>
  resolve(ok: boolean): void
  timer: ReturnType<typeof setTimeout>
}

const msgOf = (e: unknown): string => (e instanceof Error && e.message ? e.message.slice(0, 300) : 'Algo salió mal.')

export function crearAtencion(d: AtencionDeps): {
  atenderLinea(linea: string): Promise<Respuesta>
  responder(id: string, choice: ChatMcpChoice): void
  pendientes(): ChatMcpAsk[]
  denegarTodos(): void
} {
  const pendientes = new Map<string, Pendiente>()
  const topes = new Map<string, { leer: Tope; enviar: Tope }>()
  const askMs = d.askMs ?? MCP_LIMITS.askMs

  const lista = (): ChatMcpAsk[] => [...pendientes.values()].map((p) => p.ask)
  const emitir = (): void => d.pedidosCambiaron(lista())

  function topeDe(cuenta: string): { leer: Tope; enviar: Tope } {
    let t = topes.get(cuenta)
    if (!t) {
      t = { leer: new Tope(MCP_LIMITS.leerPorMinuto, 60_000), enviar: new Tope(MCP_LIMITS.enviarPorMinuto, 60_000) }
      topes.set(cuenta, t)
    }
    return t
  }

  /** La cuenta sigue habilitada y con el mismo token que autenticó el pedido. */
  function vigente(cuenta: string, hash: string): boolean {
    const cfg = d.config()
    return cfg.enabled && debeRegistrar(cfg, cuenta, d.existentes()) && cfg.tokens[cuenta] === hash
  }

  function cerrar(p: Pendiente, ok: boolean): void {
    clearTimeout(p.timer)
    pendientes.delete(p.ask.id)
    p.resolve(ok)
  }

  function preguntar(cuenta: string, ws: string, cand: ConvCandidata, op: ChatMcpOp, preview?: string): Promise<boolean> {
    // El origen y, en «enviar», el texto son parte del pedido: aprobar uno no aprueba otro.
    const key = JSON.stringify([cuenta, ws, convKey(cand.conv), op, preview ?? ''])
    for (const p of pendientes.values()) if (p.key === key) return p.promise
    if (pendientes.size >= MCP_LIMITS.maxPendientes) return Promise.resolve(false)
    const w = ws ? d.espacio(ws) : undefined
    const ask: ChatMcpAsk = {
      id: d.nuevoId(),
      op,
      conv: { ...cand.conv },
      nombre: limpiarNombre(cand.nombre),
      account: limpiarNombre(d.etiquetaCuenta(cuenta) ?? 'cuenta sin nombre'),
      expiresAt: d.now() + askMs
    }
    if (w && w.accountId === cuenta) ask.workspace = limpiarNombre(w.name)
    if (preview !== undefined) ask.preview = preview
    let resolveFn: (ok: boolean) => void = () => undefined
    const promise = new Promise<boolean>((r) => (resolveFn = r))
    const p: Pendiente = {
      ask,
      cuenta,
      key,
      promise,
      resolve: resolveFn,
      timer: setTimeout(() => {
        cerrar(p, false)
        emitir()
      }, askMs)
    }
    pendientes.set(ask.id, p)
    emitir()
    d.avisar(ask, cand.tipo === 'directo' ? `@${ask.nombre}` : ask.nombre)
    return promise
  }

  async function exigirPermiso(cuenta: string, hash: string, ws: string, cand: ConvCandidata, op: ChatMcpOp, preview?: string): Promise<void> {
    if (!permitido(d.config(), cuenta, cand.conv, op) && !(await preguntar(cuenta, ws, cand, op, preview))) throw new Error(NO_PERMITIDO)
    // Mientras esperaba, el usuario pudo apagar, desmarcar la cuenta o borrarla.
    if (!vigente(cuenta, hash)) throw new Error(d.config().enabled ? CUENTA_NO : APAGADO)
  }

  async function atender(cuenta: string, hash: string, ws: string, pedido: McpPedido): Promise<string> {
    const tope = topeDe(cuenta)
    if (pedido.op === 'listar') {
      if (!tope.leer.tomar(d.now())) throw new Error(`Más de ${MCP_LIMITS.leerPorMinuto} lecturas en un minuto. Esperá un poco.`)
      const convs = d.conversaciones().map((c) => ({
        id: convKey(c.conv),
        tipo: c.tipo,
        nombre: c.tipo === 'directo' ? `@${c.nombre}` : c.nombre
      }))
      return envolverContenido('Conversaciones del chat de Sloth. Usá el id en chat_leer y chat_enviar.', convs)
    }
    if (pedido.op === 'leer') {
      const n = validarN(pedido.n)
      const cand = resolverConversacion(pedido.conversacion, d.conversaciones())
      if (!tope.leer.tomar(d.now())) throw new Error(`Más de ${MCP_LIMITS.leerPorMinuto} lecturas en un minuto. Esperá un poco.`)
      await exigirPermiso(cuenta, hash, ws, cand, 'leer')
      const via = d.viaColumn()
      const msgs = await d.leerUltimos(cand.conv, n)
      const items = msgs
        .filter((m) => !m.notice && m.deletedAt === undefined)
        .map((m) => ({
          autor: `@${m.author.login}`,
          fecha: new Date(m.createdAt).toISOString(),
          texto: m.body,
          viaClaude: via ? m.via === 'claude' : m.body.startsWith(VIA_CLAUDE_PREFIX)
        }))
      return envolverContenido(`Últimos ${items.length} mensajes de ${convKey(cand.conv)}, del más viejo al más nuevo.`, items)
    }
    const max = d.viaColumn() ? MCP_LIMITS.maxTexto : MCP_LIMITS.maxTexto - [...VIA_CLAUDE_PREFIX].length
    const texto = validarTexto(pedido.texto, max)
    const cand = resolverConversacion(pedido.conversacion, d.conversaciones())
    if (!tope.enviar.tomar(d.now())) throw new Error(`Más de ${MCP_LIMITS.enviarPorMinuto} mensajes en un minuto. Esperá un poco.`)
    await exigirPermiso(cuenta, hash, ws, cand, 'enviar', texto)
    await d.enviar(cand.conv, texto)
    // Sin el nombre: lo eligió una persona y esto vuelve a Claude fuera del bloque de datos.
    return `Enviado a ${convKey(cand.conv)}.`
  }

  async function atenderLinea(linea: string): Promise<Respuesta> {
    if (linea.length > MCP_LIMITS.maxLinea) return { ok: false, error: NO_AUTORIZADO }
    let p: ReturnType<typeof parsearPedido>
    try {
      p = parsearPedido(linea)
    } catch {
      return { ok: false, error: NO_AUTORIZADO }
    }
    const cfg = d.config()
    const cuenta = cuentaDelToken(p.token, cfg.tokens)
    if (cuenta === undefined) return { ok: false, error: NO_AUTORIZADO }
    if (!cfg.enabled) return { ok: false, error: APAGADO }
    const hash = cfg.tokens[cuenta]
    if (!vigente(cuenta, hash)) return { ok: false, error: CUENTA_NO }
    try {
      return { ok: true, texto: await atender(cuenta, hash, p.ws, p.pedido) }
    } catch (e) {
      return { ok: false, error: msgOf(e) }
    }
  }

  function responder(id: string, choice: ChatMcpChoice): void {
    const p = pendientes.get(id)
    if (!p) return
    if (choice === 'always') {
      if (p.ask.op !== 'leer') throw new Error('Para enviar no hay «siempre»: cada mensaje se confirma.')
      try {
        d.guardarGrant(p.cuenta, p.ask.conv, p.ask.nombre)
      } finally {
        cerrar(p, true)
        emitir()
      }
      return
    }
    cerrar(p, choice === 'once')
    emitir()
  }

  function denegarTodos(): void {
    if (pendientes.size === 0) return
    for (const p of [...pendientes.values()]) cerrar(p, false)
    emitir()
  }

  return { atenderLinea, responder, pendientes: lista, denegarTodos }
}
