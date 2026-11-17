import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { escribirJsonAtomico, esObjeto, leerJson } from './json-file'
import { tomarAvisos } from './avisos'

const carpeta = (): string => mkdtempSync(join(tmpdir(), 'sloth-json-'))

interface Ajustes {
  theme: string
}
const opciones = {
  validar: (v: unknown): Ajustes | undefined => (esObjeto(v) && typeof v.theme === 'string' ? { theme: v.theme } : undefined),
  porDefecto: (): Ajustes => ({ theme: 'oscuro' })
}

test('sin archivo: valor por defecto, sin apartar ni avisar', () => {
  tomarAvisos()
  const d = carpeta()
  const r = leerJson(join(d, 'settings.json'), opciones)
  assert.deepEqual(r, { valor: { theme: 'oscuro' } })
  assert.deepEqual(tomarAvisos(), [])
  rmSync(d, { recursive: true })
})

test('archivo válido con BOM: se lee y no se toca', () => {
  const d = carpeta()
  const f = join(d, 'settings.json')
  writeFileSync(f, '﻿{"theme":"claro"}')
  assert.deepEqual(leerJson(f, opciones), { valor: { theme: 'claro' } })
  assert.deepEqual(readdirSync(d), ['settings.json'])
  rmSync(d, { recursive: true })
})

test('QA #3: settings.json con una coma de más se aparta con su contenido y avisa', () => {
  tomarAvisos()
  const d = carpeta()
  const f = join(d, 'settings.json')
  const roto = '{ "theme":"claro", "shortcuts":{}, }'
  writeFileSync(f, roto)
  const r = leerJson(f, opciones)
  assert.deepEqual(r.valor, { theme: 'oscuro' })
  assert.ok(r.apartado && /settings\.json\.corrupt-\d+$/.test(r.apartado))
  assert.equal(readFileSync(r.apartado, 'utf8'), roto)
  assert.deepEqual(readdirSync(d), [r.apartado.slice(d.length + 1)])
  const avisos = tomarAvisos()
  assert.equal(avisos.length, 1)
  assert.match(avisos[0], /settings\.json.*settings\.json\.corrupt-\d+.*valores por defecto/)
  escribirJsonAtomico(f, r.valor)
  assert.equal(readFileSync(r.apartado, 'utf8'), roto, 'el guardado siguiente no pisa el respaldo')
  rmSync(d, { recursive: true })
})

test('JSON válido que no valida también se aparta', () => {
  const d = carpeta()
  const f = join(d, 'settings.json')
  writeFileSync(f, '[1,2]')
  const r = leerJson(f, { ...opciones, silencioso: true })
  assert.ok(r.apartado)
  assert.deepEqual(r.valor, { theme: 'oscuro' })
  rmSync(d, { recursive: true })
})

test('un validador que tira cuenta como contenido inválido', () => {
  const d = carpeta()
  const f = join(d, 'x.json')
  writeFileSync(f, 'null')
  const r = leerJson(f, {
    validar: (v: unknown) => (v as { a: number }).a,
    porDefecto: () => 0,
    silencioso: true
  })
  assert.equal(r.valor, 0)
  assert.ok(r.apartado)
  rmSync(d, { recursive: true })
})

test('error de lectura que no es ENOENT: se propaga y no se aparta nada', () => {
  const d = carpeta()
  const f = join(d, 'settings.json')
  mkdirSync(f)
  assert.throws(() => leerJson(f, opciones), (e: NodeJS.ErrnoException) => e.code === 'EISDIR')
  assert.deepEqual(readdirSync(d), ['settings.json'])
  rmSync(d, { recursive: true })
})

test('escribirJsonAtomico crea la carpeta, reemplaza y no deja el tmp', () => {
  const d = carpeta()
  const f = join(d, 'features', 'a.json')
  escribirJsonAtomico(f, { a: 1 })
  escribirJsonAtomico(f, { a: 2 })
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { a: 2 })
  assert.deepEqual(readdirSync(join(d, 'features')), ['a.json'])
  rmSync(d, { recursive: true })
})
