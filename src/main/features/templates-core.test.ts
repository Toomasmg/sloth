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
