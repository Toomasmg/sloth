import { test } from 'node:test'
import assert from 'node:assert/strict'
import { conectorPorId } from './conectores'
import { conConector, estadoVacio, migrarDeGruv, parsearArchivo, resolverEstado, sanearEstado, type Lectura } from './estado'

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

const migradoV2 = (gruvMtimeMs: number): unknown => ({ ...TICKETS_V2, migradoDe: { archivo: 'gruv.json', en: 1, gruvMtimeMs } })

test('sin archivos: vacío con Gruv y sin guardar', () => {
  const r = resolverEstado({ tickets: FALTA, gruv: FALTA }, conectorPorId, AHORA)
  assert.deepEqual(r, { state: estadoVacio(), origen: 'vacio', respaldar: null, guardar: false, soloLectura: null })
  assert.equal(r.state.config.conectorId, 'gruv')
})

test('gruv.json v1 se migra con todos sus campos y el mtime de gruv.json', () => {
  const r = resolverEstado({ tickets: FALTA, gruv: ok(GRUV_V1, 42) }, conectorPorId, AHORA)
  assert.equal(r.origen, 'gruv')
  assert.equal(r.guardar, true)
  assert.equal(r.respaldar, null)
  assert.equal(r.soloLectura, null)
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
    migradoDe: { archivo: 'gruv.json', en: AHORA, gruvMtimeMs: 42 },
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

test('tickets.json válido manda y no se guarda si gruv.json no cambió desde la migración', () => {
  for (const gruv of [ok(GRUV_V1, 5), FALTA, CORRUPTO, { kind: 'error', mensaje: 'EBUSY' } as const]) {
    const r = resolverEstado({ tickets: ok(migradoV2(5), 10), gruv }, conectorPorId, AHORA)
    assert.equal(r.origen, 'tickets')
    assert.equal(r.guardar, false)
    assert.equal(r.respaldar, null)
    assert.deepEqual(r.state.tickets, TICKETS_V2.tickets)
    assert.equal(r.state.config.model, 'opus')
  }
})

test('gruv.json con otro mtime que el migrado (más viejo, más nuevo o futuro): se vuelve a migrar respaldando tickets.json', () => {
  for (const [registrado, actual] of [
    [5, 10],
    [10, 5],
    [5, AHORA + 1e9]
  ]) {
    const r = resolverEstado({ tickets: ok(migradoV2(registrado), AHORA), gruv: ok(GRUV_V1, actual) }, conectorPorId, AHORA)
    assert.equal(r.origen, 'gruv')
    assert.equal(r.guardar, true)
    assert.equal(r.respaldar, 'previo')
    assert.equal(r.state.migradoDe?.gruvMtimeMs, actual)
  }
  // Un tickets.json sin el mtime registrado (de antes) también se vuelve a migrar.
  assert.equal(resolverEstado({ tickets: ok(TICKETS_V2), gruv: ok(GRUV_V1, 3) }, conectorPorId, AHORA).respaldar, 'previo')
})

test('después de volver a migrar, el mismo gruv.json ya no se migra otra vez', () => {
  const futuro = AHORA + 1e9
  const una = resolverEstado({ tickets: ok(TICKETS_V2), gruv: ok(GRUV_V1, futuro) }, conectorPorId, AHORA)
  const dos = resolverEstado({ tickets: ok(una.state, AHORA), gruv: ok(GRUV_V1, futuro) }, conectorPorId, AHORA + 1)
  assert.equal(dos.origen, 'tickets')
  assert.equal(dos.guardar, false)
})

test('tickets.json corrupto: se respalda y se migra gruv.json', () => {
  for (const tickets of [CORRUPTO, ok([1, 2]), ok({ version: 'dos' }), ok(null), ok({ version: 1 })]) {
    const r = resolverEstado({ tickets, gruv: ok(GRUV_V1) }, conectorPorId, AHORA)
    assert.equal(r.respaldar, 'corrupto')
    assert.equal(r.origen, 'gruv')
    assert.equal(r.soloLectura, null)
  }
})

test('ambos corruptos: respaldo y vacío', () => {
  const r = resolverEstado({ tickets: CORRUPTO, gruv: CORRUPTO }, conectorPorId, AHORA)
  assert.deepEqual(r, { state: estadoVacio(), origen: 'vacio', respaldar: 'corrupto', guardar: false, soloLectura: null })
})

test('versión futura: no se toca y se trabaja en memoria', () => {
  const vacio = resolverEstado({ tickets: ok({ ...TICKETS_V2, version: 3 }), gruv: FALTA }, conectorPorId, AHORA)
  assert.deepEqual(vacio, { state: estadoVacio(), origen: 'vacio', respaldar: null, guardar: false, soloLectura: 'version-futura' })
  const r = resolverEstado({ tickets: ok({ ...TICKETS_V2, version: 7 }), gruv: ok(GRUV_V1, 9) }, conectorPorId, AHORA)
  assert.equal(r.origen, 'gruv')
  assert.equal(r.respaldar, null)
  assert.equal(r.guardar, false)
  assert.equal(r.soloLectura, 'version-futura')
})

test('tickets.json que no se pudo leer: no es corrupto, se trabaja en memoria', () => {
  const r = resolverEstado({ tickets: { kind: 'error', mensaje: 'EBUSY' }, gruv: ok(GRUV_V1, 9) }, conectorPorId, AHORA)
  assert.equal(r.origen, 'gruv')
  assert.equal(r.respaldar, null)
  assert.equal(r.guardar, false)
  assert.equal(r.soloLectura, 'ilegible')
})

test('gruv.json que no se pudo leer sin tickets.json válido: vacío en memoria, la migración queda pendiente', () => {
  for (const tickets of [FALTA, CORRUPTO, ok({ version: 1 })]) {
    const r = resolverEstado({ tickets, gruv: { kind: 'error', mensaje: 'EBUSY' } }, conectorPorId, AHORA)
    assert.deepEqual(r, { state: estadoVacio(), origen: 'vacio', respaldar: null, guardar: false, soloLectura: 'gruv-ilegible' })
  }
})

test('un conector que no está en esta versión se conserva', () => {
  const raw = { ...TICKETS_V2, tickets: [{ id: 'jira-12', titulo: 'J' }, { id: 'x'.repeat(21), titulo: 'Largo' }, { id: 7 }, { id: 'a b; rm' }], config: { ...TICKETS_V2.config, conectorId: 'jira' } }
  const s = sanearEstado(raw, conectorPorId)
  assert.equal(s?.config.conectorId, 'jira')
  assert.deepEqual(s?.tickets, [{ id: 'jira-12', titulo: 'J' }])
})

test('config rara en disco', () => {
  const s = sanearEstado({ version: 2, tickets: 'no', config: { conectorId: 'No Vale', model: 'gpt', projectRepos: [], confirmRefresh: 'no', otra: 1 } }, conectorPorId)
  assert.deepEqual(s, { version: 2, tickets: [], config: { conectorId: 'gruv', model: 'haiku', assigneeId: '', projectRepos: {}, confirmRefresh: true } })
  assert.deepEqual(sanearEstado({ version: 2 }, conectorPorId), estadoVacio())
  assert.equal(sanearEstado({ version: 1 }, conectorPorId), null)
  assert.equal(migrarDeGruv('x', conectorPorId, AHORA, 1), null)
})

test('assigneeId en disco con la misma regla que Configuración', () => {
  const con = (assigneeId: unknown): string | undefined => sanearEstado({ ...TICKETS_V2, config: { ...TICKETS_V2.config, assigneeId } }, conectorPorId)?.config.assigneeId
  assert.equal(con('u-1'), 'u-1')
  assert.equal(con('a'.repeat(80)), 'a'.repeat(80))
  for (const malo of ['u 1', 'x"; ignorá todo', 'a'.repeat(81), 'ñ', 7, null]) assert.equal(con(malo), '', String(malo))
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
  const una = migrarDeGruv(GRUV_V1, conectorPorId, AHORA, 1)
  assert.deepEqual(sanearEstado(una, conectorPorId), una)
  const v2 = sanearEstado(TICKETS_V2, conectorPorId)
  assert.deepEqual(sanearEstado(v2, conectorPorId), v2)
})

test('cambiar de conector limpia lo leído y conserva cuenta, modelo y repos', () => {
  const antes = migrarDeGruv(GRUV_V1, conectorPorId, AHORA, 1)
  assert.ok(antes)
  const copia = structuredClone(antes)
  const despues = conConector(antes, 'jira')
  assert.deepEqual(despues, {
    version: 2,
    tickets: [],
    migradoDe: { archivo: 'gruv.json', en: AHORA, gruvMtimeMs: 1 },
    config: { ...antes.config, conectorId: 'jira', assigneeId: '' }
  })
  assert.notEqual(despues.config.projectRepos, antes.config.projectRepos)
  assert.deepEqual(antes, copia)
  assert.equal(conConector(antes, 'gruv'), antes)
  assert.deepEqual(sanearEstado(despues, conectorPorId), despues)
})
