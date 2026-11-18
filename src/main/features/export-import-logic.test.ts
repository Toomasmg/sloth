import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Account, Workspace } from '../../shared/types'
import { encryptText, WRONG_PASSWORD } from './export-crypto'
import {
  buildPlan,
  cuentaExportada,
  exportRules,
  exportSpaces,
  exportTemplates,
  FORMAT,
  FORMAT_VERSION,
  fmtKb,
  openEnvelope,
  parseImport,
  readEnvelope,
  sectionSizes,
  templatesToSave,
  type ExportDoc,
  type ParsedImport
} from './export-import-logic'

const acc = (id: string, label: string): Account => ({ id, label, configDir: `C:\\secreto\\${id}`, createdAt: 1 })
const ws = (id: string, name: string, repoPath: string, accountId: string): Workspace => ({
  id,
  name,
  repoPath,
  cwd: repoPath,
  accountId,
  autoStartClaude: true,
  createdAt: 1
})

const doc = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ formato: FORMAT, formatoVersion: FORMAT_VERSION, 'versión': '1.0.0', exportado: 'hoy', ...extra })

const parse = (extra: Record<string, unknown> = {}): ParsedImport => parseImport(doc(extra))
const cuentaA = { label: 'Trabajo', shareSetup: true }
const espacioA = { nombre: 'api', ruta: 'C:\\repos\\api', cuenta: 'Trabajo' }

test('parseImport rechaza JSON roto, otros formatos y valores que no son objeto', () => {
  assert.throws(() => parseImport('{no'), /no es un JSON válido/)
  assert.throws(() => parseImport(''), /no es un JSON válido/)
  assert.throws(() => parseImport('[]'), /No es una configuración exportada/)
  assert.throws(() => parseImport('null'), /No es una configuración exportada/)
  assert.throws(() => parseImport(JSON.stringify({ formato: 'otra-cosa' })), /No es una configuración exportada/)
})

test('parseImport tolera el BOM del principio', () => {
  assert.equal(parseImport('\uFEFF' + doc()).formatoVersion, FORMAT_VERSION)
})

test('parseImport rechaza un archivo de una versión más nueva y acepta la actual', () => {
  assert.throws(() => parse({ formatoVersion: FORMAT_VERSION + 1 }), /versión más nueva/)
  assert.equal(parse().formatoVersion, FORMAT_VERSION)
})

test('parseImport sin formatoVersion se lee como formato 1', () => {
  const p = parseImport(JSON.stringify({ formato: FORMAT, cuentas: [cuentaA], espacios: [{ name: 'api', repoPath: 'C:\\r\\api', cuenta: 'Trabajo' }] }))
  assert.equal(p.formatoVersion, 1)
  assert.equal(p.version, '?')
  assert.equal(p.espacios[0].ruta, 'C:\\r\\api')
})

test('parseImport formato 1 con rama y sin carpeta marca el espacio como sin carpeta', () => {
  const p = parseImport(
    JSON.stringify({
      formato: FORMAT,
      cuentas: [cuentaA],
      espacios: [
        { name: 'wt', cuenta: 'Trabajo', branch: 'feat/x' },
        { name: 'wt2', cuenta: 'Trabajo', branch: 'feat/y', carpeta: 'C:\\wt\\y' }
      ]
    })
  )
  assert.equal(p.espacios[0].sinCarpeta, true)
  assert.equal(p.espacios[0].ruta, '')
  assert.equal(p.espacios[1].ruta, 'C:\\wt\\y')
})

test('parseImport formato 1 descarta un primer mensaje que empieza con «!» pero importa el espacio', () => {
  const p = parseImport(
    JSON.stringify({
      formato: FORMAT,
      cuentas: [cuentaA],
      espacios: [{ name: 'a', repoPath: 'C:\\a', cuenta: 'Trabajo', initialPrompt: '  !rm -rf /' }, { name: 'b', repoPath: 'C:\\b', cuenta: 'Trabajo', initialPrompt: '/ticket X-1' }]
    })
  )
  assert.equal(p.espacios[0].initialPrompt, undefined)
  assert.match(p.espacios[0].aviso ?? '', /«!»/)
  assert.equal(p.espacios[1].initialPrompt, '/ticket X-1')
})

