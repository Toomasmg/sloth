import { test } from 'node:test'
import assert from 'node:assert/strict'
import { closeSerially, type ClosingPty } from './shutdown'

/** Pty de mentira: al matarla avisa su salida después de `exitAfter` ms (o nunca, con null). */
function fake(log: string[], id: string, opts: { running?: boolean; exitAfter?: number | null; throws?: boolean } = {}): ClosingPty {
  let running = opts.running ?? true
  let done: () => void = () => {}
  const exited = new Promise<void>((r) => {
    done = r
  })
  if (!running) done()
  return {
    isRunning: () => running,
    exited,
    kill: () => {
      log.push(`kill ${id}`)
      if (opts.throws) throw new Error('ya terminó')
      const after = opts.exitAfter === undefined ? 0 : opts.exitAfter
      if (after === null) return
      setTimeout(() => {
        running = false
        log.push(`exit ${id}`)
        done()
      }, after)
    }
  }
}

test('cierra de a una: no mata la siguiente hasta que salió la anterior', async () => {
  const log: string[] = []
  await closeSerially([fake(log, 'a', { exitAfter: 20 }), fake(log, 'b', { exitAfter: 5 })], { perPtyMs: 1000, totalMs: 3000 })
  assert.deepEqual(log, ['kill a', 'exit a', 'kill b', 'exit b'])
})

test('no llama a kill() en las que ya terminaron', async () => {
  const log: string[] = []
  await closeSerially([fake(log, 'a', { running: false }), fake(log, 'b')], { perPtyMs: 1000, totalMs: 3000 })
  assert.deepEqual(log, ['kill b', 'exit b'])
})

test('si una no avisa su salida, sigue con la próxima al vencer su tope', async () => {
  const log: string[] = []
  const t0 = Date.now()
  const r = await closeSerially([fake(log, 'a', { exitAfter: null }), fake(log, 'b')], { perPtyMs: 40, totalMs: 3000 })
  assert.deepEqual(log, ['kill a', 'kill b', 'exit b'])
  assert.equal(r.timedOut, 1)
  assert.ok(Date.now() - t0 < 1000)
})

test('respeta el tope total: las que quedan no se esperan', async () => {
  const log: string[] = []
  const t0 = Date.now()
  const r = await closeSerially([fake(log, 'a', { exitAfter: null }), fake(log, 'b', { exitAfter: null }), fake(log, 'c', { exitAfter: null })], { perPtyMs: 60, totalMs: 100 })
  assert.ok(Date.now() - t0 < 400)
  assert.equal(log[0], 'kill a')
  assert.ok(r.timedOut >= 2)
})

test('si kill() tira, sigue con las demás', async () => {
  const log: string[] = []
  await closeSerially([fake(log, 'a', { throws: true }), fake(log, 'b')], { perPtyMs: 30, totalMs: 3000 })
  assert.deepEqual(log, ['kill a', 'kill b', 'exit b'])
})
