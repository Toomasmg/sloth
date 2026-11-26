import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SHORTCUT_IDS } from '../../shared/settings-model'
import { ALCANCE_EN_TERMINAL, debeDevolverFoco, esGlobalEnTerminal, seAtiende } from './atajos-terminal'

test('todos los atajos configurables tienen alcance', () => {
  for (const id of SHORTCUT_IDS) assert.ok(ALCANCE_EN_TERMINAL[id], id)
})

const tabla: [Parameters<typeof esGlobalEnTerminal>[0], boolean][] = [
  ['new', true],
  ['chat', true],
  ['layout', true],
  ['broadcastNow', true],
  ['palette', true],
  ['focus1', true],
  ['sidebar', false],
  ['help', false],
  ['rename', false]
]

for (const [id, global] of tabla) {
  test(`${id}: ${global ? 'global' : 'de la shell'} con la terminal enfocada`, () => {
    assert.equal(esGlobalEnTerminal(id), global)
    assert.equal(seAtiende(id, { enTerminal: true }), global)
    assert.equal(seAtiende(id, { enTerminal: false }), true)
  })
}

test('Ctrl+B y las teclas F siguen siendo de la shell', () => {
  assert.deepEqual(
    (['sidebar', 'help', 'rename'] as const).filter((id) => !esGlobalEnTerminal(id)),
    ['sidebar', 'help', 'rename']
  )
})

test('el foco no vuelve a quien abrió si ya está en otra capa', () => {
  assert.equal(debeDevolverFoco({ enOtraCapa: true }), false)
  assert.equal(debeDevolverFoco({ enOtraCapa: false }), true)
})
