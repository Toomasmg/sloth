import { test } from 'node:test'
import assert from 'node:assert/strict'
import { envolverStatusline } from './statusline-core'

const SCRIPT = 'C:\\Users\\yo\\AppData\\Roaming\\Sloth\\sloth-statusline.cjs'
const HELPER = 'C:/Users/yo/AppData/Roaming/Sloth/bin/sloth-hook.exe'

test('con el ejecutable en Rust no hace falta node: sin statusline solo captura', () => {
  assert.deepEqual(envolverStatusline(undefined, SCRIPT, HELPER), { type: 'command', command: `${HELPER} statusline` })
})

test('con el ejecutable envuelve la del usuario: ruta, statusline y el original en base64url', () => {
  const r = envolverStatusline({ type: 'command', command: 'bash ~/.claude/statusline-command.sh', padding: 0 }, SCRIPT, HELPER) as { command: string; padding: number }
  assert.equal(r.padding, 0)
  const [exe, sub, b64, ...resto] = r.command.split(' ')
  assert.equal(exe, HELPER)
  assert.equal(sub, 'statusline')
  assert.equal(Buffer.from(b64, 'base64url').toString('utf8'), 'bash ~/.claude/statusline-command.sh')
  assert.deepEqual(resto, [])
})

test('no envuelve dos veces con el ejecutable', () => {
  const una = envolverStatusline({ type: 'command', command: 'mi-linea' }, SCRIPT, HELPER)
  assert.deepEqual(envolverStatusline(una, SCRIPT, HELPER), una)
})

test('una statusline que envolvió la versión con node se pasa al ejecutable sin perder la original', () => {
  const conNode = envolverStatusline({ type: 'command', command: 'mi-linea', padding: 2 }, SCRIPT) as { command: string }
  assert.ok(conNode.command.startsWith('node '))
  const migrada = envolverStatusline(conNode, SCRIPT, HELPER) as { command: string; padding: number }
  assert.equal(migrada.padding, 2)
  const [exe, sub, b64] = migrada.command.split(' ')
  assert.equal(`${exe} ${sub}`, `${HELPER} statusline`)
  assert.equal(Buffer.from(b64, 'base64url').toString('utf8'), 'mi-linea')
  // Solo captura (sin original): también se pasa.
  const soloNode = envolverStatusline(undefined, SCRIPT)
  assert.deepEqual(envolverStatusline(soloNode, SCRIPT, HELPER), { type: 'command', command: `${HELPER} statusline` })
})

test('sin ejecutable sigue como antes: lo envuelto con node se deja igual', () => {
  const conNode = envolverStatusline({ type: 'command', command: 'mi-linea' }, SCRIPT)
  assert.deepEqual(envolverStatusline(conNode, SCRIPT), conNode)
  assert.deepEqual(envolverStatusline(conNode, SCRIPT, null), conNode)
})
