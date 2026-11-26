import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { hookTokenDe, nuevoNonce, pruebaCliente } from './auth'

const raiz = fileURLToPath(new URL('../..', import.meta.url))
const exe = [join(raiz, 'out', 'daemon', 'sloth-daemon.exe'), join(raiz, 'native', 'daemon', 'target', 'release', 'sloth-daemon.exe')].find(existsSync)
const KEY = 'ab'.repeat(32)

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
        const m = JSON.parse(this.buf.slice(0, i)) as Msg
        this.msgs.push(m)
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
      if (Date.now() > fin) throw new Error(`no llegó el mensaje esperado; llegaron ${JSON.stringify(this.msgs).slice(0, 500)}`)
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

async function saludar(c: Cliente): Promise<Msg> {
  const nc = nuevoNonce()
  c.send({ t: 'challenge', nonce: nc })
  const ok = await c.esperar((m) => m.t === 'challenge-ok')
  c.send({ t: 'hello', proof: pruebaCliente(KEY, nc, String(ok.nonce)), clientVersion: 'test' })
  return c.esperar((m) => m.t === 'hello-ok')
}

test('el daemon en Rust habla el protocolo del cliente', { skip: exe ? false : 'sin compilar (npm run build:daemon-rs)' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sloth-rs-'))
  const pipe = `\\\\.\\pipe\\sloth-test-${nuevoNonce().slice(0, 12)}`
  writeFileSync(join(dir, 'daemon-key'), KEY)
  const proc: ChildProcess = spawn(exe!, ['--user-data', dir, '--pipe', pipe, '--app-version', 'test'], { stdio: 'ignore', windowsHide: true })
  const salida = new Promise<number | null>((r) => proc.once('exit', (c) => r(c)))
  try {
    const malo = await conectar(pipe)
    const cerrado = new Promise<void>((r) => malo.sock.once('close', () => r()))
    malo.send({ t: 'challenge', nonce: nuevoNonce() })
    malo.send({ t: 'hello', proof: 'x'.repeat(64), clientVersion: 'test' })
    await cerrado

    const c = await conectar(pipe)
    const hello = await saludar(c)
    assert.equal(hello.protocol, 2)
    assert.equal(hello.version, 'test')
    assert.match(String(hello.hookUrl), /^http:\/\/127\.0\.0\.1:\d+\/hook$/)

    c.send({ t: 'start', rid: 1, id: 'a', spawn: { file: 'cmd.exe', args: ['/c', 'echo hola-rust'], cwd: tmpdir(), env: process.env, cols: 80, rows: 24 } })
    const r = await c.esperar((m) => m.t === 'reply' && m.rid === 1)
    assert.equal(r.ok, true, JSON.stringify(r))
    await c.esperar((m) => m.t === 'exit' && m.id === 'a')
    const texto = c.msgs.filter((m) => m.t === 'data').flatMap((m) => (m.chunks as { data: string }[]).map((x) => x.data)).join('')
    assert.match(texto, /hola-rust/)
    // El daemon contesta solo la consulta de cursor de ConPTY y no la deja en el buffer.
    assert.ok(!texto.includes('[6n'))
    c.send({ t: 'list', rid: 2 })
    const lista = await c.esperar((m) => m.t === 'reply' && m.rid === 2)
    assert.deepEqual((lista.result as { id: string; running: boolean }[]).map((s) => [s.id, s.running]), [['a', false]])

    const hookUrl = String(hello.hookUrl)
    const token = hookTokenDe(String(hello.hookToken), 'w1')
    const post = (url: string, tok: string, body: object): Promise<Response> =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sloth-token': tok }, body: JSON.stringify(body) })
    assert.equal((await post(hookUrl, token, { ws: 'w1', event: 'Stop' })).status, 204)
    const h = await c.esperar((m) => m.t === 'hook')
    assert.equal((h.event as { event: string }).event, 'Stop')
    assert.equal((await post(hookUrl, 'f'.repeat(64), { ws: 'w1', event: 'Stop' })).status, 403)
    assert.equal((await post(hookUrl.replace('/hook', '/otra'), token, {})).status, 404)

    const permiso = post(hookUrl.replace('/hook', '/permission'), token, { ws: 'w1', tool: 'Bash', input: { command: 'ls' } })
    const p = await c.esperar((m) => m.t === 'permission')
    const req = p.req as { id: string; tool: string }
    assert.equal(req.tool, 'Bash')
    c.send({ t: 'permission-answer', reqId: req.id, decision: { behavior: 'allow' } })
    assert.deepEqual(await (await permiso).json(), { decision: { behavior: 'allow' } })
    await c.esperar((m) => m.t === 'permission-resolved' && m.id === req.id)

    c.send({ t: 'shutdown', rid: 3 })
    await c.esperar((m) => m.t === 'reply' && m.rid === 3)
    assert.equal(await salida, 0)
  } finally {
    proc.kill()
    await salida
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // En Windows el log del daemon puede tardar en soltarse; no es lo que se prueba.
    }
  }
})