test('parseImport valida que cuentas, espacios y plantillas sean listas y no pasen los topes', () => {
  assert.throws(() => parse({ cuentas: {} }), /tienen que ser listas/)
  assert.throws(() => parse({ espacios: 'x' }), /tienen que ser listas/)
  assert.throws(() => parse({ plantillas: {} }), /tiene que ser una lista/)
  assert.throws(() => parse({ cuentas: Array.from({ length: 101 }, (_, i) => ({ label: `c${i}` })) }), /Demasiadas cuentas/)
  assert.throws(() => parse({ espacios: Array.from({ length: 501 }, () => espacioA) }), /Demasiados espacios/)
  assert.throws(() => parse({ plantillas: Array.from({ length: 201 }, () => ({ name: 'a', repoPath: 'C:\\a' })) }), /Demasiadas plantillas/)
  assert.throws(() => parse({ permisos: Array.from({ length: 501 }, () => ({ espacio: 'a', ruta: 'b', reglas: [] })) }), /Demasiados espacios con reglas/)
})

test('parseImport en cuentas: elementos inválidos, label faltante o larga, y duplicadas sin distinguir mayúsculas', () => {
  assert.throws(() => parse({ cuentas: ['x'] }), /Cuenta 1: formato inválido/)
  assert.throws(() => parse({ cuentas: [{}] }), /Cuenta 1: falta «label»/)
  assert.throws(() => parse({ cuentas: [{ label: '   ' }] }), /falta «label»/)
  assert.throws(() => parse({ cuentas: [{ label: 5 }] }), /tiene que ser texto/)
  assert.throws(() => parse({ cuentas: [{ label: 'x'.repeat(81) }] }), /demasiado largo/)
  const p = parse({ cuentas: [{ label: 'Trabajo' }, { label: ' trabajo ' }, { label: 'Casa', shareSetup: false }] })
  assert.deepEqual(p.cuentas, [
    { label: 'Trabajo', shareSetup: true },
    { label: 'Casa', shareSetup: false }
  ])
})

test('cuentaExportada no escribe proveedor para claude y parseImport ignora los desconocidos', () => {
  assert.deepEqual(cuentaExportada(acc('a1', 'Trabajo')), { label: 'Trabajo', shareSetup: true })
  assert.deepEqual(cuentaExportada({ ...acc('a1', 'Trabajo'), proveedor: 'claude' }, 'Max'), { label: 'Trabajo', shareSetup: true, plan: 'Max' })
  assert.deepEqual(cuentaExportada({ ...acc('a1', 'Trabajo'), proveedor: 'xx' as never }), { label: 'Trabajo', shareSetup: true })
  const p = parse({ cuentas: [{ label: 'a', proveedor: 'xx' }, { label: 'b', proveedor: 5 }, { label: 'c', proveedor: 'claude' }] })
  assert.deepEqual(p.cuentas, [
    { label: 'a', shareSetup: true },
    { label: 'b', shareSetup: true },
    { label: 'c', shareSetup: true }
  ])
})

test('parseImport conserva el plan de la cuenta solo si es corto y sin controles', () => {
  const p = parse({
    cuentas: [
      { label: 'a', plan: 'Max' },
      { label: 'b', plan: 'x'.repeat(21) },
      { label: 'c', plan: 'Pro\n' + 'x' },
      { label: 'd', plan: 42 },
      { label: 'e', plan: '   ' }
    ]
  })
  assert.deepEqual(p.cuentas.map((c) => c.plan), ['Max', undefined, undefined, undefined, undefined])
})

test('parseImport en espacios: campos faltantes, tipos y largos', () => {
  assert.throws(() => parse({ espacios: [5] }), /Espacio 1: formato inválido/)
  assert.throws(() => parse({ espacios: [{ ruta: 'C:\\a', cuenta: 'x' }] }), /Espacio 1: falta «name»/)
  assert.throws(() => parse({ espacios: [{ nombre: 'a', cuenta: 'x' }] }), /falta «ruta»/)
  assert.throws(() => parse({ espacios: [{ nombre: 'a', ruta: 'C:\\a' }] }), /falta «cuenta»/)
  assert.throws(() => parse({ espacios: [{ nombre: 'x'.repeat(121), ruta: 'C:\\a', cuenta: 'x' }] }), /demasiado largo/)
  assert.throws(() => parse({ espacios: [{ nombre: 'a', ruta: 'x'.repeat(1025), cuenta: 'x' }] }), /demasiado largo/)
  assert.throws(() => parse({ espacios: [{ nombre: 'a', ruta: ['C:\\a'], cuenta: 'x' }] }), /tiene que ser texto/)
})

