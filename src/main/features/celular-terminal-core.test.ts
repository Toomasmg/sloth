import { test } from 'node:test'
import assert from 'node:assert/strict'
import { leerPedidoTerminal, tamanoActual, MAX_DATOS_PESO, MAX_ESCRIBIR, MAX_VISOR_CHARS, nuevoVisor, pesoJson, ponerFoto, salidaDesde, sumarSalida, vencidos, type Visor } from './celular-terminal-core'
import { derivarClaves, sellarRespuesta, type Claves } from './celular-sello'

const c = (seq: number, data = `[${seq}]`) => ({ seq, data })

test('la foto se junta con lo que llegó en vivo mientras se pedía, sin repetir', () => {
  const v = nuevoVisor(0)
  sumarSalida(v, [c(4), c(5)])
  ponerFoto(v, [c(1), c(2), c(3), c(4)], 4)
  assert.deepEqual(v.chunks.map((x) => x.seq), [1, 2, 3, 4, 5])
  assert.equal(v.foto, 4)
})

test('la primera vez va todo; después, solo lo nuevo', () => {
  const v = nuevoVisor(0)
  ponerFoto(v, [c(1), c(2)], 2)
  assert.deepEqual(salidaDesde(v, -1), { reinicio: true, datos: '[1][2]', hasta: 2, mas: false })
  sumarSalida(v, [c(3)])
  assert.deepEqual(salidaDesde(v, 2), { reinicio: false, datos: '[3]', hasta: 3, mas: false })
  assert.deepEqual(salidaDesde(v, 3), { reinicio: false, datos: '', hasta: 3, mas: false })
})

test('si el celu pide algo ya recortado o de otro visor, se le manda todo de nuevo', () => {
  const v = nuevoVisor(0)
  ponerFoto(v, [c(10), c(11)], 11)
  assert.equal(salidaDesde(v, 3).reinicio, true)
  assert.equal(salidaDesde(v, 50).reinicio, true)
  assert.equal(salidaDesde(v, 9).reinicio, false)
})

test('el visor no pasa del tope, pero nunca queda vacío', () => {
  const v = nuevoVisor(0)
  ponerFoto(v, [c(1, 'x'.repeat(MAX_VISOR_CHARS)), c(2, 'y'.repeat(10))], 2)
  assert.deepEqual(v.chunks.map((x) => x.seq), [2])
  const w = nuevoVisor(0)
  sumarSalida(w, [c(1, 'z'.repeat(MAX_VISOR_CHARS + 5))])
  assert.equal(w.chunks.length, 1)
})

test('valida el pedido del celu', () => {
  assert.deepEqual(leerPedidoTerminal({ id: 'ws-1', desde: -1 }), { id: 'ws-1', desde: -1 })
  assert.deepEqual(leerPedidoTerminal({ id: 'ws-1', desde: 3, escribir: 'hola\r', tam: { cols: 60, rows: 30 } }), { id: 'ws-1', desde: 3, escribir: 'hola\r', tam: { cols: 60, rows: 30 } })
  assert.deepEqual(leerPedidoTerminal({ id: 'ws-1', desde: 0, tam: 'pc' }), { id: 'ws-1', desde: 0, tam: 'pc' })
  assert.equal(leerPedidoTerminal(null), null)
  assert.equal(leerPedidoTerminal({ id: '../x', desde: 0 }), null)
  assert.equal(leerPedidoTerminal({ id: 'login:abc', desde: 0 }), null)
  assert.equal(leerPedidoTerminal({ id: 'ws', desde: -2 }), null)
  assert.equal(leerPedidoTerminal({ id: 'ws', desde: 1.5 }), null)
  assert.equal(leerPedidoTerminal({ id: 'ws', desde: 0, escribir: '' }), null)
  assert.equal(leerPedidoTerminal({ id: 'ws', desde: 0, escribir: 'x'.repeat(MAX_ESCRIBIR + 1) }), null)
  assert.equal(leerPedidoTerminal({ id: 'ws', desde: 0, tam: { cols: 5, rows: 30 } }), null)
  assert.equal(leerPedidoTerminal({ id: 'ws', desde: 0, tam: 'grande' }), null)
})

