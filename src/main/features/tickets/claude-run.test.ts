import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runClaude } from './claude-run.ts'

class Propio extends Error {}

const base = { exe: process.execPath, args: ['-e', 'process.stdout.write("hola")'], prompt: '', cwd: process.cwd(), env: {}, quien: 'Test' }

test('runClaude conserva la clase del error que tira parse', async () => {
  await assert.rejects(
    runClaude({
      ...base,
      parse: () => {
        throw new Propio('falta')
      }
    }),
    (e) => e instanceof Propio && e.message === 'falta'
  )
})

test('runClaude devuelve lo que parsea', async () => {
  assert.equal(await runClaude({ ...base, parse: (s) => s.toUpperCase() }), 'HOLA')
})
