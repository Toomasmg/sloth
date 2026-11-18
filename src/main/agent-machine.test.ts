import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentState } from '../shared/types'
import { esEntradaDeUsuario, nextAgentState, salidaDeDoneSinHooks } from './agent-machine'

const VIVOS: AgentState[] = ['idle', 'working', 'waiting', 'done']

test('con la terminal viva, cada hook lleva a su estado', () => {
  for (const prev of [undefined, ...VIVOS])
    for (const hook of VIVOS) assert.equal(nextAgentState(prev, { hook }), hook, `${prev} + ${hook}`)
})

test('un hook tardío no revive un espacio cerrado ni uno dormido', () => {
  for (const hook of VIVOS) {
    assert.equal(nextAgentState('exited', { hook }), null)
    assert.equal(nextAgentState('sleeping', { hook }), null)
  }
})

test('abrir la terminal deja el espacio listo si no había estado, estaba cerrado o dormido', () => {
  assert.equal(nextAgentState(undefined, 'start'), 'idle')
  assert.equal(nextAgentState('exited', 'start'), 'idle')
  assert.equal(nextAgentState('sleeping', 'start'), 'idle')
})

test('reconectarse a una terminal viva no pisa lo que Claude estaba haciendo', () => {
  for (const prev of VIVOS) assert.equal(nextAgentState(prev, 'start'), null)
})

test('la salida de la terminal cierra el espacio, salvo que esté dormido', () => {
  for (const prev of [undefined, ...VIVOS, 'exited' as const]) assert.equal(nextAgentState(prev, 'exit'), 'exited')
  assert.equal(nextAgentState('sleeping', 'exit'), null)
})

test('dormir vale desde cualquier estado y despertar solo desde dormido', () => {
  for (const prev of [undefined, ...VIVOS, 'exited' as const, 'sleeping' as const]) assert.equal(nextAgentState(prev, 'sleep'), 'sleeping')
  assert.equal(nextAgentState('sleeping', 'wake'), 'idle')
  for (const prev of [undefined, ...VIVOS, 'exited' as const]) assert.equal(nextAgentState(prev, 'wake'), null)
})

test('entrada de usuario: teclas y pegado sí; respuestas del emulador, foco y mouse no', () => {
  for (const tecla of ['a', '\r', 'hola\r', '\u001b', '\u001b[200~pegado\u001b[201~', '\u0003']) assert.equal(esEntradaDeUsuario(tecla), true, JSON.stringify(tecla))
  for (const ruido of ['', '\u001b[I', '\u001b[O', '\u001b[?1;2c', '\u001b[12;40R', '\u001b[<0;10;5M', '\u001b]10;rgb:0000/0000/0000\u0007', '\u001b]11;rgb:ffff/ffff/ffff\u001b\\','\u001bOA', '\u001b[A']) {
    assert.equal(esEntradaDeUsuario(ruido), false, JSON.stringify(ruido))
  }
})

test('sin hooks, escribir en la terminal libera el done; con hooks o en otro estado no hace nada', () => {
  assert.equal(salidaDeDoneSinHooks('done', false, '\r'), true)
  assert.equal(salidaDeDoneSinHooks('done', false, '\u001b[I'), false)
  assert.equal(salidaDeDoneSinHooks('done', true, '\r'), false)
  for (const prev of [undefined, 'idle', 'working', 'waiting', 'exited', 'sleeping'] as const) assert.equal(salidaDeDoneSinHooks(prev, false, '\r'), false, String(prev))
})

test('Codex: Stop, escribir, Stop vuelve a pasar por idle y done (el aviso suena en cada turno)', () => {
  let estado: AgentState | undefined = 'idle'
  const visto: AgentState[] = []
  const mover = (input: Parameters<typeof nextAgentState>[1]): void => {
    const n = nextAgentState(estado, input)
    if (n) {
      estado = n
      visto.push(n)
    }
  }
  mover({ hook: 'done' })
  if (salidaDeDoneSinHooks(estado, false, 'otra cosa\r')) mover({ hook: 'idle' })
  mover({ hook: 'done' })
  assert.deepEqual(visto, ['done', 'idle', 'done'])
})
