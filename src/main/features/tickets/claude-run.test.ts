import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runClaude } from './claude-run'

class Propio extends Error {}

const base = { exe: process.execPath, args: ['-e', 'process.stdout.write("hola")'], prompt: '', cwd: process.cwd(), env: {}, quien: 'Test' }

test('runClaude conserva la clase del error que tira parse', async () => {
  await assert.rejects(
    runClaude({
      ...base,
      parse: () => {
        throw new Propio('falta')
      }
    }),
    (e) => e instanceof Propio && e.message === 'falta'
  )
})

test('runClaude devuelve lo que parsea', async () => {
  assert.equal(await runClaude({ ...base, parse: (s) => s.toUpperCase() }), 'HOLA')
})

const vive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('runClaude con temprano corta el proceso apenas una línea alcanza y lo mata', async () => {
  const inicio = Date.now()
  const pid = await runClaude({
    ...base,
    args: ['-e', "console.log(JSON.stringify({type:'system',subtype:'init',pid:process.pid}));setTimeout(()=>{},20000)"],
    timeoutMs: 10_000,
    parse: () => 0,
    temprano: (l) => (l.includes('init') ? Number(JSON.parse(l).pid) : undefined)
  })
  assert.ok(pid > 0)
  assert.ok(Date.now() - inicio < 5000)
  for (let i = 0; i < 50 && vive(pid); i++) await new Promise((r) => setTimeout(r, 100))
  assert.equal(vive(pid), false)
})

test('runClaude ignora un temprano que tira y sigue hasta el final', async () => {
  const r = await runClaude({
    ...base,
    args: ['-e', 'console.log("uno");console.log("dos")'],
    parse: (s) => s.trim().split(/\r?\n/).length,
    temprano: () => {
      throw new Error('mal')
    }
  })
  assert.equal(r, 2)
})
