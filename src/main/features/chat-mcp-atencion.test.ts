import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatConvRef } from '../../shared/chat'
import type { ChatMcpAsk, ModoRiesgoso } from '../../shared/chat-mcp'
import { APAGADO, crearAtencion, CUENTA_NO, NO_AUTORIZADO, NO_PERMITIDO, type AtencionDeps, type MsgLeido } from './chat-mcp-atencion'
import { hashToken, MCP_LIMITS, type McpConfig } from './chat-mcp-core'

const T1 = '11111111-1111-4111-8111-111111111111'
const TOK_A = 'a'.repeat(64)
const TOK_B = 'b'.repeat(64)

function armar(over: Partial<McpConfig> = {}): {
  cfg: McpConfig
  asks: ChatMcpAsk[][]
  enviados: string[]
  grants: string[]
  modo: ModoRiesgoso | null
  deps: AtencionDeps
  at: ReturnType<typeof crearAtencion>
} {
  const s = {
    cfg: { enabled: true, cuentas: ['A', 'B'], grants: [], tokens: { A: hashToken(TOK_A), B: hashToken(TOK_B) }, ...over } as McpConfig,
    asks: [] as ChatMcpAsk[][],
    enviados: [] as string[],
    grants: [] as string[],
    modo: null as ModoRiesgoso | null
  }
  let n = 0
  const deps: AtencionDeps = {
    config: () => s.cfg,
    existentes: () => ['A', 'B'],
    conversaciones: () => [{ conv: { kind: 'team', id: T1 }, nombre: 'Diseño\u202E', tipo: 'equipo' }],
    leerUltimos: async (): Promise<MsgLeido[]> => [{ author: { login: 'ana' }, body: 'hola', createdAt: 0 }],
    enviar: async (_c: ChatConvRef, texto: string) => {
      s.enviados.push(texto)
    },
    viaColumn: () => true,
    espacio: (id) => (id === 'wA' ? { name: 'Espacio A', accountId: 'A' } : id === 'wB' ? { name: 'Espacio B', accountId: 'B' } : undefined),
    etiquetaCuenta: (id) => `Cuenta ${id}`,
    guardarGrant: (cuenta, conv) => {
      s.grants.push(`${cuenta}|${conv.kind}:${conv.id}`)
      s.cfg = { ...s.cfg, grants: [...s.cfg.grants, { accountId: cuenta, conv, nombre: 'x', at: 0 }] }
    },
    modoRiesgoso: () => s.modo,
    pedidosCambiaron: (l) => s.asks.push(l),
    avisar: () => undefined,
    now: () => 1000,
    nuevoId: () => `id${++n}`,
    askMs: 5000
  }
  const at = crearAtencion(deps)
  return Object.assign(s, { deps, at })
}

const linea = (token: string, pedido: object, ws = ''): string => JSON.stringify({ token, ws, pedido })
const leer = { op: 'leer', conversacion: `team:${T1}` }
const ultimo = (s: { asks: ChatMcpAsk[][] }): ChatMcpAsk[] => s.asks[s.asks.length - 1] ?? []

test('token incorrecto con el largo correcto: no autorizado', async () => {
  const s = armar()
  assert.deepEqual(await s.at.atenderLinea(linea('c'.repeat(64), { op: 'listar' })), { ok: false, error: NO_AUTORIZADO })
})

test('una línea más larga que el tope no se procesa', async () => {
  const s = armar()
  const r = await s.at.atenderLinea(linea(TOK_A, { op: 'enviar', conversacion: T1, texto: 'x'.repeat(MCP_LIMITS.maxLinea) }))
  assert.deepEqual(r, { ok: false, error: NO_AUTORIZADO })
  assert.equal(s.asks.length, 0)
})

test('cuenta no marcada: su token ya no vale para nada', async () => {
  const s = armar({ cuentas: ['A'] })
  assert.deepEqual(await s.at.atenderLinea(linea(TOK_B, { op: 'listar' })), { ok: false, error: CUENTA_NO })
  assert.equal((await s.at.atenderLinea(linea(TOK_A, { op: 'listar' }))).ok, true)
})

test('apagado: nada pasa', async () => {
  const s = armar({ enabled: false })
  assert.deepEqual(await s.at.atenderLinea(linea(TOK_A, { op: 'listar' })), { ok: false, error: APAGADO })
})

test('la cuenta del diálogo sale del token y el espacio de otra cuenta no se muestra', async () => {
  const s = armar()
  const p = s.at.atenderLinea(linea(TOK_B, leer, 'wA'))
  const [ask] = ultimo(s)
  assert.equal(ask.account, 'Cuenta B')
  assert.equal(ask.workspace, undefined)
  assert.equal(ask.nombre, 'Diseño')
  s.at.responder(ask.id, 'deny')
  assert.deepEqual(await p, { ok: false, error: NO_PERMITIDO })
})

test('el espacio de la misma cuenta se muestra como dato', async () => {
  const s = armar()
  const p = s.at.atenderLinea(linea(TOK_A, leer, 'wA'))
  const [ask] = ultimo(s)
  assert.equal(ask.workspace, 'Espacio A')
  s.at.responder(ask.id, 'once')
  assert.equal((await p).ok, true)
})

test('dedupe por origen: el mismo pedido desde otra cuenta abre su propio diálogo', async () => {
  const s = armar()
  const pa = s.at.atenderLinea(linea(TOK_A, leer))
  const pa2 = s.at.atenderLinea(linea(TOK_A, leer))
  const pb = s.at.atenderLinea(linea(TOK_B, leer))
  const pend = ultimo(s)
  assert.equal(pend.length, 2)
  s.at.responder(pend[0].id, 'once')
  assert.equal((await pa).ok, true)
  assert.equal((await pa2).ok, true)
  assert.equal(s.at.pendientes().length, 1)
  s.at.responder(pend[1].id, 'deny')
  assert.equal((await pb).ok, false)
})

