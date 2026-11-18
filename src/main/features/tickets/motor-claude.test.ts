import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CAPACIDADES } from '../../../shared/proveedores'
import { validarConector, type ConectorMcp } from './conector'
import gruv from './conectores/gruv'
import { buildDescubrirArgs } from './descubrir'
import { buildAccionArgs, buildDetalleArgs, buildListaArgs } from './motor'
import { motorClaude } from './motor-claude'
import { motorDe } from './motores'

const GRUV = validarConector(gruv) as ConectorMcp
const ajenos = ['mcp__otro__algo', 'mcp__otro__mas']
const LIMITES = [undefined, { maxTurns: 7 }, { maxTurns: 5, maxCostUsd: 0.5 }]

test('lista: igual que buildListaArgs más --verbose', () => {
  for (const limites of LIMITES) {
    assert.deepEqual(
      motorClaude.argv({ tarea: 'lista', def: GRUV, model: 'haiku', ajenos, limites }),
      [...buildListaArgs(GRUV, 'haiku', ajenos, limites), '--verbose']
    )
  }
})

test('detalle y accion: igual que sus build, sin --verbose agregado', () => {
  for (const limites of LIMITES) {
    assert.deepEqual(motorClaude.argv({ tarea: 'detalle', def: GRUV, model: 'sonnet', ajenos, limites }), buildDetalleArgs(GRUV, 'sonnet', ajenos, limites))
    assert.deepEqual(
      motorClaude.argv({ tarea: 'accion', def: GRUV, model: 'sonnet', ajenos, limites, accion: 'comentar' }),
      buildAccionArgs(GRUV, 'sonnet', 'comentar', ajenos, limites)
    )
  }
})

test('descubrir y revisar: igual que buildDescubrirArgs', () => {
  assert.deepEqual(motorClaude.argv({ tarea: 'descubrir', model: 'haiku', ajenos: [] }), buildDescubrirArgs())
  const schema = { type: 'object' }
  assert.deepEqual(motorClaude.argv({ tarea: 'revisar', model: 'haiku', ajenos: [], schema }), buildDescubrirArgs(schema, 'stream-json'))
})

test('un pedido incompleto falla en vez de armar argumentos a medias', () => {
  assert.throws(() => motorClaude.argv({ tarea: 'lista', model: 'haiku', ajenos: [] }), /incompleto/)
  assert.throws(() => motorClaude.argv({ tarea: 'detalle', model: 'haiku', ajenos: [] }), /incompleto/)
  assert.throws(() => motorClaude.argv({ tarea: 'accion', def: GRUV, model: 'haiku', ajenos: [] }), /incompleto/)
})

test('normalizar es identidad y el motor no suma entorno', () => {
  const p = { tarea: 'lista' as const, model: 'haiku', ajenos: [] }
  for (const s of ['', '{"type":"result"}', 'a\nb\r\nc\n']) assert.equal(motorClaude.normalizar(s, p), s)
  assert.deepEqual(motorClaude.envExtra(p), {})
  assert.equal(motorClaude.leeInit, true)
  assert.equal(motorClaude.experimental, false)
  assert.equal(motorClaude.cortarSi, undefined)
})

test('motorDe: cuentas viejas y de claude usan el motor de claude', () => {
  assert.equal(motorDe({}), motorClaude)
  assert.equal(motorDe({ proveedor: 'claude' }), motorClaude)
  assert.notEqual(motorDe({ proveedor: 'codex' }), motorClaude)
  assert.equal(motorDe({ proveedor: 'futuro' }), undefined)
})

test('capacidad ticketsHeadless', () => {
  assert.equal(CAPACIDADES.claude.ticketsHeadless, true)
  assert.equal(CAPACIDADES.codex.ticketsHeadless, true)
})
