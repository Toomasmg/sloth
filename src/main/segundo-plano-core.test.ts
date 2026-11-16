import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { HookEventPayload } from '../shared/daemon-protocol'
import { esFalsoFinal, pendientes, registrar, VENCE_MS, venceEn, type Fondo } from './segundo-plano-core'

const WS = 'ws1'
const ev = (event: HookEventPayload['event'], extra: Partial<HookEventPayload> = {}): HookEventPayload => ({ ws: WS, event, ...extra })

function correr(eventos: HookEventPayload[], ahora = 0): Map<string, Fondo> {
  const m = new Map<string, Fondo>()
  for (const e of eventos) registrar(m, e, ahora)
  return m
}

test('un shell de fondo sigue pendiente cuando Claude termina el turno', () => {
  const m = correr([ev('UserPromptSubmit'), ev('PreToolUse', { tool: 'Bash', enSegundoPlano: true }), ev('Stop')])
  assert.equal(pendientes(m, WS, 0), 1)
  assert.equal(esFalsoFinal(ev('Stop'), 1), true)
  assert.equal(esFalsoFinal(ev('Notification', { notificationType: 'idle_prompt' }), 1), true)
})

test('el turno que despierta el shell al terminar lo descuenta', () => {
  const m = correr([ev('PreToolUse', { enSegundoPlano: true }), ev('Stop'), ev('PreToolUse', { tool: 'Read' })])
  assert.equal(pendientes(m, WS, 0), 0)
})

test('un turno sin herramientas (Stop tras Stop) también descuenta', () => {
  const m = correr([ev('PreToolUse', { enSegundoPlano: true }), ev('Stop'), ev('Stop')])
  assert.equal(pendientes(m, WS, 0), 0)
})

test('si el aviso llega como UserPromptSubmit de tarea, descuenta; si escribió el usuario, no', () => {
  const lanzar = [ev('PreToolUse', { enSegundoPlano: true }), ev('Stop')]
  assert.equal(pendientes(correr([...lanzar, ev('UserPromptSubmit', { avisoDeTarea: true })]), WS, 0), 0)
  assert.equal(pendientes(correr([...lanzar, ev('UserPromptSubmit'), ev('PreToolUse')]), WS, 0), 1)
})

test('dos shells: el primer aviso deja uno pendiente', () => {
  const m = correr([ev('PreToolUse', { enSegundoPlano: true }), ev('PreToolUse', { enSegundoPlano: true }), ev('Stop'), ev('Stop')])
  assert.equal(pendientes(m, WS, 0), 1)
})

test('sin shells de fondo, Stop y el aviso de inactividad son finales de verdad', () => {
  const m = correr([ev('UserPromptSubmit'), ev('PreToolUse', { tool: 'Bash' }), ev('Stop')])
  assert.equal(pendientes(m, WS, 0), 0)
  assert.equal(esFalsoFinal(ev('Stop'), 0), false)
})

test('un pedido que no es de inactividad sigue avisando aunque haya shells', () => {
  assert.equal(esFalsoFinal(ev('Notification', { notificationType: 'elicitation_dialog' }), 2), false)
  assert.equal(esFalsoFinal(ev('PreToolUse'), 2), false)
})

test('un shell que nunca avisa vence a los 30 minutos', () => {
  const m = correr([ev('PreToolUse', { enSegundoPlano: true }), ev('Stop')])
  assert.equal(venceEn(m, WS, 0), VENCE_MS)
  assert.equal(pendientes(m, WS, VENCE_MS), 0)
})

test('cerrar o reabrir Claude borra la cuenta', () => {
  const m = correr([ev('PreToolUse', { enSegundoPlano: true }), ev('SessionEnd')])
  assert.equal(pendientes(m, WS, 0), 0)
  assert.equal(m.size, 0)
})
