import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lanzableSinShell, nombreServidorValido, servidorDePrefijo, servidoresRevisados, servidoresDeConfigToml, servidoresIgnorados } from './codex-config'

test('dos servidores: la subtabla .env no suma otro nombre', () => {
  const toml = `model = "gpt-5"

[mcp_servers.gruv]
command = "npx"
args = ["-y", "gruv-mcp"]

[mcp_servers.gruv.env]
TOKEN = "x"

[mcp_servers.otro]
url = "https://ejemplo.test/mcp"
`
  assert.deepEqual(servidoresDeConfigToml(toml), ['gruv', 'otro'])
})

test('nombres con comillas, claves con puntos y tabla en línea', () => {
  const toml = `[mcp_servers."a b"]
command = "x"

[mcp_servers.'c-d']
command = "y"

[mcp_servers.gruv]
command = "z"
`
  assert.deepEqual(servidoresDeConfigToml(toml), ['a b', 'c-d', 'gruv'])
  assert.deepEqual(servidoresDeConfigToml('mcp_servers.e.command = "x"\n'), ['e'])
  assert.deepEqual(servidoresDeConfigToml('[mcp_servers]\nf = { command = "x" }\n'), ['f'])
})

test('duplicado: una sola vez y en orden de aparición', () => {
  const toml = '[mcp_servers.b]\ncommand = "x"\n[mcp_servers.a]\ncommand = "x"\n[mcp_servers.b.env]\nK = "v"\n'
  assert.deepEqual(servidoresDeConfigToml(toml), ['b', 'a'])
})

test('sin mcp_servers, vacío o solo comentarios: lista vacía', () => {
  assert.deepEqual(servidoresDeConfigToml(''), [])
  assert.deepEqual(servidoresDeConfigToml('# nada\n[otra]\nx = 1\n'), [])
  assert.deepEqual(servidoresDeConfigToml('[mcp_servers]\n'), [])
})

test('un TOML que no se entiende o es enorme da undefined, no una lista a medias', () => {
  assert.equal(servidoresDeConfigToml('[mcp_servers.x\ncommand = '), undefined)
  assert.equal(servidoresDeConfigToml('a = "' + 'x'.repeat(2 * 1024 * 1024) + '"'), undefined)
})

test('nombreServidorValido y servidoresIgnorados', () => {
  for (const ok of ['gruv', 'a_b', 'c-d', 'X1']) assert.equal(nombreServidorValido(ok), true, ok)
  for (const mal of ['', 'x y', 'a;b', '..', 'a.b', 'a"b', 'a\nb', 'x'.repeat(65), 'ñ']) assert.equal(nombreServidorValido(mal), false, mal)
  assert.deepEqual(servidoresIgnorados(['ok', 'x y', 'a.b']), ['x y', 'a.b'])
})

test('servidorDePrefijo: solo servidores que pueden estar en un config.toml', () => {
  assert.equal(servidorDePrefijo('mcp__gruv__'), 'gruv')
  assert.equal(servidorDePrefijo('mcp__gruv-tomy__'), 'gruv-tomy')
  assert.equal(servidorDePrefijo('mcp__claude_ai_Linear__'), undefined)
  assert.equal(servidorDePrefijo('mcp__a.b__'), undefined)
  assert.equal(servidorDePrefijo('gruv'), undefined)
  assert.equal(servidorDePrefijo('mcp____'), undefined)
})

test('servidoresRevisados: sin saber si andan y sin los nombres que no se pueden nombrar', () => {
  assert.deepEqual(servidoresRevisados(['gruv', 'a b']), [{ nombre: 'gruv', prefijo: 'mcp__gruv__', estado: 'otro' }])
  assert.deepEqual(servidoresRevisados([]), [])
})

test('lanzableSinShell: un .cmd de Windows no', () => {
  assert.equal(lanzableSinShell('C:\a\codex.cmd', 'win32'), false)
  assert.equal(lanzableSinShell('C:\a\codex.exe', 'win32'), true)
  assert.equal(lanzableSinShell('/usr/bin/codex.cmd', 'linux'), true)
})
