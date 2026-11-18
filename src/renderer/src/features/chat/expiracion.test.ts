import test from 'node:test'
import assert from 'node:assert/strict'
import { ESPERA_MAX_MS, esperaHasta, vigilarVencimiento } from './expiracion'

const HORA = 3_600_000

// Timers que cuentan tiempo "monotónico": la suspensión mueve la hora de pared pero no los timers.
function banco(pared = 1_000_000) {
  let t = 0
  let siguiente = 1
  const pendientes = new Map<number, { fn: () => void; en: number; ms: number }>()
  return {
    pendientes,
    ahora: () => pared + t,
    programar: (fn: () => void, ms: number) => {
      const id = siguiente++
      pendientes.set(id, { fn, en: t + ms, ms })
      return id
    },
    cancelar: (h: unknown) => pendientes.delete(h as number),
    avanzar(ms: number) {
      const hasta = t + ms
      for (;;) {
        const prox = [...pendientes.entries()].sort((a, b) => a[1].en - b[1].en)[0]
        if (!prox || prox[1].en > hasta) break
        pendientes.delete(prox[0])
        t = prox[1].en
        prox[1].fn()
      }
      t = hasta
    },
    suspender(ms: number) {
      pared += ms
    },
    maxEspera: () => Math.max(0, ...[...pendientes.values()].map((p) => p.ms))
  }
}

test('vence a la hora justa y avisa una sola vez', () => {
  const b = banco()
  let n = 0
  vigilarVencimiento(b.ahora() + 150_000, b.ahora, b.programar, b.cancelar, () => n++)
  b.avanzar(149_000)
  assert.equal(n, 0)
  b.avanzar(120_000)
  assert.equal(n, 1)
  assert.equal(b.pendientes.size, 0)
})

test('ninguna espera pasa de 60 s ni de 2^31 aunque el vencimiento esté a meses', () => {
  const b = banco()
  vigilarVencimiento(b.ahora() + 2160 * HORA, b.ahora, b.programar, b.cancelar, () => {})
  assert.equal(b.maxEspera(), ESPERA_MAX_MS)
  b.avanzar(10 * ESPERA_MAX_MS)
  assert.equal(b.maxEspera(), ESPERA_MAX_MS)
  assert.ok(esperaHasta(Number.MAX_SAFE_INTEGER, 0) <= 2 ** 31 - 1)
})

test('suspensión simulada: la hora de pared salta 8 h y el siguiente tramo ya avisa', () => {
  const b = banco()
  let n = 0
  vigilarVencimiento(b.ahora() + 6 * HORA, b.ahora, b.programar, b.cancelar, () => n++)
  b.avanzar(30_000)
  b.suspender(8 * HORA)
  b.avanzar(ESPERA_MAX_MS)
  assert.equal(n, 1)
})

test('suspensión simulada: al volver la ventana, revisar avisa sin esperar al timer', () => {
  const b = banco()
  let n = 0
  const v = vigilarVencimiento(b.ahora() + 6 * HORA, b.ahora, b.programar, b.cancelar, () => n++)
  b.suspender(8 * HORA)
  v.revisar()
  assert.equal(n, 1)
  assert.equal(b.pendientes.size, 0)
})

test('revisar antes del vencimiento no avisa y deja un solo timer', () => {
  const b = banco()
  let n = 0
  const v = vigilarVencimiento(b.ahora() + HORA, b.ahora, b.programar, b.cancelar, () => n++)
  v.revisar()
  v.revisar()
  assert.equal(n, 0)
  assert.equal(b.pendientes.size, 1)
})

test('vencimiento en el pasado: avisa en la espera mínima y no antes de revisar', () => {
  const b = banco()
  let n = 0
  vigilarVencimiento(b.ahora() - 5000, b.ahora, b.programar, b.cancelar, () => n++)
  assert.equal(b.maxEspera(), 1000)
  b.avanzar(1000)
  assert.equal(n, 1)
})

test('vencimiento en el pasado: revisar avisa en el acto', () => {
  const b = banco()
  let n = 0
  const v = vigilarVencimiento(b.ahora() - 5000, b.ahora, b.programar, b.cancelar, () => n++)
  v.revisar()
  assert.equal(n, 1)
})

test('cambio de retención: parar la vigilia vieja y arrancar otra no deja avisos de la anterior', () => {
  const b = banco()
  let viejo = 0
  let nuevo = 0
  const v1 = vigilarVencimiento(b.ahora() + 24 * HORA, b.ahora, b.programar, b.cancelar, () => viejo++)
  b.avanzar(HORA)
  v1.parar()
  vigilarVencimiento(b.ahora() + 2 * HORA, b.ahora, b.programar, b.cancelar, () => nuevo++)
  assert.equal(b.pendientes.size, 1)
  b.avanzar(3 * HORA)
  assert.equal(viejo, 0)
  assert.equal(nuevo, 1)
})

test('una vigilia parada no avisa aunque la llamen', () => {
  const b = banco()
  let n = 0
  const v = vigilarVencimiento(b.ahora() + 1000, b.ahora, b.programar, b.cancelar, () => n++)
  v.parar()
  b.suspender(HORA)
  v.revisar()
  assert.equal(n, 0)
  assert.equal(b.pendientes.size, 0)
})
