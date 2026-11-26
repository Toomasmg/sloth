import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PrRow } from '../../../shared/prs'
import { chipPrRojo, contarPendientesPrs, insigniaEquipo, insigniaPrs, resumenParaRiel, type PendientesPrs } from './pendientes'

type Parcial = Pick<PrRow, 'mine' | 'checks' | 'reviewRequestedFromMe' | 'isDraft' | 'review'>
const pr = (o: Partial<Parcial>): Parcial => ({ mine: false, checks: 'ok', reviewRequestedFromMe: false, isDraft: false, review: 'none', ...o })
const SIN: PendientesPrs = { propiosRojos: 0, piden: 0, rojos: 0, sinRevision: 0 }
const NADA = { propiosRojos: 0, piden: 0 }
const con = (o: Partial<PendientesPrs>): PendientesPrs => ({ ...SIN, ...o })
const repos = (...prs: Parcial[]): Parameters<typeof contarPendientesPrs>[0] => [{ prs: prs as PrRow[] }]

test('contarPendientesPrs: tabla', () => {
  const casos: [string, Parcial[], Pick<PendientesPrs, 'propiosRojos' | 'piden'>][] = [
    ['sin PRs', [], NADA],
    ['propio con CI rojo', [pr({ mine: true, checks: 'fail' })], { propiosRojos: 1, piden: 0 }],
    ['propio borrador con CI rojo igual cuenta', [pr({ mine: true, checks: 'fail', isDraft: true })], { propiosRojos: 1, piden: 0 }],
    ['ajeno con CI rojo no cuenta', [pr({ checks: 'fail' })], NADA],
    ['propio con CI pendiente o sin checks no cuenta', [pr({ mine: true, checks: 'pending' }), pr({ mine: true, checks: 'none' })], NADA],
    ['me piden revisión', [pr({ reviewRequestedFromMe: true })], { propiosRojos: 0, piden: 1 }],
    ['me piden revisión de un borrador: no cuenta', [pr({ reviewRequestedFromMe: true, isDraft: true })], NADA],
    ['mezcla', [pr({ mine: true, checks: 'fail' }), pr({ reviewRequestedFromMe: true }), pr({ reviewRequestedFromMe: true }), pr({})], { propiosRojos: 1, piden: 2 }]
  ]
  for (const [nombre, lista, esperado] of casos) {
    const { propiosRojos, piden } = contarPendientesPrs(repos(...lista))
    assert.deepEqual({ propiosRojos, piden }, esperado, nombre)
  }
})

test('contarPendientesPrs suma entre repos', () => {
  const r = [{ prs: [pr({ mine: true, checks: 'fail' })] as PrRow[] }, { prs: [pr({ mine: true, checks: 'fail' })] as PrRow[] }]
  assert.equal(contarPendientesPrs(r).propiosRojos, 2)
})

test('insigniaEquipo: tabla', () => {
  assert.equal(insigniaEquipo(null), null)
  assert.equal(insigniaEquipo({ ciFailing: 0, blocked: 0, waitingReview: 3 }), null)
  assert.deepEqual(insigniaEquipo({ ciFailing: 1, blocked: 0, waitingReview: 0 }), { n: 1, tono: 'danger', label: '1 PR con CI fallando' })
  assert.deepEqual(insigniaEquipo({ ciFailing: 2, blocked: 1, waitingReview: 2 }), {
    n: 3,
    tono: 'danger',
    label: '2 PRs con CI fallando, 1 ticket bloqueado, 2 esperando review'
  })
  assert.equal(insigniaEquipo({ ciFailing: 0, blocked: 2, waitingReview: 0 })?.label, '2 tickets bloqueados')
})

test('insigniaPrs: lo rojo propio manda sobre las revisiones pedidas', () => {
  assert.equal(insigniaPrs(SIN), null)
  assert.deepEqual(insigniaPrs(con({ propiosRojos: 0, piden: 1 })), { n: 1, tono: 'waiting', label: '1 te pide revisión' })
  assert.deepEqual(insigniaPrs(con({ propiosRojos: 0, piden: 3 })), { n: 3, tono: 'waiting', label: '3 te piden revisión' })
  assert.deepEqual(insigniaPrs(con({ propiosRojos: 1, piden: 2 })), { n: 1, tono: 'danger', label: '1 tuyo con CI fallando, 2 te piden revisión' })
})

test('chipPrRojo', () => {
  assert.equal(chipPrRojo(con({ piden: 5 })), null)
  assert.equal(chipPrRojo(con({ propiosRojos: 1, piden: 0 }))?.texto, '1 PR rojo')
  assert.equal(chipPrRojo(con({ propiosRojos: 2, piden: 0 }))?.texto, '2 PRs rojos')
  assert.match(chipPrRojo(con({ propiosRojos: 2, piden: 0 }))?.label ?? '', /2 PRs tuyos con CI fallando/)
})

test('contarPendientesPrs también cuenta lo ajeno para el respaldo de Equipo', () => {
  const c = contarPendientesPrs(repos(pr({ checks: 'fail' }), pr({ review: 'required' }), pr({ review: 'required', isDraft: true }), pr({ mine: true, checks: 'fail' })))
  assert.equal(c.rojos, 2)
  assert.equal(c.sinRevision, 1)
})

test('resumenParaRiel: con lectura de GitHub manda Equipo; sin ella, lo guardado de PRs', () => {
  const guardado = con({ rojos: 2, sinRevision: 3 })
  const equipo = { ciFailing: 1, waitingReview: 4, blocked: 2 }
  assert.deepEqual(resumenParaRiel({ ...equipo, leyoGithub: true }, guardado), equipo)
  assert.deepEqual(resumenParaRiel({ ...equipo, leyoGithub: false }, guardado), { ciFailing: 2, waitingReview: 3, blocked: 2 })
  assert.deepEqual(resumenParaRiel(null, guardado), { ciFailing: 2, waitingReview: 3, blocked: 0 })
})
