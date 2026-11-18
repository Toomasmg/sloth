import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { spawn } from 'node:child_process'
import { LectorLimitesCodex } from './codex-limites'
import type { DepsLimites } from './codex-limites'

const CUENTA = { id: 'c1', configDir: 'C:\\cuentas\\c1', proveedor: 'codex' }
const AHORA = 1_700_000_000_000
const RESULTADO = { rateLimits: { primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: Math.floor((AHORA + 3_600_000) / 1000) }, secondary: null } }

class HijoFalso extends EventEmitter {
  pid = 4321
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stdin = new PassThrough()
  stdout = new PassThrough()
  recibido = ''
  constructor(guion: (hijo: HijoFalso, linea: string) => void) {
    super()
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (d: string) => {
      this.recibido += d
      for (const l of d.split('\n')) if (l) guion(this, l)
    })
  }
  responder(obj: unknown): void {
    this.stdout.write(`${JSON.stringify(obj)}\n`)
  }
}

function conExito(resultado: unknown = RESULTADO): (h: HijoFalso, l: string) => void {
  return (h, l) => {
    const m = JSON.parse(l) as { id?: number; method?: string }
    if (m.method === 'initialize') h.responder({ id: m.id, result: { userAgent: 'x' } })
    if (m.method === 'account/rateLimits/read') h.responder({ id: m.id, result: resultado })
  }
}

function armar(guion: (h: HijoFalso, l: string) => void, over: Partial<DepsLimites> = {}) {
  const t = { ahora: AHORA, spawns: 0, matados: [] as number[], llamadas: [] as { file: string; args: readonly string[]; opts: Record<string, unknown> }[], hijos: [] as HijoFalso[] }
  const falso = ((file: string, args: readonly string[], opts: Record<string, unknown>) => {
    t.spawns++
    t.llamadas.push({ file, args, opts })
    const h = new HijoFalso(guion)
    t.hijos.push(h)
    return h
  }) as unknown as typeof spawn
  const deps: Partial<DepsLimites> = {
    spawn: falso,
    ahora: () => t.ahora,
    entorno: () => ({ PATH: 'x', OPENAI_API_KEY: 'k', CODEX_HOME: 'C:\\otra', SLOTH_TOKEN: 's' }),
    matar: {
      platform: 'linux',
      taskkill: async () => true,
      killGroup: (pid) => {
        t.matados.push(pid)
        for (const h of t.hijos) {
          h.exitCode = 0
          h.emit('exit')
          h.emit('close')
        }
      },
      killOne: () => undefined
    },
    ...over
  }
  return { lector: new LectorLimitesCodex(deps), t }
}

test('lee los límites, escribe el pedido en dos tiempos y mata el árbol', async () => {
  const { lector, t } = armar(conExito())
  const r = await lector.leer(CUENTA, 'codex')
  assert.deepEqual(r, { cincoHoras: { pct: 37, reiniciaEn: (AHORA + 3_600_000) }, semana: null, at: AHORA })
  assert.equal(t.spawns, 1)
  assert.deepEqual(t.matados, [4321])
  const { file, args, opts } = t.llamadas[0]
  assert.equal(file, 'codex')
  assert.deepEqual(args, ['app-server'])
  assert.equal(opts.windowsHide, true)
  assert.deepEqual(opts.stdio, ['pipe', 'pipe', 'ignore'])
  const env = opts.env as Record<string, string>
  assert.equal(env.CODEX_HOME, CUENTA.configDir)
  assert.equal('OPENAI_API_KEY' in env, false)
  assert.equal('SLOTH_TOKEN' in env, false)
  assert.equal(env.PATH, 'x')
  const metodos = t.hijos[0].recibido.split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { method: string }).method)
  assert.deepEqual(metodos, ['initialize', 'initialized', 'account/rateLimits/read'])
})

test('cache de 5 minutos por cuenta', async () => {
  const { lector, t } = armar(conExito())
  await lector.leer(CUENTA, 'codex')
  t.ahora += 4 * 60_000
  const otra = await lector.leer(CUENTA, 'codex')
  assert.equal(t.spawns, 1)
  assert.equal(otra?.cincoHoras?.pct, 37)
  assert.equal(lector.cacheado(CUENTA.id)?.cincoHoras?.pct, 37)
  t.ahora += 2 * 60_000
  assert.equal(lector.cacheado(CUENTA.id), undefined)
  await lector.leer(CUENTA, 'codex')
  assert.equal(t.spawns, 2)
})

test('dos llamadas simultáneas son un solo spawn', async () => {
  const { lector, t } = armar(conExito())
  const [a, b] = await Promise.all([lector.leer(CUENTA, 'codex'), lector.leer(CUENTA, 'codex')])
  assert.equal(t.spawns, 1)
  assert.deepEqual(a, b)
})

test('cuentas distintas se leen una a la vez', async () => {
  let abiertos = 0
  let maximo = 0
  const guion = (h: HijoFalso, l: string): void => {
    const m = JSON.parse(l) as { id?: number; method?: string }
    if (m.method === 'initialize') {
      abiertos++
      h.once('close', () => abiertos--)
      maximo = Math.max(maximo, abiertos)
      h.responder({ id: m.id, result: {} })
    }
    if (m.method === 'account/rateLimits/read') h.responder({ id: m.id, result: RESULTADO })
  }
  const { lector, t } = armar(guion)
  await Promise.all([lector.leer(CUENTA, 'codex'), lector.leer({ ...CUENTA, id: 'c2' }, 'codex')])
  assert.equal(t.spawns, 2)
  assert.equal(maximo, 1)
  assert.equal(t.matados.length, 2)
})

