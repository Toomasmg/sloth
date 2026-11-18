import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validarConector, type ConectorMcp } from './conector'
import gruv from './conectores/gruv'
import { lanzamientoDe } from './lanzamiento'
import { motorCodex } from './motor-codex'

const ARGS = ['exec', '--json', '-c', 'approval_policy="never"', '-c', 'mcp_servers.gruv.enabled_tools=["a","b"]', '-']

test('un .exe, o cualquier ejecutable fuera de Windows, va tal cual y sin verbatim', () => {
  assert.deepEqual(lanzamientoDe('C:\\bin\\codex.exe', ARGS, 'win32'), { file: 'C:\\bin\\codex.exe', args: ARGS, verbatim: false })
  assert.deepEqual(lanzamientoDe('/usr/bin/codex', ARGS, 'linux'), { file: '/usr/bin/codex', args: ARGS, verbatim: false })
  assert.equal(lanzamientoDe('/usr/bin/codex.cmd', ARGS, 'linux').verbatim, false)
})

test('un .cmd de Windows corre por cmd.exe verbatim, con la ruta entre comillas y las comillas de los argumentos escapadas', () => {
  const l = lanzamientoDe('C:\\Users\\Yo Mismo\\AppData\\Roaming\\npm\\codex.cmd', ARGS, 'win32')
  assert.equal(l.file, 'cmd.exe')
  assert.equal(l.verbatim, true)
  assert.deepEqual(l.args, [
    '/d',
    '/s',
    '/c',
    '""C:\\Users\\Yo Mismo\\AppData\\Roaming\\npm\\codex.cmd" exec --json -c approval_policy=\\"never\\" -c mcp_servers.gruv.enabled_tools=[\\"a\\",\\"b\\"] -"'
  ])
  assert.equal(lanzamientoDe('C:\\npm\\CODEX.BAT', [], 'win32').args[3], '""C:\\npm\\CODEX.BAT""')
  assert.equal(lanzamientoDe('\\\\servidor\\npm\\codex.cmd', ['-'], 'win32').verbatim, true)
})

test('una ruta de .cmd con caracteres que cmd lee como sintaxis, o que no es absoluta, no se lanza', () => {
  for (const exe of ['C:\\a&b\\codex.cmd', 'C:\\a%PATH%\\codex.cmd', 'C:\\a"b\\codex.cmd', 'C:\\a^b\\codex.cmd', 'C:\\a!b\\codex.cmd', 'C:\\a\nb\\codex.cmd', 'C:\\a<b\\codex.cmd', 'C:\\a|b\\codex.cmd', 'C:\\a>b\\codex.cmd', 'codex.cmd', '..\\codex.cmd', '\\codex.cmd']) {
    assert.throws(() => lanzamientoDe(exe, ARGS, 'win32'), /ruta de Codex/, exe)
  }
})

test('un argumento con algo que cmd lee como comando no se lanza por cmd.exe', () => {
  for (const peligroso of ['a&calc', 'a|b', 'a>b', 'a<b', 'a^b', '%PATH%', '!x!', 'a b', 'a;b', "a'b", 'a(b)', 'a\nb', '', 'a`b']) {
    assert.throws(() => lanzamientoDe('C:\\npm\\codex.cmd', ['exec', peligroso], 'win32'), /argumento/, JSON.stringify(peligroso))
  }
  // Con un .exe ningún argumento pasa por cmd: no se filtra nada.
  assert.deepEqual(lanzamientoDe('C:\\bin\\codex.exe', ['a&b', 'x y'], 'win32').args, ['a&b', 'x y'])
})

test('el argv real de Codex siempre es lanzable por cmd.exe', () => {
  const def = validarConector(gruv) as ConectorMcp
  const args = motorCodex.argv({ tarea: 'detalle', def, model: 'm', ajenos: [], servidoresCuenta: ['gruv', 'otro-1', 'otro_2'], servidorElegido: 'gruv' })
  assert.doesNotThrow(() => lanzamientoDe('C:\\npm\\codex.cmd', args, 'win32'))
})

test('en Windows, un shim .cmd como el de npm recibe el argv intacto y el prompt por stdin', { skip: process.platform !== 'win32' }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'sloth lanz '))
  try {
    const dir = join(base, 'Yo Mismo', 'npm')
    mkdirSync(join(dir, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true })
    // Mismas líneas que el codex.cmd que genera npm; el codex.js de mentira devuelve lo que recibió.
    writeFileSync(
      join(dir, 'codex.cmd'),
      [
        '@ECHO off',
        'GOTO start',
        ':find_dp0',
        'SET dp0=%~dp0',
        'EXIT /b',
        ':start',
        'SETLOCAL',
        'CALL :find_dp0',
        'SET "_prog=node"',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
        ''
      ].join('\r\n')
    )
    writeFileSync(
      join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
      "let d=''\nprocess.stdin.setEncoding('utf8').on('data',(x)=>{d+=x}).on('end',()=>process.stdout.write(JSON.stringify({argv:process.argv.slice(2),stdin:d})))\n"
    )
    const def = validarConector(gruv) as ConectorMcp
    const args = motorCodex.argv({ tarea: 'lista', def, model: 'm', ajenos: [], servidoresCuenta: ['gruv', 'otro'], servidorElegido: 'gruv' })
    const l = lanzamientoDe(join(dir, 'codex.cmd'), args, 'win32')
    const prompt = 'Listá los tickets "ya" & %PATH% ^ | < > !x!\nsegunda línea'
    const salida = await new Promise<string>((resolve, reject) => {
      const c = spawn(l.file, l.args, { windowsVerbatimArguments: l.verbatim, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
      let out = ''
      c.stdout.setEncoding('utf8').on('data', (x: string) => (out += x))
      c.on('error', reject)
      c.on('close', () => resolve(out))
      c.stdin.end(prompt, 'utf8')
    })
    assert.deepEqual(JSON.parse(salida), { argv: args, stdin: prompt })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
