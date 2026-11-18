import { test } from 'node:test'
import assert from 'node:assert/strict'
import { conReintento, type PresupuestoReintento } from './reintento'

class Pasajero extends Error {
  costo?: number
  constructor(costo?: number) {
    super('pasajero')
    this.costo = costo
  }
}
const base = { intentosMax: 3, tiempoMaxMs: 300_000, reintentable: (e: unknown): boolean => e instanceof Pasajero, costoDe: (e: unknown): number | undefined => (e instanceof Pasajero ? e.costo : undefined) }

test('reintenta lo pasajero hasta el máximo y devuelve lo que salga', async () => {
  let n = 0
  const r = await conReintento(async () => {
    if (++n < 3) throw new Pasajero()
    return 'ok'
  }, base)
  assert.deepEqual([r, n], ['ok', 3])
  n = 0
  await assert.rejects(conReintento(async () => { n++; throw new Pasajero() }, base), Pasajero)
  assert.equal(n, 3)
})

test('lo que no es pasajero no se reintenta', async () => {
  let n = 0
  await assert.rejects(conReintento(async () => { n++; throw new Error('otro') }, base), /otro/)
  assert.equal(n, 1)
})

test('cada intento fallido descuenta del tope de costo y el siguiente recibe lo que queda', async () => {
  const vistos: Array<number | undefined> = []
  await assert.rejects(
    conReintento(async (p: PresupuestoReintento) => { vistos.push(p.restanteUsd); throw new Pasajero(0.3) }, { ...base, costoMaxUsd: 0.5 }),
    Pasajero
  )
  assert.equal(vistos.length, 2)
  assert.equal(vistos[0], 0.5)
  assert.ok(Math.abs((vistos[1] ?? 0) - 0.2) < 1e-9)
})

test('con menos del mínimo de costo restante no se reintenta', async () => {
  let n = 0
  await assert.rejects(conReintento(async () => { n++; throw new Pasajero(0.495) }, { ...base, costoMaxUsd: 0.5, minimoUsd: 0.01 }), Pasajero)
  assert.equal(n, 1)
})

test('sin tope de costo no se descuenta nada', async () => {
  const vistos: Array<number | undefined> = []
  await assert.rejects(conReintento(async (p) => { vistos.push(p.restanteUsd); throw new Pasajero(5) }, base), Pasajero)
  assert.deepEqual(vistos, [undefined, undefined, undefined])
})

test('el tiempo total se acota: no se reintenta si no queda lo mínimo y cada intento sabe cuánto le queda', async () => {
  let t = 0
  const restantes: number[] = []
  await assert.rejects(
    conReintento(async (p) => { restantes.push(p.restanteMs); t += 200_000; throw new Pasajero() }, { ...base, tiempoMaxMs: 300_000, minimoMs: 30_000, ahora: () => t }),
    Pasajero
  )
  assert.deepEqual(restantes, [300_000, 100_000])
  restantes.length = 0
  t = 0
  await assert.rejects(
    conReintento(async (p) => { restantes.push(p.restanteMs); t += 280_000; throw new Pasajero() }, { ...base, minimoMs: 30_000, ahora: () => t }),
    Pasajero
  )
  assert.deepEqual(restantes, [300_000])
})
