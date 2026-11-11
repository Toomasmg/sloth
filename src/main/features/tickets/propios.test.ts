import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ConectorInvalidoError, type ConectorMcp } from './conector'
import { CONECTORES } from './conectores'
import github from './conectores/github'
import linear from './conectores/linear'
import {
  armarRegistro,
  EQUIPO_MAX,
  esVerboEscritura,
  IMPORT_MAX_BYTES,
  jsonCanonico,
  parsearArchivoPropios,
  parsearImport,
  textoExport,
  validarPropio
} from './propios'

const hash = (t: string): string => createHash('sha256').update(t).digest('hex').slice(0, 16)

function propio(id: string, cambios: Partial<ConectorMcp['herramientas']> = {}): ConectorMcp {
  const d = structuredClone(linear) as unknown as ConectorMcp
  d.id = id
  d.herramientas = { ...d.herramientas, ...cambios }
  return d
}

function rechazaEn(raw: unknown, ruta: string): void {
  assert.throws(
    () => validarPropio(raw),
    (e: unknown) => e instanceof ConectorInvalidoError && e.ruta === ruta
  )
}

test('un incluido clonado con otro id pasa y sale sin verificar', () => {
  const def = validarPropio({ ...propio('mi-linear'), verificado: true })
  assert.equal(def.id, 'mi-linear')
  assert.equal(def.verificado, false)
})

test('una herramienta de lectura que parece de escritura se rechaza con su ruta', () => {
  rechazaEn(propio('mi-linear', { lista: ['get_user', 'create_draft'] }), 'conector.herramientas.lista[1]')
  const conApoyo = propio('mi-linear', { apoyo: ['addComment'] })
  conApoyo.pistas = { ...conApoyo.pistas, apoyo: 'Usala si hace falta' }
  rechazaEn(conApoyo, 'conector.herramientas.apoyo[0]')
})

test('los conectores propios de vía gh se rechazan', () => {
  rechazaEn({ ...github, id: 'mi-github' }, 'conector.via')
})

test('esVerboEscritura', () => {
  for (const n of ['list_comments', 'get_issue', 'getJiraIssue', 'settings_get', 'login', 'setup']) assert.equal(esVerboEscritura(n), false, n)
  for (const n of ['createJiraIssue', 'add_comment', 'editJiraIssue', 'transition_issue', 'delete', 'Update-item']) assert.equal(esVerboEscritura(n), true, n)
})

test('armarRegistro: un id de incluido no entra y queda el aviso', () => {
  const r = armarRegistro({ incluidos: CONECTORES, usuario: [propio('linear')], equipos: [], hash })
  assert.equal(r.lista.length, CONECTORES.length)
  assert.match(r.avisos[0], /«linear» usa el id de uno incluido/)
  assert.ok(r.lista.every((c) => c.origen.tipo === 'incluido' && /^[0-9a-f]{16}$/.test(c.hash)))
})

test('armarRegistro: el del usuario gana al del equipo y entre repos gana el de repoKey menor', () => {
  const r = armarRegistro({
    incluidos: CONECTORES,
    usuario: [propio('mio')],
    equipos: [
      { repo: 'Z:/b', repoKey: 'z:/b', equipo: 'B', conectores: [propio('compartido')] },
      { repo: 'Z:/a', repoKey: 'z:/a', equipo: 'A', conectores: [propio('mio'), propio('compartido')] }
    ],
    hash
  })
  assert.deepEqual(r.lista.find((c) => c.def.id === 'mio')?.origen, { tipo: 'usuario' })
  assert.deepEqual(r.lista.find((c) => c.def.id === 'compartido')?.origen, { tipo: 'equipo', repo: 'Z:/a', equipo: 'A' })
  assert.equal(r.avisos.length, 2)
  assert.ok(r.avisos.every((a) => a.startsWith('Del equipo ') && a.length <= 200))
})

test('armarRegistro: un equipo con más de EQUIPO_MAX conectores se corta', () => {
  const conectores = Array.from({ length: EQUIPO_MAX + 2 }, (_, i) => propio(`eq-${i}`))
  const r = armarRegistro({ incluidos: [], usuario: [], equipos: [{ repo: 'r', repoKey: 'r', equipo: 'E', conectores }], hash })
  assert.equal(r.lista.length, EQUIPO_MAX)
  assert.match(r.avisos[0], /más de 10/)
})

test('jsonCanonico no depende del orden de las claves y cambia si cambia una herramienta', () => {
  const a = propio('mi-linear')
  const b = Object.fromEntries(Object.entries(a).reverse())
  assert.equal(jsonCanonico(a), jsonCanonico(b))
  assert.notEqual(jsonCanonico(a), jsonCanonico(propio('mi-linear', { lista: ['get_user'] })))
})

test('propios.ts no importa nada de node (la interfaz también lo usa)', () => {
  const fuente = readFileSync(new URL('./propios.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(fuente, /from 'node:/)
})

test('parsearImport: ida y vuelta con textoExport, y errores legibles', () => {
  const def = validarPropio(propio('mi-linear'))
  assert.deepEqual(parsearImport(textoExport(def)), def)
  assert.throws(() => parsearImport(' '.repeat(IMPORT_MAX_BYTES + 1)), /pesa más de 64 KB/)
  assert.throws(() => parsearImport('{"__proto__": {}}'), /clave no permitida «__proto__»/)
  assert.throws(() => parsearImport('{roto'), /no es un JSON válido/)
  assert.throws(() => parsearImport(JSON.stringify({ ...github, id: 'mi-github' })), /vía mcp/)
})

test('parsearArchivoPropios', () => {
  assert.deepEqual(parsearArchivoPropios(null), { archivo: { version: 1, conectores: [], aceptados: {} }, corrupto: false, avisos: [] })
  assert.equal(parsearArchivoPropios('{roto').corrupto, true)
  assert.equal(parsearArchivoPropios('{"version":2,"conectores":[],"aceptados":{}}').corrupto, true)
  const r = parsearArchivoPropios(
    JSON.stringify({
      version: 1,
      conectores: [propio('bueno'), propio('malo', { lista: ['create_draft'] })],
      aceptados: { 'z:/a::x': 'a'.repeat(16), 'z:/a::y': 'no-es-hash', ['k'.repeat(1101)]: 'b'.repeat(16) }
    })
  )
  assert.equal(r.corrupto, false)
  assert.deepEqual(
    r.archivo.conectores.map((c) => c.id),
    ['bueno']
  )
  assert.equal(r.avisos.length, 1)
  assert.deepEqual(r.archivo.aceptados, { 'z:/a::x': 'a'.repeat(16) })
})
