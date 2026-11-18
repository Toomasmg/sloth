import { test } from 'node:test'
import assert from 'node:assert/strict'
import { entornoDeTerminal } from './hook-env-core'
import { CAPACIDADES } from '../shared/proveedores'

const base = { PATH: 'p', CODEX_HOME: 'C:/x' }
const hook = (): { url: string; token: string } => ({ url: 'http://127.0.0.1:1/hook', token: 'tok' })

test('Claude: el entorno de siempre, con URL y token', () => {
  assert.deepEqual(entornoDeTerminal(base, CAPACIDADES.claude, false, 'w1', hook), { ...base, SLOTH_WS: 'w1', SLOTH_HOOK_URL: 'http://127.0.0.1:1/hook', SLOTH_TOKEN: 'tok' })
})

test('Codex sin activar el aviso no recibe el token ni la URL', () => {
  const env = entornoDeTerminal(base, CAPACIDADES.codex, false, 'w1', () => assert.fail('no tenía que pedir el token'))
  assert.deepEqual(env, { ...base, SLOTH_WS: 'w1' })
  assert.equal('SLOTH_TOKEN' in env, false)
})

test('Codex con el aviso activado recibe URL y token por entorno', () => {
  const env = entornoDeTerminal(base, CAPACIDADES.codex, true, 'w1', hook)
  assert.equal(env.SLOTH_TOKEN, 'tok')
  assert.equal(env.SLOTH_HOOK_URL, 'http://127.0.0.1:1/hook')
})

test('un agente sin hooks ni avisoTurno nunca recibe el token, ni con el aviso activado', () => {
  const sin = { hooks: false, avisoTurno: false }
  for (const activo of [true, false]) {
    const env = entornoDeTerminal(base, sin, activo, 'w1', () => assert.fail('no tenía que pedir el token'))
    assert.equal('SLOTH_TOKEN' in env, false)
    assert.equal('SLOTH_HOOK_URL' in env, false)
  }
})