test('parseImport en espacios formato 2 ignora ticket y primer mensaje, y valida colores', () => {
  const p = parse({
    cuentas: [cuentaA],
    espacios: [
      { ...espacioA, initialPrompt: 'hola', ticket: 'X-1', color: '#3b82f6', colorEspacio: 'lila' },
      { ...espacioA, nombre: 'b', color: '#123456', colorEspacio: 'rojo' },
      { ...espacioA, nombre: 'c', color: 5, colorEspacio: 5 }
    ]
  })
  assert.equal(p.espacios[0].initialPrompt, undefined)
  assert.equal(p.espacios[0].ticket, undefined)
  assert.equal(p.espacios[0].color, '#3b82f6')
  assert.equal(p.espacios[0].colorEspacio, 'lila')
  assert.equal(p.espacios[1].color, undefined)
  assert.equal(p.espacios[1].colorEspacio, undefined)
  assert.equal(p.espacios[2].color, undefined)
})

test('parseImport recorta espacios y conserva rutas con «..» sin tocarlas (solo texto, no se escribe nada)', () => {
  const p = parse({ cuentas: [cuentaA], espacios: [{ nombre: '  api  ', ruta: ' C:\\a\\..\\..\\x ', cuenta: 'Trabajo' }] })
  assert.equal(p.espacios[0].nombre, 'api')
  assert.equal(p.espacios[0].ruta, 'C:\\a\\..\\..\\x')
})

test('parseImport en plantillas: requeridos, worktree y primer mensaje con «!»', () => {
  assert.throws(() => parse({ plantillas: [1] }), /Plantilla 1: formato inválido/)
  assert.throws(() => parse({ plantillas: [{ repoPath: 'C:\\a' }] }), /falta «name»/)
  assert.throws(() => parse({ plantillas: [{ name: 'a' }] }), /falta «repoPath»/)
  assert.throws(() => parse({ plantillas: [{ name: 'a', repoPath: 'C:\\a', useWorktree: 'x' }] }), /«useWorktree» inválido/)
  assert.throws(() => parse({ plantillas: [{ name: 'a', repoPath: 'C:\\a', useWorktree: {} }] }), /falta «branchPattern»/)
  assert.throws(() => parse({ plantillas: [{ name: 'a', repoPath: 'x'.repeat(1001) }] }), /demasiado largo/)
  const p = parse({
    plantillas: [
      { name: 'ok', repoPath: 'C:\\a', cuenta: 'Trabajo', namePattern: '{n}', initialPrompt: '/x', useWorktree: { branchPattern: 'f/{n}' }, autoStartClaude: false, resume: false },
      { name: 'mala', repoPath: 'C:\\b', initialPrompt: '!calc' },
      { name: 'nula', repoPath: 'C:\\c', useWorktree: null }
    ]
  })
  assert.deepEqual(p.plantillas.map((t) => t.name), ['ok', 'nula'])
  assert.equal(p.plantillas[0].useWorktree?.branchPattern, 'f/{n}')
  assert.equal(p.plantillas[0].autoStartClaude, false)
  assert.equal(p.plantillas[1].autoStartClaude, true)
  assert.equal(p.plantillasDescartadas.length, 1)
  assert.equal(p.plantillasDescartadas[0].name, 'mala')
})

test('parseImport en apariencia deja pasar solo valores conocidos', () => {
  const p = parse({ apariencia: { theme: 'noche', density: 'compacta', uiFontSize: 14, accent: 'lila', lightMode: true } })
  assert.deepEqual(p.apariencia, { theme: 'noche', density: 'compacta', uiFontSize: 14, accent: 'lila', lightMode: true })
  const mala = parse({ apariencia: { theme: 'fucsia', density: 'enorme', uiFontSize: 99, accent: 'coral', lightMode: 'sí' } })
  assert.deepEqual(mala.apariencia, {})
  assert.deepEqual(parse({ apariencia: { uiFontSize: 14.5 } }).apariencia, {})
  assert.deepEqual(parse({ apariencia: { uiFontSize: 11 } }).apariencia, {})
  assert.equal(parse({ apariencia: [] }).apariencia, undefined)
  assert.equal(parse().apariencia, undefined)
})