test('vencen los visores que nadie consulta', () => {
  const m = new Map([['a', nuevoVisor(0)], ['b', nuevoVisor(25_000)]])
  assert.deepEqual(vencidos(m, 40_000), ['a'])
})

test('el tamaño: el del celu mientras la PC no se mueva; si la PC cambia, gana la PC', () => {
  const v = nuevoVisor(0)
  assert.deepEqual(tamanoActual(v, { cols: 120, rows: 30 }), { cols: 120, rows: 30 })
  assert.deepEqual(tamanoActual(undefined, null), { cols: 80, rows: 24 })
  v.ajustado = { cols: 45, rows: 40 }
  v.pcAlAjustar = { cols: 120, rows: 30 }
  assert.deepEqual(tamanoActual(v, { cols: 120, rows: 30 }), { cols: 45, rows: 40 })
  assert.deepEqual(tamanoActual(v, { cols: 140, rows: 30 }), { cols: 140, rows: 30 })
  assert.equal(v.ajustado, null)
})

const claves = derivarClaves(Buffer.alloc(32, 7).toString('base64url')) as Claves
const MAX_PAGINA = 262_144

/** Lo que el celu recibe de verdad: la respuesta sellada con el mismo JSON que arma celular.ts. */
const sellada = (r: ReturnType<typeof salidaDesde>): number => sellarRespuesta(claves, Buffer.alloc(16, 1), JSON.stringify({ ...r, viva: true, cols: 80, rows: 24, ajustado: false })).length

const ansi = (seq: number, n = 3000): { seq: number; data: string } => ({ seq, data: Array.from({ length: n }, (_, i) => `\x1b[3${(i % 7) + 1}mx`).join('') })
const visorDe = (chunks: { seq: number; data: string }[]): Visor => {
  const v = nuevoVisor(0)
  ponerFoto(v, chunks, chunks[chunks.length - 1].seq)
  return v
}

test('el peso es el que ocupa en el JSON: ESC 6, comilla y barra 2, tilde 2, caja 3, emoji 4', () => {
  for (const t of ['abc', '\x1b[0m', 'dijo "hola" y \\ \r\n\t', 'ñandú café', '─│╭╯', '😀👍', '\ud83d solo', '\u0001\u007f', '']) {
    assert.equal(pesoJson(t), Buffer.byteLength(JSON.stringify(t)) - 2, JSON.stringify(t))
  }
})

