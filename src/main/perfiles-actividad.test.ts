import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agregarActividad, ARCHIVOS_ACTIVIDAD, leerActividad, limpiarEntrada, MAX_BYTES_ACTIVIDAD } from './perfiles-actividad'

const dirTmp = (): string => mkdtempSync(join(tmpdir(), 'sloth-actividad-'))

test('limpiarEntrada descarta campos extra como prompt y salida', () => {
  const e = limpiarEntrada({ t: 5, tipo: 'espacio', espacio: 'api', prompt: 'secreto', salida: 'texto de la terminal', pr: undefined })
  assert.deepEqual(e, { t: 5, tipo: 'espacio', espacio: 'api' })
})

test('limpiarEntrada rechaza tipos desconocidos, tiempos inválidos y valores que no son objeto', () => {
  assert.equal(limpiarEntrada({ t: 5, tipo: 'prompt' }), null)
  assert.equal(limpiarEntrada({ t: 0, tipo: 'pr' }), null)
  assert.equal(limpiarEntrada({ t: 1.5, tipo: 'pr' }), null)
  assert.equal(limpiarEntrada({ t: '5', tipo: 'pr' }), null)
  assert.equal(limpiarEntrada(null), null)
  assert.equal(limpiarEntrada([]), null)
  assert.equal(limpiarEntrada('espacio'), null)
})

test('limpiarEntrada recorta el largo y saca saltos de línea y caracteres de control', () => {
  const e = limpiarEntrada({ t: 1, tipo: 'ticket', ticket: 'ABC-1\nsegunda línea\u0000', espacio: 'x'.repeat(500) })
  assert.equal(e?.ticket, 'ABC-1 segunda línea')
  assert.equal(e?.espacio?.length, 120)
  assert.equal(limpiarEntrada({ t: 1, tipo: 'espacio', espacio: '  \n ' })?.espacio, undefined)
})

test('agregarActividad rota al pasar el tope y nunca deja más de tres archivos', () => {
  const dir = dirTmp()
  const relleno = 'y'.repeat(120)
  const porArchivo = Math.ceil(MAX_BYTES_ACTIVIDAD / 200) + 5
  for (let i = 1; i <= porArchivo * 4; i++) agregarActividad(dir, { t: i, tipo: 'espacio', espacio: relleno, ticket: relleno })
  const archivos = readdirSync(dir).sort()
  assert.deepEqual(archivos, ['actividad-1.jsonl', 'actividad-2.jsonl', 'actividad.jsonl'])
  assert.ok(archivos.length <= ARCHIVOS_ACTIVIDAD)
  const ultimo = leerActividad(dir, 1)[0]
  assert.equal(ultimo?.t, porArchivo * 4)
})

test('agregarActividad escribe una línea JSON por entrada y rechaza una inválida', () => {
  const dir = dirTmp()
  agregarActividad(dir, { t: 10, tipo: 'pr', pr: '#42' })
  assert.equal(readFileSync(join(dir, 'actividad.jsonl'), 'utf8'), '{"t":10,"tipo":"pr","pr":"#42"}\n')
  assert.throws(() => agregarActividad(dir, { t: -1, tipo: 'pr' }), /inválida/)
  assert.equal(existsSync(join(dir, 'actividad-1.jsonl')), false)
})

test('leerActividad salta la línea corrupta del medio y devuelve las más nuevas primero', () => {
  const dir = dirTmp()
  const l = (t: number): string => JSON.stringify({ t, tipo: 'espacio', espacio: `e${t}` })
  writeFileSync(join(dir, 'actividad.jsonl'), `${l(1)}\n{roto\n${l(3)}\n[1,2]\n${l(4)}\n`)
  writeFileSync(join(dir, 'actividad-1.jsonl'), `${l(-9)}\n${JSON.stringify({ t: 0.5, tipo: 'pr' })}\n${l(2)}\n`)
  assert.deepEqual(leerActividad(dir, 50).map((e) => e.t), [4, 3, 1, 2])
  assert.deepEqual(leerActividad(dir, 2).map((e) => e.t), [4, 3])
})

test('leerActividad acota el límite a 1..200 y devuelve vacío si no hay carpeta', () => {
  const dir = dirTmp()
  for (let i = 1; i <= 250; i++) agregarActividad(dir, { t: i, tipo: 'espacio', espacio: 'a' })
  assert.equal(leerActividad(dir, 0).length, 1)
  assert.equal(leerActividad(dir, 9999).length, 200)
  assert.equal(leerActividad(join(dir, 'no-existe'), 10).length, 0)
})
