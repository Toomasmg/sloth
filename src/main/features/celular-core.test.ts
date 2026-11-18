import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AccountUsage, AgentStatus } from '../../shared/types'
import { aMs, claveValida, armarEstado, debeAvisar, elegirIp, leerLimites, puertoValido, resumenPermiso, servidorNtfy, temaValido, textoAviso, tokenNtfyTras, tokenNtfyValido, type Entrada } from './celular-core'

const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal })

test('elegirIp prefiere el Wi-Fi y descarta lo virtual, lo interno y lo público', () => {
  assert.equal(
    elegirIp({
      'vEthernet (WSL)': [v4('172.20.0.1')],
      'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
      Ethernet: [v4('192.168.0.20')],
      'Wi-Fi': [{ address: 'fe80::1', family: 'IPv6', internal: false }, v4('192.168.0.31')]
    }),
    '192.168.0.31'
  )
  assert.equal(elegirIp({ Ethernet: [v4('10.0.0.5')], Otra: [v4('8.8.8.8')] }), '10.0.0.5')
  assert.equal(elegirIp({ 'Conexión de red inalámbrica': [{ address: '172.16.4.2', family: 4, internal: false }] }), '172.16.4.2')
  assert.equal(elegirIp({ 'VirtualBox Host-Only': [v4('192.168.56.1')] }), null)
  assert.equal(elegirIp({}), null)
})

test('claveValida acepta solo 32 bytes en base64url canónico', () => {
  assert.equal(claveValida('A'.repeat(43)), true)
  assert.equal(claveValida('A'.repeat(42)), false)
  assert.equal(claveValida('A'.repeat(44)), false)
  assert.equal(claveValida('A'.repeat(42) + '+'), false)
  assert.equal(claveValida('A'.repeat(42) + 'B'), false)
  assert.equal(claveValida(undefined), false)
  assert.equal(claveValida(123), false)
})

test('puerto y tema se validan', () => {
  assert.equal(puertoValido(47321), true)
  assert.equal(puertoValido(80), false)
  assert.equal(puertoValido(70000), false)
  assert.equal(puertoValido(4732.5), false)
  assert.equal(temaValido('sloth-' + 'a'.repeat(14)), true)
  assert.equal(temaValido('con espacio'), false)
  assert.equal(temaValido('a/b/c/d/e'), false)
  assert.equal(temaValido('ab'), false)
})

test('temaValido: 19 caracteres no, 20 sí, 65 no', () => {
  assert.equal(temaValido('a'.repeat(19)), false)
  assert.equal(temaValido('a'.repeat(20)), true)
  assert.equal(temaValido('a'.repeat(65)), false)
})

test('servidorNtfy: https sin credenciales, query ni hash; vacío es ntfy.sh', () => {
  assert.equal(servidorNtfy(undefined), 'https://ntfy.sh/')
  assert.equal(servidorNtfy(''), 'https://ntfy.sh/')
  assert.equal(servidorNtfy('https://ntfy.ejemplo.com'), 'https://ntfy.ejemplo.com/')
  assert.equal(servidorNtfy('https://ntfy.ejemplo.com/sub'), 'https://ntfy.ejemplo.com/sub/')
  assert.equal(servidorNtfy('http://ntfy.ejemplo.com/'), null)
  assert.equal(servidorNtfy('https://user@ntfy.ejemplo.com/'), null)
  assert.equal(servidorNtfy('https://user:pass@ntfy.ejemplo.com/'), null)
  assert.equal(servidorNtfy('https://ntfy.ejemplo.com/?x=1'), null)
  assert.equal(servidorNtfy('https://ntfy.ejemplo.com/#x'), null)
  assert.equal(servidorNtfy('no es una url'), null)
  assert.equal(servidorNtfy(5), null)
})

test('tokenNtfyValido', () => {
  assert.equal(tokenNtfyValido('tk_abc.DEF-123'), true)
  assert.equal(tokenNtfyValido(''), false)
  assert.equal(tokenNtfyValido('con espacio'), false)
  assert.equal(tokenNtfyValido('a\nb'), false)
  assert.equal(tokenNtfyValido('a'.repeat(201)), false)
  assert.equal(tokenNtfyValido(null), false)
})

test('aMs entiende segundos, milisegundos e ISO', () => {
  assert.equal(aMs(1_800_000_000), 1_800_000_000_000)
  assert.equal(aMs(1_800_000_000_000), 1_800_000_000_000)
  assert.equal(aMs('1800000000'), 1_800_000_000_000)
  assert.equal(aMs('2027-01-15T12:00:00Z'), Date.parse('2027-01-15T12:00:00Z'))
  assert.equal(aMs('mañana'), null)
  assert.equal(aMs(null), null)
})

test('leerLimites: sin archivo, roto o vencido queda «sin datos»', () => {
  const ahora = 1_800_000_000_000
  assert.deepEqual(leerLimites(null, ahora), { cincoHoras: null, semana: null, at: null })
  assert.deepEqual(leerLimites('{roto', ahora), { cincoHoras: null, semana: null, at: null })
  const r = leerLimites(
    JSON.stringify({ fiveHour: { pct: 72.4, resetsAt: (ahora + 3_600_000) / 1000 }, sevenDay: { pct: 41, resetsAt: (ahora - 1000) / 1000 }, at: ahora - 5000 }),
    ahora
  )
  assert.deepEqual(r.cincoHoras, { pct: 72.4, reiniciaEn: ahora + 3_600_000 })
  assert.equal(r.semana, null)
  assert.equal(r.at, ahora - 5000)
  assert.equal(leerLimites(JSON.stringify({ fiveHour: { pct: 130 } }), ahora).cincoHoras?.pct, 100)
  assert.equal(leerLimites(JSON.stringify({ fiveHour: { pct: '50' } }), ahora).cincoHoras, null)
})

