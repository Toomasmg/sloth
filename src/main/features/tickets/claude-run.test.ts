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

class Tope extends Error {}

test('runClaude con cortarSi mata el hijo y rechaza con el error que devuelve', async () => {
  const inicio = Date.now()
  let pid = 0
  await assert.rejects(
    runClaude({
      ...base,
      args: ['-e', "console.log(JSON.stringify({pid:process.pid}));console.log('corta');setTimeout(()=>{},20000)"],
      timeoutMs: 10_000,
      parse: () => 0,
      cortarSi: (l) => {
        if (l.includes('"pid"')) pid = Number(JSON.parse(l).pid)
        return l === 'corta' ? new Tope('tope') : undefined
      }
    }),
    (e) => e instanceof Tope && e.message === 'tope'
  )
  assert.ok(Date.now() - inicio < 5000)
  assert.ok(pid > 0)
  for (let i = 0; i < 50 && vive(pid); i++) await new Promise((r) => setTimeout(r, 100))
  assert.equal(vive(pid), false)
})

test('runClaude con cortarSi que no corta se comporta igual que sin él', async () => {
  const r = await runClaude({ ...base, args: ['-e', 'console.log("uno");console.log("dos")'], parse: (s) => s.trim().split(/\r?\n/).length, cortarSi: () => undefined })
  assert.equal(r, 2)
})

test('runClaude nombra al agente en «No pude abrir»', async () => {
  const sinExe = { ...base, exe: 'no-existe-este-programa-sloth', parse: () => 0 }
  await assert.rejects(runClaude(sinExe), /^Error: No pude abrir Claude:/)
  await assert.rejects(runClaude({ ...sinExe, agente: 'Codex' }), /^Error: No pude abrir Codex:/)
})
