import { test } from 'node:test'
import assert from 'node:assert/strict'
import { conectorPorId } from './conectores'
import { estadoVacio, migrarDeGruv, parsearArchivo, resolverEstado, sanearEstado, type Lectura } from './estado'

const AHORA = 1_700_000_000_000
const FALTA: Lectura = { kind: 'falta' }
const CORRUPTO: Lectura = { kind: 'corrupto' }
const ok = (json: unknown, mtimeMs = 1): Lectura => ({ kind: 'ok', json, mtimeMs })

/** gruv.json v1 como lo deja la 0.6.4. */
const GRUV_V1 = {
  version: 1,
  tickets: [
    { id: 'TCK-1', titulo: 'Uno', estado: 'En Curso', responsable: 'Ana' },
    { id: 'malo', titulo: 'Inválido' },
    { id: 'TCK-2', titulo: 'Dos' }
  ],
  estados: [
    { clave: 'abierto', nombre: 'Abierto' },
    { clave: 'cerrado', nombre: 'Cerrado' }
  ],
  me: { id: 'u-1', nombre: 'Tomy' },
  fetchedAt: 123,
  fetchedBy: 'acc-1',
  lastRun: { tokens: 10, costUsd: 0.01, durationMs: 900 },
  lastError: 'falló algo',
  config: { queryAccountId: 'acc-1', model: 'sonnet', assigneeId: 'u-1', defaultRepo: 'C:/repo', projectRepos: { Web: 'C:/web' }, confirmRefresh: false }
}

const TICKETS_V2 = {
  version: 2,
  tickets: [{ id: 'TCK-9', titulo: 'Nueve', estado: 'abierto' }],
  config: { conectorId: 'gruv', model: 'opus', assigneeId: '', projectRepos: {}, confirmRefresh: true }
}

test('sin archivos: vacío con Gruv y sin guardar', () => {
  const r = resolverEstado({ tickets: FALTA, gruv: FALTA }, conectorPorId, AHORA)
  assert.deepEqual(r, { state: estadoVacio(), origen: 'vacio', respaldar: null, guardar: false })
  assert.equal(r.state.config.conectorId, 'gruv')
})

test('gruv.json v1 se migra con todos sus campos', () => {
  const r = resolverEstado({ tickets: FALTA, gruv: ok(GRUV_V1) }, conectorPorId, AHORA)
  assert.equal(r.origen, 'gruv')
  assert.equal(r.guardar, true)
  assert.equal(r.respaldar, null)
  assert.deepEqual(r.state, {
    version: 2,
    tickets: [
      { id: 'TCK-1', titulo: 'Uno', estado: 'en_curso', responsable: 'Ana' },
      { id: 'TCK-2', titulo: 'Dos' }
    ],
    estados: [{ clave: 'abierto', nombre: 'Abierto' }],
    me: { id: 'u-1', nombre: 'Tomy' },
    fetchedAt: 123,
    fetchedBy: 'acc-1',
    lastRun: { tokens: 10, costUsd: 0.01, durationMs: 900 },
    lastError: 'falló algo',
    migradoDe: { archivo: 'gruv.json', en: AHORA },
    config: {
      conectorId: 'gruv',
      queryAccountId: 'acc-1',
      model: 'sonnet',
      assigneeId: 'u-1',
      defaultRepo: 'C:/repo',
      projectRepos: { Web: 'C:/web' },
      confirmRefresh: false
    }
  })
})

test('tickets.json válido manda y no se guarda', () => {
  const r = resolverEstado({ tickets: ok(TICKETS_V2, 10), gruv: ok(GRUV_V1, 5) }, conectorPorId, AHORA)
  assert.equal(r.origen, 'tickets')
  assert.equal(r.guardar, false)
  assert.deepEqual(r.state.tickets, TICKETS_V2.tickets)
  assert.equal(r.state.config.model, 'opus')
})

