import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crearActividad, dispositivoDe } from './celular-actividad'

const ANDROID = 'Mozilla/5.0 (Linux; Android 13; SM-G965F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

test('dispositivoDe reconoce los celus comunes y no rompe con lo raro', () => {
  assert.equal(dispositivoDe(ANDROID), 'Android · Chrome')
  assert.equal(dispositivoDe(IPHONE), 'iPhone · Safari')
  assert.equal(dispositivoDe('Mozilla/5.0 (iPhone) CriOS/120 Safari/604'), 'iPhone · Chrome')
  assert.equal(dispositivoDe('Mozilla/5.0 (Linux; Android 13) SamsungBrowser/23.0 Chrome/115 Safari/537'), 'Android · Samsung Internet')
  assert.equal(dispositivoDe(''), 'Otro · navegador')
})

test('un celu nuevo avisa una vez; mientras sigue consultando no, y al volver tras un rato sí', () => {
  const a = crearActividad({ activoMs: 20_000, regresoMs: 600_000 })
  const q = { ip: '192.168.0.23', ua: ANDROID }
  assert.equal(a.visto(q, 1000), true)
  assert.equal(a.visto(q, 2500), false)
  assert.equal(a.visto(q, 4000), false)
  assert.deepEqual(a.conectados(5000), [{ dispositivo: 'Android · Chrome', ip: '192.168.0.23', desde: 1000, ultimo: 4000 }])
  assert.deepEqual(a.conectados(4000 + 20_000), [], 'sin consultar 20 s deja de estar conectado')
  assert.equal(a.visto(q, 4000 + 600_000), true, 'volvió después de 10 min')
  assert.deepEqual(
    a.eventos().map((e) => [e.tipo, e.celu]),
    [
      ['conecto', 'Android · Chrome'],
      ['conecto', 'Android · Chrome']
    ]
  )
})

test('dos celus en la misma IP (o la misma red) se cuentan aparte', () => {
  const a = crearActividad()
  assert.equal(a.visto({ ip: '192.168.0.23', ua: ANDROID }, 1), true)
  assert.equal(a.visto({ ip: '192.168.0.23', ua: IPHONE }, 2), true)
  assert.equal(a.conectados(3).length, 2)
})

test('las escrituras seguidas en la misma terminal son un solo evento con cuántas veces; otra terminal o un permiso, otro', () => {
  const a = crearActividad({ juntarMs: 60_000 })
  const q = { ip: '10.0.0.5', ua: IPHONE }
  assert.equal(a.anotar(q, 'escribio', 'web', 1000), true)
  assert.equal(a.anotar(q, 'escribio', 'web', 2000), false)
  assert.equal(a.anotar(q, 'escribio', 'web', 3000), false)
  assert.equal(a.anotar(q, 'escribio', 'api', 4000), true)
  assert.equal(a.anotar(q, 'aprobo', 'api', 5000), true)
  assert.equal(a.anotar(q, 'escribio', 'api', 5000 + 61_000), true, 'pasado el minuto, evento nuevo')
  const ev = a.eventos()
  assert.deepEqual(
    ev.map((e) => [e.tipo, e.espacio, e.veces ?? 1]),
    [
      ['escribio', 'api', 1],
      ['aprobo', 'api', 1],
      ['escribio', 'api', 1],
      ['escribio', 'web', 3]
    ]
  )
  assert.equal(ev[3].at, 3000, 'la hora es la de la última escritura')
  assert.ok(!JSON.stringify(ev).includes('echo'), 'no guarda contenidos')
})

test('el registro tiene tope y olvidarCelus no lo borra', () => {
  const a = crearActividad({ maxEventos: 3 })
  const q = { ip: '10.0.0.5', ua: IPHONE }
  a.visto(q, 1)
  for (let i = 0; i < 5; i++) a.anotar(q, 'aprobo', `ws${i}`, 10 + i)
  assert.deepEqual(
    a.eventos().map((e) => e.espacio),
    ['ws4', 'ws3', 'ws2']
  )
  a.olvidarCelus()
  assert.deepEqual(a.conectados(20), [])
  assert.equal(a.eventos().length, 3)
  assert.equal(a.visto(q, 30), true, 'después de regenerar, entrar de nuevo avisa')
})
