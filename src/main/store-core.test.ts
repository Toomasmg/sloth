import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { corregirRutasViejas, decidirCarga, estadoVacio, validarCuenta, validarEspacio, validarEstado, type EstadoValidado } from './store-core'

const cuenta = { id: 'a1', label: 'A', configDir: 'C:\\datos\\accounts\\a1', createdAt: 1 }
const espacio = { id: 'w1', name: 'Uno', repoPath: 'C:\\repo', cwd: 'C:\\repo', accountId: 'a1', autoStartClaude: true, createdAt: 2 }

test('QA #1: una cuenta nula se descarta y el resto se carga', () => {
  const v = validarEstado({ version: 1, accounts: [null, cuenta], workspaces: [], openPanes: [] })
  assert.ok(v)
  assert.deepEqual(v.estado.accounts, [cuenta])
  assert.equal(v.cuentasDescartadas, 1)
  assert.equal(v.versionFutura, false)
})

test('QA #1: una cuenta sin configDir se descarta (antes tiraba en fixLegacyPaths)', () => {
  const v = validarEstado({ version: 1, accounts: [{ id: 'a1', label: 'A' }], workspaces: [], openPanes: [] })
  assert.ok(v)
  assert.deepEqual(v.estado.accounts, [])
  assert.equal(v.cuentasDescartadas, 1)
  assert.doesNotThrow(() => corregirRutasViejas(v.estado.accounts, 'C:\\AppData\\AntiRea', 'C:\\AppData\\Sloth'))
})

test('QA #2: espacios nulos o sin repoPath se descartan y quedan los buenos', () => {
  const v = validarEstado({ version: 1, accounts: [cuenta], workspaces: [null, { id: 'x' }, espacio], openPanes: ['w1', 'x', 3] })
  assert.ok(v)
  assert.deepEqual(v.estado.workspaces, [espacio])
  assert.equal(v.espaciosDescartados, 2)
  assert.deepEqual(v.estado.openPanes, ['w1', 'x'])
})

test('campos obligatorios de tipo raro descartan la entrada', () => {
  assert.equal(validarCuenta({ ...cuenta, id: 5 }), undefined)
  assert.equal(validarCuenta({ ...cuenta, configDir: '' }), undefined)
  assert.equal(validarCuenta('a1'), undefined)
  assert.equal(validarEspacio({ ...espacio, repoPath: ['C:\\repo'] }), undefined)
  assert.equal(validarEspacio({ ...espacio, accountId: null }), undefined)
  assert.equal(validarEspacio([espacio]), undefined)
})

test('campos opcionales de tipo raro se sacan y los que faltan toman su valor por defecto', () => {
  assert.deepEqual(validarCuenta({ id: 'a1', configDir: 'C:\\x', shareSetup: 'sí', createdAt: 'ayer' }), {
    id: 'a1',
    label: 'a1',
    configDir: 'C:\\x',
    createdAt: 0
  })
  const w = validarEspacio({ id: 'w1', repoPath: 'C:\\repo', accountId: 'a1', icon: 7, resume: 'true', branch: 'main', autoStartClaude: 'no' })
  assert.deepEqual(w, { id: 'w1', name: 'w1', repoPath: 'C:\\repo', cwd: 'C:\\repo', accountId: 'a1', autoStartClaude: true, createdAt: 0, branch: 'main' })
})

test('proveedor: ausente no se agrega, de tipo raro se saca y un texto desconocido se conserva', () => {
  assert.deepEqual(validarCuenta(cuenta), cuenta)
  assert.equal('proveedor' in (validarCuenta(cuenta) ?? {}), false)
  assert.equal('proveedor' in (validarCuenta({ ...cuenta, proveedor: 5 }) ?? {}), false)
  assert.equal(validarCuenta({ ...cuenta, proveedor: 'codex' })?.proveedor, 'codex')
})

test('se conservan los campos que esta versión no conoce', () => {
  const v = validarEstado({ version: 1, accounts: [{ ...cuenta, futuro: { x: 1 } }], workspaces: [], openPanes: [] })
  assert.deepEqual(v?.estado.accounts[0], { ...cuenta, futuro: { x: 1 } })
})