test('parseImport en atajos descarta ids desconocidos y combinaciones inválidas', () => {
  const p = parse({ atajos: { palette: 'ctrl k', hackeo: 'ctrl x', new: 'k', help: 5 } })
  assert.deepEqual(Object.keys(p.atajos ?? {}), ['palette'])
  assert.equal(parse({ atajos: { hackeo: 'ctrl x' } }).atajos, undefined)
  assert.equal(parse({ atajos: 'x' }).atajos, undefined)
})

test('parseImport en equipo acepta solo una URL https de proyecto', () => {
  assert.match(parse({ equipo: { supabaseUrl: 'https://abc.supabase.co' } }).equipo ?? '', /^https:\/\/abc\.supabase\.co/)
  for (const url of ['http://abc.supabase.co', 'https://u:p@abc.supabase.co', 'https://abc.supabase.co/x', 'https://abc.supabase.co/?a=1', 'no', '', 5]) {
    assert.equal(parse({ equipo: { supabaseUrl: url } }).equipo, undefined, String(url))
  }
})

test('parseImport en permisos: estructura inválida falla, reglas inválidas quedan marcadas', () => {
  assert.throws(() => parse({ permisos: [5] }), /Permisos 1: formato inválido/)
  assert.throws(() => parse({ permisos: [{ espacio: 'a', ruta: 'b' }] }), /Permisos 1: formato inválido/)
  assert.throws(() => parse({ permisos: [{ ruta: 'b', reglas: [] }] }), /falta «espacio»/)
  assert.throws(() => parse({ permisos: [{ espacio: 'a', ruta: 'b', reglas: Array.from({ length: 501 }, () => 'Edit') }] }), /demasiadas reglas/)
  const p = parse({
    permisos: [
      {
        espacio: 'api',
        ruta: 'C:\\repos\\api',
        reglas: [
          { kind: 'cmd', tool: 'Bash', match: 'npm test' },
          { kind: 'cmd', tool: 'Bash', match: 'npm *' },
          { kind: 'edit', tool: 'Edit', match: 'src/**' },
          { kind: 'net', tool: 'WebFetch', match: 'Example.com' },
          { kind: 'otro', tool: 'Bash', match: 'x' },
          null,
          7
        ]
      }
    ]
  })
  const r = p.permisos[0].reglas
  assert.deepEqual(r.map((x) => x.valida), [true, false, false, true, false, false, false])
  assert.equal(r[3].draft?.match, 'example.com')
  assert.equal(r[1].draft, undefined)
  assert.ok(r[1].motivo)
})

test('parseImport convierte reglas de texto del formato viejo solo si no amplían el permiso', () => {
  const p = parse({
    permisos: [
      {
        espacio: 'a',
        ruta: 'b',
        reglas: ['Bash(npm test)', 'Bash', 'Bash(*)', 'WebFetch(domain:docs.x.com)', 'WebFetch', 'WebFetch(https://x.com)', 'Edit', 'Edit(src/**)', 'mcp__s__t', 'mcp__s__t(x)', 'Raro', '(((']
      }
    ]
  })
  assert.deepEqual(
    p.permisos[0].reglas.map((x) => x.valida),
    [true, false, false, true, false, false, true, false, true, false, false, false]
  )
})

test('parseImport corta el texto mostrado de una regla enorme', () => {
  const p = parse({ permisos: [{ espacio: 'a', ruta: 'b', reglas: ['x'.repeat(5000)] }] })
  assert.ok(p.permisos[0].reglas[0].texto.length <= 200)
})

test('readEnvelope distingue plano de cifrado y rechaza lo dañado', () => {
  const plano = readEnvelope(doc())
  assert.equal(plano.kind, 'plano')
  assert.throws(() => readEnvelope('x'), /no es un JSON válido/)
  assert.throws(() => readEnvelope(JSON.stringify({ formato: 'otro' })), /No es una configuración exportada/)
  assert.throws(() => readEnvelope(JSON.stringify({ formato: FORMAT, cifrado: {} })), /cifrado está dañado/)
  assert.throws(() => readEnvelope(JSON.stringify({ formato: FORMAT, cifrado: {}, datos: 5 })), /cifrado está dañado/)
})

