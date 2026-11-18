import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MOTIVO_AJENO, MOTIVO_SIN_NODE, avisoUnaVez, depsNotifyReales, desinstalarNotify, prepararNotify, type DepsNotify } from './codex-notify'

const DIR = 'C:/cuentas/a'
const FILE = join(DIR, 'config.toml')
const SCRIPT = 'C:\\Users\\a b\\sloth-notify.cjs'

function falso(inicial?: string, opciones: { falloEscribir?: Error; falloLeer?: Error } = {}): { deps: DepsNotify; llamadas: string[]; archivo: () => string | undefined } {
  let texto = inicial
  const llamadas: string[] = []
  const deps: DepsNotify = {
    leer() {
      if (opciones.falloLeer) throw opciones.falloLeer
      return texto
    },
    respaldar(f) {
      llamadas.push(`respaldar ${f}`)
    },
    escribir(f, t) {
      if (opciones.falloEscribir) throw opciones.falloEscribir
      llamadas.push(`escribir ${f}`)
      texto = t
    }
  }
  return { deps, llamadas, archivo: () => texto }
}

test('agrega la línea, respalda antes de escribir y deja el resto como estaba', () => {
  const f = falso('cli_auth_credentials_store = "file"\n')
  assert.equal(prepararNotify(DIR, 'node', SCRIPT, f.deps), undefined)
  assert.deepEqual(f.llamadas, [`respaldar ${FILE}`, `escribir ${FILE}`])
  assert.ok(f.archivo()?.startsWith('notify = ["node", "C:\\\\Users\\\\a b\\\\sloth-notify.cjs"] # sloth-notify\n'))
  assert.ok(f.archivo()?.endsWith('cli_auth_credentials_store = "file"\n'))
})

test('una segunda vez no escribe ni respalda', () => {
  const f = falso('')
  prepararNotify(DIR, 'node', SCRIPT, f.deps)
  f.llamadas.length = 0
  assert.equal(prepararNotify(DIR, 'node', SCRIPT, f.deps), undefined)
  assert.deepEqual(f.llamadas, [])
})

test('un notify ajeno no se pisa: ni escribe ni respalda, y da el motivo', () => {
  const inicial = 'notify = ["python", "mio.py"]\n'
  const f = falso(inicial)
  assert.equal(prepararNotify(DIR, 'node', SCRIPT, f.deps), MOTIVO_AJENO)
  assert.deepEqual(f.llamadas, [])
  assert.equal(f.archivo(), inicial)
})

test('sin node o con una ruta que no se puede escribir no toca nada', () => {
  const f = falso('a = 1\n')
  assert.equal(prepararNotify(DIR, undefined, SCRIPT, f.deps), MOTIVO_SIN_NODE)
  assert.match(prepararNotify(DIR, 'node', 'C:/a\nb', f.deps) ?? '', /caracteres/)
  assert.deepEqual(f.llamadas, [])
})

test('config.toml de solo lectura: devuelve el motivo sin tirar y sin datos de la cuenta', () => {
  const err = Object.assign(new Error(`EPERM: operation not permitted, open '${FILE}'`), { code: 'EPERM' })
  const f = falso('a = 1\n', { falloEscribir: err })
  const motivo = prepararNotify(DIR, 'node', SCRIPT, f.deps)
  assert.match(motivo ?? '', /EPERM/)
  assert.equal((motivo ?? '').includes('cuentas'), false)
  assert.equal(f.archivo(), 'a = 1\n')
  const g = falso('a = 1\n', { falloLeer: err })
  assert.match(prepararNotify(DIR, 'node', SCRIPT, g.deps) ?? '', /leer/)
})

test('si falta el config.toml se crea solo con la línea, sin respaldo que hacer', () => {
  const f = falso(undefined)
  assert.equal(prepararNotify(DIR, 'node', SCRIPT, f.deps), undefined)
  assert.equal(f.archivo()?.split('\n').length, 2)
})

test('desinstalar saca solo la línea de Sloth y respalda antes', () => {
  const base = 'cli_auth_credentials_store = "file"\n[tui]\nx = 1\n'
  const f = falso(base)
  prepararNotify(DIR, 'node', SCRIPT, f.deps)
  f.llamadas.length = 0
  assert.equal(desinstalarNotify(DIR, f.deps), undefined)
  assert.deepEqual(f.llamadas, [`respaldar ${FILE}`, `escribir ${FILE}`])
  assert.equal(f.archivo(), base)
})

test('desinstalar sin línea de Sloth no toca el archivo ni respalda; con uno ajeno tampoco', () => {
  for (const inicial of [undefined, 'a = 1\n', 'notify = ["x"]\n']) {
    const f = falso(inicial)
    assert.equal(desinstalarNotify(DIR, f.deps), undefined)
    assert.deepEqual(f.llamadas, [])
    assert.equal(f.archivo(), inicial)
  }
})

test('avisoUnaVez dice cada motivo una sola vez', () => {
  const dichos: string[] = []
  const avisar = avisoUnaVez((m) => dichos.push(m))
  avisar('uno')
  avisar('uno')
  avisar('dos')
  assert.deepEqual(dichos, ['uno', 'dos'])
})

test('con archivos de verdad: respaldo una sola vez, sin restos de tmp y el original queda en .sloth-bak', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sloth-notify-fs-'))
  try {
    const file = join(dir, 'config.toml')
    const original = '\uFEFFa = 1\r\n[t]\r\nb = 2\r\n'
    writeFileSync(file, original)
    assert.equal(prepararNotify(dir, 'node', SCRIPT, depsNotifyReales), undefined)
    assert.equal(readFileSync(`${file}.sloth-bak`, 'utf8'), original)
    assert.ok(readFileSync(file, 'utf8').includes('# sloth-notify\r\n'))
    assert.equal(desinstalarNotify(dir, depsNotifyReales), undefined)
    assert.equal(readFileSync(file, 'utf8'), original)
    assert.equal(readFileSync(`${file}.sloth-bak`, 'utf8'), original)
    assert.deepEqual(readdirSync(dir).sort(), ['config.toml', 'config.toml.sloth-bak'])
    assert.equal(existsSync(join(dir, 'auth.json')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
