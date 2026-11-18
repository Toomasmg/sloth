import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkEnvironment, repoCandidates } from './onboarding-env'

test('los repos que ya usás van primero, sin duplicados y como mucho 8', () => {
  const home = mkdtempSync(join(tmpdir(), 'sloth-repos-'))
  try {
    const dev = join(home, 'dev')
    for (const n of ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) mkdirSync(join(dev, n, '.git'), { recursive: true })
    mkdirSync(join(dev, 'sin-git'))
    const mio = join(home, 'otro', 'mio')
    mkdirSync(join(mio, '.git'), { recursive: true })
    const lista = repoCandidates(home, [mio, mio.toUpperCase(), join(dev, 'b')])
    assert.equal(lista.length, 8)
    assert.deepEqual(lista.slice(0, 2), [mio, join(dev, 'b')])
    assert.equal(new Set(lista.map((p) => p.toLowerCase())).size, 8)
    assert.ok(!lista.some((p) => p.endsWith('sin-git')))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('una carpeta que no se puede leer se saltea', () => {
  const hijos = (): string[] => {
    throw new Error('EACCES')
  }
  assert.deepEqual(repoCandidates('C:\\no\\existe', [], () => true, hijos), [])
})

test('busca repos en las rutas comunes de Windows con barras bien escapadas', () => {
  const vistos: string[] = []
  repoCandidates(String.raw`C:\Users\x`, [], () => false, (p) => (vistos.push(p), []))
  for (const p of [String.raw`C:\dev\work`, String.raw`C:\dev`, String.raw`D:\dev\work`]) assert.ok(vistos.includes(p), p)
})

test('sin Node ni git el chequeo los marca faltantes pero opcionales; Claude Code sigue siendo requisito', async () => {
  const r = await checkEnvironment({ pathEnv: '', home: 'Z:/h', appData: 'Z:/a', isFile: () => false, run: async () => ({ ok: false, code: null, stdout: '', stderr: '', error: 'no' }) })
  const por = Object.fromEntries(r.items.map((i) => [i.id, i]))
  for (const id of ['node', 'git'] as const) {
    assert.equal(por[id].optional, true, id)
    assert.equal(por[id].state, 'missing', id)
    assert.ok(por[id].fix && por[id].command, id)
  }
  assert.match(por.node.fix ?? '', /terminales andan igual/)
  assert.match(por.git.fix ?? '', /terminales y los espacios andan igual/)
  assert.equal(por.claude.state, 'missing')
  assert.notEqual(por.claude.optional, true)
})