test('archivo cifrado: ida y vuelta por el sobre y parseImport', () => {
  const interior = doc({ cuentas: [cuentaA], espacios: [espacioA] })
  const enc = encryptText(interior, 'contraseña-larga')
  const env = readEnvelope(JSON.stringify({ formato: FORMAT, formatoVersion: FORMAT_VERSION, 'versión': '9.9.9', exportado: 'hoy', ...enc }))
  assert.equal(env.kind, 'cifrado')
  if (env.kind !== 'cifrado') return
  assert.equal(env.version, '9.9.9')
  const p = parseImport(openEnvelope(env, 'contraseña-larga'))
  assert.equal(p.espacios[0].nombre, 'api')
})

test('archivo cifrado: contraseña vacía o errónea, y datos manipulados, no abren nada', () => {
  const enc = encryptText(doc(), 'contraseña-larga')
  const env = readEnvelope(JSON.stringify({ formato: FORMAT, ...enc }))
  if (env.kind !== 'cifrado') throw new Error('se esperaba un archivo cifrado')
  assert.equal(env.version, '?')
  assert.throws(() => openEnvelope(env, ''), { message: WRONG_PASSWORD })
  assert.throws(() => openEnvelope(env, 'otra-contraseña'), { message: WRONG_PASSWORD })
  const buf = Buffer.from(env.encrypted.datos, 'base64')
  buf[0] ^= 1
  assert.throws(() => openEnvelope({ ...env, encrypted: { ...env.encrypted, datos: buf.toString('base64') } }, 'contraseña-larga'), { message: WRONG_PASSWORD })
})

test('archivo cifrado con un algoritmo desconocido no lo abre esta versión', () => {
  const enc = encryptText(doc(), 'contraseña-larga')
  const env = readEnvelope(JSON.stringify({ formato: FORMAT, cifrado: { ...enc.cifrado, algoritmo: 'rot13' }, datos: enc.datos }))
  if (env.kind !== 'cifrado') throw new Error('se esperaba un archivo cifrado')
  assert.throws(() => openEnvelope(env, 'contraseña-larga'), /no lo reconoce/)
})

const accounts = [acc('a1', 'Trabajo')]

test('buildPlan clasifica cuentas y espacios: ok, ya, conflicto, faltante y saltear', () => {
  const parsed = parse({
    cuentas: [cuentaA, { label: 'Casa' }],
    espacios: [
      { nombre: 'nuevo', ruta: 'C:\\repos\\nuevo', cuenta: 'Casa' },
      { nombre: 'API', ruta: 'c:/repos/api/', cuenta: 'Trabajo' },
      { nombre: 'web', ruta: 'C:\\repos\\otra', cuenta: 'Trabajo' },
      { nombre: 'lejos', ruta: 'D:\\no-existe', cuenta: 'Trabajo' },
      { nombre: 'huérfano', ruta: 'C:\\repos\\h', cuenta: 'Fantasma' }
    ]
  })
  const workspaces = [ws('w1', 'api', 'C:\\repos\\api', 'a1'), ws('w2', 'web', 'C:\\repos\\web', 'a1')]
  const plan = buildPlan(parsed, accounts, workspaces, (p) => p.toLowerCase().startsWith('c:'), null)
  assert.deepEqual(plan.cuentas, [{ label: 'Trabajo', action: 'existe' }, { label: 'Casa', action: 'crear' }])
  assert.deepEqual(plan.espacios.map((e) => e.status), ['ok', 'ya', 'conflicto', 'faltante', 'saltear'])
  assert.equal(plan.espacios[2].existente, 'web')
  assert.match(plan.espacios[4].motivo ?? '', /«Fantasma»/)
})

test('buildPlan salta un worktree sin carpeta y no toca los espacios locales', () => {
  const parsed = parseImport(JSON.stringify({ formato: FORMAT, cuentas: [cuentaA], espacios: [{ name: 'wt', cuenta: 'Trabajo', branch: 'f/x' }] }))
  const locales = [ws('w1', 'local', 'C:\\l', 'a1')]
  const copia = JSON.stringify(locales)
  const plan = buildPlan(parsed, accounts, locales, () => true, null)
  assert.equal(plan.espacios[0].status, 'saltear')
  assert.equal(JSON.stringify(locales), copia)
})

