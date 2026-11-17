import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TemplateFile } from './templates-core'

test('QA #3: templates.json roto se aparta como .corrupt-* y no se pisa al guardar', () => {
  const d = mkdtempSync(join(tmpdir(), 'sloth-tpl-'))
  const f = join(d, 'templates.json')
  const roto = '{ "version": 1, "templates": [], }'
  writeFileSync(f, roto)
  const t = new TemplateFile(f)
  assert.deepEqual(t.all(), [])
  const apartados = readdirSync(d).filter((n) => /^templates\.json\.corrupt-\d+$/.test(n))
  assert.equal(apartados.length, 1)
  assert.equal(readFileSync(join(d, apartados[0]), 'utf8'), roto)
  rmSync(d, { recursive: true })
})

const plantilla = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'p1', name: 'Una', accountId: 'sugerida', autoStartClaude: true, resume: false, counter: 3, createdAt: 1, updatedAt: 1, ...extra
})

test('versionado: templates.json sin version se lee, se respalda y se guarda con version 1 conservando campos desconocidos', () => {
  const d = mkdtempSync(join(tmpdir(), 'sloth-tpl-'))
  const f = join(d, 'templates.json')
  const original = JSON.stringify({ templates: [plantilla()], defaultId: 'p1', futuro: { a: 1 } })
  writeFileSync(f, original)
  const t = new TemplateFile(f)
  assert.equal(t.all().length, 1)
  assert.equal(t.defaultId(), 'p1')
  t.save({ name: 'Otra', accountId: 'sugerida' }, new Set())
  const guardado = JSON.parse(readFileSync(f, 'utf8'))
  assert.equal(guardado.version, 1)
  assert.deepEqual(guardado.futuro, { a: 1 })
  assert.equal(guardado.templates.length, 2)
  const bak = readdirSync(d).filter((n) => /^templates\.json\.bak-/.test(n))
  assert.equal(bak.length, 1)
  assert.equal(readFileSync(join(d, bak[0]), 'utf8'), original)
  rmSync(d, { recursive: true })
})

test('versionado: templates.json con version futura se lee pero nunca se reescribe', () => {
  const d = mkdtempSync(join(tmpdir(), 'sloth-tpl-'))
  const f = join(d, 'templates.json')
  const original = JSON.stringify({ version: 2, templates: [plantilla()], nuevo: true })
  writeFileSync(f, original)
  const t = new TemplateFile(f)
  assert.equal(t.all().length, 1)
  t.save({ name: 'Otra', accountId: 'sugerida' }, new Set())
  assert.equal(readFileSync(f, 'utf8'), original)
  assert.deepEqual(readdirSync(d), ['templates.json'])
  rmSync(d, { recursive: true })
})

test('versionado: templates.json con version rara se aparta y arranca vacío', () => {
  const d = mkdtempSync(join(tmpdir(), 'sloth-tpl-'))
  const f = join(d, 'templates.json')
  writeFileSync(f, JSON.stringify({ version: 'dos', templates: [plantilla()] }))
  const t = new TemplateFile(f)
  assert.deepEqual(t.all(), [])
  assert.equal(readdirSync(d).filter((n) => n.includes('.corrupt-')).length, 1)
  rmSync(d, { recursive: true })
})
