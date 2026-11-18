import { test } from 'node:test'
import assert from 'node:assert/strict'
import { entornoJob, leerSalidaJob, limitesDe, nombreJob, perfilVigente, sinLimites } from './rendimiento-core'

const R = { enchufada: { ramMB: 8192, nucleos: 8 }, bateria: { ramMB: 4096, nucleos: 4 }, bateriaDistinta: true }

test('perfilVigente usa el de batería solo si está a batería y el ajuste está prendido', () => {
  assert.equal(perfilVigente(R, true), R.bateria)
  assert.equal(perfilVigente(R, false), R.enchufada)
  assert.equal(perfilVigente({ ...R, bateriaDistinta: false }, true), R.enchufada)
})

test('limitesDe arma la máscara con los primeros núcleos', () => {
  assert.deepEqual(limitesDe({ ramMB: 4096, nucleos: 4 }, 32_000, 14), { ramMB: 4096, nucleos: 4, afinidad: '15' })
  assert.equal(limitesDe({ ramMB: 0, nucleos: 1 }, 32_000, 14).afinidad, '1')
})

test('limitesDe: 0 o más de lo que hay es sin límite, y los núcleos vuelven como máscara completa', () => {
  const l = limitesDe({ ramMB: 0, nucleos: 0 }, 32_000, 14)
  assert.deepEqual(l, { ramMB: 0, nucleos: 14, afinidad: '16383' })
  assert.equal(sinLimites(l, 14), true)
  assert.equal(limitesDe({ ramMB: 64_000, nucleos: 99 }, 32_000, 14).ramMB, 0)
  assert.equal(limitesDe({ ramMB: 64_000, nucleos: 99 }, 32_000, 14).nucleos, 14)
  assert.equal(sinLimites(limitesDe({ ramMB: 4096, nucleos: 0 }, 32_000, 14), 14), false)
})

test('limitesDe con 64 núcleos o más no se pasa de un grupo de afinidad', () => {
  const l = limitesDe({ ramMB: 0, nucleos: 0 }, 32_000, 128)
  assert.equal(l.nucleos, 64)
  assert.equal(l.afinidad, (2n ** 64n - 1n).toString())
  assert.equal(sinLimites(l, 128), true)
})

test('entornoJob pasa todo como texto y rechaza PIDs inválidos', () => {
  const limites = limitesDe({ ramMB: 2048, nucleos: 2 }, 32_000, 14)
  const e = entornoJob({ nombre: nombreJob(42), raiz: 42, incluirRaiz: true, excluir: '', limites, dueno: 42 })
  assert.deepEqual(e, {
    SLOTH_JOB_NOMBRE: 'Local\\Sloth-Rendimiento-42',
    SLOTH_JOB_RAIZ: '42',
    SLOTH_JOB_INCLUIR_RAIZ: '1',
    SLOTH_JOB_EXCLUIR: '',
    SLOTH_JOB_RAM_BYTES: String(2048 * 1024 * 1024),
    SLOTH_JOB_AFINIDAD: '3',
    SLOTH_JOB_DUENO: '42'
  })
  for (const raiz of [0, -1, 1.5, Number.NaN]) assert.throws(() => entornoJob({ nombre: 'x', raiz, incluirRaiz: false, excluir: '', limites, dueno: 1 }))
})

test('leerSalidaJob lee la última línea y rechaza lo que no esperaba', () => {
  assert.deepEqual(leerSalidaJob('aviso\r\n{"procesos":3,"vistos":4}\r\n'), { procesos: 3, vistos: 4 })
  assert.throws(() => leerSalidaJob(''))
  assert.throws(() => leerSalidaJob('{"procesos":"3"}'))
})
