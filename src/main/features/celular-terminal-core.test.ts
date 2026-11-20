import { test } from 'node:test'
import assert from 'node:assert/strict'
import { debeEsperar, leerPedidoTerminal, sinAutomaticas, sinSalida, tamanoActual, ESPERA_MAX_MS, MAX_DATOS_PESO, MAX_ESCRIBIR, MAX_VISOR_CHARS, nuevoVisor, pesoJson, ponerFoto, salidaDesde, sumarSalida, vencidos, type Visor } from './celular-terminal-core'
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

test('espera: entero de 0 al tope; cualquier otra cosa invalida el pedido', () => {
  assert.deepEqual(leerPedidoTerminal({ id: 'ws', desde: 4, espera: 0 }), { id: 'ws', desde: 4, espera: 0 })
  assert.deepEqual(leerPedidoTerminal({ id: 'ws', desde: 4, espera: 20000 }), { id: 'ws', desde: 4, espera: 20000 })
  assert.deepEqual(leerPedidoTerminal({ id: 'ws', desde: 4, espera: ESPERA_MAX_MS }), { id: 'ws', desde: 4, espera: ESPERA_MAX_MS })
  for (const mala of [-1, 1.5, NaN, Infinity, '5', true, null, [], {}, ESPERA_MAX_MS + 1, 1e9]) {
    assert.equal(leerPedidoTerminal({ id: 'ws', desde: 4, espera: mala }), null, String(mala))
  }
})

test('espera mayor que cero no se mezcla con escribir, tam ni soloEscribir', () => {
  assert.equal(leerPedidoTerminal({ id: 'ws', desde: 0, espera: 20000, escribir: 'ls' }), null)
  assert.equal(leerPedidoTerminal({ id: 'ws', desde: 0, espera: 1, tam: 'pc' }), null)
  assert.equal(leerPedidoTerminal({ id: 'ws', desde: 0, espera: 20000, tam: { cols: 60, rows: 30 }, soloEscribir: true }), null)
  assert.deepEqual(leerPedidoTerminal({ id: 'ws', desde: 0, espera: 0, escribir: 'ls' }), { id: 'ws', desde: 0, espera: 0, escribir: 'ls' })
})

test('soloEscribir: solo true, y solo con algo que escribir o un tamaño', () => {
  assert.deepEqual(leerPedidoTerminal({ id: 'ws', desde: 0, soloEscribir: true, escribir: 'a' }), { id: 'ws', desde: 0, escribir: 'a', soloEscribir: true })
  assert.deepEqual(leerPedidoTerminal({ id: 'ws', desde: 0, soloEscribir: true, tam: 'pc' }), { id: 'ws', desde: 0, tam: 'pc', soloEscribir: true })
  for (const mala of [false, 1, 'true', null, {}]) {
    assert.equal(leerPedidoTerminal({ id: 'ws', desde: 0, soloEscribir: mala, escribir: 'a' }), null, String(mala))
  }
  assert.equal(leerPedidoTerminal({ id: 'ws', desde: 0, soloEscribir: true }), null)
  assert.equal(leerPedidoTerminal({ id: 'ws', desde: 0, soloEscribir: true, espera: 0 }), null)
})

test('sesion y n van juntos, validados, y solo con una escritura', () => {
  const ok = { id: 'ws', desde: 0, escribir: 'a', sesion: 'abcDEF12', n: 7 }
  assert.deepEqual(leerPedidoTerminal(ok), ok)
  assert.deepEqual(leerPedidoTerminal({ id: 'ws', desde: 0, tam: 'pc', sesion: 'a_b-c_d-e', n: 1 }), { id: 'ws', desde: 0, tam: 'pc', sesion: 'a_b-c_d-e', n: 1 })
  assert.equal(leerPedidoTerminal({ ...ok, sesion: undefined }), null, 'n sin sesion')
  assert.deepEqual(leerPedidoTerminal({ id: 'ws', desde: 0, espera: 20000, sesion: 'abcDEF12' }), { id: 'ws', desde: 0, espera: 20000, sesion: 'abcDEF12' }, 'sesion sola (el mirar)')
  for (const mala of ['corta', 'x'.repeat(41), 'con espacio1', 'ñandúñandú', 7, null, '../../etc']) {
    assert.equal(leerPedidoTerminal({ ...ok, sesion: mala }), null, String(mala))
  }
  for (const mala of [0, -1, 1.5, NaN, '7', 1_000_000_001, true, null]) {
    assert.equal(leerPedidoTerminal({ ...ok, n: mala }), null, String(mala))
  }
  assert.equal(leerPedidoTerminal({ id: 'ws', desde: 0, sesion: 'abcDEF12', n: 1 }), null, 'n sin nada que escribir')
  assert.equal(leerPedidoTerminal({ id: 'ws', desde: 0, espera: 5, sesion: 'abcDEF12', n: 1 }), null)
})

