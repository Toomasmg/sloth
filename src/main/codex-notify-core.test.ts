import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOTIFY_MARCA, aplicarNotify, lineaNotify, quitarNotify, verificarCambio } from './codex-notify-core'
import { analizar, problemaDeDuplicados } from './toml-escaner'

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

const cuantosNotifyDeRaiz = (toml: string): number => {
  const a = analizar(toml)
  assert.equal(a.ok, true)
  return a.ok ? a.sentencias.filter((x) => x.tipo === 'clave' && x.tabla.length === 0 && x.ruta[0] === 'notify').length : -1
}

test('una cadena """ con \\""" adentro no esconde el notify del usuario', () => {
  const base = 'a = """x \\""" y"""\nnotify = ["py", "n.py"]\n'
  assert.deepEqual(aplicarNotify(base, LINEA), { toml: base, cambio: 'ajeno' })
  const seguidas = 'a = """x \\\\"""\nnotify = ["py"]\n'
  assert.equal(aplicarNotify(seguidas, LINEA).cambio, 'ajeno')
  const cuatro = 'a = """x""""\nnotify = ["py"]\n'
  assert.equal(aplicarNotify(cuatro, LINEA).cambio, 'ajeno')
  const finDeLineaEscapado = 'a = """uno \\\n   dos"""\nnotify = ["py"]\n'
  assert.equal(aplicarNotify(finDeLineaEscapado, LINEA).cambio, 'ajeno')
})

test('cadenas literales: la barra no escapa y un notify adentro no cuenta', () => {
  const literal = "a = '''x \\'''\nnotify = [\"py\"]\n"
  assert.equal(aplicarNotify(literal, LINEA).cambio, 'ajeno')
  const conComillasDobles = "a = '''\nnotify = [\"x\"]\n\"\"\"\n'''\n"
  const r = aplicarNotify(conComillasDobles, LINEA)
  assert.equal(r.cambio, 'agregada')
  assert.equal(cuantosNotifyDeRaiz(r.toml), 1)
  assert.equal(aplicarNotify("a = 'C:\\x' # c\nnotify = [\"p\"]\n", LINEA).cambio, 'ajeno')
})

test('notify solo dentro de una tabla o de una tabla en línea: se agrega el de raíz y queda uno', () => {
  for (const base of ['[tui]\nnotify = ["x"]\n', 'x = { notify = 1 }\n', '[[hooks]]\nnotify = 1\n', '[a.notify]\nb = 1\n']) {
    const r = aplicarNotify(base, LINEA)
    assert.equal(r.cambio, 'agregada', base)
    assert.equal(cuantosNotifyDeRaiz(r.toml), 1, base)
    assert.equal(verificarCambio(base, r.toml, true), undefined, base)
  }
})

test('notify con comentario al final, con comillas o con escapes en la clave: es del usuario', () => {
  for (const base of ['notify = ["a"] # mi aviso\n', '"notify" = ["a"]\n', "'notify' = [\"a\"]\n", '"not\\u0069fy" = ["a"]\n', 'notify=["a"]\n', '  notify   =   [ "a" ]  \n']) {
    assert.equal(aplicarNotify(base, LINEA).cambio, 'ajeno', base)
  }
  assert.equal(aplicarNotify('"no.tify" = 1\n', LINEA).cambio, 'agregada')
  assert.equal(aplicarNotify('"notify.x" = 1\n', LINEA).cambio, 'agregada')
})

test('notify como tabla o con clave punteada choca con el de raíz: no se escribe', () => {
  for (const base of ['[notify]\nx = 1\n', '[ "notify" ]\n', '[[notify]]\n', 'notify.x = 1\n', '[notify.sub]\n']) {
    assert.equal(aplicarNotify(base, LINEA).cambio, 'ajeno', base)
  }
})

test('una marca que no es un comentario real no hace nuestra a la línea', () => {
  assert.equal(aplicarNotify('notify = ["a # sloth-notify"]\n', LINEA).cambio, 'ajeno')
  assert.equal(aplicarNotify('notify = ["a"] # x # sloth-notify\n', LINEA).cambio, 'ajeno')
  assert.equal(aplicarNotify('notify = [\n "a",\n] # sloth-notify\n', LINEA).cambio, 'ajeno')
})