test('ids repetidos: queda el primero', () => {
  const v = validarEstado({ accounts: [cuenta, { ...cuenta, label: 'B' }], workspaces: [espacio, espacio] })
  assert.equal(v?.estado.accounts.length, 1)
  assert.equal(v?.estado.accounts[0].label, 'A')
  assert.equal(v?.cuentasDescartadas, 1)
  assert.equal(v?.espaciosDescartados, 1)
  assert.equal(v?.cuentasRepetidas, 1)
  assert.equal(v?.espaciosRepetidos, 1)
})

test('version futura se marca; la conocida o ausente no', () => {
  assert.equal(validarEstado({ version: 2, accounts: [cuenta] })?.versionFutura, true)
  assert.equal(validarEstado({ version: 1 })?.versionFutura, false)
  assert.equal(validarEstado({})?.versionFutura, false)
})

test('listas ausentes o que no son listas quedan vacías sin contar descartes; la raíz que no es objeto no sirve', () => {
  const v = validarEstado({ accounts: 'x', workspaces: {} })
  assert.deepEqual(v, {
    estado: { version: 1, accounts: [], workspaces: [], openPanes: [] },
    cuentasDescartadas: 0,
    espaciosDescartados: 0,
    cuentasRepetidas: 0,
    espaciosRepetidos: 0,
    versionFutura: false,
    migrado: true
  })
  assert.equal(validarEstado(null), undefined)
  assert.equal(validarEstado([]), undefined)
})

test('corregirRutasViejas mueve solo las cuentas que vivían en AntiRea', () => {
  const accs = [
    { ...cuenta, configDir: 'C:\\AppData\\antirea\\accounts\\a1' },
    { ...cuenta, id: 'a2', configDir: 'C:\\AppData\\Sloth\\accounts\\a2' }
  ]
  assert.equal(corregirRutasViejas(accs, 'C:\\AppData\\AntiRea', 'C:\\AppData\\Sloth'), true)
  assert.deepEqual(
    accs.map((a) => a.configDir),
    ['C:\\AppData\\Sloth\\accounts\\a1', 'C:\\AppData\\Sloth\\accounts\\a2']
  )
  assert.equal(corregirRutasViejas(accs, 'C:\\AppData\\AntiRea', 'C:\\AppData\\Sloth'), false)
})

const leido = (raw: unknown): EstadoValidado => {
  const v = validarEstado(raw)
  assert.ok(v)
  return v
}

test('M5: archivo sano: no respalda, no guarda y el store es confiable', () => {
  const d = decidirCarga({ v: leido({ version: 1, accounts: [cuenta], workspaces: [espacio] }) }, false)
  assert.deepEqual(d, { soloLectura: false, respaldar: false, guardar: false, confiable: true })
})

test('M5 / I2: no se pudo leer: solo lectura, sin guardar ni respaldar, y no es confiable para podar', () => {
  const d = decidirCarga({ v: estadoVacio(), soloLectura: true, motivo: 'no se pudo leer (EBUSY)' }, false)
  assert.equal(d.soloLectura, true)
  assert.equal(d.respaldar, false)
  assert.equal(d.guardar, false)
  assert.equal(d.confiable, false)
  assert.match(d.aviso?.(undefined) ?? '', /^sloth-state\.json no se pudo leer \(EBUSY\)\. Arranqué sin cuentas.*no voy a guardar/)
})

test('M5 / I2: archivo roto y apartado: arranca vacío y no es confiable (otras funciones no podan)', () => {
  const d = decidirCarga({ v: estadoVacio(), apartado: 'sloth-state.json.corrupt-1' }, false)
  assert.equal(d.soloLectura, false)
  assert.equal(d.guardar, false)
  assert.equal(d.confiable, false)
  assert.match(d.aviso?.(undefined) ?? '', /corrupt-1/)
})

test('M5: con descartes respalda y guarda, pero no es confiable; el aviso separa dañadas de repetidas (N2)', () => {
  const d = decidirCarga({ v: leido({ accounts: [cuenta, cuenta, null], workspaces: [{ id: 'x' }] }) }, false)
  assert.equal(d.respaldar, true)
  assert.equal(d.guardar, true)
  assert.equal(d.confiable, false)
  const texto = d.aviso?.('sloth-state.json.bak-9') ?? ''
  assert.match(texto, /1 cuenta dañada, 1 cuenta repetida, 1 espacio dañado/)
  assert.match(texto, /sloth-state\.json\.bak-9/)
  assert.match(d.aviso?.(undefined) ?? '', /no pude respaldarlo.*hasta que se pueda/)
})