test('un error JSON-RPC es sin dato, mata el árbol y no se reintenta por 30 minutos', async () => {
  const { lector, t } = armar((h, l) => {
    const m = JSON.parse(l) as { id?: number; method?: string }
    if (m.method === 'initialize') h.responder({ id: m.id, error: { code: -32600, message: 'C:\\Users\\alguien\\x' } })
  })
  assert.equal(await lector.leer(CUENTA, 'codex'), undefined)
  assert.deepEqual(t.matados, [4321])
  t.ahora += 29 * 60_000
  assert.equal(await lector.leer(CUENTA, 'codex'), undefined)
  assert.equal(t.spawns, 1)
  t.ahora += 2 * 60_000
  assert.equal(await lector.leer(CUENTA, 'codex'), undefined)
  assert.equal(t.spawns, 2)
})

test('con el método devuelve error tras el handshake también es sin dato', async () => {
  const { lector } = armar((h, l) => {
    const m = JSON.parse(l) as { id?: number; method?: string }
    if (m.method === 'initialize') h.responder({ id: m.id, result: {} })
    if (m.method === 'account/rateLimits/read') h.responder({ id: m.id, error: { code: -32601, message: 'x' } })
  })
  assert.equal(await lector.leer(CUENTA, 'codex'), undefined)
})

test('una respuesta sin ventanas válidas es un resultado vacío, no un número inventado', async () => {
  const { lector } = armar(conExito({ rateLimits: { primary: { usedPercent: 10, windowDurationMins: 60 } } }))
  assert.deepEqual(await lector.leer(CUENTA, 'codex'), { cincoHoras: null, semana: null, at: AHORA })
})

test('el timeout de 10 s da sin dato y mata el árbol', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] })
  const { lector, t } = armar(() => undefined)
  const p = lector.leer(CUENTA, 'codex')
  await new Promise((r) => setImmediate(r))
  ctx.mock.timers.tick(10_000)
  assert.equal(await p, undefined)
  assert.deepEqual(t.matados, [4321])
})

test('si el proceso se cierra solo o no se puede lanzar es sin dato', async () => {
  const cierra = armar((h) => {
    h.emit('close')
  })
  assert.equal(await cierra.lector.leer(CUENTA, 'codex'), undefined)
  const falla = armar(() => undefined, {
    spawn: (() => {
      throw Object.assign(new Error('ENOENT C:\\secreto'), { code: 'ENOENT' })
    }) as unknown as typeof spawn
  })
  assert.equal(await falla.lector.leer(CUENTA, 'codex'), undefined)
  const noExiste = armar((h) => {
    h.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }))
  })
  assert.equal(await noExiste.lector.leer(CUENTA, 'codex'), undefined)
})

test('más de 256 KB de salida aborta la lectura', async () => {
  const { lector, t } = armar((h) => {
    h.stdout.write('x'.repeat(300 * 1024))
  })
  assert.equal(await lector.leer(CUENTA, 'codex'), undefined)
  assert.deepEqual(t.matados, [4321])
})

test('texto suelto y notificaciones del servidor se ignoran', async () => {
  const { lector } = armar((h, l) => {
    const m = JSON.parse(l) as { id?: number; method?: string }
    if (m.method === 'initialize') {
      h.stdout.write('Starting...\n')
      h.responder({ method: 'account/rateLimits/updated', params: {} })
      h.responder({ id: m.id, result: {} })
    }
    if (m.method === 'account/rateLimits/read') h.responder({ id: m.id, result: RESULTADO })
  })
  assert.equal((await lector.leer(CUENTA, 'codex'))?.cincoHoras?.pct, 37)
})

test('un agente que Sloth no conoce no lanza nada', async () => {
  const { lector, t } = armar(conExito())
  assert.equal(await lector.leer({ ...CUENTA, proveedor: 'otro' }, 'codex'), undefined)
  assert.equal(t.spawns, 0)
})

test('en Windows un .cmd corre por cmd.exe verbatim con argv fijo y una ruta rara no se lanza', async () => {
  const ok = armar(conExito(), { matar: { platform: 'win32', taskkill: async () => true, killGroup: () => undefined, killOne: () => undefined } })
  const p = ok.lector.leer(CUENTA, 'C:\\Users\\Yo Mismo\\npm\\codex.cmd')
  await new Promise((r) => setImmediate(r))
  const h = ok.t.hijos[0]
  const l = ok.t.llamadas[0]
  assert.equal(l.file, 'cmd.exe')
  assert.deepEqual(l.args, ['/d', '/s', '/c', '""C:\\Users\\Yo Mismo\\npm\\codex.cmd" app-server"'])
  assert.equal(l.opts.windowsVerbatimArguments, true)
  assert.equal(l.opts.detached, false)
  h.exitCode = 0
  h.emit('close')
  await p

  const rara = armar(conExito(), { matar: { platform: 'win32', taskkill: async () => true, killGroup: () => undefined, killOne: () => undefined } })
  assert.equal(await rara.lector.leer(CUENTA, 'C:\\a&b\\codex.cmd'), undefined)
  assert.equal(rara.t.spawns, 0)
})
