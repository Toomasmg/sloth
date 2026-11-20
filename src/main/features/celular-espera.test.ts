import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crearEsperas, type Esperas, type MotivoEspera } from './celular-espera'

const pausa = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function esperar(e: Esperas, id: string, ms: number, cancelar?: AbortSignal, dueno?: string): Promise<MotivoEspera> {
  const p = e.esperar(id, ms, cancelar, dueno)
  assert.ok(p, 'había cupo')
  return p
}

test('vence a los ms y no deja nada abierto', async () => {
  const e = crearEsperas()
  const t0 = Date.now()
  assert.equal(await esperar(e, 'a', 30), 'vencio')
  assert.ok(Date.now() - t0 >= 25)
  assert.equal(e.activas(), 0)
})

test('varios avisos seguidos resuelven «dato» una sola vez, contado desde el primero', async () => {
  const e = crearEsperas({ coalescenciaMs: 40 })
  const t0 = Date.now()
  const p = esperar(e, 'a', 5000)
  let veces = 0
  void p.then(() => veces++)
  for (let i = 0; i < 5; i++) {
    e.avisar('a')
    await pausa(3)
  }
  assert.equal(await p, 'dato')
  const t = Date.now() - t0
  assert.ok(t >= 35 && t < 300, `tardó ${t} ms`)
  await pausa(10)
  assert.equal(veces, 1)
  assert.equal(e.activas(), 0)
})

test('avisar sin nadie esperando no acumula nada: la espera siguiente no sale sola', async () => {
  const e = crearEsperas({ coalescenciaMs: 2 })
  e.avisar('a')
  e.avisar('a')
  assert.equal(e.activas(), 0)
  assert.equal(await esperar(e, 'a', 40), 'vencio')
})

test('un aviso a otra terminal no despierta a esta', async () => {
  const e = crearEsperas({ coalescenciaMs: 2 })
  const p = esperar(e, 'a', 40)
  e.avisar('b')
  assert.equal(await p, 'vencio')
})

test('la segunda espera del mismo id suelta a la primera y toma su lugar sin gastar cupo', async () => {
  const e = crearEsperas({ maxGlobal: 1 })
  const primera = esperar(e, 'a', 5000)
  const segunda = esperar(e, 'a', 5000)
  assert.equal(await primera, 'soltada')
  assert.equal(e.activas(), 1)
  e.soltar('a')
  assert.equal(await segunda, 'soltada')
  assert.equal(e.activas(), 0)
})

test('tope global: la que no entra es null y no deja rastro; al liberar un lugar vuelve a entrar', async () => {
  const e = crearEsperas({ maxGlobal: 6 })
  const abiertas = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => esperar(e, id, 5000))
  assert.equal(e.esperar('g', 5000), null)
  assert.equal(e.activas(), 6)
  e.soltar('c')
  assert.equal(await abiertas[2], 'soltada')
  const g = esperar(e, 'g', 5000)
  assert.equal(e.activas(), 6)
  e.soltarTodas()
  assert.deepEqual(await Promise.all([...abiertas, g]), Array(7).fill('soltada'))
  assert.equal(e.activas(), 0)
})

test('soltar de un id que no espera no hace nada; soltarTodas suelta a todas', async () => {
  const e = crearEsperas()
  e.soltar('nadie')
  const ps = ['a', 'b', 'c'].map((id) => esperar(e, id, 5000))
  e.soltarTodas()
  assert.deepEqual(await Promise.all(ps), ['soltada', 'soltada', 'soltada'])
  assert.equal(e.activas(), 0)
  e.soltarTodas()
})

test('cancelar: la señal cancela la espera abierta', async () => {
  const e = crearEsperas()
  const ctl = new AbortController()
  const p = esperar(e, 'a', 5000, ctl.signal)
  ctl.abort()
  assert.equal(await p, 'cancelada')
  assert.equal(e.activas(), 0)
})