test('buildPlan no pisa plantillas con el mismo nombre y salta las de carpetas inexistentes', () => {
  const parsed = parse({
    plantillas: [
      { name: 'Existe', repoPath: 'C:\\a' },
      { name: 'nueva', repoPath: 'C:\\b' },
      { name: 'NUEVA', repoPath: 'C:\\b2' },
      { name: 'sin-carpeta', repoPath: 'D:\\x' },
      { name: 'mala', repoPath: 'C:\\c', initialPrompt: '!x' }
    ]
  })
  const plan = buildPlan(parsed, accounts, [], (p) => p.startsWith('C:'), { templates: [{ name: 'existe' }] })
  assert.deepEqual(plan.plantillas.nuevas, ['nueva'])
  assert.deepEqual(plan.plantillas.existentes, ['Existe', 'NUEVA'])
  assert.deepEqual(plan.plantillas.salteadas.map((s) => s.name), ['mala', 'sin-carpeta'])
})

test('buildPlan cuenta atajos, apariencia, equipo y reglas válidas', () => {
  const parsed = parse({
    apariencia: { theme: 'claro' },
    atajos: { palette: 'ctrl k', new: 'alt n' },
    equipo: { supabaseUrl: 'https://abc.supabase.co' },
    cuentas: [cuentaA],
    espacios: [espacioA],
    permisos: [
      { espacio: 'api', ruta: 'C:\\repos\\api', reglas: ['Bash(npm test)', 'Bash'] },
      { espacio: 'otro', ruta: 'C:\\x', reglas: [] }
    ]
  })
  const plan = buildPlan(parsed, accounts, [], () => true, null)
  assert.equal(plan.apariencia, true)
  assert.deepEqual(plan.aparienciaValores, { theme: 'claro' })
  assert.equal(plan.atajos, 2)
  assert.ok(plan.equipo)
  assert.equal(plan.reglas, 2)
  assert.equal(plan.reglasValidas, 1)
  assert.equal(plan.permisos[0].espacioIndex, 0)
  assert.equal(plan.permisos[1].espacioIndex, -1)
  assert.deepEqual(plan.permisos[0].reglas.map((r) => r.id), ['0.0', '0.1'])
})

test('buildPlan de un archivo vacío no propone nada', () => {
  const plan = buildPlan(parse(), accounts, [], () => true, null)
  assert.equal(plan.apariencia, false)
  assert.equal(plan.aparienciaValores, null)
  assert.equal(plan.atajos, 0)
  assert.equal(plan.equipo, null)
  assert.deepEqual(plan.espacios, [])
  assert.equal(buildPlan(parse({ apariencia: { theme: 'x' } }), accounts, [], () => true, null).apariencia, false)
})

test('templatesToSave devuelve solo las nuevas, con la cuenta por nombre o «sugerida»', () => {
  const parsed = parse({
    plantillas: [
      { name: 'a', repoPath: 'C:\\a', cuenta: 'Trabajo' },
      { name: 'b', repoPath: 'C:\\b', cuenta: 'Desconocida' },
      { name: 'c', repoPath: 'C:\\c' },
      { name: 'ya', repoPath: 'C:\\d' }
    ]
  })
  const plan = buildPlan(parsed, accounts, [], () => true, [{ name: 'ya' }])
  const out = templatesToSave(parsed, plan, new Map([['trabajo', 'a1']]))
  assert.deepEqual(out.map((t) => [t.name, t.accountId]), [['a', 'a1'], ['b', 'sugerida'], ['c', 'sugerida']])
  assert.ok(out.every((t) => !('id' in t)))
})

test('exportSpaces no lleva ids ni configDir y omite espacios sin cuenta', () => {
  const out = exportSpaces(
    [ws('w1', 'api', 'C:\\r\\api', 'a1'), ws('w2', 'huérfano', 'C:\\r\\h', 'borrada'), { ...ws('w3', 'web', 'C:\\r\\w', 'a1'), color: 'coral' }, { ...ws('w4', 'x', 'C:\\r\\x', 'a1'), color: 'rojo' }],
    accounts,
    (id) => (id === 'a1' ? '#3b82f6' : undefined)
  )
  assert.deepEqual(out.map((e) => e.nombre), ['api', 'web', 'x'])
  assert.equal(out[1].colorEspacio, 'coral')
  assert.equal(out[2].colorEspacio, undefined)
  const json = JSON.stringify(out)
  assert.ok(!json.includes('secreto') && !json.includes('w1') && !json.includes('a1'))
})

