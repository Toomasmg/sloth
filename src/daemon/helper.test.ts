import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hookTokenDe, nuevoNonce, pruebaCliente } from './auth'

const raiz = fileURLToPath(new URL('../..', import.meta.url))
const buscar = (nombre: string): string | undefined =>
  [join(raiz, 'out', 'daemon', nombre), join(raiz, 'native', 'daemon', 'target', 'release', nombre), join(raiz, 'native', 'helper', 'target', 'release', nombre)].find(existsSync)
const hook = buscar('sloth-hook.exe')
const daemon = buscar('sloth-daemon.exe')
const faltan = hook && daemon ? false : 'sin compilar (npm run build:daemon-rs)'
const KEY = 'cd'.repeat(32)

type Msg = Record<string, unknown> & { t: string }

class Cliente {
  msgs: Msg[] = []
  private buf = ''
  readonly sock: Socket
  constructor(sock: Socket) {
    this.sock = sock
    sock.setEncoding('utf8')
    sock.on('data', (d: string) => {
      this.buf += d
      let i: number
      while ((i = this.buf.indexOf('\n')) >= 0) {
        this.msgs.push(JSON.parse(this.buf.slice(0, i)) as Msg)
        this.buf = this.buf.slice(i + 1)
      }
    })
    sock.on('error', () => {})
  }
  send(m: object): void {
    this.sock.write(JSON.stringify(m) + '\n')
  }
  async esperar(pred: (m: Msg) => boolean, ms = 8000): Promise<Msg> {
    const fin = Date.now() + ms
    for (;;) {
      const m = this.msgs.find(pred)
      if (m) return m
      if (Date.now() > fin) throw new Error(`no llegó el mensaje esperado; llegaron ${JSON.stringify(this.msgs).slice(0, 400)}`)
      await new Promise((r) => setTimeout(r, 25))
    }
  }
}

async function conectar(pipe: string): Promise<Cliente> {
  const fin = Date.now() + 5000
  for (;;) {
    try {
      return await new Promise<Cliente>((resolve, reject) => {
        const s = connect(pipe)
        s.once('connect', () => resolve(new Cliente(s)))
        s.once('error', reject)
      })
    } catch (e) {
      if (Date.now() > fin) throw e
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}

test('el ejecutable de hooks le habla al daemon: eventos, permisos y nada sin las variables', { skip: faltan }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sloth-hk-'))
  const pipe = `\\\\.\\pipe\\sloth-test-${nuevoNonce().slice(0, 12)}`
  writeFileSync(join(dir, 'daemon-key'), KEY)
  const proc: ChildProcess = spawn(daemon!, ['--user-data', dir, '--pipe', pipe, '--app-version', 'test'], { stdio: 'ignore', windowsHide: true })
  const salida = new Promise<number | null>((r) => proc.once('exit', (c) => r(c)))
  try {
    const c = await conectar(pipe)
    const nc = nuevoNonce()
    c.send({ t: 'challenge', nonce: nc })
    const ok = await c.esperar((m) => m.t === 'challenge-ok')
    c.send({ t: 'hello', proof: pruebaCliente(KEY, nc, String(ok.nonce)), clientVersion: 'test' })
    const hello = await c.esperar((m) => m.t === 'hello-ok')
    const env = { ...process.env, SLOTH_HOOK_URL: String(hello.hookUrl), SLOTH_TOKEN: hookTokenDe(String(hello.hookToken), 'w1'), SLOTH_WS: 'w1' }

    // Un evento normal llega al daemon y de ahí a la interfaz.
    const r = spawnSync(hook!, ['PreToolUse'], { env, input: JSON.stringify({ tool_name: 'Bash', tool_input: { run_in_background: true } }), encoding: 'utf8', timeout: 10_000 })
    assert.equal(r.status, 0)
    const h = await c.esperar((m) => m.t === 'hook')
    assert.deepEqual(
      { ...(h.event as object), at: undefined },
      { ws: 'w1', event: 'PreToolUse', tool: 'Bash', enSegundoPlano: true, at: undefined }
    )

    // Sin las variables no hace nada y sale en paz; con un token de otro espacio el daemon lo rechaza y tampoco rompe.
    const sinEnv = spawnSync(hook!, ['Stop'], { env: { ...process.env, SLOTH_HOOK_URL: '', SLOTH_TOKEN: '', SLOTH_WS: '', ANTIREA_HOOK_URL: '' }, input: '{}', encoding: 'utf8', timeout: 10_000 })
    assert.equal(sinEnv.status, 0)
    const ajeno = spawnSync(hook!, ['Stop'], { env: { ...env, SLOTH_TOKEN: hookTokenDe(String(hello.hookToken), 'otro') }, input: '{}', encoding: 'utf8', timeout: 10_000 })
    assert.equal(ajeno.status, 0)
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(c.msgs.filter((m) => m.t === 'hook').length, 1, 'solo llegó el primero')

    // Un pedido de permiso espera la decisión y la imprime como la espera Claude.
    const p = spawn(hook!, ['PermissionRequest'], { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    let impreso = ''
    p.stdout.on('data', (d: Buffer) => (impreso += d.toString('utf8')))
    const termino = new Promise<number | null>((res) => p.once('exit', (cod) => res(cod)))
    p.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, permission_suggestions: [{ x: 1 }] }))
    const pedido = await c.esperar((m) => m.t === 'permission')
    const req = pedido.req as { id: string; tool: string; input: unknown; suggestions: unknown }
    assert.equal(req.tool, 'Bash')
    assert.deepEqual(req.input, { command: 'ls' })
    assert.deepEqual(req.suggestions, [{ x: 1 }])
    c.send({ t: 'permission-answer', reqId: req.id, decision: { behavior: 'allow' } })
    assert.equal(await termino, 0)
    assert.deepEqual(JSON.parse(impreso), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })

    // Si la interfaz no decide (null), no imprime nada y Claude pregunta en la terminal.
    const q = spawn(hook!, ['PermissionRequest'], { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    let impreso2 = ''
    q.stdout.on('data', (d: Buffer) => (impreso2 += d.toString('utf8')))
    const termino2 = new Promise<number | null>((res) => q.once('exit', (cod) => res(cod)))
    q.stdin.end(JSON.stringify({ tool_name: 'Edit', tool_input: {} }))
    const pedido2 = await c.esperar((m) => m.t === 'permission' && (m.req as { tool: string }).tool === 'Edit')
    c.send({ t: 'permission-answer', reqId: (pedido2.req as { id: string }).id, decision: null })
    assert.equal(await termino2, 0)
    assert.equal(impreso2, '')

    c.send({ t: 'shutdown', rid: 1 })
    assert.equal(await salida, 0)
  } finally {
    proc.kill()
    await salida
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // En Windows el log del daemon puede tardar en soltarse.
    }
  }
})

