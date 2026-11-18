import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tomarCandado } from './candado-archivo'

const carpeta = (): string => mkdtempSync(join(tmpdir(), 'sloth-candado-'))

test('el segundo que lo pide no lo toma hasta que el primero lo libera', () => {
  const d = carpeta()
  const ruta = join(d, 'perfiles.lock')
  const a = tomarCandado(ruta, { pid: 100, vivo: () => true })
  assert.equal(a.tomado, true)
  const b = tomarCandado(ruta, { pid: 200, vivo: () => true })
  assert.deepEqual(b, { tomado: false, pid: 100 })
  if (a.tomado) a.candado.liberar()
  assert.equal(existsSync(ruta), false)
  assert.equal(tomarCandado(ruta, { pid: 200, vivo: () => true }).tomado, true)
  rmSync(d, { recursive: true })
})

test('uno que quedó de un proceso que murió se toma', () => {
  const d = carpeta()
  const ruta = join(d, 'perfiles.lock')
  writeFileSync(ruta, JSON.stringify({ pid: 100, desde: Date.now() }))
  assert.equal(tomarCandado(ruta, { pid: 200, vivo: (p) => p !== 100 }).tomado, true)
  rmSync(d, { recursive: true })
})

test('uno muy viejo se toma aunque el pid exista (el pid se reusa)', () => {
  const d = carpeta()
  const ruta = join(d, 'perfiles.lock')
  writeFileSync(ruta, JSON.stringify({ pid: 100, desde: 1000 }))
  assert.equal(tomarCandado(ruta, { pid: 200, ahora: () => 1000 + 11 * 60_000, vivo: () => true }).tomado, true)
  rmSync(d, { recursive: true })
})

test('un archivo vacío recién creado es de otro que lo está escribiendo; uno viejo y roto se toma', () => {
  const d = carpeta()
  const ruta = join(d, 'perfiles.lock')
  writeFileSync(ruta, '')
  assert.deepEqual(tomarCandado(ruta, { pid: 200, vivo: () => true }), { tomado: false, pid: null })
  const viejo = new Date(Date.now() - 60_000)
  utimesSync(ruta, viejo, viejo)
  assert.equal(tomarCandado(ruta, { pid: 200, vivo: () => true }).tomado, true)
  rmSync(d, { recursive: true })
})

test('crea la carpeta que falte y liberar dos veces no tira', () => {
  const d = carpeta()
  const r = tomarCandado(join(d, 'a', 'b', 'x.lock'))
  assert.equal(r.tomado, true)
  if (r.tomado) {
    r.candado.liberar()
    r.candado.liberar()
  }
  rmSync(d, { recursive: true })
})
