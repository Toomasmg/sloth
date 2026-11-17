import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copiaPty, hashesDe, mismosHashes } from './daemon-bin'

function arbol(): string {
  const raiz = mkdtempSync(join(tmpdir(), 'sloth-bin-'))
  mkdirSync(join(raiz, 'lib'), { recursive: true })
  writeFileSync(join(raiz, 'a.cjs'), 'uno')
  writeFileSync(join(raiz, 'lib', 'b.js'), 'dos')
  return raiz
}

test('hashesDe usa rutas relativas con / y solo archivos', (t) => {
  const raiz = arbol()
  t.after(() => rmSync(raiz, { recursive: true, force: true }))
  mkdirSync(join(raiz, 'vacia'))
  assert.deepEqual([...hashesDe(raiz).keys()].sort(), ['a.cjs', 'lib/b.js'])
})

test('cambiar un byte, sumar o sacar un archivo rompe la igualdad', (t) => {
  const raiz = arbol()
  t.after(() => rmSync(raiz, { recursive: true, force: true }))
  const base = hashesDe(raiz)
  assert.ok(mismosHashes(base, hashesDe(raiz)))
  writeFileSync(join(raiz, 'lib', 'b.js'), 'doz')
  assert.ok(!mismosHashes(base, hashesDe(raiz)))
  writeFileSync(join(raiz, 'lib', 'b.js'), 'dos')
  writeFileSync(join(raiz, 'extra.node'), 'x')
  assert.ok(!mismosHashes(base, hashesDe(raiz)))
  rmSync(join(raiz, 'extra.node'))
  rmSync(join(raiz, 'a.cjs'))
  assert.ok(!mismosHashes(base, hashesDe(raiz)))
})

test('hashesDe respeta el filtro, también para carpetas', (t) => {
  const raiz = arbol()
  t.after(() => rmSync(raiz, { recursive: true, force: true }))
  writeFileSync(join(raiz, '.ok'), 'v')
  const sinOk = hashesDe(raiz, (rel) => !(rel.length === 1 && rel[0] === '.ok'))
  assert.ok(mismosHashes(sinOk, new Map([...hashesDe(raiz)].filter(([k]) => k !== '.ok'))))
  assert.deepEqual([...hashesDe(raiz, (rel) => rel[0] !== 'lib').keys()].sort(), ['.ok', 'a.cjs'])
})

test('copiaPty deja afuera src/, .pdb, tests y prebuilds de otra arquitectura', () => {
  const keep = 'win32-x64'
  assert.ok(copiaPty([], '', keep))
  assert.ok(!copiaPty(['src'], 'src', keep))
  assert.ok(copiaPty(['lib', 'src'], 'src', keep))
  assert.ok(!copiaPty(['build', 'Release', 'pty.pdb'], 'pty.pdb', keep))
  assert.ok(!copiaPty(['lib', 'x.test.js'], 'x.test.js', keep))
  assert.ok(!copiaPty(['prebuilds', 'win32-arm64'], 'win32-arm64', keep))
  assert.ok(copiaPty(['prebuilds', keep, 'pty.node'], 'pty.node', keep))
  assert.ok(copiaPty(['build', 'Release', 'pty.node'], 'pty.node', keep))
})