const ENTRADA = JSON.stringify({ model: { display_name: 'Opus' }, rate_limits: { five_hour: { used_percentage: 72.5, resets_at: 1894000000 } } })
const original = (cmd: string): string => Buffer.from(cmd).toString('base64url')
const limpio = (extra: Record<string, string>): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const k of ['MSYSTEM', 'EXEPATH', 'SLOTH_WS', 'CLAUDE_CONFIG_DIR']) if (!(k in extra)) delete e[k]
  return e
}

test('la statusline: guarda los límites solo si la lanzó Sloth y devuelve la salida de la original', { skip: hook ? process.platform !== 'win32' : faltan }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sloth-sl-rs-'))
  try {
    const original1 = spawnSync(hook!, ['statusline', original('Write-Output "hola desde powershell"')], { env: limpio({ SLOTH_WS: 'w1' }), input: ENTRADA, encoding: 'utf8', timeout: 20_000 })
    assert.equal(original1.stdout.trim(), 'hola desde powershell')

    const solo = spawnSync(hook!, ['statusline'], { env: limpio({ SLOTH_WS: 'w1', CLAUDE_CONFIG_DIR: dir }), input: ENTRADA, encoding: 'utf8', timeout: 20_000 })
    assert.equal(solo.stdout, '')
    const j = JSON.parse(readFileSync(join(dir, 'sloth-limites.json'), 'utf8')) as { fiveHour: unknown; sevenDay: unknown }
    assert.deepEqual(j.fiveHour, { pct: 72.5, resetsAt: 1894000000 })
    assert.equal(j.sevenDay, null)
    rmSync(join(dir, 'sloth-limites.json'))

    spawnSync(hook!, ['statusline'], { env: limpio({ CLAUDE_CONFIG_DIR: dir }), input: ENTRADA, encoding: 'utf8', timeout: 20_000 })
    assert.equal(existsSync(join(dir, 'sloth-limites.json')), false, 'sin SLOTH_WS no guarda')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('la statusline con Git Bash corre la original en ese bash con la misma entrada y devuelve su código', { skip: hook ? !existsSync('C:\\Program Files\\Git\\bin\\bash.exe') : faltan }, () => {
  const r = spawnSync(hook!, ['statusline', original('read -r j; printf "bash vio: %s" "${j:0:9}"; exit 3')], {
    env: limpio({ MSYSTEM: 'MINGW64', EXEPATH: 'C:\\Program Files\\Git\\bin' }),
    input: ENTRADA,
    encoding: 'utf8',
    timeout: 20_000
  })
  assert.equal(r.stdout, 'bash vio: {"model":')
  assert.equal(r.status, 3)
})

test('el aviso de Codex solo avisa un turno terminado y no copia nada de su texto', { skip: faltan }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sloth-nt-'))
  const pipe = `\\\\.\\pipe\\sloth-test-${nuevoNonce().slice(0, 12)}`
  writeFileSync(join(dir, 'daemon-key'), KEY)
  const proc = spawn(daemon!, ['--user-data', dir, '--pipe', pipe, '--app-version', 'test'], { stdio: 'ignore', windowsHide: true })
  const salida = new Promise<number | null>((r) => proc.once('exit', (c) => r(c)))
  try {
    const c = await conectar(pipe)
    const nc = nuevoNonce()
    c.send({ t: 'challenge', nonce: nc })
    const ok = await c.esperar((m) => m.t === 'challenge-ok')
    c.send({ t: 'hello', proof: pruebaCliente(KEY, nc, String(ok.nonce)), clientVersion: 'test' })
    const hello = await c.esperar((m) => m.t === 'hello-ok')
    const env = { ...process.env, SLOTH_HOOK_URL: String(hello.hookUrl), SLOTH_TOKEN: hookTokenDe(String(hello.hookToken), 'w9'), SLOTH_WS: 'w9' }
    spawnSync(hook!, ['notify', '{"type":"otro"}'], { env, timeout: 10_000 })
    spawnSync(hook!, ['notify', '{"type":"agent-turn-complete","last-assistant-message":"secreto","cwd":"C:\\\\x"}'], { env, timeout: 10_000 })
    const h = await c.esperar((m) => m.t === 'hook')
    assert.deepEqual({ ...(h.event as object), at: undefined }, { ws: 'w9', event: 'Stop', at: undefined })
    assert.equal(JSON.stringify(c.msgs).includes('secreto'), false)
    assert.equal(c.msgs.filter((m) => m.t === 'hook').length, 1)
    c.send({ t: 'shutdown', rid: 1 })
    await salida
  } finally {
    proc.kill()
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // El log del daemon puede tardar en soltarse.
    }
  }
})
