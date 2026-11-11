import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adoptarLegado, avisoSoloLectura, cargarTeam, estadoTeamVacio, mappingDe } from './team-estado'

const PR = {
  repo: 'org/app',
  number: 7,
  title: 'Algo',
  login: 'ana',
  branch: 'b',
  isDraft: false,
  review: 'pending',
  ci: 'pass',
  checks: { pass: 1, fail: 0, running: 0 },
  url: 'https://github.com/org/app/pull/7'
}

test('sin archivo arranca vacío', () => {
  assert.deepEqual(cargarTeam(null), { kind: 'vacio', state: estadoTeamVacio() })
})

test('v1: conserva github y el mapeo, y deja gruv y config afuera', () => {
  const v1 = {
    version: 1,
    github: { prs: [PR], repos: ['org/app'], errors: {}, fetchedAt: 5 },
    gruv: { tickets: [{ id: 'TCK-1' }], personas: [{ id: '12', nombre: 'Ana' }] },
    mapping: { ana: 'g:12', bot: '-' },
    config: { model: 'haiku', confirmGruv: false }
  }
  const r = cargarTeam(`﻿${JSON.stringify(v1)}`)
  assert.equal(r.kind, 'ok')
  assert.ok(r.kind === 'ok' && r.migrado)
  assert.equal(r.state.version, 2)
  assert.deepEqual(r.state.mapping, { ana: 'g:12', bot: '-' })
  assert.deepEqual(r.state.github, { prs: [PR], repos: ['org/app'], errors: {}, fatal: undefined, fetchedAt: 5 })
  assert.ok(!('gruv' in r.state))
  assert.ok(!('config' in r.state))
})

test('sin version se trata como v1', () => {
  const r = cargarTeam(JSON.stringify({ mapping: { ana: 'n:ana' } }))
  assert.ok(r.kind === 'ok' && r.migrado)
  assert.deepEqual(r.state.mapping, { ana: 'n:ana' })
})

test('v2 carga sin migrar', () => {
  const r = cargarTeam(JSON.stringify({ version: 2, github: { prs: [], repos: [], errors: {} }, mapping: { ana: 'g:12' } }))
  assert.ok(r.kind === 'ok' && !r.migrado)
  assert.deepEqual(r.state.mapping, { ana: 'g:12' })
})

test('JSON roto o que no es objeto: corrupto', () => {
  assert.equal(cargarTeam('{').kind, 'corrupto')
  assert.equal(cargarTeam('[1]').kind, 'corrupto')
  assert.equal(cargarTeam('null').kind, 'corrupto')
})

test('versión más nueva: futuro, con lo que se entiende', () => {
  const r = cargarTeam(JSON.stringify({ version: 3, mapping: { ana: 'g:12' } }))
  assert.equal(r.kind, 'futuro')
  assert.deepEqual(r.state.mapping, { ana: 'g:12' })
})

test('descarta PRs que no son de GitHub y mapeos inválidos', () => {
  const r = cargarTeam(
    JSON.stringify({
      version: 2,
      github: { prs: [PR, { ...PR, url: 'https://evil.example/pull/1' }], repos: ['org/app', 3], errors: [], fatal: 4 },
      mapping: { ana: 'x', beto: 'g:3' }
    })
  )
  assert.deepEqual(r.state.github.prs, [PR])
  assert.deepEqual(r.state.github.repos, ['org/app'])
  assert.deepEqual(r.state.github.errors, {})
  assert.equal(r.state.github.fatal, undefined)
  assert.deepEqual(r.state.mapping, { beto: 'g:3' })
})

test('v1 con tickets o cuenta de Gruv: queda marcado que usaba Gruv, y la marca sobrevive en v2', () => {
  const conTickets = cargarTeam(JSON.stringify({ version: 1, gruv: { tickets: [{ id: 'TCK-1' }] } }))
  assert.ok(conTickets.kind === 'ok' && conTickets.state.veniaDeGruv === true)
  const conCuenta = cargarTeam(JSON.stringify({ config: { queryAccountId: 'acc1' } }))
  assert.ok(conCuenta.kind === 'ok' && conCuenta.state.veniaDeGruv === true)
  const sinNada = cargarTeam(JSON.stringify({ version: 1, gruv: { tickets: [] }, mapping: {} }))
  assert.ok(sinNada.kind === 'ok' && sinNada.state.veniaDeGruv === undefined)
  const v2 = cargarTeam(JSON.stringify({ version: 2, veniaDeGruv: true }))
  assert.ok(v2.kind === 'ok' && v2.state.veniaDeGruv === true)
})

test('avisoSoloLectura explica cada motivo', () => {
  for (const m of ['futuro', 'ilegible', 'sin-respaldo'] as const) assert.match(avisoSoloLectura(m), /no se guarda/i)
  assert.match(avisoSoloLectura('futuro'), /más nueva/)
})

test('mapeo por conector: se carga limpio y no se mezcla entre conectores', () => {
  const r = cargarTeam(
    JSON.stringify({ version: 2, mappings: { gruv: { ana: 'g:1', mala: 'x' }, gh: { ana: '-' }, '': { ana: 'g:2' }, roto: 4 } })
  )
  assert.ok(r.kind === 'ok' && !r.migrado)
  assert.deepEqual(r.state.mappings, { gruv: { ana: 'g:1' }, gh: { ana: '-' } })
  assert.deepEqual(mappingDe(r.state, 'gruv'), { ana: 'g:1' })
  assert.deepEqual(mappingDe(r.state, 'otro'), {})
})

test('adoptarLegado: el mapeo viejo pasa al conector activo sin pisar lo que ya tenía', () => {
  const s = estadoTeamVacio()
  s.mapping = { ana: 'g:1', beto: 'g:2' }
  s.mappings = { gruv: { beto: '-' } }
  assert.equal(adoptarLegado(s, 'gruv'), true)
  assert.deepEqual(s.mappings, { gruv: { ana: 'g:1', beto: '-' } })
  assert.deepEqual(s.mapping, {})
  assert.equal(adoptarLegado(s, 'gruv'), false)
})

test('adoptarLegado: sin conector activo o sin mapeo viejo no toca nada', () => {
  const s = estadoTeamVacio()
  s.mapping = { ana: 'g:1' }
  assert.equal(adoptarLegado(s, null), false)
  assert.deepEqual(s.mapping, { ana: 'g:1' })
  assert.equal(adoptarLegado(estadoTeamVacio(), 'gh'), false)
})
