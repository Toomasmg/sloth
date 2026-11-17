import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { respaldarAntesDeReemplazar, respaldarUnaVez } from './respaldo'

function conCarpeta(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sloth-respaldo-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('copia el archivo la primera vez', () =>
  conCarpeta((dir) => {
    const f = join(dir, 'settings.json')
    writeFileSync(f, 'uno')
    assert.equal(respaldarUnaVez(f), true)
    assert.equal(readFileSync(`${f}.sloth-bak`, 'utf8'), 'uno')
  }))

test('la segunda vez no pisa el respaldo', () =>
  conCarpeta((dir) => {
    const f = join(dir, 'settings.json')
    writeFileSync(f, 'uno')
    respaldarUnaVez(f)
    writeFileSync(f, 'dos')
    assert.equal(respaldarUnaVez(f), false)
    assert.equal(readFileSync(`${f}.sloth-bak`, 'utf8'), 'uno')
  }))

test('sin archivo no hace nada', () =>
  conCarpeta((dir) => {
    const f = join(dir, 'settings.json')
    assert.equal(respaldarUnaVez(f), false)
    assert.equal(existsSync(`${f}.sloth-bak`), false)
  }))

test('antes de reemplazar respalda lo que cambió y no lo que ya es igual', () =>
  conCarpeta((dir) => {
    const f = join(dir, 'settings.json')
    assert.equal(respaldarAntesDeReemplazar(f, 'base'), false)
    writeFileSync(f, 'base')
    assert.equal(respaldarAntesDeReemplazar(f, 'base'), false)
    assert.equal(existsSync(`${f}.sloth-prev`), false)
    writeFileSync(f, 'editado a mano')
    assert.equal(respaldarAntesDeReemplazar(f, 'base'), true)
    assert.equal(readFileSync(`${f}.sloth-prev`, 'utf8'), 'editado a mano')
  }))
