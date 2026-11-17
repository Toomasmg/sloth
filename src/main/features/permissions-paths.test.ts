import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { editInsideRepo, realPathOf } from './permissions-paths'
import { alwaysLabel, checkRule, findRule, ruleFor, ruleWarning, type EditScope, type PermissionRule } from './permissions-core'

const w = path.win32
const REPO = 'C:\\Users\\ana\\repo'

// Disco falso: existen estas carpetas (en minúsculas, como compara Windows) y `links` son junctions.
function fakeReal(existing: string[], links: Record<string, string> = {}): (p: string) => string {
  const have = new Set(existing.map((e) => e.toLowerCase()))
  return (p) => {
    const key = p.toLowerCase()
    for (const [from, to] of Object.entries(links)) {
      if (key === from.toLowerCase() || key.startsWith(from.toLowerCase() + '\\')) return to + p.slice(from.length)
    }
    if (!have.has(key)) throw Object.assign(new Error('no existe'), { code: 'ENOENT' })
    return p
  }
}

const disk = fakeReal(['C:\\', 'C:\\Users', 'C:\\Users\\ana', REPO, `${REPO}\\src`, `${REPO}\\.git`, `${REPO}\\.git\\hooks`])

test('adentro del repo sí, aunque el archivo sea nuevo o cambien las mayúsculas', () => {
  assert.equal(editInsideRepo(`${REPO}\\README.md`, REPO, disk, w), true)
  assert.equal(editInsideRepo('c:\\users\\ANA\\Repo\\src\\nuevo\\a.ts', REPO, disk, w), true)
  assert.equal(editInsideRepo(`${REPO}\\src\\..\\b.ts`, REPO, disk, w), true)
})

test('afuera del repo no: .., otra carpeta, otro disco, rutas relativas', () => {
  assert.equal(editInsideRepo(`${REPO}\\..\\otro\\x.ts`, REPO, disk, w), false)
  assert.equal(editInsideRepo(`${REPO}\\src\\..\\..\\x.ts`, REPO, disk, w), false)
  assert.equal(editInsideRepo('C:\\Users\\ana\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.cmd', REPO, disk, w), false)
  assert.equal(editInsideRepo('C:\\Users\\ana\\.claude\\settings.json', REPO, disk, w), false)
  assert.equal(editInsideRepo('D:\\repo\\x.ts', REPO, disk, w), false)
  assert.equal(editInsideRepo('src\\x.ts', REPO, disk, w), false)
  assert.equal(editInsideRepo(REPO, REPO, disk, w), false)
  assert.equal(editInsideRepo('C:\\Users\\ana\\repo-malo\\x.ts', REPO, disk, w), false)
})

test('las carpetas protegidas no entran, con cualquier mayúscula, punto final o nombre corto', () => {
  for (const f of ['.git\\hooks\\pre-commit', '.GIT\\config', '.git.\\config', '.claude\\settings.json', 'sub\\.vscode\\tasks.json', '.husky\\pre-push', '.github\\workflows\\ci.yml', 'GIT~1\\config', 'a.txt:stream', '.idea\\workspace.xml']) {
    assert.equal(editInsideRepo(`${REPO}\\${f}`, REPO, disk, w), false, f)
  }
})

test('un junction del repo que apunta afuera o a .git no cuenta como adentro', () => {
  const real = fakeReal(['C:\\', 'C:\\Users', 'C:\\Users\\ana', REPO, 'C:\\Windows'], { [`${REPO}\\afuera`]: 'C:\\Windows', [`${REPO}\\ganchos`]: `${REPO}\\.git\\hooks` })
  assert.equal(editInsideRepo(`${REPO}\\afuera\\x.dll`, REPO, real, w), false)
  assert.equal(editInsideRepo(`${REPO}\\ganchos\\pre-commit`, REPO, real, w), false)
})

test('un error que no es «no existe» no aprueba', () => {
  const real = (): string => {
    throw Object.assign(new Error('sin permiso'), { code: 'EPERM' })
  }
  assert.equal(realPathOf(`${REPO}\\x`, real, w), undefined)
  assert.equal(editInsideRepo(`${REPO}\\x`, REPO, real, w), false)
})

test('junction real en disco', { skip: process.platform !== 'win32' }, () => {
  const base = mkdtempSync(path.join(tmpdir(), 'sloth-junction-'))
  try {
    const repo = path.join(base, 'repo')
    const outside = path.join(base, 'afuera')
    mkdirSync(repo)
    mkdirSync(outside)
    writeFileSync(path.join(repo, 'a.txt'), '')
    symlinkSync(outside, path.join(repo, 'link'), 'junction')
    assert.equal(editInsideRepo(path.join(repo, 'a.txt'), repo, realpathSync.native), true)
    assert.equal(editInsideRepo(path.join(repo, 'link', 'x.txt'), repo, realpathSync.native), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

const req = (file: string, tool = 'Edit') => ({ id: '1', ws: 'w1', tool, input: { file_path: file }, at: 0, expiresAt: 0 })

test('la regla de edición guarda la carpeta y sin alcance no aprueba nada', () => {
  const draft = ruleFor(req(`${REPO}\\README.md`), REPO)
  assert.equal(draft.cwd, REPO)
  assert.equal(draft.label, 'Editar archivos en este repo')
  const rule: PermissionRule = { ...draft, id: 'r', on: true, createdAt: 0 }
  assert.equal(findRule([rule], req(`${REPO}\\x.ts`)), undefined)
  const scope: EditScope = (r, q) => editInsideRepo(String(q.input.file_path), r.cwd ?? REPO, disk, w)
  assert.equal(findRule([rule], req(`${REPO}\\x.ts`, 'Write'), scope), rule)
  assert.equal(findRule([rule], req('C:\\Users\\ana\\.claude\\settings.json', 'Write'), scope), undefined)
})

test('una regla vieja sin cwd usa la carpeta del espacio, no todo el disco', () => {
  const rule: PermissionRule = { id: 'r', workspaceId: 'w1', kind: 'edit', tool: 'Edit', match: '*', label: 'Editar x', on: true, createdAt: 0 }
  const scope: EditScope = (r, q) => editInsideRepo(String(q.input.file_path), r.cwd ?? REPO, disk, w)
  assert.equal(findRule([rule], req(`${REPO}\\x.ts`), scope), rule)
  assert.equal(findRule([rule], req('C:\\Users\\ana\\Documents\\WindowsPowerShell\\profile.ps1'), scope), undefined)
})

test('texto del botón y avisos al importar reglas amplias', () => {
  assert.equal(alwaysLabel('edit'), 'Permitir siempre ediciones en este repo')
  const edit = checkRule({ kind: 'edit', tool: 'Write', match: '*' })
  const other = checkRule({ kind: 'other', tool: 'mcp__slack__send', match: '*' })
  assert.ok(edit.ok && other.ok)
  if (edit.ok) assert.match(ruleWarning(edit.rule) ?? '', /cualquier edición/)
  if (other.ok) assert.match(ruleWarning(other.rule) ?? '', /cualquier uso de send/)
  assert.equal(ruleWarning({ kind: 'cmd', tool: 'Bash' }), undefined)
})
