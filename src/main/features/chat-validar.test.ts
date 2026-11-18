import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHAT_SCHEMA_ESPERADA, FUNCIONES_SIN_ANON, TABLAS_ESPERADAS, codigoSeguro, validarChat } from './chat-validar'

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
const KEY = `${b64({ alg: 'HS256' })}.${b64({ role: 'anon' })}.firma_de_prueba`
const SERVICE = `${b64({ alg: 'HS256' })}.${b64({ role: 'service_role' })}.firma_de_prueba`
const URL_OK = 'https://abcdefghijkl.supabase.co'

interface Pedido {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}
type Resp = Response | Error | (() => Promise<Response>)

const json = (status: number, cuerpo: unknown): Response =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } })

function servidor(rutas: Record<string, Resp> = {}): { fetch: typeof fetch; pedidos: Pedido[] } {
  const pedidos: Pedido[] = []
  const porDefecto = (ruta: string, method: string): Resp => {
    if (ruta === '/auth/v1/health') return json(200, { status: 'ok' })
    if (ruta === '/auth/v1/settings') return json(200, { external: { github: true } })
    if (ruta === '/rest/v1/rpc/chat_schema_version') return json(200, CHAT_SCHEMA_ESPERADA)
    if (ruta.startsWith('/rest/v1/rpc/')) return json(401, { code: '42501', message: 'permission denied for function' })
    if (ruta.startsWith('/rest/v1/') && method === 'GET') return json(401, { code: '42501', message: 'permission denied for table' })
    return json(404, {})
  }
  const fake = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(input))
    pedidos.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: typeof init?.body === 'string' ? init.body : undefined
    })
    const r = rutas[u.pathname] ?? rutas[`${u.pathname}${u.search}`] ?? porDefecto(u.pathname, init?.method ?? 'GET')
    if (r instanceof Error) throw r
    return typeof r === 'function' ? r() : r
  }) as typeof fetch
  return { fetch: fake, pedidos }
}

const correr = (s: { fetch: typeof fetch }, extra: { supabaseUrl?: string; anonKey?: string; timeoutMs?: number; totalMs?: number } = {}) =>
  validarChat({ supabaseUrl: URL_OK, anonKey: KEY, fetch: s.fetch, ...extra })
const por = (cs: Awaited<ReturnType<typeof correr>>, id: string) => cs.find((c) => c.id === id)

test('todo bien: todos los chequeos en ok', async () => {
  const cs = await correr(servidor())
  assert.deepEqual(
    cs.map((c) => [c.id, c.estado]),
    [['host', 'ok'], ['alcance', 'ok'], ['github', 'ok'], ['tablas', 'ok'], ['funciones', 'ok'], ['version', 'ok']]
  )
})

test('falta message_reactions (404 PGRST205): tablas falla y la nombra', async () => {
  const cs = await correr(servidor({ '/rest/v1/message_reactions': json(404, { code: 'PGRST205', message: 'Could not find the table' }) }))
  assert.equal(por(cs, 'tablas')?.estado, 'fallo')
  assert.match(por(cs, 'tablas')?.detalle ?? '', /message_reactions/)
  assert.match(por(cs, 'tablas')?.accion ?? '', /setup\.sql/)
  assert.equal(por(cs, 'funciones')?.estado, 'ok')
})

test('falta remove_member (404 PGRST202): funciones falla con la migración 0007', async () => {
  const cs = await correr(servidor({ '/rest/v1/rpc/remove_member': json(404, { code: 'PGRST202', message: 'Could not find the function' }) }))
  assert.equal(por(cs, 'funciones')?.estado, 'fallo')
  assert.match(por(cs, 'funciones')?.detalle ?? '', /remove_member.*0007/)
})

test('sin chat_schema_version: aviso que pide la migración 0009 y lo demás sigue ok', async () => {
  const cs = await correr(servidor({ '/rest/v1/rpc/chat_schema_version': json(404, { code: 'PGRST202' }) }))
  assert.equal(por(cs, 'version')?.estado, 'aviso')
  assert.match(por(cs, 'version')?.detalle ?? '', /migración 0009/)
  for (const id of ['host', 'alcance', 'github', 'tablas', 'funciones']) assert.equal(por(cs, id)?.estado, 'ok', id)
})

