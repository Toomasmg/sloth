import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dentroDelRepo, findRule, ruleFor, ruleMatches, type PermissionRequestLike, type PermissionRule } from './permissions-core'

const CWD = 'C:\\dev\\repo'
const pedido = (tool: string, input: Record<string, unknown>): PermissionRequestLike => ({ id: 'p1', ws: 'w1', tool, input, at: 0, expiresAt: 0 })
const regla = (req: PermissionRequestLike): PermissionRule => ({ ...ruleFor(req), id: 'r1', on: true, createdAt: 0 })

test('dentroDelRepo acepta archivos del repo, con cualquier barra y mayúsculas', () => {
  assert.equal(dentroDelRepo('C:\\dev\\repo\\README.md', CWD), true)
  assert.equal(dentroDelRepo('c:/DEV/repo/src/a.ts', CWD), true)
  assert.equal(dentroDelRepo('src\\a.ts', CWD), true)
  assert.equal(dentroDelRepo('/home/ana/repo/a.ts', '/home/ana/repo'), true)
})

test('dentroDelRepo rechaza lo que cae fuera del repo', () => {
  assert.equal(dentroDelRepo('C:\\Users\\ana\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.cmd', CWD), false)
  assert.equal(dentroDelRepo('C:\\dev\\repo\\..\\otro\\a.ts', CWD), false)
  assert.equal(dentroDelRepo('..\\..\\Users\\ana\\.claude\\settings.json', CWD), false)
  assert.equal(dentroDelRepo('C:\\dev\\repo-vecino\\a.ts', CWD), false)
  assert.equal(dentroDelRepo('D:\\dev\\repo\\a.ts', CWD), false)
  assert.equal(dentroDelRepo('C:\\dev\\repo', CWD), false)
  assert.equal(dentroDelRepo('\\\\servidor\\dev\\repo\\a.ts', CWD), false)
})

test('dentroDelRepo rechaza las carpetas del repo que ejecutan lo que se escribe', () => {
  for (const f of ['.git\\hooks\\pre-commit', '.claude\\settings.json', '.vscode\\tasks.json', '.husky\\pre-push', 'paquete\\.git\\config'])
    assert.equal(dentroDelRepo(`${CWD}\\${f}`, CWD), false, f)
  assert.equal(dentroDelRepo(`${CWD}\\.GIT.\\config`, CWD), false)
  assert.equal(dentroDelRepo(`${CWD}\\.git \\config`, CWD), false)
  assert.equal(dentroDelRepo(`${CWD}\\GIT~1\\config`, CWD), false)
  assert.equal(dentroDelRepo(`${CWD}\\a.ts:oculto`, CWD), false)
  assert.equal(dentroDelRepo(`${CWD}\\.gitignore`, CWD), true)
})

test('la regla de ediciones solo aprueba dentro de la carpeta del espacio', () => {
  const r = regla(pedido('Edit', { file_path: `${CWD}\\README.md` }))
  assert.equal(ruleMatches(r, pedido('Write', { file_path: `${CWD}\\src\\b.ts` }), CWD), true)
  assert.equal(ruleMatches(r, pedido('Write', { file_path: 'C:\\Users\\ana\\Documents\\WindowsPowerShell\\profile.ps1' }), CWD), false)
  assert.equal(ruleMatches(r, pedido('Write', { file_path: `${CWD}\\.git\\hooks\\pre-commit` }), CWD), false)
  assert.equal(ruleMatches(r, pedido('NotebookEdit', { notebook_path: `${CWD}\\n.ipynb` }), CWD), true)
})

test('sin carpeta del espacio o sin ruta en el pedido, la regla de ediciones no aprueba', () => {
  const r = regla(pedido('Edit', { file_path: `${CWD}\\README.md` }))
  assert.equal(ruleMatches(r, pedido('Edit', { file_path: `${CWD}\\README.md` })), false)
  assert.equal(ruleMatches(r, pedido('Edit', {}), CWD), false)
})

test('las reglas de comando y de dominio siguen siendo exactas', () => {
  const cmd = regla(pedido('Bash', { command: 'npm test' }))
  assert.equal(findRule([cmd], pedido('Bash', { command: 'npm test' }), CWD)?.id, 'r1')
  assert.equal(findRule([cmd], pedido('Bash', { command: 'npm test; rm -rf x' }), CWD), undefined)
  const net = regla(pedido('WebFetch', { url: 'https://example.com/a' }))
  assert.equal(findRule([net], pedido('WebFetch', { url: 'https://example.com/b' }))?.id, 'r1')
  assert.equal(findRule([net], pedido('WebFetch', { url: 'https://example.org/' })), undefined)
  assert.equal(findRule([cmd], { ...pedido('Bash', { command: 'npm test' }), ws: 'otro' }, CWD), undefined)
})
