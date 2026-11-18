import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Ticket } from '../../shared/tickets'
import github from './tickets/conectores/github'
import gruv from './tickets/conectores/gruv'
import { buildPeople, personasDe, personasElegidasEquipo, ticketsActivos, type TeamPr } from './team-core'

const t = (id: string, estado: string | undefined, responsable?: string, responsableId?: string): Ticket => ({
  id,
  titulo: `Ticket ${id}`,
  estado,
  responsable,
  responsableId
})

test('ticketsActivos con los estados de Gruv: en curso, revisión y bloqueado entran', () => {
  const tickets = ['abierto', 'en_curso', 'en_revision', 'pre_rtd', 'en_qa', 'bloqueado', 'cerrado'].map((e, i) => t(`TCK-${i + 1}`, e, 'Ana'))
  const activos = ticketsActivos(tickets, gruv.estados)
  assert.deepEqual(
    activos.map((x) => [x.estado, x.categoria, x.estadoNombre]),
    [
      ['en_curso', 'en_curso', 'En curso'],
      ['en_revision', 'revision', 'En revisión'],
      ['pre_rtd', 'revision', 'Pre RTD'],
      ['en_qa', 'revision', 'En QA'],
      ['bloqueado', 'bloqueado', 'Bloqueado']
    ]
  )
})

test('ticketsActivos sin estados activos (gh): entra lo abierto con responsable, como en curso', () => {
  const activos = ticketsActivos([t('12', 'abierto', 'ana'), t('13', 'abierto'), t('14', 'cerrado', 'ana')], github.estados)
  assert.deepEqual(
    activos.map((x) => [x.id, x.categoria, x.estadoNombre]),
    [['12', 'en_curso', 'Abierto']]
  )
})

test('ticketsActivos usa la clave como nombre si no hay lista de estados', () => {
  const [b] = ticketsActivos([t('TCK-2', 'abierto', 'Ana')], [])
  assert.equal(b?.estadoNombre, 'abierto')
})

test('personasDe no repite personas por id ni por nombre', () => {
  const activos = ticketsActivos(
    [t('TCK-1', 'en_curso', 'Ana Pérez', '12'), t('TCK-2', 'en_qa', 'Ana Pérez', '12'), t('TCK-3', 'bloqueado', 'Beto'), t('TCK-4', 'en_curso', 'beto ')],
    gruv.estados
  )
  assert.deepEqual(personasDe(activos), [{ id: '12', nombre: 'Ana Pérez' }, { nombre: 'Beto' }])
})

test('un mapeo g:12 guardado se aplica a la persona con responsableId 12', () => {
  const pr: TeamPr = {
    repo: 'org/app',
    number: 1,
    title: 'Algo',
    login: 'zz-otro',
    branch: 'b',
    isDraft: false,
    review: 'pending',
    ci: 'pass',
    checks: { pass: 1, fail: 0, running: 0 },
    url: 'https://github.com/org/app/pull/1'
  }
  const tickets = ticketsActivos([t('TCK-1', 'en_curso', 'Ana Pérez', '12')], gruv.estados)
  const { people } = buildPeople({ prs: [pr], tickets, personas: personasDe(tickets), mapping: { 'zz-otro': 'g:12' } })
  const ana = people.find((p) => p.key === 'g:12')
  assert.ok(ana)
  assert.equal(ana.matchedBy, 'manual')
  assert.equal(ana.idConector, '12')
  assert.deepEqual(ana.logins, ['zz-otro'])
})

test('con GitHub como conector, el PR del mismo login cae en la tarjeta del ticket', () => {
  const pr: TeamPr = {
    repo: 'org/app',
    number: 5,
    title: 'Algo',
    login: 'TomyMG',
    authorName: 'Tomas Munoz',
    branch: 'b',
    isDraft: false,
    review: 'pending',
    ci: 'pass',
    checks: { pass: 1, fail: 0, running: 0 },
    url: 'https://github.com/org/app/pull/5'
  }
  const tickets = ticketsActivos([t('12', 'abierto', 'tomymg', 'tomymg')], github.estados)
  const { people } = buildPeople({ prs: [pr], tickets, personas: personasDe(tickets), mapping: {} })
  assert.equal(people.length, 1)
  assert.equal(people[0].tickets.length, 1)
  assert.equal(people[0].prs.length, 1)
  assert.equal(people[0].matchedBy, 'auto')
})

test('ticketsActivos descarta un estado que no está en la lista', () => {
  const activos = ticketsActivos([t('TCK-1', 'raro', 'Ana')], [{ clave: 'en_curso', nombre: 'En curso', categoria: 'en_curso' }])
  assert.deepEqual(activos, [])
})

test('personasElegidasEquipo da tarjeta a las elegidas que están en la lista, con el nombre acotado', () => {
  const lista = [{ id: 'u1', nombre: 'Mateo' }, { id: 'u2', nombre: 'L'.repeat(200) }]
  assert.deepEqual(personasElegidasEquipo(['u2', 'u9', 'u1'], lista), [{ id: 'u2', nombre: 'L'.repeat(80) }, { id: 'u1', nombre: 'Mateo' }])
  assert.deepEqual(personasElegidasEquipo(['u1'], undefined), [])
})

test('una elegida sin tickets tiene tarjeta y se une con la que ya tiene tickets', () => {
  const activos = ticketsActivos([t('TCK-1', 'en_curso', 'Ana', 'u1')], gruv.estados)
  const view = buildPeople({ prs: [], tickets: activos, personas: [...personasDe(activos), ...personasElegidasEquipo(['u1', 'u2'], [{ id: 'u1', nombre: 'Ana' }, { id: 'u2', nombre: 'Mateo' }])], mapping: {} })
  assert.deepEqual(view.people.map((p) => [p.nombre, p.tickets.length]), [['Ana', 1], ['Mateo', 0]])
})
