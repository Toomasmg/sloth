import { test } from 'node:test'
import assert from 'node:assert/strict'
import { textoDiagnostico, type DatosDiagnostico, type EntradaLog } from './diagnostico-texto'

const AHORA = Date.UTC(2026, 10, 17, 12, 0, 0)

const base = (): DatosDiagnostico => ({
  sloth: '0.6.28',
  electron: '33.0.0',
  node: '20.18.0',
  chrome: '130.0.0',
  so: 'win32 10.0.26300 x64',
  features: ['git', 'chat', 'celular'],
  cuentas: 2,
  espacios: 5,
  ajustes: { sounds: true, lightMode: false },
  errores: [],
  avisos: [],
  crashPrevio: false
})

const entrada = (i: number): EntradaLog => ({ t: AHORA - (100 - i) * 1000, nivel: 'error', origen: 'main', msg: `falla ${i}` })

test('trae todas las secciones', () => {
  const texto = textoDiagnostico(
    {
      ...base(),
      errores: [{ t: AHORA - 5000, nivel: 'error', origen: 'renderer', msg: 'TypeError: x es undefined' }],
      avisos: ['Encontré un archivo dañado']
    },
    AHORA
  )
  assert.match(texto, /^Diagnóstico de Sloth\n2026-11-17T12:00:00\.000Z\n/)
  assert.match(texto, /Sloth 0\.6\.28 · Electron 33\.0\.0 · Node 20\.18\.0 · Chrome 130\.0\.0/)
  assert.match(texto, /Sistema: win32 10\.0\.26300 x64/)
  assert.match(texto, /Funciones activas: git, chat, celular/)
  assert.match(texto, /Cuentas: 2 · Espacios: 5/)
  assert.match(texto, /sounds: sí\n {2}lightMode: no/)
  assert.match(texto, /Últimos errores y avisos \(2\)/)
  assert.match(texto, /\[2026-11-17T11:59:55\.000Z\] renderer: TypeError: x es undefined/)
  assert.match(texto, /\[aviso\] Encontré un archivo dañado/)
  assert.ok(texto.endsWith('Este texto no se envió a ningún lado: se copió a tu portapapeles. Revisalo antes de compartirlo.'))
})

test('las listas vacías lo dicen', () => {
  const texto = textoDiagnostico({ ...base(), features: [], ajustes: {} }, AHORA)
  assert.match(texto, /Últimos errores y avisos \(0\)\n\(sin errores\)\n\(sin avisos\)/)
  assert.match(texto, /Funciones activas: \(ninguna\)/)
  assert.doesNotMatch(texto, /sesión anterior/)
  assert.doesNotMatch(texto, /No se pudo escribir/)
})

test('muestra solo las 30 más nuevas, con la más nueva al final', () => {
  const errores = Array.from({ length: 45 }, (_, i) => entrada(i))
  const texto = textoDiagnostico({ ...base(), errores }, AHORA)
  assert.match(texto, /Últimos errores y avisos \(30\)/)
  assert.doesNotMatch(texto, /falla 14\b/)
  assert.ok(texto.indexOf('falla 15') < texto.indexOf('falla 44'))
  assert.ok(texto.includes('falla 44'))
})

test('avisa del cierre inesperado y del log que no se pudo escribir', () => {
  const texto = textoDiagnostico({ ...base(), crashPrevio: true, fallosLog: 'EACCES: permission denied' }, AHORA)
  assert.match(texto, /La sesión anterior terminó de forma inesperada\./)
  assert.match(texto, /No se pudo escribir el archivo de log: EACCES: permission denied/)
})

test('una fecha inválida no tira el diagnóstico', () => {
  const texto = textoDiagnostico({ ...base(), errores: [{ t: Number.NaN, nivel: 'error', origen: 'main', msg: 'x' }] }, AHORA)
  assert.match(texto, /\[fecha desconocida\] main: x/)
})
