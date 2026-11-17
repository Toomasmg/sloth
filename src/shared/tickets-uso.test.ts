import test from 'node:test'
import assert from 'node:assert/strict'
import { fmtCosto, resumenUso, textoUltimaConsulta } from './tickets-uso'
import type { UsoPorDia } from './tickets'

const a = (corridas: number, costUsd: number) => ({ corridas, costUsd, vueltas: corridas * 3, durationMs: corridas * 1000 })

test('resumenUso suma hoy y los últimos 7 días contando hoy', () => {
  const uso: UsoPorDia = {
    '2026-03-02': { x: a(1, 0.5), y: a(2, 0.25) },
    '2026-02-24': { x: a(1, 1) },
    '2026-02-23': { x: a(9, 9) },
    '2026-03-03': { x: a(4, 4) }
  }
  const r = resumenUso(uso, '2026-03-02')
  assert.equal(r.hoy.corridas, 3)
  assert.equal(r.hoy.costUsd, 0.75)
  assert.equal(r.semana.corridas, 4)
  assert.equal(r.semana.costUsd, 1.75)
})

test('resumenUso filtra por conector y tolera datos vacíos o un día inválido', () => {
  const uso: UsoPorDia = { '2026-03-02': { x: a(1, 0.5), y: a(2, 0.25) } }
  assert.equal(resumenUso(uso, '2026-03-02', 'y').hoy.corridas, 2)
  assert.equal(resumenUso(undefined, '2026-03-02').semana.corridas, 0)
  assert.equal(resumenUso(uso, 'mal').semana.corridas, 0)
})

test('fmtCosto usa 3 decimales bajo 1 y 2 desde 1', () => {
  assert.equal(fmtCosto(0.0123), '~US$ 0,012')
  assert.equal(fmtCosto(1.234), '~US$ 1,23')
})

test('textoUltimaConsulta omite lo que falta', () => {
  assert.equal(textoUltimaConsulta({}), '')
  assert.equal(
    textoUltimaConsulta({ tokens: 1500, costUsd: 0.5, numTurns: 1, durationMs: 12000 }),
    `Última consulta: ~${(1500).toLocaleString('es-AR')} tokens · costo estimado ~US$ 0,500 · 1 vuelta · 12 s`
  )
  assert.equal(textoUltimaConsulta({ numTurns: 5 }), 'Última consulta: 5 vueltas')
})
