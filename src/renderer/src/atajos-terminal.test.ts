import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capaAjena, seAtiende, type TeclaEvento } from './atajos-terminal'

const tecla = (key: string | null, mods: Partial<TeclaEvento> = {}): TeclaEvento => ({
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  altGraph: false,
  isComposing: false,
  key,
  ...mods
})

const enTerminal: [string, TeclaEvento, boolean][] = [
  ['Ctrl+Shift+M', tecla('M', { ctrlKey: true, shiftKey: true }), true],
  ['Ctrl+Shift+Enter', tecla('Enter', { ctrlKey: true, shiftKey: true }), true],
  ['Ctrl+Alt+1', tecla('1', { ctrlKey: true, altKey: true }), true],
  ['Ctrl+2', tecla('2', { ctrlKey: true }), true],
  ['Ctrl+,', tecla(',', { ctrlKey: true }), true],
  ['Ctrl+N es de la shell', tecla('N', { ctrlKey: true }), false],
  ['Ctrl+B es de la shell', tecla('B', { ctrlKey: true }), false],
  ['Ctrl+C reasignado no se toma', tecla('C', { ctrlKey: true }), false],
  ['Ctrl+R reasignado no se toma', tecla('R', { ctrlKey: true }), false],
  ['Ctrl+Enter es de la shell', tecla('Enter', { ctrlKey: true }), false],
  ['F1 es del programa', tecla('F1'), false],
  ['F2 es del programa', tecla('F2'), false],
  ['Alt+B (palabra atrás) es de la shell', tecla('B', { altKey: true }), false],
  ['AltGr+2 (@) no se toma', tecla('2', { ctrlKey: true, altKey: true, altGraph: true }), false],
  ['componiendo no se toma', tecla('M', { ctrlKey: true, shiftKey: true, isComposing: true }), false]
]

for (const [nombre, e, esperado] of enTerminal) {
  test(`terminal enfocada: ${nombre}`, () => assert.equal(seAtiende(e, true), esperado))
}

test('fuera de la terminal se atiende todo, salvo AltGr y composición', () => {
  assert.equal(seAtiende(tecla('N', { ctrlKey: true }), false), true)
  assert.equal(seAtiende(tecla('F2'), false), true)
  assert.equal(seAtiende(tecla('2', { ctrlKey: true, altKey: true, altGraph: true }), false), false)
  assert.equal(seAtiende(tecla('N', { ctrlKey: true, isComposing: true }), false), false)
})

test('capaAjena: solo si el foco está en una capa que no es la propia', () => {
  const a = {}
  assert.equal(capaAjena(null, a), false)
  assert.equal(capaAjena(a, a), false)
  assert.equal(capaAjena({}, a), true)
})
