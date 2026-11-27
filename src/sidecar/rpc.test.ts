import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ORIGEN_UI, Rpc, type Salida } from './rpc'
import { origenConfiable } from '../main/ipc-guard'

function armar(): { rpc: Rpc; salidas: Salida[] } {
  const salidas: Salida[] = []
  const rpc = new Rpc((l) => salidas.push(JSON.parse(l) as Salida))
  return { rpc, salidas }
}
const esperar = (): Promise<void> => new Promise((r) => setImmediate(r))

test('invoke llama al handler y responde con su resultado', async () => {
  const { rpc, salidas } = armar()
  rpc.handle('suma', (_e, a, b) => (a as number) + (b as number))
  rpc.recibir(JSON.stringify({ k: 'invoke', id: 1, channel: 'suma', args: [2, 3] }) + '\n')
  await esperar()
  assert.deepEqual(salidas, [{ k: 'result', id: 1, ok: true, result: 5 }])
})

test('un handler que tira o un canal sin handler responden con error', async () => {
  const { rpc, salidas } = armar()
  rpc.handle('mal', () => {
    throw new Error('rompió')
  })
  rpc.recibir(JSON.stringify({ k: 'invoke', id: 1, channel: 'mal', args: [] }) + '\n')
  rpc.recibir(JSON.stringify({ k: 'invoke', id: 2, channel: 'nada', args: [] }) + '\n')
  await esperar()
  const porId = [...salidas].sort((a, b) => ('id' in a && 'id' in b ? a.id - b.id : 0))
  assert.deepEqual(porId, [
    { k: 'result', id: 1, ok: false, error: 'rompió' },
    { k: 'result', id: 2, ok: false, error: 'Sin handler para nada' }
  ])
})

test('el evento del handler viene del origen de la app y pasa el chequeo de ipc-guard', async () => {
  const { rpc } = armar()
  let url = ''
  rpc.handle('x', (e) => {
    url = e.senderFrame.url
  })
  rpc.recibir(JSON.stringify({ k: 'invoke', id: 1, channel: 'x', args: [] }) + '\n')
  await esperar()
  assert.equal(url, ORIGEN_UI)
  assert.equal(origenConfiable(url, undefined), true)
})

test('las líneas pueden llegar partidas o juntas', async () => {
  const { rpc, salidas } = armar()
  rpc.handle('eco', (_e, v) => v)
  const l1 = JSON.stringify({ k: 'invoke', id: 1, channel: 'eco', args: ['á'] }) + '\n'
  const l2 = JSON.stringify({ k: 'invoke', id: 2, channel: 'eco', args: ['b'] }) + '\n'
  rpc.recibir(l1.slice(0, 10))
  rpc.recibir(l1.slice(10) + l2)
  await esperar()
  assert.deepEqual(
    salidas.map((s) => (s.k === 'result' ? s.result : null)),
    ['á', 'b']
  )
})

test('send avisa a los oyentes y una línea inválida se ignora', () => {
  const { rpc } = armar()
  const vistos: unknown[] = []
  rpc.on('pty:write', (_e, ...a) => vistos.push(a))
  rpc.recibir('esto no es json\n')
  rpc.recibir(JSON.stringify({ k: 'send', channel: 'pty:write', args: ['id', 'ls'] }) + '\n')
  assert.deepEqual(vistos, [['id', 'ls']])
})

test('nativo espera la respuesta de Rust y rechaza si falla', async () => {
  const { rpc, salidas } = armar()
  const ok = rpc.nativo<string>('clipboard.read')
  const mal = rpc.nativo('dialog.open')
  assert.deepEqual(salidas, [
    { k: 'native', id: 1, op: 'clipboard.read', args: [] },
    { k: 'native', id: 2, op: 'dialog.open', args: [] }
  ])
  rpc.recibir(JSON.stringify({ k: 'native-result', id: 1, ok: true, result: 'hola' }) + '\n')
  rpc.recibir(JSON.stringify({ k: 'native-result', id: 2, ok: false, error: 'cancelado' }) + '\n')
  assert.equal(await ok, 'hola')
  await assert.rejects(mal, /cancelado/)
})

test('emitir manda un evento a la UI y native-event llega a quien lo espera', () => {
  const { rpc, salidas } = armar()
  rpc.emitir('agent:status', 'ws1', { estado: 'trabaja' })
  assert.deepEqual(salidas, [{ k: 'event', channel: 'agent:status', args: ['ws1', { estado: 'trabaja' }] }])
  const vistos: unknown[] = []
  rpc.alEventoNativo('window:focus', (...a) => vistos.push(a))
  rpc.recibir(JSON.stringify({ k: 'native-event', name: 'window:focus', args: [true] }) + '\n')
  assert.deepEqual(vistos, [[true]])
})
