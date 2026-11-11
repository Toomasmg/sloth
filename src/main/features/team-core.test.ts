import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Ticket } from '../../shared/tickets'
import github from './tickets/conectores/github'
import gruv from './tickets/conectores/gruv'
import { buildPeople, personasDe, ticketsActivos, type TeamPr } from './team-core'

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

test('ticketsActivos usa la clave como nombre si el estado no está en la lista', () => {
  const [a] = ticketsActivos([t('TCK-1', 'raro', 'Ana')], [{ clave: 'en_curso', nombre: 'En curso', categoria: 'en_curso' }])
  assert.equal(a, undefined)
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