test('el pedido de antes, sin los campos nuevos, sigue valiendo y no los inventa', () => {
  const p = leerPedidoTerminal({ id: 'ws', desde: 2, escribir: 'x' })
  assert.deepEqual(p, { id: 'ws', desde: 2, escribir: 'x' })
  assert.ok(p && !('espera' in p) && !('soloEscribir' in p) && !('n' in p))
})

test('vencen los visores que nadie consulta', () => {
  const m = new Map([['a', nuevoVisor(0)], ['b', nuevoVisor(25_000)]])
  assert.deepEqual(vencidos(m, 40_000), ['a'])
})

test('el tamaño es el de la PC; el celu no lo cambia', () => {
  assert.deepEqual(tamanoActual({ cols: 120, rows: 30 }), { cols: 120, rows: 30 })
  assert.deepEqual(tamanoActual(null), { cols: 80, rows: 24 })
})

const E = '\x1b'
const AUTOMATICAS: [string, string][] = [
  ['posición del cursor', `${E}[24;80R`],
  ['posición con ?', `${E}[?24;80R`],
  ['atributos primarios', `${E}[?1;2c`],
  ['atributos secundarios', `${E}[>0;276;0c`],
  ['modo reportado', `${E}[?2004;2$y`],
  ['modo ANSI reportado', `${E}[4;2$y`],
  ['estado del dispositivo', `${E}[0n`],
  ['estado con ?', `${E}[?0n`],
  ['tamaño en caracteres', `${E}[8;24;80t`],
  ['foco adentro', `${E}[I`],
  ['foco afuera', `${E}[O`],
  ['mouse SGR apretado', `${E}[<0;39;19M`],
  ['mouse SGR soltado', `${E}[<0;39;19m`],
  ['mouse SGR botón derecho', `${E}[<2;3;4M`],
  ['posición en la fila 1 con columna de dos cifras', `${E}[1;12R`],
  ['posición en la fila 1 con columna 9', `${E}[1;9R`],
  ['posición en la fila 2', `${E}[2;3R`],
  ['mouse X10', `${E}[M !!`],
  ['color por OSC con BEL', `${E}]10;rgb:e8e8/eaea/eded\x07`],
  ['color por OSC con ST', `${E}]11;rgb:0b0b/0d0d/1010${E}\\`],
  ['DECRQSS', `${E}P1$r0m${E}\\`]
]

test('lo que el xterm del celu contesta solo se saca, sin importar dónde venga', () => {
  for (const [nombre, sec] of AUTOMATICAS) {
    assert.equal(sinAutomaticas(sec), '', nombre)
    assert.equal(sinAutomaticas(`ls${sec}\r`), 'ls\r', `${nombre} entre teclas`)
    assert.equal(sinAutomaticas(sec + sec), '', `${nombre} repetida`)
  }
  assert.equal(sinAutomaticas(AUTOMATICAS.map(([, s]) => s).join('') + 'x'), 'x')
})

test('las teclas de verdad pasan tal cual', () => {
  const teclas = [
    'hola', 'ñandú é', '\r', '\x7f', '\x03', E, '\t', `${E}[Z`, `${E}[A`, `${E}[B`, `${E}[C`, `${E}[D`, `${E}[H`, `${E}[F`,
    `${E}[1;5C`, `${E}[3~`, `${E}[5~`, `${E}OP`, `${E}[15~`, `${E}f`, `${E}[u`, `${E}[27;5;13~`, '😀', 'ESC[I sin ESC'
  ]
  for (const t of teclas) assert.equal(sinAutomaticas(t), t, JSON.stringify(t))
  assert.equal(sinAutomaticas(teclas.join('')), teclas.join(''))
})