test('la foto inicial de una terminal llena de colores entra sellada en lo que acepta la página', () => {
  const v = visorDe([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((s) => ansi(s)))
  assert.ok(v.tam > 100_000)
  const completa = { reinicio: true, datos: v.chunks.map((c) => c.data).join(''), hasta: 10, mas: false }
  assert.ok(sellada(completa) > MAX_PAGINA, 'sin el tope, esta foto no la abre la página')
  const r = salidaDesde(v, -1)
  assert.equal(r.reinicio, true)
  assert.equal(r.hasta, 10)
  assert.ok(pesoJson(r.datos) <= MAX_DATOS_PESO)
  assert.ok(sellada(r) < 200_000, String(sellada(r)))
  assert.ok(r.datos.endsWith(ansi(10).data), 'lo último que pasó está')
})

test('la foto es la cola: se corta entre trozos, nunca a la mitad de uno', () => {
  const v = visorDe([1, 2, 3, 4].map((s) => ({ seq: s, data: String(s).repeat(40) })))
  const r = salidaDesde(v, -1, 100)
  assert.equal(r.datos, '3'.repeat(40) + '4'.repeat(40))
  assert.equal(r.hasta, 4)
})

test('un trozo gigante solo se manda truncado a su final', () => {
  const v = visorDe([{ seq: 1, data: 'a'.repeat(300) + 'FIN' }])
  const r = salidaDesde(v, -1, 100)
  assert.equal(r.datos.length, 100)
  assert.ok(r.datos.endsWith('FIN'))
  const w = visorDe([{ seq: 1, data: 'x' }, { seq: 2, data: 'b'.repeat(300) + 'FIN' }])
  const i = salidaDesde(w, 1, 100)
  assert.equal(i.reinicio, false)
  assert.equal(i.hasta, 2)
  assert.ok(i.datos.endsWith('FIN') && pesoJson(i.datos) <= 100)
  assert.equal(pesoJson(salidaDesde(visorDe([{ seq: 1, data: '😀'.repeat(100) }]), -1, 21).datos), 20, 'un emoji no se parte')
})

test('las respuestas comunes siguen de donde quedó la anterior: sin huecos ni repetidos', () => {
  const chunks = Array.from({ length: 40 }, (_, i) => ({ seq: i + 1, data: `<${i + 1}>${'ñ'.repeat(i % 7 === 0 ? 90 : 10)}` }))
  const v = visorDe(chunks)
  let desde = 0
  let juntado = ''
  let vueltas = 0
  for (;;) {
    const r = salidaDesde(v, desde, 200)
    assert.equal(r.reinicio, false)
    juntado += r.datos
    assert.ok(r.hasta > desde || !r.mas)
    desde = r.hasta
    vueltas++
    if (!r.mas) break
    assert.ok(vueltas < 100)
  }
  assert.equal(juntado, chunks.map((c) => c.data).join(''))
  assert.ok(vueltas > 3)
  assert.equal(desde, 40)
  assert.deepEqual(salidaDesde(v, 40, 200), { reinicio: false, datos: '', hasta: 40, mas: false })
})

test('lo que llega en vivo mientras el celu va por partes se suma sin perder nada', () => {
  const v = visorDe([1, 2, 3].map((s) => ({ seq: s, data: String(s).repeat(30) })))
  const a = salidaDesde(v, 0, 70)
  assert.deepEqual([a.hasta, a.mas], [2, true])
  sumarSalida(v, [{ seq: 4, data: '4'.repeat(30) }])
  const b = salidaDesde(v, a.hasta, 70)
  const c = salidaDesde(v, b.hasta, 70)
  assert.equal(a.datos + b.datos + c.datos, '1'.repeat(30) + '2'.repeat(30) + '3'.repeat(30) + '4'.repeat(30))
  assert.equal(c.mas, false)
})

test('un desde fuera de rango o sin salida no rompe nada', () => {
  const vacio = nuevoVisor(0)
  assert.deepEqual(salidaDesde(vacio, -1), { reinicio: true, datos: '', hasta: 0, mas: false })
  assert.deepEqual(salidaDesde(vacio, 0), { reinicio: false, datos: '', hasta: 0, mas: false })
  const v = visorDe([c(10), c(11)])
  assert.equal(salidaDesde(v, 99).reinicio, true)
  assert.equal(salidaDesde(v, 99).hasta, 11)
  assert.equal(salidaDesde(v, 1).reinicio, true)
})

test('en el peor caso del visor (150000 caracteres de puros ESC) la respuesta sellada queda bajo el límite', () => {
  const peor = visorDe([{ seq: 1, data: '\x1b'.repeat(MAX_VISOR_CHARS) }])
  assert.ok(sellada(salidaDesde(peor, -1)) < 200_000)
  const cajas = visorDe([{ seq: 1, data: '─'.repeat(MAX_VISOR_CHARS) }])
  assert.ok(sellada(salidaDesde(cajas, -1)) < 200_000)
  const incremental = visorDe([{ seq: 1, data: 'a' }, ansi(2, 20_000), ansi(3, 20_000)])
  assert.ok(sellada(salidaDesde(incremental, 1)) < 200_000)
})
