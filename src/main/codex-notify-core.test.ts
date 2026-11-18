import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOTIFY_MARCA, aplicarNotify, lineaNotify, quitarNotify } from './codex-notify-core'

const LINEA = 'notify = ["node", "C:\\\\Users\\\\a b\\\\sloth-notify.cjs"] # sloth-notify'

test('lineaNotify escapa barras y comillas y lleva la marca', () => {
  assert.equal(lineaNotify('node', 'C:\\Users\\a b\\x.js'), 'notify = ["node", "C:\\\\Users\\\\a b\\\\x.js"] # sloth-notify')
  assert.equal(lineaNotify('node', 'C:/d"x/y.js'), 'notify = ["node", "C:/d\\"x/y.js"] # sloth-notify')
  assert.ok(lineaNotify('node', 'x')?.endsWith(NOTIFY_MARCA))
})

test('lineaNotify no escribe rutas con saltos de línea o caracteres de control', () => {
  assert.equal(lineaNotify('node', 'C:/a\nnotify = ["x"]'), undefined)
  assert.equal(lineaNotify('node', 'C:/a\r/x.js'), undefined)
  assert.equal(lineaNotify('no\u0000de', 'x'), undefined)
  assert.equal(lineaNotify('', 'x'), undefined)
  assert.equal(lineaNotify('node', ''), undefined)
})

test('archivo vacío: se agrega la línea con salto', () => {
  assert.deepEqual(aplicarNotify('', LINEA), { toml: `${LINEA}\n`, cambio: 'agregada' })
})

test('con solo el almacén de credenciales: la línea va antes y el resto queda igual', () => {
  const base = 'cli_auth_credentials_store = "file"\n'
  assert.deepEqual(aplicarNotify(base, LINEA), { toml: `${LINEA}\n${base}`, cambio: 'agregada' })
})

test('con una tabla: la línea va antes de la primera tabla, nunca dentro', () => {
  const base = 'model = "x"\n\n[mcp_servers.x]\ncommand = "y"\n'
  const r = aplicarNotify(base, LINEA)
  assert.equal(r.cambio, 'agregada')
  assert.equal(r.toml, `${LINEA}\n${base}`)
  assert.ok(r.toml.indexOf('notify') < r.toml.indexOf('[mcp_servers.x]'))
})

test('un notify ajeno no se toca', () => {
  const base = 'notify = ["python", "avisar.py"]\n[tui]\nx = 1\n'
  assert.deepEqual(aplicarNotify(base, LINEA), { toml: base, cambio: 'ajeno' })
  const comillas = '"notify" = ["a"]\n'
  assert.equal(aplicarNotify(comillas, LINEA).cambio, 'ajeno')
  const multilinea = 'notify = [\n  "a",\n  "b",\n]\n'
  assert.deepEqual(aplicarNotify(multilinea, LINEA), { toml: multilinea, cambio: 'ajeno' })
})

test('una marca vieja con otra ruta se reemplaza; igual no cambia nada', () => {
  const vieja = 'notify = ["node", "C:/viejo.cjs"] # sloth-notify\nmodel = "x"\n'
  assert.deepEqual(aplicarNotify(vieja, LINEA), { toml: `${LINEA}\nmodel = "x"\n`, cambio: 'actualizada' })
  const igual = `${LINEA}\nmodel = "x"\n`
  assert.deepEqual(aplicarNotify(igual, LINEA), { toml: igual, cambio: 'igual' })
})

test('CRLF: la línea nueva usa CRLF y el resto queda byte a byte', () => {
  const base = 'a = 1\r\n[t]\r\nb = 2\r\n'
  const r = aplicarNotify(base, LINEA)
  assert.equal(r.toml, `${LINEA}\r\n${base}`)
  const vieja = 'notify = ["node", "x"] # sloth-notify\r\nb = 2\r\n'
  assert.equal(aplicarNotify(vieja, LINEA).toml, `${LINEA}\r\nb = 2\r\n`)
})

test('BOM: se conserva al principio del archivo', () => {
  const base = '\uFEFFa = 1\n'
  assert.equal(aplicarNotify(base, LINEA).toml, `\uFEFF${LINEA}\na = 1\n`)
  const conMarca = `\uFEFFnotify = ["node", "x"] ${NOTIFY_MARCA}\na = 1\n`
  assert.equal(aplicarNotify(conMarca, LINEA).toml, `\uFEFF${LINEA}\na = 1\n`)
  assert.equal(aplicarNotify('\uFEFFnotify = ["a"]\n', LINEA).cambio, 'ajeno')
})

test('un comentario que dice notify no cuenta', () => {
  const base = '# notify = ["x"]\na = 1\n'
  assert.deepEqual(aplicarNotify(base, LINEA), { toml: `${LINEA}\n${base}`, cambio: 'agregada' })
})

test('notify dentro de una tabla o de una cadena multilínea no cuenta', () => {
  const enTabla = '[tui]\nnotify = ["x"]\n'
  assert.deepEqual(aplicarNotify(enTabla, LINEA), { toml: `${LINEA}\n${enTabla}`, cambio: 'agregada' })
  const enCadena = 'instrucciones = """\nnotify = ["x"]\n[otra]\n"""\nb = 1\n'
  assert.deepEqual(aplicarNotify(enCadena, LINEA), { toml: `${LINEA}\n${enCadena}`, cambio: 'agregada' })
  const enLiteral = "x = '''\nnotify = [\"x\"]\n'''\n"
  assert.equal(aplicarNotify(enLiteral, LINEA).cambio, 'agregada')
})

test('un array de otra clave que sigue en la línea de abajo no se toma por una tabla', () => {
  const base = 'lista = [\n  ["a"],\n  ["b"]\n]\nnotify = ["x"]\n'
  assert.equal(aplicarNotify(base, LINEA).cambio, 'ajeno')
})

test('ruta de Windows con espacios y barras', () => {
  const l = lineaNotify('node', 'C:\\Users\\a b\\x.js') as string
  const r = aplicarNotify('', l)
  assert.equal(r.toml, `${l}\n`)
  assert.ok(r.toml.includes('C:\\\\Users\\\\a b\\\\x.js'))
})

test('quitarNotify saca solo la línea de Sloth y deja el resto como estaba', () => {
  const base = 'cli_auth_credentials_store = "file"\n\n[tui]\nx = 1\n'
  const puesto = aplicarNotify(base, LINEA).toml
  assert.deepEqual(quitarNotify(puesto), { toml: base, quitada: true })
  const crlf = 'a = 1\r\n[t]\r\n'
  assert.equal(quitarNotify(aplicarNotify(crlf, LINEA).toml).toml, crlf)
  const bom = '\uFEFFa = 1\n'
  assert.equal(quitarNotify(aplicarNotify(bom, LINEA).toml).toml, bom)
  assert.equal(quitarNotify(aplicarNotify('', LINEA).toml).toml, '')
})

test('quitarNotify no toca un notify ajeno ni un archivo sin notify', () => {
  const ajeno = 'notify = ["python", "x.py"]\n'
  assert.deepEqual(quitarNotify(ajeno), { toml: ajeno, quitada: false })
  assert.deepEqual(quitarNotify('a = 1\n'), { toml: 'a = 1\n', quitada: false })
  assert.deepEqual(quitarNotify(''), { toml: '', quitada: false })
})
