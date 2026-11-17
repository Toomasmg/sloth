import { test } from 'node:test'
import assert from 'node:assert/strict'
import { corregirRutasViejas, validarCuenta, validarEspacio, validarEstado } from './store-core'

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
    versionFutura: false
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
