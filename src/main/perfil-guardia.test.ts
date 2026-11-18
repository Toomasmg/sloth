import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const SRC = join(import.meta.dirname, '..')
const USER_DATA = /getPath\(\s*['"`]userData['"`]\s*\)/

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const f = join(dir, n)
    if (statSync(f).isDirectory()) return n === 'node_modules' ? [] : archivos(f)
    return /\.(ts|tsx|mts|cts)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [f] : []
  })
}

test('solo perfil.ts pregunta por userData: lo demás pasa por raizDatos() o rutaPerfil()', () => {
  const unico = join(SRC, 'main', 'perfil.ts')
  const infractores = ['main', 'preload', 'shared', 'renderer']
    .flatMap((d) => archivos(join(SRC, d)))
    .filter((f) => f !== unico && USER_DATA.test(readFileSync(f, 'utf8')))
    .map((f) => relative(SRC, f).split(sep).join('/'))
  assert.deepEqual(infractores, [], `Usá raizDatos() o rutaPerfil() de perfil.ts en: ${infractores.join(', ')}`)
})

test('la guardia mira donde tiene que mirar', () => {
  assert.ok(USER_DATA.test(readFileSync(join(SRC, 'main', 'perfil.ts'), 'utf8')))
  assert.ok(USER_DATA.test("app.getPath( 'userData' )"))
  assert.ok(archivos(join(SRC, 'main')).some((f) => f.endsWith(join('features', 'settings.ts'))))
})