test('M5: solo rutas corregidas: respalda y guarda en silencio y sigue siendo confiable', () => {
  const d = decidirCarga({ v: leido({ accounts: [cuenta] }) }, true)
  assert.equal(d.respaldar, true)
  assert.equal(d.guardar, true)
  assert.equal(d.confiable, true)
  assert.equal(d.aviso, undefined)
})

test('M5 / M2: versión futura: respalda, queda en solo lectura, no guarda y no es confiable', () => {
  const d = decidirCarga({ v: leido({ version: 2, accounts: [cuenta] }) }, false)
  assert.equal(d.soloLectura, true)
  assert.equal(d.respaldar, true)
  assert.equal(d.guardar, false)
  assert.equal(d.confiable, false)
  assert.match(d.aviso?.('bak') ?? '', /versión más nueva.*guardé el original como bak.*solo lectura.*no voy a guardar/)
})

test('versión futura con rutas viejas o descartes: sigue sin guardar', () => {
  const d = decidirCarga({ v: leido({ version: 9, accounts: [cuenta, null] }) }, true)
  assert.equal(d.soloLectura, true)
  assert.equal(d.guardar, false)
})

test('sin version: se migra, así que respalda y guarda en silencio y el store sigue confiable', () => {
  const d = decidirCarga({ v: leido({ accounts: [cuenta], workspaces: [espacio] }) }, false)
  assert.equal(d.soloLectura, false)
  assert.equal(d.respaldar, true)
  assert.equal(d.guardar, true)
  assert.equal(d.confiable, true)
  assert.equal(d.aviso, undefined)
})

const fixtureV1 = readFileSync(new URL('./fixtures/sloth-state-v1.json', import.meta.url), 'utf8')

test('fixture v1 con version explícita: sin descartes, sin migrar y listas idénticas al archivo', () => {
  const crudo = JSON.parse(fixtureV1)
  const v = leido(crudo)
  assert.equal(v.estado.version, 1)
  assert.equal(v.migrado, false)
  assert.equal(v.versionFutura, false)
  assert.equal(v.cuentasDescartadas + v.espaciosDescartados, 0)
  assert.deepEqual(v.estado, crudo)
  assert.deepEqual(decidirCarga({ v }, false), { soloLectura: false, respaldar: false, guardar: false, confiable: true })
})

test('fixture v1 sin version (formato anterior): se lee sin pérdida y queda migrado con version 1', () => {
  const crudo = JSON.parse(fixtureV1)
  delete crudo.version
  const v = leido(crudo)
  assert.equal(v.estado.version, 1)
  assert.equal(v.migrado, true)
  assert.equal(v.cuentasDescartadas + v.espaciosDescartados, 0)
  assert.deepEqual(v.estado, { ...JSON.parse(fixtureV1) })
  assert.equal(JSON.stringify(Object.keys(v.estado).sort()), JSON.stringify(['accounts', 'openPanes', 'version', 'workspaces']))
  assert.deepEqual(decidirCarga({ v }, false), { soloLectura: false, respaldar: true, guardar: true, confiable: true, aviso: undefined })
})

test('versión futura: el estado leído conserva los campos nuevos y no se toca la entrada', () => {
  const crudo = { version: 2, accounts: [{ ...cuenta, nuevo: { n: 1 } }], workspaces: [], openPanes: [], sync: { id: 'x' } }
  const copia = structuredClone(crudo)
  const v = leido(crudo)
  assert.equal(v.versionFutura, true)
  assert.deepEqual(v.estado.accounts[0], { ...cuenta, nuevo: { n: 1 } })
  assert.deepEqual(crudo, copia)
})

test('campos desconocidos en la raíz se conservan al migrar', () => {
  const v = leido({ accounts: [cuenta], preferencia: { a: [1, 2] } })
  assert.deepEqual((v.estado as unknown as Record<string, unknown>).preferencia, { a: [1, 2] })
})

test('version que no se entiende deja el archivo inválido (se aparta): texto, fraccionaria, cero, negativa, null', () => {
  for (const version of ['x', '1', 1.5, 0, -1, null, true]) {
    assert.equal(validarEstado({ version, accounts: [cuenta] }), undefined, JSON.stringify(version))
  }
})

test('JSON corrupto o de otra forma: la raíz que no es objeto no sirve', () => {
  for (const x of [undefined, null, 'no es json', 42, [], [cuenta]]) assert.equal(validarEstado(x), undefined)
})
