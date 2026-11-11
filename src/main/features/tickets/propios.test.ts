import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ConectorInvalidoError, type ConectorMcp } from './conector'
import { CONECTORES } from './conectores'
import { buildAccionArgs } from './motor'
import github from './conectores/github'
import linear from './conectores/linear'
import {
  armarRegistro,
  EQUIPO_MAX,
  IMPORT_MAX_BYTES,
  jsonCanonico,
  parsearArchivoPropios,
  parsearConectoresEquipo,
  parsearImport,
  pareceDeLectura,
  textoExport,
  validarPropio,
  vistaHerramientas
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

test('pareceDeLectura: las de lectura de los incluidos pasan', () => {
  for (const c of CONECTORES) {
    if (c.via !== 'mcp' || c.id === 'jira' || c.id === 'azure-devops') continue
    const h = c.herramientas
    for (const n of [...h.lista, ...h.detalle, ...(h.apoyo ?? [])]) assert.equal(pareceDeLectura(n), true, `${c.id}: ${n}`)
  }
  for (const n of ['list_comments', 'get_issue', 'getJiraIssue', 'settings_get', 'atlassianUserInfo', 'notion-fetch', 'users-get-current', 'getJQLIssues']) assert.equal(pareceDeLectura(n), true, n)
})

test('pareceDeLectura: lo que escribe en cualquier parte del nombre, o no se reconoce como lectura, no pasa', () => {
  const casos = [
    'executeWrite', 'executeDestructive', 'executeRead', 'jira_create_issue', 'jira_delete_issue', 'push_files', 'run_workflow', 'fork_repository', 'bulkDelete', 'publishArtifact',
    'createJiraIssue', 'add_comment', 'editJiraIssue', 'transition_issue', 'delete', 'Update-item', 'get_and_delete', 'confluence_update_page', 'issue_set_assignee', 'mergePullRequest', 'closeIssue', 'assign_issue',
    'login', 'setup', 'createissue', 'do_things'
  ]
  for (const n of casos) assert.equal(pareceDeLectura(n), false, n)
})

test('revisarNoConfiable: en lista, detalle, apoyo y apoyoEn', () => {
  rechazaEn(propio('mi-linear', { lista: ['get_user', 'executeWrite'] }), 'conector.herramientas.lista[1]')
  const enDetalle = propio('mi-linear', { detalle: ['get_issue', 'jira_create_issue'] })
  enDetalle.pistas = { ...enDetalle.pistas, detalle: [{ herramienta: 'jira_create_issue', args: { id: '{ticket}' } }] }
  rechazaEn(enDetalle, 'conector.herramientas.detalle[1]')
  const conApoyoEn = propio('mi-linear', { escritura: { comentar: 'save_comment' }, apoyo: ['get_issue'], apoyoEn: { comentar: ['search_issues', 'executeWrite'] } })
  conApoyoEn.pistas = { ...conApoyoEn.pistas, apoyo: 'Usala si hace falta', acciones: { comentar: { args: { issueId: '{ticket}', body: '{cuerpo}' } } } }
  rechazaEn(conApoyoEn, 'conector.herramientas.apoyoEn.comentar[1]')
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
      { repo: 'Z:/b', repoKey: 'z:/b', equipo: 'B', conectores: [propio('compartido', { lista: ['get_user'] })] },
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
  assert.deepEqual(parsearArchivoPropios(null), { archivo: { version: 1, conectores: [], aceptados: {}, apartados: [] }, corrupto: false, futuro: false, avisos: [] })
  assert.equal(parsearArchivoPropios('{roto').corrupto, true)
  assert.equal(parsearArchivoPropios('{"version":0,"conectores":[],"aceptados":{}}').corrupto, true)
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

test('armarRegistro: el mismo conector en otra copia del repo no avisa', () => {
  const equipo = (k: string): { repo: string; repoKey: string; equipo: string; conectores: unknown[] } => ({ repo: k, repoKey: k, equipo: 'E', conectores: [propio('mio')] })
  const r = armarRegistro({ incluidos: [], usuario: [], equipos: [equipo('z:/wt'), equipo('z:/repo')], hash })
  assert.deepEqual(r.avisos, [])
  assert.deepEqual(r.lista[0].origen, { tipo: 'equipo', repo: 'z:/repo', equipo: 'E' })
})

test('parsearConectoresEquipo: devuelve la lista cruda e ignora las claves _ de arriba', () => {
  const conectores = [{ id: 'mio', cualquier: 'cosa' }]
  assert.deepEqual(parsearConectoresEquipo(JSON.stringify({ formato: 'sloth-conectores', versión: 1, _nota: 'x', conectores })), conectores)
})

test('parsearConectoresEquipo: rechaza formato, versión, claves desconocidas, más de 10 y __proto__', () => {
  const t = (o: Record<string, unknown>): string => JSON.stringify({ formato: 'sloth-conectores', versión: 1, conectores: [], ...o })
  assert.throws(() => parsearConectoresEquipo(t({ formato: 'sloth-team' })), /formato/)
  assert.throws(() => parsearConectoresEquipo(t({ versión: 2 })), /Actualizá Sloth/)
  assert.throws(() => parsearConectoresEquipo(t({ plantillas: [] })), /plantillas/)
  assert.throws(() => parsearConectoresEquipo(t({ conectores: Array.from({ length: 11 }, () => ({})) })), /como mucho 10/)
  assert.throws(() => parsearConectoresEquipo(t({ conectores: { id: 'x' } })), /tiene que ser una lista/)
  assert.throws(() => parsearConectoresEquipo('{"formato":"sloth-conectores","versión":1,"conectores":[{"__proto__":{}}]}'), /__proto__/)
  assert.throws(() => parsearConectoresEquipo('{'), /JSON/)
})

test('parsearArchivoPropios: el que no valida queda apartado tal cual y vuelve a cargarse si después valida', () => {
  const malo = { ...propio('mi-viejo', { lista: ['get_user', 'executeWrite'] }), _extra: 1 }
  const bueno = propio('mi-linear')
  const r = parsearArchivoPropios(JSON.stringify({ version: 1, conectores: [bueno, malo], aceptados: {} }))
  assert.equal(r.corrupto, false)
  assert.deepEqual(r.archivo.conectores.map((c) => c.id), ['mi-linear'])
  assert.deepEqual(r.archivo.apartados, [malo])
  assert.match(r.avisos[0], /mi-viejo.*no se borra/)

  const otraVez = parsearArchivoPropios(JSON.stringify(r.archivo))
  assert.deepEqual(otraVez.archivo.apartados, [malo])
  const arreglado = parsearArchivoPropios(JSON.stringify({ ...r.archivo, apartados: [propio('mi-viejo')] }))
  assert.deepEqual(arreglado.archivo.conectores.map((c) => c.id), ['mi-linear', 'mi-viejo'])
  assert.deepEqual(arreglado.archivo.apartados, [])
})

test('parsearArchivoPropios: una versión más nueva no es corrupta ni se toca', () => {
  const r = parsearArchivoPropios(JSON.stringify({ version: 2, conectores: [] }))
  assert.equal(r.corrupto, false)
  assert.equal(r.futuro, true)
  assert.match(r.avisos[0], /actualizá Sloth/)
  assert.equal(parsearArchivoPropios(JSON.stringify({ version: 'x' })).corrupto, true)
})

test('vistaHerramientas: cada acción muestra lo mismo que va a --allowedTools, con apoyoEn y la nota', () => {
  const def = propio('mi-linear', { escritura: { comentar: 'save_comment' }, apoyo: ['get_issue'], apoyoEn: { comentar: ['search_issues'] } })
  def.pistas = { ...def.pistas, apoyo: 'Leé {ticket} antes', acciones: { comentar: { args: { issueId: '{ticket}', body: '{cuerpo}' }, nota: 'Pegá lo que encuentres' } } }
  const v = vistaHerramientas(validarPropio(def) as ConectorMcp)
  assert.deepEqual(v.acciones.comentar, ['save_comment', 'get_issue', 'search_issues'])
  const args = buildAccionArgs(def, 'haiku', 'comentar')
  assert.deepEqual(args[args.indexOf('--allowedTools') + 1].split(','), v.acciones.comentar?.map((t) => def.herramientas.prefijo + t))
  assert.deepEqual(v.detalle, [...def.herramientas.detalle, 'get_issue'].filter((t, i, xs) => xs.indexOf(t) === i))
  assert.deepEqual(v.pistas.acciones.comentar, { args: '{"issueId":"{ticket}","body":"{cuerpo}"}', nota: 'Pegá lo que encuentres' })
  assert.equal(v.pistas.apoyo, 'Leé {ticket} antes')
  assert.equal(v.pistas.yoConId, def.pistas.yo.conId)
  assert.equal(v.pistas.detalle.length, def.pistas.detalle.length)
})
