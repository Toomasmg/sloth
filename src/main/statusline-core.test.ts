import { test } from 'node:test'
import assert from 'node:assert/strict'
import { envolverStatusline, STATUSLINE_MARKER } from './statusline-core'

const SCRIPT = 'C:\\Users\\yo\\AppData\\Roaming\\Sloth\\sloth-statusline.cjs'

test('envuelve la statusline del usuario y la corre tal cual, con la misma entrada', () => {
  const r = envolverStatusline({ type: 'command', command: 'bash ~/.claude/statusline-command.sh', padding: 0 }, SCRIPT) as { command: string; padding: number }
  assert.equal(r.padding, 0)
  assert.ok(r.command.startsWith('j=$(cat); '))
  assert.ok(r.command.includes('node "C:/Users/yo/AppData/Roaming/Sloth/sloth-statusline.cjs"'))
  assert.ok(r.command.endsWith('printf \'%s\' "$j" | (\nbash ~/.claude/statusline-command.sh\n)'))
})

test('no envuelve dos veces', () => {
  const una = envolverStatusline({ type: 'command', command: 'mi-linea' }, SCRIPT)
  assert.deepEqual(envolverStatusline(una, SCRIPT), una)
  assert.ok(JSON.stringify(una).includes(STATUSLINE_MARKER))
})

test('sin statusline solo captura; lo que no es de comando no se toca', () => {
  assert.deepEqual(envolverStatusline(undefined, SCRIPT), { type: 'command', command: 'node "C:/Users/yo/AppData/Roaming/Sloth/sloth-statusline.cjs"' })
  const rara = { type: 'otra', valor: 1 }
  assert.equal(envolverStatusline(rara, SCRIPT), rara)
})

test('un comentario o un punto y coma de la statusline original no se come el resto', () => {
  const r = envolverStatusline({ type: 'command', command: 'echo hola # comentario' }, SCRIPT) as { command: string }
  assert.ok(r.command.endsWith('(\necho hola # comentario\n)'))
})