test('gruv.json más nuevo que tickets.json: se vuelve a migrar', () => {
  const r = resolverEstado({ tickets: ok(TICKETS_V2, 5), gruv: ok(GRUV_V1, 10) }, conectorPorId, AHORA)
  assert.equal(r.origen, 'gruv')
  assert.equal(r.guardar, true)
  assert.equal(r.respaldar, null)
})

test('tickets.json corrupto: se respalda y se migra gruv.json', () => {
  for (const tickets of [CORRUPTO, ok([1, 2]), ok({ version: 'dos' }), ok(null)]) {
    const r = resolverEstado({ tickets, gruv: ok(GRUV_V1) }, conectorPorId, AHORA)
    assert.equal(r.respaldar, 'corrupto')
    assert.equal(r.origen, 'gruv')
  }
})

test('ambos corruptos: respaldo y vacío', () => {
  const r = resolverEstado({ tickets: CORRUPTO, gruv: CORRUPTO }, conectorPorId, AHORA)
  assert.deepEqual(r, { state: estadoVacio(), origen: 'vacio', respaldar: 'corrupto', guardar: false })
})

test('versión futura: se respalda aparte', () => {
  const r = resolverEstado({ tickets: ok({ ...TICKETS_V2, version: 3 }), gruv: FALTA }, conectorPorId, AHORA)
  assert.equal(r.respaldar, 'version-futura')
  assert.equal(r.origen, 'vacio')
})

test('un conector que no está en esta versión se conserva', () => {
  const raw = { ...TICKETS_V2, tickets: [{ id: 'jira-12', titulo: 'J' }, { id: 'x'.repeat(21), titulo: 'Largo' }, { id: 7 }], config: { ...TICKETS_V2.config, conectorId: 'jira' } }
  const s = sanearEstado(raw, conectorPorId)
  assert.equal(s?.config.conectorId, 'jira')
  assert.deepEqual(s?.tickets, [{ id: 'jira-12', titulo: 'J' }])
})

test('config rara en disco', () => {
  const s = sanearEstado({ version: 2, tickets: 'no', config: { conectorId: 'No Vale', model: 'gpt', projectRepos: [], confirmRefresh: 'no', otra: 1 } }, conectorPorId)
  assert.deepEqual(s, { version: 2, tickets: [], config: { conectorId: 'gruv', model: 'haiku', assigneeId: '', projectRepos: {}, confirmRefresh: true } })
  assert.deepEqual(sanearEstado({ version: 2 }, conectorPorId), estadoVacio())
  assert.equal(sanearEstado({ version: 1 }, conectorPorId), null)
  assert.equal(migrarDeGruv('x', conectorPorId, AHORA), null)
})

test('ids inválidos afuera y estados normalizados', () => {
  const s = sanearEstado({ ...TICKETS_V2, tickets: [{ id: 'tck-3', estado: 'En Revisión' }, { id: 'TCK-12345678' }, null, { id: 'TCK-4', estado: 42 }] }, conectorPorId)
  assert.deepEqual(s?.tickets, [
    { id: 'TCK-3', estado: 'en_revision' },
    { id: 'TCK-4', estado: '42' }
  ])
})

test('parsearArchivo saca el BOM y distingue falta de corrupto', () => {
  assert.deepEqual(parsearArchivo('\uFEFF{"version":2}', 7), { kind: 'ok', json: { version: 2 }, mtimeMs: 7 })
  assert.deepEqual(parsearArchivo(null), { kind: 'falta' })
  assert.deepEqual(parsearArchivo('{roto'), { kind: 'corrupto' })
})

test('sanear dos veces da lo mismo', () => {
  const una = migrarDeGruv(GRUV_V1, conectorPorId, AHORA)
  assert.deepEqual(sanearEstado(una, conectorPorId), una)
  const v2 = sanearEstado(TICKETS_V2, conectorPorId)
  assert.deepEqual(sanearEstado(v2, conectorPorId), v2)
})
