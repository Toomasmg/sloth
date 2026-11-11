import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { repoCandidates } from './onboarding-env'

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
  assert.deepEqual(repoCandidates('C:\no\existe', [], () => true, hijos), [])
})