test('versión vieja es fallo y versión más nueva es aviso', async () => {
  const vieja = await correr(servidor({ '/rest/v1/rpc/chat_schema_version': json(200, 7) }))
  assert.equal(por(vieja, 'version')?.estado, 'fallo')
  assert.match(por(vieja, 'version')?.detalle ?? '', /el 7 .* el 9/)
  const nueva = await correr(servidor({ '/rest/v1/rpc/chat_schema_version': json(200, 12) }))
  assert.equal(por(nueva, 'version')?.estado, 'aviso')
  assert.match(por(nueva, 'version')?.accion ?? '', /Actualizá Sloth/)
})

test('versión que no es un entero razonable queda sin datos', async () => {
  for (const cuerpo of [1.5, -1, 99999, 'nueve', null, { v: 9 }]) {
    const cs = await correr(servidor({ '/rest/v1/rpc/chat_schema_version': json(200, cuerpo) }))
    assert.equal(por(cs, 'version')?.estado, 'sin-datos', JSON.stringify(cuerpo))
  }
})

test('health 401: fallo de clave, el resto sin datos y no hay más pedidos', async () => {
  const s = servidor({ '/auth/v1/health': json(401, { message: 'Invalid API key' }) })
  const cs = await correr(s)
  assert.equal(por(cs, 'alcance')?.estado, 'fallo')
  assert.match(por(cs, 'alcance')?.detalle ?? '', /rechazó la clave/)
  for (const id of ['github', 'tablas', 'funciones', 'version']) assert.equal(por(cs, id)?.estado, 'sin-datos', id)
  assert.equal(s.pedidos.length, 1)
})

test('servidor caído, 404 y 500 en health: fallo sin lanzar', async () => {
  const caido = await correr(servidor({ '/auth/v1/health': new TypeError('fetch failed') }))
  assert.match(por(caido, 'alcance')?.detalle ?? '', /Sin conexión/)
  const noEs = await correr(servidor({ '/auth/v1/health': new Response('<html>Not found</html>', { status: 404 }) }))
  assert.match(por(noEs, 'alcance')?.detalle ?? '', /no responde como un proyecto de Supabase/)
  const roto = await correr(servidor({ '/auth/v1/health': new Response('boom', { status: 503 }) }))
  assert.equal(por(roto, 'alcance')?.estado, 'fallo')
  assert.match(por(roto, 'alcance')?.detalle ?? '', /código 503/)
})

test('timeout: ni en health ni en los sondeos lanza', async () => {
  const timeout = Object.assign(new Error('x'), { name: 'TimeoutError' })
  const enHealth = await correr(servidor({ '/auth/v1/health': timeout }))
  assert.equal(por(enHealth, 'alcance')?.estado, 'fallo')
  assert.match(por(enHealth, 'alcance')?.detalle ?? '', /no respondió a tiempo/)
  const enSondeo = await correr(servidor({ '/rest/v1/messages': timeout, '/rest/v1/rpc/dm_writable': timeout, '/rest/v1/rpc/chat_schema_version': timeout, '/auth/v1/settings': timeout }))
  assert.equal(por(enSondeo, 'alcance')?.estado, 'ok')
  assert.equal(por(enSondeo, 'tablas')?.estado, 'sin-datos')
  assert.equal(por(enSondeo, 'funciones')?.estado, 'sin-datos')
  assert.equal(por(enSondeo, 'version')?.estado, 'sin-datos')
  assert.equal(por(enSondeo, 'github')?.estado, 'sin-datos')
})