const uso = (tokens: number, messages: number): AccountUsage => {
  const t = { input: tokens, output: 0, cacheWrite: 0, cacheRead: 0, messages }
  return { last5h: t, today: t, last7d: t, scannedAt: 0 }
}

function entrada(): Entrada {
  const agentes = new Map<string, AgentStatus>([
    ['w1', { state: 'working', detail: 'Bash', at: 100 }],
    ['w2', { state: 'done', at: 200 }],
    ['w3', { state: 'idle', at: 300 }]
  ])
  return {
    ahora: 1000,
    aprobar: false,
    cuentas: [
      { id: 'a', label: 'Fusion' },
      { id: 'b', label: 'Personal' }
    ],
    espacios: [
      { id: 'w1', name: 'web', accountId: 'a' },
      { id: 'w2', name: 'api', accountId: 'a' },
      { id: 'w3', name: 'docs', accountId: 'b' },
      { id: 'w4', name: 'sin terminal', accountId: 'b' }
    ],
    agentes,
    uso: { a: uso(1500, 12) },
    limites: { a: { cincoHoras: { pct: 50, reiniciaEn: null }, semana: null, at: 900 } },
    pedidos: [{ id: 'p1', ws: 'w1', texto: 'Bash: npm test', at: 950, expiresAt: 5000 }]
  }
}

test('armarEstado: un pedido pendiente pone al espacio en «te necesita» y ordena por urgencia', () => {
  const e = armarEstado(entrada())
  assert.deepEqual(
    e.sesiones.map((s) => [s.id, s.estado]),
    [
      ['w1', 'waiting'],
      ['w2', 'done'],
      ['w3', 'idle']
    ]
  )
  assert.deepEqual(e.pedidos, [{ id: 'p1', sesionId: 'w1', sesion: 'web', texto: 'Bash: npm test', desde: 950, vence: 5000 }])
})

test('armarEstado: una cuenta sin datos de límites ni uso queda en null, nunca en 0', () => {
  const e = armarEstado(entrada())
  const b = e.cuentas.find((c) => c.id === 'b')
  assert.deepEqual(b, { id: 'b', nombre: 'Personal', cincoHoras: null, semana: null, limitesLeidosEn: null, hoy: null })
  assert.deepEqual(e.cuentas[0].hoy, { tokens: 1500, mensajes: 12 })
})

test('armarEstado: no expone carpetas y descarta pedidos de espacios borrados', () => {
  const ent = entrada()
  ent.pedidos.push({ id: 'p2', ws: 'borrado', texto: 'x', at: 1, expiresAt: 2 })
  const e = armarEstado(ent)
  assert.equal(e.pedidos.length, 1)
  assert.ok(!JSON.stringify(e).includes('cwd'))
})

test('textoAviso no deja saltos de línea y corta lo largo', () => {
  assert.deepEqual(textoAviso('termino', 'web'), { titulo: 'web terminó', cuerpo: 'Claude terminó. Revisá los cambios antes de seguir.' })
  const p = textoAviso('permiso', 'api\nmala', 'Bash: ' + 'x'.repeat(500))
  assert.equal(p.titulo, 'api mala pide permiso')
  assert.ok(p.cuerpo.length <= 160)
  assert.equal(textoAviso('teNecesita', 'web', '').cuerpo, 'Claude necesita tu atención.')
  assert.deepEqual(textoAviso('termino', 'web', undefined, 'Codex'), { titulo: 'web terminó', cuerpo: 'Codex terminó. Revisá los cambios antes de seguir.' })
  assert.equal(textoAviso('teNecesita', 'web', '', 'Codex').cuerpo, 'Codex necesita tu atención.')
})

test('debeAvisar no repite el mismo aviso dentro de la ventana', () => {
  const m = new Map<string, number>()
  assert.equal(debeAvisar(m, 'w1:termino', 0), true)
  assert.equal(debeAvisar(m, 'w1:termino', 5000), false)
  assert.equal(debeAvisar(m, 'w2:termino', 5000), true)
  assert.equal(debeAvisar(m, 'w1:termino', 10_000), true)
})

test('resumenPermiso no lleva el comando ni la ruta', () => {
  assert.equal(resumenPermiso('cmd'), 'Claude quiere correr un comando.')
  assert.equal(resumenPermiso('edit'), 'Claude quiere editar archivos.')
  assert.equal(resumenPermiso('otra'), 'Claude quiere usar una herramienta.')
})

test('tokenNtfyTras: cambiar de servidor sin token nuevo borra el guardado', () => {
  const actual = { servidor: 'https://ntfy.miempresa.com/', token: 'tk_a' }
  assert.equal(tokenNtfyTras(actual, 'https://ntfy.miempresa.com/', undefined), 'tk_a')
  assert.equal(tokenNtfyTras(actual, 'https://ntfy.sh/', undefined), undefined)
  assert.equal(tokenNtfyTras(actual, 'https://ntfy.sh/', 'tk_b'), 'tk_b')
  assert.equal(tokenNtfyTras(actual, 'https://ntfy.miempresa.com/', null), undefined)
})
