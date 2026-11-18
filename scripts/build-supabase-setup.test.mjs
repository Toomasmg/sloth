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

test('pegar setup.sql sobre una base que ya tenía 0001 a 0008 no rompe ni cambia el esquema', { skip: PGlite ? false : 'PGlite no está instalado' }, async () => {
  const { stub } = await import(pathToFileURL(join(raiz, 'supabase', 'tests', 'stub.mjs')).href)
  const nueva = new PGlite({ extensions: { pgcrypto } })
  await nueva.exec(stub)
  await nueva.exec(readFileSync(setup, 'utf8'))

  const vieja = new PGlite({ extensions: { pgcrypto } })
  await vieja.exec(stub)
  for (const n of nombres.slice(0, 8)) await vieja.exec(readFileSync(join(migraciones, n), 'utf8'))
  await vieja.exec(readFileSync(setup, 'utf8'))
  await vieja.exec(readFileSync(setup, 'utf8'))

  const consultas = {
    politicas: `select tablename, policyname, cmd, roles::text, qual, with_check from pg_policies where schemaname = 'public' order by 1, 2`,
    funciones: `select p.proname, md5(pg_get_functiondef(p.oid)), p.proacl::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by 1, 2`,
    grants: `select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' order by 1, 2, 3`,
    columnas: `select table_name, column_name, grantee, privilege_type from information_schema.column_privileges where table_schema = 'public' and grantee in ('anon', 'authenticated') order by 1, 2, 3, 4`,
    triggers: `select event_object_table, trigger_name, action_timing, event_manipulation from information_schema.triggers where trigger_schema = 'public' order by 1, 2, 3, 4`,
    constraints: `select conrelid::regclass::text, conname, pg_get_constraintdef(oid) from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2`
  }
  for (const [nombre, sql] of Object.entries(consultas)) {
    assert.deepEqual((await vieja.query(sql)).rows, (await nueva.query(sql)).rows, `difiere ${nombre}`)
  }
})