test('un fetch que nunca responde se corta con el timeout y no se cuelga', async () => {
  const colgado = ((_u: unknown, init?: RequestInit) =>
    new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(init.signal?.reason)))) as typeof fetch
  const cs = await validarChat({ supabaseUrl: URL_OK, anonKey: KEY, fetch: colgado, timeoutMs: 30, totalMs: 200 })
  assert.equal(por(cs, 'alcance')?.estado, 'fallo')
  assert.equal(por(cs, 'tablas')?.estado, 'sin-datos')
})

test('el tope total corta aunque cada pedido tenga mucho margen', async () => {
  const colgado = ((_u: unknown, init?: RequestInit) =>
    new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(init.signal?.reason)))) as typeof fetch
  const t0 = Date.now()
  const cs = await validarChat({ supabaseUrl: URL_OK, anonKey: KEY, fetch: colgado, timeoutMs: 60_000, totalMs: 50 })
  assert.ok(Date.now() - t0 < 2000)
  assert.equal(por(cs, 'alcance')?.estado, 'fallo')
})

test('HTML en vez de JSON: no rompe y queda sin datos', async () => {
  const html = () => new Response('<html><body>Bad gateway</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
  const cs = await correr(servidor({ '/auth/v1/settings': html(), '/rest/v1/rpc/chat_schema_version': html(), '/rest/v1/profiles': html() }))
  assert.equal(por(cs, 'github')?.estado, 'sin-datos')
  assert.equal(por(cs, 'version')?.estado, 'sin-datos')
  assert.equal(por(cs, 'tablas')?.estado, 'aviso')
})

test('respuesta enorme: se corta y no se usa', async () => {
  const enorme = () => new Response(JSON.stringify({ external: { github: true }, relleno: 'x'.repeat(5_000_000) }), { status: 200 })
  const cs = await correr(servidor({ '/auth/v1/settings': enorme() }))
  assert.equal(por(cs, 'github')?.estado, 'sin-datos')
})

test('GitHub deshabilitado: fallo con qué activar', async () => {
  const cs = await correr(servidor({ '/auth/v1/settings': json(200, { external: { github: false } }) }))
  assert.equal(por(cs, 'github')?.estado, 'fallo')
  assert.match(por(cs, 'github')?.detalle ?? '', /Authentication → Sign In \/ Providers → GitHub/)
})

test('clave service_role o secret: se niega y no hace ningún pedido', async () => {
  for (const anonKey of [SERVICE, 'sb_secret_abcdefgh12345']) {
    const s = servidor()
    const cs = await correr(s, { anonKey })
    assert.equal(cs.length, 1)
    assert.equal(cs[0].id, 'clave')
    assert.equal(cs[0].estado, 'fallo')
    assert.match(cs[0].detalle, /service_role/)
    assert.equal(s.pedidos.length, 0)
    assert.ok(!JSON.stringify(cs).includes(anonKey))
  }
})

test('URL inválida: fallo sin pedidos', async () => {
  const s = servidor()
  const cs = await correr(s, { supabaseUrl: 'http://abcdefghijkl.supabase.co' })
  assert.equal(cs[0].estado, 'fallo')
  assert.equal(s.pedidos.length, 0)
})

test('host propio: aviso con el host, sin estado de confirmado', async () => {
  const cs = await correr(servidor(), { supabaseUrl: 'https://proyecto.ejemplo.com' })
  const host = por(cs, 'host')
  assert.equal(host?.estado, 'aviso')
  assert.match(host?.detalle ?? '', /Host propio: proyecto\.ejemplo\.com/)
  assert.equal(por(cs, 'alcance')?.estado, 'ok')
})

test('un 200 en una función sin execute para anon es aviso de seguridad, no ok', async () => {
  const cs = await correr(servidor({ '/rest/v1/rpc/chat_rate_hit': json(200, true) }))
  assert.equal(por(cs, 'funciones')?.estado, 'aviso')
  assert.match(por(cs, 'funciones')?.detalle ?? '', /chat_rate_hit/)
})

test('un 200 en una tabla (anon la lee) es aviso', async () => {
  const cs = await correr(servidor({ '/rest/v1/messages': json(200, []) }))
  assert.equal(por(cs, 'tablas')?.estado, 'aviso')
  assert.match(por(cs, 'tablas')?.detalle ?? '', /messages/)
})

test('cuerpo hostil del servidor: nada de eso llega a la salida', async () => {
  const hostil = {
    message: '<img onerror=x>'.repeat(1000),
    code: 'x'.repeat(5000),
    hint: 'linea1\nlinea2\r\n<script>alert(1)</script>',
    details: 'Bearer abc.def.ghi'
  }
  const cs = await correr(
    servidor({
      '/rest/v1/teams': json(500, hostil),
      '/rest/v1/rpc/dm_writable': json(500, hostil),
      '/rest/v1/rpc/chat_schema_version': json(500, hostil),
      '/auth/v1/settings': json(500, hostil)
    })
  )
  const salida = JSON.stringify(cs)
  for (const frag of ['onerror', 'xxxxx', 'linea1', 'script', 'Bearer']) assert.ok(!salida.includes(frag), frag)
  assert.ok(salida.length < 4000)
  assert.equal(por(cs, 'tablas')?.estado, 'sin-datos')
})

test('codigoSeguro solo deja pasar códigos con forma de código', () => {
  assert.equal(codigoSeguro({ code: 'PGRST205' }), 'PGRST205')
  assert.equal(codigoSeguro({ code: '42501' }), '42501')
  for (const code of ['x'.repeat(5000), 'pgrst205', 'ABC', 'ABCDEFGHI', 'PG RST', '<b>ABCDE', 'AB\nCDE', 42501, null]) {
    assert.equal(codigoSeguro({ code }), null, String(code))
  }
  for (const v of [null, undefined, 'PGRST205', 5, []]) assert.equal(codigoSeguro(v), null)
})

test('seguridad: solo apikey, GET/POST de lectura, POST solo a funciones conocidas, sin la clave en el resultado', async () => {
  const s = servidor()
  const cs = await correr(s)
  const permitidas = new Set([...FUNCIONES_SIN_ANON.map((f) => f.nombre), 'chat_schema_version'])
  assert.equal(s.pedidos.length, 1 + 1 + TABLAS_ESPERADAS.length + FUNCIONES_SIN_ANON.length + 1)
  for (const p of s.pedidos) {
    assert.ok(p.url.startsWith(`${URL_OK}/`), p.url)
    assert.equal(p.headers.apikey, KEY)
    assert.ok(!('authorization' in p.headers), 'Authorization')
    assert.ok(p.method === 'GET' || p.method === 'POST', p.method)
    if (p.method === 'POST') {
      const fn = new URL(p.url).pathname.replace('/rest/v1/rpc/', '')
      assert.ok(permitidas.has(fn), fn)
      assert.ok(Object.values(JSON.parse(p.body ?? 'null') as Record<string, unknown>).every((v) => v === null), 'los parámetros van en null')
    } else if (p.url.includes('/rest/v1/')) {
      assert.match(p.url, /\?select=\*&limit=0$/)
    }
  }
  assert.ok(!JSON.stringify(cs).includes(KEY))
  assert.ok(!JSON.stringify(cs).includes('firma_de_prueba'))
})

test('las funciones sondeadas usan los nombres de parámetro reales de las migraciones', async () => {
  const { readFileSync } = await import('node:fs')
  const sql = readFileSync(new URL('../../../supabase/setup.sql', import.meta.url), 'utf8')
  for (const f of FUNCIONES_SIN_ANON) {
    const m = sql.match(new RegExp(`function public\\.${f.nombre}\\(([^)]*)\\)`, 'g'))
    assert.ok(m, f.nombre)
    const nombres = Object.keys(f.args)
    assert.ok(
      m.some((d) => nombres.every((n) => d.includes(n)) && d.split(',').length === nombres.length),
      `${f.nombre}: ${m.join(' | ')}`
    )
  }
  for (const t of TABLAS_ESPERADAS) assert.match(sql, new RegExp(`create table if not exists public\\.${t}\\b`), t)
})