test('strings con # y corchetes, arrays con comentarios y fechas no confunden al escáner', () => {
  const base = 'a = "x # y [z]"\nl = [\n  "]", # c\n  "[t]"\n]\nd = 1979-05-27 07:32:00Z\nh = 07:32:00\nn = { a = [1, 2], b = "c" }\nnotify = ["py"]\n[t]\nx = 1\n'
  assert.equal(aplicarNotify(base, LINEA).cambio, 'ajeno')
  const sin = base.replace('notify = ["py"]\n', '')
  const r = aplicarNotify(sin, LINEA)
  assert.equal(r.cambio, 'agregada')
  assert.equal(r.toml, `${LINEA}\n${sin}`)
})

test('CRLF y BOM combinados con cadenas multilínea', () => {
  const base = '\uFEFFa = """x \\""" y"""\r\nb = 1\r\n[t]\r\nc = 2\r\n'
  const r = aplicarNotify(base, LINEA)
  assert.equal(r.toml, `\uFEFF${LINEA}\r\n${base.slice(1)}`)
  assert.deepEqual(quitarNotify(r.toml), { toml: base, quitada: true })
  assert.equal(aplicarNotify('\uFEFFa = """x \\""" y"""\r\nnotify = ["p"]\r\n', LINEA).cambio, 'ajeno')
})

test('un TOML que no cierra o con claves repetidas es dudoso: no se escribe nada', () => {
  for (const base of ['a = """sin cerrar\nnotify = ["x"]\n', 'a = "sin cerrar\n', 'a = [1, 2\n', 'a = 1\na = 2\n', 'a.b = 1\na = 2\n', '[t]\n[t]\n', 'a = 1\n[a]\n', 'a = \n', 'a = 1 b = 2\n', 'a = nope\n', 'a = "\\q"\n']) {
    assert.equal(aplicarNotify(base, LINEA).cambio, 'dudoso', JSON.stringify(base))
  }
  const conMarca = `a = """x\n${NOTIFY_MARCA}\n`
  assert.deepEqual(quitarNotify(conMarca), { toml: conMarca, quitada: false, dudoso: true })
})

test('verificarCambio rechaza un resultado con dos notify, con otro contenido o sin nuestra línea', () => {
  const antes = 'a = 1\n'
  assert.equal(verificarCambio(antes, aplicarNotify(antes, LINEA).toml, true), undefined)
  assert.ok(verificarCambio(antes, antes, true))
  assert.ok(verificarCambio(antes, `${LINEA}\n${LINEA}\n${antes}`, true))
  assert.ok(verificarCambio(antes, `notify = ["x"]\n${antes}`, true))
  assert.ok(verificarCambio(antes, `${LINEA}\n${antes}b = 2\n`, true))
  assert.ok(verificarCambio(antes, `${LINEA}\n[notify]\n${antes}`, true))
  assert.ok(verificarCambio(antes, 'a = """x', true))
  assert.equal(verificarCambio(`${antes}${LINEA}\n`, antes, false), undefined)
  assert.ok(verificarCambio(`${antes}${LINEA}\n`, `${antes}${LINEA}\n`, false))
})

test('problemaDeDuplicados: repetidos reales sí, tablas de array y subtablas legítimas no', () => {
  const dup = (t: string): string | undefined => {
    const a = analizar(t)
    assert.equal(a.ok, true, t)
    return a.ok ? problemaDeDuplicados(a.sentencias) : 'no analiza'
  }
  assert.ok(dup('a = 1\na = 2\n'))
  assert.ok(dup('"a" = 1\n\'a\' = 2\n'))
  assert.ok(dup('[t]\nx = 1\nx = 2\n'))
  assert.ok(dup('[t]\n[t]\n'))
  assert.ok(dup('a.b = 1\n[a]\n'))
  assert.ok(dup('a = 1\na.b = 2\n'))
  assert.ok(dup('[t.u]\n[[t]]\n'))
  assert.equal(dup('a = 1\n[t]\na = 2\n'), undefined)
  assert.equal(dup('[a.b]\nx = 1\n[a]\ny = 2\n'), undefined)
  assert.equal(dup('[[p]]\nx = 1\n[p.s]\nz = 1\n[[p]]\nx = 2\n[p.s]\nz = 2\n'), undefined)
  assert.equal(dup('a.b = 1\na.c = 2\n'), undefined)
})