test('un pegado entre corchetes no se toca por dentro', () => {
  const pegado = `${E}[200~hola ${E}[I ${E}[24;80R chau${E}[201~`
  assert.equal(sinAutomaticas(pegado), pegado)
  assert.equal(sinAutomaticas(`${E}[I${pegado}${E}[O`), pegado)
  assert.equal(sinAutomaticas(`${E}[200~sin cierre ${E}[I`), `${E}[200~sin cierre ${E}[I`)
})

test('sinAutomaticas solo quita: nunca agrega ni reordena', () => {
  const entradas = ['', 'a', `a${E}[Ib${E}[<0;1;1Mc${E}[24;80R`, `${E}[`, `${E}[24;`, `${E}]10;sin cerrar`, `${E}[200~${E}[I${E}[201~${E}[O`]
  for (const e of entradas) {
    const r = sinAutomaticas(e)
    let i = 0
    for (const c of r) {
      i = e.indexOf(c, i)
      assert.ok(i >= 0, `${JSON.stringify(r)} sale de ${JSON.stringify(e)}`)
      i++
    }
    assert.ok(r.length <= e.length)
  }
  assert.equal(sinAutomaticas(`${E}[24;`), `${E}[24;`, 'una secuencia a medias no se toca')
})

test('sinAutomaticas es idempotente: al sacar una secuencia no queda otra armada con los restos', () => {
  assert.equal(sinAutomaticas(`${E}[${E}[II`), '')
  assert.equal(sinAutomaticas(`${E}[<${E}[O0;1;1M`), '')
  const entradas = ['', 'hola', `${E}[${E}[II`, `${E}[2${E}[I4;80R`, `${E}[${E}[${E}[III`, `a${E}]1${E}[O0;?\x07b`, `${E}[200~${E}[I${E}[201~`]
  for (const e of entradas) {
    const r = sinAutomaticas(e)
    assert.equal(sinAutomaticas(r), r, JSON.stringify(e))
  }
})

test('lo que se podría confundir con una respuesta pero lo tipea el usuario pasa: F3 con modificador y la rueda del mouse', () => {
  for (let mod = 2; mod <= 8; mod++) assert.equal(sinAutomaticas(`${E}[1;${mod}R`), `${E}[1;${mod}R`, `F3 con modificador ${mod}`)
  for (const rueda of [`${E}[<64;3;4M`, `${E}[<65;30;4M`]) assert.equal(sinAutomaticas(rueda), rueda)
  assert.equal(sinAutomaticas(`${E}[<640;3;4M`), '', '640 no es la rueda')
  assert.equal(sinAutomaticas(`${E}[?1;2R`), '', 'con ? es una posición')
})

test('Esc y «[I» juntos no se distinguen de un reporte de foco: la PC los saca, por eso la página no los junta', () => {
  assert.equal(sinAutomaticas(`${E}[I`), '')
  assert.equal(sinAutomaticas(`${E}`), E)
  assert.equal(sinAutomaticas('[I'), '[I')
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

test('el mirar queda abierto solo si no hay nada nuevo, la terminal vive y no es la primera pantalla', () => {
  const vacio = { reinicio: false, datos: '' }
  const mirar = { id: 'ws', desde: 5, espera: 20000 }
  assert.equal(debeEsperar(mirar, vacio, true), true)
  assert.equal(debeEsperar(mirar, { reinicio: false, datos: 'hola' }, true), false, 'hay salida: se responde ya')
  assert.equal(debeEsperar(mirar, { reinicio: true, datos: '' }, true), false, 'reinicio: se responde ya')
  assert.equal(debeEsperar(mirar, vacio, false), false, 'cerrada: se avisa ya')
  assert.equal(debeEsperar({ ...mirar, desde: -1 }, vacio, true), false, 'primera vez')
  assert.equal(debeEsperar({ id: 'ws', desde: 5 }, vacio, true), false, 'sin espera: como antes')
  assert.equal(debeEsperar({ id: 'ws', desde: 5, espera: 0 }, vacio, true), false)
  assert.equal(debeEsperar({ ...mirar, soloEscribir: true, escribir: 'a' }, vacio, true), false)
})

test('sin salida: sigue desde donde estaba el celu', () => {
  assert.deepEqual(sinSalida({ id: 'ws', desde: 12 }), { reinicio: false, datos: '', hasta: 12, mas: false })
})
