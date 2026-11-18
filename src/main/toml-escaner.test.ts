import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analizar } from './toml-escaner'

const rutas = (t: string): string[] => {
  const a = analizar(t)
  assert.equal(a.ok, true, t)
  return a.ok ? a.sentencias.map((s) => `${s.tipo}:${[...s.tabla, ...s.ruta].join('/')}`) : []
}

test('claves peladas, con comillas, punteadas y con escapes', () => {
  assert.deepEqual(rutas('a = 1\n"b.c" = 2\n\'d\' = 3\ne . f = 4\n"g\\u0068" = 5\n'), ['clave:a', 'clave:b.c', 'clave:d', 'clave:e/f', 'clave:gh'])
})

test('tablas y tablas de array con sus claves', () => {
  assert.deepEqual(rutas('[a.b]\nx = 1\n[[c]]\ny = 2\n[ "d" . e ]\n'), ['tabla:a/b', 'clave:a/b/x', 'tablaArray:c', 'clave:c/y', 'tabla:d/e'])
})

test('valores: cadenas multilínea, arrays anidados con comentarios, tablas en línea y fechas', () => {
  const t = 'a = """\nx \\"""\n"""\nb = \'\'\'\n"""\n\'\'\'\nc = [\n  [1, 2], # uno\n  ["]"],\n]\nd = { e = 1, f = { g = "h" } }\ni = 1979-05-27T07:32:00-08:00\nj = -1.5e+3\nk = 0xDEAD_beef\nl = +inf\n'
  assert.deepEqual(rutas(t), ['clave:a', 'clave:b', 'clave:c', 'clave:d', 'clave:i', 'clave:j', 'clave:k', 'clave:l'])
})

test('líneas y offsets de cada sentencia', () => {
  const texto = 'a = """x\ny"""\nb = 1 # c\n'
  const a = analizar(texto)
  assert.equal(a.ok, true)
  if (!a.ok) return
  assert.deepEqual(a.sentencias.map((s) => [s.lineaIni, s.lineaFin]), [[0, 1], [2, 2]])
  assert.equal(texto.slice(a.sentencias[1].desde, a.sentencias[1].hasta), 'b = 1')
})

test('lo que no cierra o no es TOML devuelve ok false y el motivo no lleva el contenido', () => {
  for (const t of ['a = "x', 'a = """x', "a = 'x", "a = '''x", 'a = [1', 'a = {b = 1', '[a', '[[a]', 'a b = 1', 'a = 1 2', '= 1', 'a = "\\uZZZZ"', 'a = """\\x"""', 'a = """""""""']) {
    const r = analizar(t)
    assert.equal(r.ok, false, t)
    if (!r.ok) assert.match(r.motivo, /línea \d+/)
  }
  const secreto = analizar('clave_secreta = "token')
  assert.equal(secreto.ok === false && secreto.motivo.includes('token'), false)
})

test('anidado excesivo no revienta la pila', () => {
  assert.equal(analizar(`a = ${'['.repeat(5000)}`).ok, false)
})
