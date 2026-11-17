import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { editInsideRepo, realPathInside, type PathFs } from './permissions-paths'
import { alwaysLabel, checkRule, findRule, ruleFor, ruleWarning, type EditScope, type PermissionRule } from './permissions-core'

const w = path.win32
const REPO = 'C:\\Users\\ana\\repo'

const missing = (): never => {
  throw Object.assign(new Error('no existe'), { code: 'ENOENT' })
}

// Disco falso: existen estas rutas (comparadas en minúsculas, como Windows; realpath devuelve la
// forma canónica) y `links` son enlaces o junctions; con destino null, colgantes.
function fakeFs(existing: string[], links: Record<string, string | null> = {}): PathFs {
  const have = new Map(existing.map((e) => [e.toLowerCase(), e]))
  const linkOf = (p: string): [string, string | null] | undefined => {
    const key = p.toLowerCase()
    return Object.entries(links).find(([from]) => key === from.toLowerCase() || key.startsWith(from.toLowerCase() + '\\'))
  }
  const real = (p: string): string => {
    const l = linkOf(p)
    if (!l) return have.get(p.toLowerCase()) ?? missing()
    const [from, to] = l
    return to === null ? missing() : real(to + p.slice(from.length))
  }
  const lstat = (p: string): { isSymbolicLink(): boolean } => {
    const l = linkOf(p)
    if (l && l[0].toLowerCase() === p.toLowerCase()) return { isSymbolicLink: () => true }
    real(p)
    return { isSymbolicLink: () => false }
  }
  return { real, lstat }
}

const BASE = ['C:\\', 'C:\\Users', 'C:\\Users\\ana', REPO, `${REPO}\\src`, `${REPO}\\.git`, `${REPO}\\.git\\hooks`]
const disk = fakeFs(BASE)

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

test('un junction del repo que apunta afuera, a .git o a otra carpeta del repo no cuenta como adentro', () => {
  const fs = fakeFs([...BASE, 'C:\\Windows'], { [`${REPO}\\afuera`]: 'C:\\Windows', [`${REPO}\\ganchos`]: `${REPO}\\.git\\hooks`, [`${REPO}\\atajo`]: `${REPO}\\src` })
  assert.equal(editInsideRepo(`${REPO}\\afuera\\x.dll`, REPO, fs, w), false)
  assert.equal(editInsideRepo(`${REPO}\\ganchos\\pre-commit`, REPO, fs, w), false)
  assert.equal(editInsideRepo(`${REPO}\\atajo\\x.ts`, REPO, fs, w), false)
})

test('un enlace colgante del repo no aprueba, ni como archivo ni como carpeta', () => {
  const fs = fakeFs(BASE, { [`${REPO}\\notas.md`]: null, [`${REPO}\\src\\gen`]: null })
  assert.equal(editInsideRepo(`${REPO}\\notas.md`, REPO, fs, w), false)
  assert.equal(editInsideRepo(`${REPO}\\src\\gen\\nuevo\\a.ts`, REPO, fs, w), false)
  assert.equal(editInsideRepo(`${REPO}\\src\\otro.md`, REPO, fs, w), true)
})

test('el repo abierto a través de un junction sí vale', () => {
  const fs = fakeFs(['C:\\', 'C:\\D', 'C:\\D\\repo', 'C:\\D\\repo\\src', 'C:\\Users', 'C:\\Users\\ana'], { [REPO]: 'C:\\D\\repo' })
  assert.equal(editInsideRepo(`${REPO}\\src\\a.ts`, REPO, fs, w), true)
  assert.equal(editInsideRepo('C:\\D\\repo\\b.ts', REPO, fs, w), true)
})

test('un error que no es «no existe» no aprueba', () => {
  const fs: PathFs = {
    real: (p) => p,
    lstat: () => {
      throw Object.assign(new Error('sin permiso'), { code: 'EPERM' })
    }
  }
  assert.equal(realPathInside(`${REPO}\\x`, REPO, fs, w), undefined)
  assert.equal(editInsideRepo(`${REPO}\\x`, REPO, fs, w), false)
})

test('nombres con ~ que no son cortos 8.3 sí entran', () => {
  assert.equal(editInsideRepo(`${REPO}\\informe~2.docx`, REPO, disk, w), true)
  assert.equal(editInsideRepo(`${REPO}\\src\\VSCODE~1\\x`, REPO, disk, w), false)
})

const DISK: PathFs = { real: (p) => realpathSync.native(p), lstat: (p) => lstatSync(p) }

test('junction real en disco', { skip: process.platform !== 'win32' }, () => {
  const base = mkdtempSync(path.join(tmpdir(), 'sloth-junction-'))
  try {
    const repo = path.join(base, 'repo')
    const outside = path.join(base, 'afuera')
    mkdirSync(repo)
    mkdirSync(outside)
    writeFileSync(path.join(repo, 'a.txt'), '')
    symlinkSync(outside, path.join(repo, 'link'), 'junction')
    symlinkSync(path.join(base, 'no-existe'), path.join(repo, 'colgante'), 'junction')
    assert.equal(editInsideRepo(path.join(repo, 'a.txt'), repo, DISK), true)
    assert.equal(editInsideRepo(path.join(repo, 'nuevo', 'b.txt'), repo, DISK), true)
    assert.equal(editInsideRepo(path.join(repo, 'link', 'x.txt'), repo, DISK), false)
    assert.equal(editInsideRepo(path.join(repo, 'colgante', 'x.txt'), repo, DISK), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('symlink de archivo colgante real en disco', (t) => {
  const base = mkdtempSync(path.join(tmpdir(), 'sloth-symlink-'))
  try {
    const repo = path.join(base, 'repo')
    mkdirSync(repo)
    try {
      symlinkSync(path.join(base, 'afuera', 'x.cmd'), path.join(repo, 'notas.md'), 'file')
    } catch (e) {
      if ((e as { code?: unknown }).code === 'EPERM') return t.skip('sin permiso para crear symlinks')
      throw e
    }
    assert.equal(editInsideRepo(path.join(repo, 'notas.md'), repo, DISK), false)
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