test('exportTemplates traduce la cuenta a su nombre y deja afuera lo inválido', () => {
  const out = exportTemplates(
    {
      templates: [
        { id: 't1', name: 'a', repoPath: 'C:\\a', accountId: 'a1', resume: false, namePattern: 'p', useWorktree: { branchPattern: 'f/x' }, initialPrompt: '/x' },
        { name: 'b', repoPath: 'C:\\b', accountId: 'sugerida' },
        { name: 5, repoPath: 'C:\\c' },
        'x'
      ]
    },
    accounts
  )
  assert.equal(out.length, 2)
  assert.equal(out[0].cuenta, 'Trabajo')
  assert.equal(out[0].resume, false)
  assert.equal(out[1].cuenta, undefined)
  assert.ok(!('id' in out[0]))
  assert.deepEqual(exportTemplates('basura', accounts), [])
  assert.deepEqual(exportTemplates(null, accounts), [])
})

test('exportRules incluye solo reglas válidas y activas de cada espacio', () => {
  const w = [ws('w1', 'api', 'C:\\r\\api', 'a1'), ws('w2', 'vacío', 'C:\\r\\v', 'a1')]
  const out = exportRules(
    [
      { workspaceId: 'w1', kind: 'cmd', tool: 'Bash', match: 'npm test' },
      { workspaceId: 'w1', kind: 'cmd', tool: 'Bash', match: 'npm test', on: false },
      { workspaceId: 'w1', kind: 'cmd', tool: 'Bash', match: 'rm *' },
      { workspaceId: 'otro', kind: 'edit', tool: 'Edit', match: '*' },
      null,
      'x'
    ],
    w
  )
  assert.deepEqual(out, [{ espacio: 'api', ruta: 'C:\\r\\api', reglas: [{ kind: 'cmd', tool: 'Bash', match: 'npm test' }] }])
})

test('lo exportado se vuelve a leer igual (ida y vuelta de espacios y plantillas)', () => {
  const espacios = exportSpaces([ws('w1', 'api', 'C:\\r\\api', 'a1')], accounts, () => '#3b82f6')
  const plantillas = exportTemplates([{ name: 't', repoPath: 'C:\\t', accountId: 'a1' }], accounts)
  const p = parse({ cuentas: [cuentaA], espacios, plantillas })
  assert.equal(p.espacios[0].nombre, 'api')
  assert.equal(p.espacios[0].color, '#3b82f6')
  assert.equal(p.plantillas[0].cuenta, 'Trabajo')
})

test('sectionSizes mide cada grupo y fmtKb lo muestra', () => {
  const d: ExportDoc = { formato: FORMAT, formatoVersion: FORMAT_VERSION, 'versión': '1', exportado: 'x', atajos: { palette: 'Ctrl K' } }
  const s = sectionSizes(d)
  assert.equal(s.plantillas, 0)
  assert.ok(s.atajos > 0)
  assert.equal(fmtKb(0), '0 KB')
  assert.equal(fmtKb(0.3), '< 1 KB')
  assert.equal(fmtKb(10.4), '≈ 10 KB')
})

test('el nombre del perfil en el archivo no cambia lo que se importa', () => {
  const extra = { cuentas: [cuentaA], espacios: [espacioA], atajos: { palette: 'Ctrl K' } }
  const con = parse({ ...extra, perfil: 'Trabajo' })
  const sin = parse(extra)
  assert.deepEqual(con, sin)
  assert.deepEqual(parse({ ...extra, perfil: { x: 1 } }), sin)
})

test('lo exportado lleva solo el nombre del perfil: ni ids, ni usuario de GitHub ni rutas del perfil', () => {
  const d: ExportDoc = { formato: FORMAT, formatoVersion: FORMAT_VERSION, 'versión': '1', exportado: 'x', perfil: 'Trabajo', espacios: exportSpaces([ws('w1', 'api', 'C:\repos\api', 'a1')], [acc('a1', 'Trabajo')], () => undefined) }
  const json = JSON.stringify(d)
  assert.match(json, /"perfil":"Trabajo"/)
  for (const prohibido of ['ghLogin', 'p-', 'perfiles', 'principal', 'secreto']) assert.equal(json.includes(prohibido), false, prohibido)
  const fuente = readFileSync(join(import.meta.dirname, 'export-import.ts'), 'utf8')
  assert.equal(/ghLogin/.test(fuente), false)
  assert.equal(fuente.match(/perfilActivo\(\)\.\w+/g)?.join(), 'perfilActivo().nombre')
})
