import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { construirSetup } from './build-supabase-setup.mjs'

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const migraciones = join(raiz, 'supabase', 'migrations')
const setup = join(raiz, 'supabase', 'setup.sql')
const nombres = readdirSync(migraciones)
  .filter((n) => /^\d{4}_.*\.sql$/.test(n))
  .sort()

let PGlite = null
let pgcrypto = null
try {
  ;({ PGlite } = await import('@electric-sql/pglite'))
  ;({ pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto'))
} catch (e) {
  if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e
}

test('setup.sql coincide con la concatenación de las migraciones', () => {
  assert.equal(
    readFileSync(setup, 'utf8').replaceAll('\r\n', '\n'),
    construirSetup(migraciones),
    'supabase/setup.sql está desactualizado: corré node scripts/build-supabase-setup.mjs'
  )
})

test('las migraciones van numeradas sin saltos', () => {
  nombres.forEach((n, i) => assert.equal(n.slice(0, 4), String(i + 1).padStart(4, '0'), `salto antes de ${n}`))
  assert.equal(nombres.length, 9)
})

test('idempotencia estática: todo create tiene su forma segura', () => {
  const problemas = []
  for (const nombre of nombres) {
    const sql = readFileSync(join(migraciones, nombre), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n')
    for (const m of sql.matchAll(/\bcreate\s+(?:unique\s+)?(table|index|extension|policy|trigger|type|schema)\b(?!\s+if\s+not\s+exists)/gi)) {
      const tipo = m[1].toLowerCase()
      const resto = sql.slice(m.index + m[0].length)
      if (tipo === 'policy' || tipo === 'trigger' || tipo === 'type') {
        const nombreObj = resto.match(/^\s+("?[\w.]+"?)/)?.[1]
        const esperado = new RegExp(`drop\\s+${tipo}\\s+if\\s+exists\\s+${nombreObj?.replace(/\./g, '\\.')}\\b`, 'i')
        if (nombreObj && esperado.test(sql)) continue
      }
      problemas.push(`${nombre}: ${m[0]} ${resto.slice(0, 40).split('\n')[0]}`)
    }
    for (const m of sql.matchAll(/\bcreate\s+function\b/gi)) problemas.push(`${nombre}: create function sin or replace`)
  }
  assert.deepEqual(problemas, [])
})

test('el harness PGlite la aplica limpia y dos veces', { skip: PGlite ? false : 'PGlite no está instalado' }, async () => {
  const r = spawnSync(process.execPath, [join(raiz, 'supabase', 'tests', 'rls.test.mjs'), setup], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)

  const { stub } = await import(pathToFileURL(join(raiz, 'supabase', 'tests', 'stub.mjs')).href)
  const db = new PGlite({ extensions: { pgcrypto } })
  await db.exec(stub)
  const sql = readFileSync(setup, 'utf8')
  await db.exec(sql)
  await db.exec(sql)
})
