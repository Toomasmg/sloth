import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { dentroDelRepoReal, realPathInside, type PathFs } from './permissions-paths'
import { dentroDelRepo, findRule, ruleFor, type PermissionRule } from '../../shared/permissions-core'

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
const dentro = (f: string, fs: PathFs = disk): boolean => dentroDelRepoReal(f, REPO, fs, w)

test('adentro del repo sí, aunque el archivo sea nuevo, relativo o cambien las mayúsculas', () => {
  assert.equal(dentro(`${REPO}\\README.md`), true)
  assert.equal(dentro('c:\\users\\ANA\\Repo\\src\\nuevo\\a.ts'), true)
  assert.equal(dentro(`${REPO}\\src\\..\\b.ts`), true)
  assert.equal(dentro('src\\x.ts'), true)
})

test('afuera del repo no, igual que dentroDelRepo', () => {
  for (const f of [`${REPO}\\..\\otro\\x.ts`, 'C:\\Users\\ana\\.claude\\settings.json', 'D:\\repo\\x.ts', REPO, 'C:\\Users\\ana\\repo-malo\\x.ts']) assert.equal(dentro(f), false, f)
})

test('un junction del repo que apunta afuera, a .git o a otra carpeta del repo no cuenta como adentro', () => {
  const fs = fakeFs([...BASE, 'C:\\Windows'], { [`${REPO}\\afuera`]: 'C:\\Windows', [`${REPO}\\ganchos`]: `${REPO}\\.git\\hooks`, [`${REPO}\\atajo`]: `${REPO}\\src` })
  assert.equal(dentro(`${REPO}\\afuera\\x.dll`, fs), false)
  assert.equal(dentro(`${REPO}\\ganchos\\pre-commit`, fs), false)
  assert.equal(dentro(`${REPO}\\atajo\\x.ts`, fs), false)
})

test('un enlace colgante del repo no aprueba, ni como archivo ni como carpeta', () => {
  const fs = fakeFs(BASE, { [`${REPO}\\notas.md`]: null, [`${REPO}\\src\\gen`]: null })
  assert.equal(dentroDelRepo(`${REPO}\\notas.md`, REPO), true)
  assert.equal(dentro(`${REPO}\\notas.md`, fs), false)
  assert.equal(dentro(`${REPO}\\src\\gen\\nuevo\\a.ts`, fs), false)
  assert.equal(dentro(`${REPO}\\src\\otro.md`, fs), true)
})

test('el repo abierto a través de un junction sí vale', () => {
  const fs = fakeFs(['C:\\', 'C:\\D', 'C:\\D\\repo', 'C:\\D\\repo\\src', 'C:\\Users', 'C:\\Users\\ana'], { [REPO]: 'C:\\D\\repo' })
  assert.equal(dentro(`${REPO}\\src\\a.ts`, fs), true)
})

test('un error que no es «no existe» no aprueba', () => {
  const fs: PathFs = {
    real: (p) => p,
    lstat: () => {
      throw Object.assign(new Error('sin permiso'), { code: 'EPERM' })
    }
  }
  assert.equal(realPathInside(`${REPO}\\x`, REPO, fs, w), undefined)
  assert.equal(dentro(`${REPO}\\x`, fs), false)
})

test('carpetas sensibles y nombres cortos 8.3 de cualquiera de ellas', () => {
  for (const f of ['.github\\workflows\\ci.yml', '.idea\\workspace.xml', '.devcontainer\\devcontainer.json', '.sloth\\team.json', '.githooks\\pre-commit', 'VSCODE~1\\tasks.json', 'CLAUDE~1\\settings.json'])
    assert.equal(dentroDelRepo(`${REPO}\\${f}`, REPO), false, f)
  for (const f of ['informe~2.docx', 'notas-viejas~1.md', 'backup~1.txt.bak']) assert.equal(dentroDelRepo(`${REPO}\\${f}`, REPO), true, f)
})

test('la regla de ediciones usa la comprobación con disco que le pasa main', () => {
  const pedido = (file: string) => ({ id: '1', ws: 'w1', tool: 'Write', input: { file_path: file }, at: 0, expiresAt: 0 })
  const rule: PermissionRule = { ...ruleFor(pedido(`${REPO}\\a.md`)), id: 'r', on: true, createdAt: 0 }
  const fs = fakeFs(BASE, { [`${REPO}\\notas.md`]: null })
  const real = (f: string, c: string): boolean => dentroDelRepoReal(f, c, fs, w)
  assert.equal(findRule([rule], pedido(`${REPO}\\b.md`), REPO, real), rule)
  assert.equal(findRule([rule], pedido(`${REPO}\\notas.md`), REPO, real), undefined)
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
    assert.equal(dentroDelRepoReal(path.join(repo, 'a.txt'), repo, DISK), true)
    assert.equal(dentroDelRepoReal(path.join(repo, 'nuevo', 'b.txt'), repo, DISK), true)
    assert.equal(dentroDelRepoReal(path.join(repo, 'link', 'x.txt'), repo, DISK), false)
    assert.equal(dentroDelRepoReal(path.join(repo, 'colgante', 'x.txt'), repo, DISK), false)
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
    assert.equal(dentroDelRepoReal(path.join(repo, 'notas.md'), repo, DISK), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
