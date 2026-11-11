import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTeamExport, parseTeamConfig, TEAM_FORMAT, TEAM_VERSION } from './team-config-core'

const base = { formato: TEAM_FORMAT, versión: TEAM_VERSION, equipo: 'Núcleo' }
const texto = (extra: Record<string, unknown>): string => JSON.stringify({ ...base, ...extra })

test('conectores: se aceptan tal cual y no tocan las plantillas', () => {
  const conectores = [{ id: 'mio', cualquier: 'cosa' }]
  const cfg = parseTeamConfig(texto({ conectores }))
  assert.deepEqual(cfg.conectores, conectores)
  assert.equal(parseTeamConfig(texto({})).conectores, undefined)
})

test('conectores: más de 10 o algo que no es lista se rechaza', () => {
  assert.throws(() => parseTeamConfig(texto({ conectores: Array.from({ length: 11 }, () => ({})) })), /conectores: como mucho 10/)
  assert.throws(() => parseTeamConfig(texto({ conectores: { id: 'x' } })), /conectores: tiene que ser una lista/)
  assert.throws(() => parseTeamConfig('{"formato":"sloth-team","versión":1,"equipo":"x","conectores":[{"__proto__":{}}]}'), /__proto__/)
})

test('buildTeamExport conserva los conectores que le pasan', () => {
  const conectores = [{ id: 'mio' }]
  const out = buildTeamExport('Z:/repo', [], { equipo: 'Núcleo', conectores })
  assert.deepEqual(out.config.conectores, conectores)
  assert.deepEqual(JSON.parse(out.text).conectores, conectores)
  assert.equal(buildTeamExport('Z:/repo', [], { equipo: 'Núcleo' }).config.conectores, undefined)
})
