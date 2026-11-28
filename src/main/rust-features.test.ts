import { test } from 'node:test'
import assert from 'node:assert/strict'
import { funcionesEnRust } from './rust-features'

test('sin lista (Electron) ninguna función es de Rust', () => {
  assert.equal(funcionesEnRust(undefined).size, 0)
  assert.equal(funcionesEnRust('').size, 0)
})

test('la lista se separa por comas, sin espacios ni vacíos', () => {
  assert.deepEqual([...funcionesEnRust('git, help,,')], ['git', 'help'])
})