test('con la señal ya cancelada resuelve «cancelada» sin tomar cupo ni soltar a la anterior', async () => {
  const e = crearEsperas({ maxGlobal: 1 })
  const viva = esperar(e, 'a', 5000)
  const ctl = new AbortController()
  ctl.abort()
  assert.equal(await esperar(e, 'a', 5000, ctl.signal), 'cancelada')
  assert.equal(await esperar(e, 'b', 5000, ctl.signal), 'cancelada')
  assert.equal(e.activas(), 1)
  e.soltar('a')
  assert.equal(await viva, 'soltada')
})

test('red que cae con el pedido abierto: el abort con un aviso pendiente no resuelve dos veces ni deja timers', async () => {
  const e = crearEsperas({ coalescenciaMs: 15 })
  const ctl = new AbortController()
  let veces = 0
  const p = esperar(e, 'a', 5000, ctl.signal).then((m) => {
    veces++
    return m
  })
  e.avisar('a')
  ctl.abort()
  assert.equal(await p, 'cancelada')
  await pausa(40)
  assert.equal(veces, 1)
  assert.equal(e.activas(), 0)
  e.avisar('a')
  assert.equal(e.activas(), 0)
})

test('abortar después de resolver no toca a la espera siguiente del mismo id', async () => {
  const e = crearEsperas({ coalescenciaMs: 1 })
  const ctl = new AbortController()
  const p = esperar(e, 'a', 5000, ctl.signal)
  e.avisar('a')
  assert.equal(await p, 'dato')
  const otra = esperar(e, 'a', 5000)
  ctl.abort()
  assert.equal(e.activas(), 1)
  e.soltar('a')
  assert.equal(await otra, 'soltada')
})

test('ms raros se acotan: negativo o NaN vence ya, y uno enorme sigue siendo una espera normal que se puede soltar', async () => {
  const e = crearEsperas()
  assert.equal(await esperar(e, 'a', -5), 'vencio')
  assert.equal(await esperar(e, 'a', NaN), 'vencio')
  const larga = esperar(e, 'a', 10 ** 9)
  e.soltar('a')
  assert.equal(await larga, 'soltada')
  assert.equal(e.activas(), 0)
})

test('dos celus en la misma terminal esperan los dos y un aviso despierta a ambos; el tercero no entra', async () => {
  const e = crearEsperas({ coalescenciaMs: 2 })
  const a = esperar(e, 'ws', 5000, undefined, 'celu-a')
  const b = esperar(e, 'ws', 5000, undefined, 'celu-b')
  assert.equal(e.activas(), 2)
  assert.equal(e.esperar('ws', 5000, undefined, 'celu-c'), null)
  const otra = esperar(e, 'otra', 5000, undefined, 'celu-c')
  e.avisar('ws')
  assert.deepEqual(await Promise.all([a, b]), ['dato', 'dato'])
  assert.equal(e.activas(), 1, 'la de otra terminal sigue')
  e.soltarTodas()
  assert.equal(await otra, 'soltada')
  assert.equal(e.activas(), 0)
})

test('un celu que vuelve a pedir suelta solo a su propia espera, no a la del otro', async () => {
  const e = crearEsperas()
  const a1 = esperar(e, 'ws', 5000, undefined, 'celu-a')
  const b = esperar(e, 'ws', 5000, undefined, 'celu-b')
  const a2 = esperar(e, 'ws', 5000, undefined, 'celu-a')
  assert.equal(await a1, 'soltada')
  assert.equal(e.activas(), 2)
  e.soltar('ws')
  assert.deepEqual(await Promise.all([a2, b]), ['soltada', 'soltada'])
  assert.equal(e.activas(), 0)
})

test('el tope por terminal no le quita cupo a las demás ni deja rastro al rechazar', async () => {
  const e = crearEsperas({ maxGlobal: 3, maxPorTerminal: 1 })
  const a = esperar(e, 'a', 5000)
  assert.equal(e.esperar('a', 5000, undefined, 'otro'), null)
  const b = esperar(e, 'b', 5000)
  const c = esperar(e, 'c', 5000)
  assert.equal(e.esperar('d', 5000), null)
  assert.equal(e.activas(), 3)
  e.soltarTodas()
  await Promise.all([a, b, c])
  assert.equal(e.activas(), 0)
})
