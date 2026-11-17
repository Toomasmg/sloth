import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { cortarArbol, esperarCierre, matarArbol, pidValido, spawnOptsArbol } from './kill-tree'
import type { KillDeps } from './kill-tree'

function falsas(platform: NodeJS.Platform, over: Partial<KillDeps> = {}): { deps: KillDeps; llamadas: string[] } {
  const llamadas: string[] = []
  const deps: KillDeps = {
    platform,
    taskkill: async (pid) => {
      llamadas.push(`taskkill:${pid}`)
      return true
    },
    killGroup: (pid) => {
      llamadas.push(`group:${pid}`)
    },
    killOne: (pid) => {
      llamadas.push(`one:${pid}`)
    },
    ...over
  }
  return { deps, llamadas }
}

const esrch = (): never => {
  throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
}

const noLider = (): never => {
  throw Object.assign(new Error('no es líder'), { code: 'EPERM' })
}

test('en Windows usa taskkill y no el grupo', async () => {
  const { deps, llamadas } = falsas('win32')
  await matarArbol(123, deps)
  assert.deepEqual(llamadas, ['taskkill:123'])
})

test('fuera de Windows mata el grupo', async () => {
  const { deps, llamadas } = falsas('linux')
  await matarArbol(123, deps)
  assert.deepEqual(llamadas, ['group:123'])
})

test('si el grupo no existe no sigue; si no era líder cae al pid solo', async () => {
  const a = falsas('linux', { killGroup: esrch })
  await matarArbol(123, a.deps)
  assert.deepEqual(a.llamadas, [])
  const b = falsas('linux', { killGroup: noLider })
  await matarArbol(123, b.deps)
  assert.deepEqual(b.llamadas, ['one:123'])
  const c = falsas('linux', { killGroup: noLider, killOne: esrch })
  await assert.doesNotReject(matarArbol(123, c.deps))
})

test('un pid inválido no mata nada', async () => {
  for (const pid of [undefined, 0, 1, -5, NaN, 1.5]) {
    for (const plat of ['win32', 'linux'] as const) {
      const { deps, llamadas } = falsas(plat)
      await matarArbol(pid, deps)
      assert.deepEqual(llamadas, [], `pid ${String(pid)} en ${plat}`)
    }
  }
  assert.equal(pidValido(2), true)
  assert.equal(pidValido('123'), false)
})

test('si taskkill falla, matarArbol resuelve igual', async () => {
  const { deps } = falsas('win32', { taskkill: () => Promise.reject(new Error('falló')) })
  await assert.doesNotReject(matarArbol(123, deps))
})

test('si taskkill sale con error, cae a matar el proceso directo', async () => {
  const { deps, llamadas } = falsas('win32', { taskkill: async () => false })
  await matarArbol(123, deps)
  assert.deepEqual(llamadas, ['one:123'])
})

test('si taskkill tira y killOne también, matarArbol resuelve igual', async () => {
  const { deps } = falsas('win32', {
    taskkill: () => Promise.reject(new Error('falló')),
    killOne: () => {
      throw new Error('EPERM')
    }
  })
  await assert.doesNotReject(matarArbol(123, deps))
})

test('cortarArbol no espera más del plazo aunque taskkill no vuelva', async () => {
  const { deps } = falsas('win32', { taskkill: () => new Promise<boolean>(() => {}) })
  const hijo = Object.assign(hijoFalso(), { pid: 123 })
  const t0 = Date.now()
  await cortarArbol(hijo, deps, 50)
  assert.ok(Date.now() - t0 < 1000)
})

test('detached solo fuera de Windows', () => {
  assert.deepEqual(spawnOptsArbol('win32'), { detached: false })
  assert.deepEqual(spawnOptsArbol('linux'), { detached: true })
})

function hijoFalso(exitCode: number | null = null): EventEmitter & { exitCode: number | null; signalCode: NodeJS.Signals | null } {
  return Object.assign(new EventEmitter(), { exitCode, signalCode: null })
}

test('esperarCierre resuelve cuando el hijo sale', async () => {
  const hijo = hijoFalso()
  const p = esperarCierre(hijo, 5000)
  hijo.emit('exit', 0)
  await p
  assert.equal(hijo.listenerCount('exit'), 0)
  assert.equal(hijo.listenerCount('close'), 0)
})

test('esperarCierre resuelve por tope si no sale', async () => {
  await esperarCierre(hijoFalso(), 20)
})

test('esperarCierre resuelve ya si el hijo había cerrado', async () => {
  await esperarCierre(hijoFalso(0), 60_000)
})
