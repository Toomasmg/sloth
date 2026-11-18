import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NOTIFY_SCRIPT, NOTIFY_SCRIPT_MARCA } from './notify-script'

test('el script no copia nada del texto del turno ni de la carpeta', () => {
  for (const campo of ['last-assistant-message', 'input-messages', 'cwd', 'thread-id', 'turn-id']) {
    assert.equal(NOTIFY_SCRIPT.includes(campo), false, campo)
  }
  assert.ok(NOTIFY_SCRIPT.includes(NOTIFY_SCRIPT_MARCA))
  assert.equal(NOTIFY_SCRIPT.includes('stdin'), false)
  for (const peligro of ['child_process', 'eval(', 'Function(', 'exec']) assert.equal(NOTIFY_SCRIPT.includes(peligro), false, peligro)
})

interface Pedido {
  token: string | string[] | undefined
  body: string
}

async function correr(argumento: string, envDe: (url: string) => Record<string, string | undefined>): Promise<{ pedidos: Pedido[]; codigo: number | null }> {
  const pedidos: Pedido[] = []
  const servidor = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString('utf8')))
    req.on('end', () => {
      pedidos.push({ token: req.headers['x-sloth-token'], body })
      res.writeHead(204).end()
    })
  })
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r))
  const carpeta = mkdtempSync(join(tmpdir(), 'sloth-notify-'))
  try {
    const script = join(carpeta, 'sloth notify.cjs')
    writeFileSync(script, NOTIFY_SCRIPT)
    const puerto = (servidor.address() as AddressInfo).port
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' }
    for (const [k, v] of Object.entries(envDe(`http://127.0.0.1:${puerto}/hook`))) if (v !== undefined) env[k] = v
    const hijo = spawn(process.execPath, [script, argumento], { env, stdio: 'ignore', windowsHide: true })
    const codigo = await new Promise<number | null>((r) => hijo.on('exit', r))
    return { pedidos, codigo }
  } finally {
    servidor.close()
    rmSync(carpeta, { recursive: true, force: true })
  }
}

const ENV = (url: string): Record<string, string | undefined> => ({ SLOTH_HOOK_URL: url, SLOTH_TOKEN: 'tok', SLOTH_WS: 'ws-1' })
const TURNO = JSON.stringify({ type: 'agent-turn-complete', cwd: 'C:/secreto', 'last-assistant-message': 'texto privado', 'input-messages': ['hola'] })

test('un turno terminado manda un Stop con solo el espacio', async () => {
  const r = await correr(TURNO, ENV)
  assert.equal(r.codigo, 0)
  assert.equal(r.pedidos.length, 1)
  assert.equal(r.pedidos[0].token, 'tok')
  assert.deepEqual(JSON.parse(r.pedidos[0].body), { ws: 'ws-1', event: 'Stop' })
  assert.equal(r.pedidos[0].body.includes('secreto'), false)
  assert.equal(r.pedidos[0].body.includes('privado'), false)
})

test('otro tipo de evento, JSON roto o un argumento que no es un objeto no mandan nada y salen con 0', async () => {
  for (const arg of [JSON.stringify({ type: 'otra-cosa' }), '{roto', 'null', '[]', '"agent-turn-complete"', '']) {
    const r = await correr(arg, ENV)
    assert.equal(r.codigo, 0, arg)
    assert.equal(r.pedidos.length, 0, arg)
  }
})

test('fuera de Sloth (sin las variables) no hace nada', async () => {
  for (const falta of ['SLOTH_HOOK_URL', 'SLOTH_TOKEN', 'SLOTH_WS']) {
    const r = await correr(TURNO, (u) => ({ ...ENV(u), [falta]: undefined }))
    assert.equal(r.codigo, 0, falta)
    assert.equal(r.pedidos.length, 0, falta)
  }
})

test('un destino que no es la propia máquina no recibe el token', async () => {
  for (const url of ['http://example.com/hook', 'https://127.0.0.1/hook', 'no es una url']) {
    const r = await correr(TURNO, (u) => ({ ...ENV(u), SLOTH_HOOK_URL: url }))
    assert.equal(r.codigo, 0, url)
    assert.equal(r.pedidos.length, 0, url)
  }
})
