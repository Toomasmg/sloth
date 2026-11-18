import test from 'node:test'
import assert from 'node:assert/strict'
import { crearReloj } from './reloj-core'

function banco(visibleInicial = true) {
  let t = 1000
  let desfase = 0
  let visible = visibleInicial
  let siguiente = 1
  const pendientes = new Map<number, { fn: () => void; en: number }>()
  const reloj = crearReloj(
    () => t,
    () => t + desfase,
    (fn, ms) => {
      const id = siguiente++
      pendientes.set(id, { fn, en: t + ms })
      return id
    },
    (h) => pendientes.delete(h as number),
    () => visible
  )
  return {
    reloj,
    pendientes,
    saltarHoraDePared(ms: number) {
      desfase += ms
    },
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
    ocultar() {
      visible = false
      reloj.reanudar()
    },
    mostrar() {
      visible = true
      reloj.reanudar()
    }
  }
}

test('tres suscriptores comparten un solo timer', () => {
  const b = banco()
  b.reloj.suscribir(() => {}, 500)
  b.reloj.suscribir(() => {}, 500)
  b.reloj.suscribir(() => {}, 500)
  assert.equal(b.pendientes.size, 1)
  b.avanzar(500)
  assert.equal(b.pendientes.size, 1)
})

test('al soltar el último no queda timer', () => {
  const b = banco()
  const a = b.reloj.suscribir(() => {}, 500)
  const c = b.reloj.suscribir(() => {}, 500)
  a()
  assert.equal(b.pendientes.size, 1)
  c()
  assert.equal(b.pendientes.size, 0)
})

test('sin suscriptores no hay timer ni notificaciones', () => {
  const b = banco()
  b.avanzar(10_000)
  assert.equal(b.pendientes.size, 0)
})

test('el timer sigue el período mínimo y cada uno recibe el suyo', () => {
  const b = banco()
  let rapido = 0
  let lento = 0
  b.reloj.suscribir(() => rapido++, 500)
  b.reloj.suscribir(() => lento++, 2000)
  b.avanzar(4000)
  assert.equal(rapido, 8)
  assert.equal(lento, 2)
})

test('al soltar el más rápido el timer pasa al período que queda', () => {
  const b = banco()
  let lento = 0
  const rapido = b.reloj.suscribir(() => {}, 500)
  b.reloj.suscribir(() => lento++, 2000)
  rapido()
  b.avanzar(4000)
  assert.equal(lento, 2)
})

test('oculto no hay timer y al volver refresca una vez', () => {
  const b = banco()
  let n = 0
  b.reloj.suscribir(() => n++, 500)
  b.ocultar()
  assert.equal(b.pendientes.size, 0)
  b.avanzar(60_000)
  assert.equal(n, 0)
  b.mostrar()
  assert.equal(n, 1)
  assert.equal(b.pendientes.size, 1)
  b.avanzar(500)
  assert.equal(n, 2)
})

test('suscribirse con la ventana oculta no arma timer hasta volver', () => {
  const b = banco(false)
  b.reloj.suscribir(() => {}, 500)
  assert.equal(b.pendientes.size, 0)
  b.mostrar()
  assert.equal(b.pendientes.size, 1)
})

test('la marca cambia en cada tick y es estable entre ticks', () => {
  const b = banco()
  b.reloj.suscribir(() => {}, 500)
  const m0 = b.reloj.marca()
  assert.equal(b.reloj.marca(), m0)
  b.avanzar(500)
  assert.equal(b.reloj.marca(), m0 + 500)
})

test('la primera suscripción después de un rato refresca la marca', () => {
  const b = banco()
  b.avanzar(30_000)
  b.reloj.suscribir(() => {}, 500)
  assert.equal(b.reloj.marca(), 31_000)
})

test('un callback que se suelta durante el tick no rompe a los demás', () => {
  const b = banco()
  let n = 0
  let soltar = (): void => {}
  soltar = b.reloj.suscribir(() => soltar(), 500)
  b.reloj.suscribir(() => n++, 500)
  b.avanzar(1000)
  assert.equal(n, 2)
})

test('altas y bajas seguidas de otros no le sacan los ticks a un suscriptor lento', () => {
  const b = banco()
  let lento = 0
  b.reloj.suscribir(() => lento++, 30_000)
  for (let i = 0; i < 12; i++) {
    const baja = b.reloj.suscribir(() => {}, 5000)
    b.avanzar(10_000)
    baja()
  }
  assert.equal(lento, 4)
})

test('un suscriptor que entra y sale sin parar no corre el timer ni lo duplica', () => {
  const b = banco()
  let lento = 0
  b.reloj.suscribir(() => lento++, 1000)
  for (let i = 0; i < 100; i++) {
    b.reloj.suscribir(() => {}, 60_000)()
    assert.equal(b.pendientes.size, 1)
    b.avanzar(100)
  }
  assert.equal(lento, 10)
})

test('un suscriptor más rápido que entra adelanta el timer sin perjudicar al lento', () => {
  const b = banco()
  let lento = 0
  let rapido = 0
  b.reloj.suscribir(() => lento++, 10_000)
  b.avanzar(3000)
  b.reloj.suscribir(() => rapido++, 1000)
  b.avanzar(7000)
  assert.equal(lento, 1)
  assert.equal(rapido, 7)
})

test('si la hora de pared retrocede el reloj sigue notificando', () => {
  const b = banco()
  let n = 0
  b.reloj.suscribir(() => n++, 500)
  b.avanzar(500)
  b.saltarHoraDePared(-3_600_000)
  b.avanzar(1000)
  assert.equal(n, 3)
  assert.equal(b.reloj.marca(), 1000 + 1500 - 3_600_000)
})

test('si la hora de pared salta hacia adelante no dispara ticks de más', () => {
  const b = banco()
  let n = 0
  b.reloj.suscribir(() => n++, 500)
  b.saltarHoraDePared(3_600_000)
  b.avanzar(1000)
  assert.equal(n, 2)
})