test('si se desmarca la cuenta mientras espera, aprobar no alcanza', async () => {
  const s = armar()
  const p = s.at.atenderLinea(linea(TOK_A, leer))
  s.cfg = { ...s.cfg, cuentas: ['B'] }
  s.at.responder(ultimo(s)[0].id, 'once')
  assert.deepEqual(await p, { ok: false, error: CUENTA_NO })
})

test('si se apaga o cambia el token mientras espera, tampoco', async () => {
  const s = armar()
  const p = s.at.atenderLinea(linea(TOK_A, leer))
  s.cfg = { ...s.cfg, enabled: false }
  s.at.responder(ultimo(s)[0].id, 'once')
  assert.deepEqual(await p, { ok: false, error: APAGADO })
  const s2 = armar()
  const p2 = s2.at.atenderLinea(linea(TOK_A, leer))
  s2.cfg = { ...s2.cfg, tokens: { ...s2.cfg.tokens, A: hashToken('d'.repeat(64)) } }
  s2.at.responder(ultimo(s2)[0].id, 'once')
  assert.deepEqual(await p2, { ok: false, error: CUENTA_NO })
})

test('«siempre» para leer queda por cuenta: otra cuenta vuelve a preguntar', async () => {
  const s = armar()
  const p = s.at.atenderLinea(linea(TOK_A, leer))
  s.at.responder(ultimo(s)[0].id, 'always')
  assert.equal((await p).ok, true)
  assert.deepEqual(s.grants, [`A|team:${T1}`])
  const antes = s.asks.length
  assert.equal((await s.at.atenderLinea(linea(TOK_A, leer))).ok, true)
  assert.equal(s.asks.length, antes)
  const pb = s.at.atenderLinea(linea(TOK_B, leer))
  assert.equal(ultimo(s).length, 1)
  s.at.responder(ultimo(s)[0].id, 'deny')
  assert.equal((await pb).ok, false)
})

test('enviar no acepta «siempre» y muestra el texto exacto', async () => {
  const s = armar()
  const p = s.at.atenderLinea(linea(TOK_A, { op: 'enviar', conversacion: T1, texto: '  hola\r\nchau ' }))
  const [ask] = ultimo(s)
  assert.equal(ask.preview, 'hola\nchau')
  assert.throws(() => s.at.responder(ask.id, 'always'), /siempre/)
  assert.equal(s.at.pendientes().length, 1)
  s.at.responder(ask.id, 'once')
  assert.equal((await p).ok, true)
  assert.deepEqual(s.enviados, ['hola\nchau'])
})

test('sin la columna via, el tope de texto descuenta el prefijo', async () => {
  const s = armar()
  s.deps.viaColumn = () => false
  const r = await s.at.atenderLinea(linea(TOK_A, { op: 'enviar', conversacion: T1, texto: 'a'.repeat(MCP_LIMITS.maxTexto) }))
  assert.equal(r.ok, false)
  assert.match(r.ok ? '' : r.error, /caracteres/)
})

test('listar cuenta para el tope de lecturas', async () => {
  const s = armar()
  for (let i = 0; i < MCP_LIMITS.leerPorMinuto; i++) assert.equal((await s.at.atenderLinea(linea(TOK_A, { op: 'listar' }))).ok, true)
  assert.equal((await s.at.atenderLinea(linea(TOK_A, { op: 'listar' }))).ok, false)
  assert.equal((await s.at.atenderLinea(linea(TOK_B, { op: 'listar' }))).ok, true)
})

test('con la cuenta en bypass, un «siempre» guardado igual pregunta y marca sinSiempre', async () => {
  const s = armar({ grants: [{ accountId: 'A', conv: { kind: 'team', id: T1 }, nombre: 'x', at: 0 }] })
  s.modo = 'bypassPermissions'
  const p = s.at.atenderLinea(linea(TOK_A, leer))
  const [ask] = ultimo(s)
  assert.equal(ask.sinSiempre, 'bypassPermissions')
  s.at.responder(ask.id, 'once')
  assert.equal((await p).ok, true)
})

test('con la cuenta en bypass, responder «siempre» tira error y el pedido sigue', async () => {
  const s = armar()
  s.modo = 'acceptEdits'
  const p = s.at.atenderLinea(linea(TOK_A, leer))
  const [ask] = ultimo(s)
  assert.throws(() => s.at.responder(ask.id, 'always'), /no hay «siempre»/)
  assert.equal(s.at.pendientes().length, 1)
  assert.deepEqual(s.grants, [])
  s.at.responder(ask.id, 'deny')
  assert.equal((await p).ok, false)
})

test('sin modo riesgoso un grant guardado no pregunta y el pedido no trae sinSiempre', async () => {
  const s = armar({ grants: [{ accountId: 'A', conv: { kind: 'team', id: T1 }, nombre: 'x', at: 0 }] })
  assert.equal((await s.at.atenderLinea(linea(TOK_A, leer))).ok, true)
  assert.equal(s.asks.length, 0)
  const s2 = armar()
  const p = s2.at.atenderLinea(linea(TOK_A, leer))
  assert.equal(ultimo(s2)[0].sinSiempre, undefined)
  s2.at.responder(ultimo(s2)[0].id, 'once')
  await p
})
