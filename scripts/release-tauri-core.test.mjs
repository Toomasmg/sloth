import { test } from 'node:test'
import assert from 'node:assert/strict'
import { latestJson, latestYml, nombreElectron, nombreTauri, sha512Base64 } from './release-tauri-core.mjs'

test('latest.json apunta al instalador de Tauri de esa versión con su firma', () => {
  const j = latestJson({ version: '0.9.0', notas: 'n', firma: 'FIRMA', fecha: '2026-11-27T00:00:00Z' })
  assert.equal(j.version, '0.9.0')
  assert.equal(j.platforms['windows-x86_64'].signature, 'FIRMA')
  assert.equal(j.platforms['windows-x86_64'].url, `https://github.com/Toomasmg/sloth/releases/download/v0.9.0/${nombreTauri('0.9.0')}`)
})

test('latest.yml usa el nombre de electron-updater y el sha512 del mismo archivo', () => {
  const bytes = Buffer.from('instalador')
  const yml = latestYml({ version: '0.9.0', bytes, fecha: '2026-11-27T00:00:00.000Z' })
  const sha = sha512Base64(bytes)
  assert.match(yml, /^version: 0\.9\.0$/m)
  assert.match(yml, new RegExp(`^path: ${nombreElectron('0.9.0')}$`, 'm'))
  assert.ok(yml.split('\n').includes(`sha512: ${sha}`))
  assert.match(yml, /size: 10$/m)
  assert.match(yml, /releaseDate: '2026-11-27T00:00:00\.000Z'/)
})

test('los dos nombres son distintos', () => {
  assert.notEqual(nombreTauri('1.0.0'), nombreElectron('1.0.0'))
})
