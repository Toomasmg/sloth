import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aDef, argsPorDefecto, borradorNuevo, conHerramientas, deDef, revisarId, slugId, validarBorrador, type Borrador } from './borrador'

const HERRAMIENTAS = ['get_me', 'search_cards', 'get_card', 'create_card', 'update_card', 'delete_board']

function base(): Borrador {
  const b = borradorNuevo('Trello', 'mcp__claude_ai_Trello__', HERRAMIENTAS)
  b.herramientas = b.herramientas.map((h) => (h.nombre === 'search_cards' ? { ...h, rol: 'lista' } : h))
  b.acciones = { estado: { herramienta: 'update_card', args: argsPorDefecto('estado'), nota: '' } }
  return b
}

const roles = (b: Borrador): Record<string, string> => Object.fromEntries(b.herramientas.map((h) => [h.nombre, h.rol]))

test('un borrador con una herramienta de lista y la acción de estado da un conector válido', () => {
  const r = validarBorrador(base())
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.def.id, 'trello')
  assert.equal(r.def.verificado, false)
  assert.equal(r.def.via, 'mcp')
  if (r.def.via !== 'mcp') return
  assert.deepEqual(r.def.herramientas.lista, ['search_cards'])
  assert.deepEqual(r.def.herramientas.escritura, { estado: 'update_card' })
  assert.deepEqual(r.def.pistas.acciones.estado, { args: { id: '{ticket}', estado: '{estado}' } })
  assert.equal(r.def.ejemplo.estado, 'por_hacer')
})

test('las herramientas sin marcar quedan negadas; las de lectura y escritura no', () => {
  assert.deepEqual(aDef(base()).herramientas.negar, ['get_me', 'get_card', 'create_card', 'delete_board'])
})

test('marcar una herramienta de escritura como de lista no pasa', () => {
  const b = base()
  b.herramientas = b.herramientas.map((h) => (h.nombre === 'create_card' ? { ...h, rol: 'lista' } : h))
  const r = validarBorrador(b)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.ruta, /^conector\.herramientas\.lista\[\d+\]$/)
})

test('un ejemplo de id que no cumple el formato no pasa', () => {
  const b = { ...base(), ejemploId: 'abc' }
  const r = validarBorrador(b)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.ruta, 'conector.ejemplo.id')
  assert.equal(revisarId(b), 'El ejemplo no cumple el formato.')
  assert.equal(revisarId(base()), null)
})

test('deDef(aDef(b)) vuelve al mismo borrador', () => {
  const b = base()
  b.herramientas = b.herramientas.map((h) => (h.nombre === 'get_card' ? { ...h, rol: 'detalle' } : h.nombre === 'get_me' ? { ...h, rol: 'apoyo' } : h))
  b.detalleArg = { get_card: 'cardId' }
  b.pistas.apoyo = 'Usá get_me para saber tu id.'
  b.acciones.comentar = { herramienta: 'create_card', args: { ticket: 'card', cuerpo: '' }, nota: 'Comentá {ticket}' }
  b.formato = 'propio'
  b.regexPropia = '^[a-f0-9]{8}$'
  b.ejemploId = 'abcd1234'
  const vuelta = deDef(aDef(b))
  assert.deepEqual(roles(vuelta), roles(b))
  assert.deepEqual(vuelta.acciones, b.acciones)
  assert.deepEqual(vuelta.detalleArg, b.detalleArg)
  assert.equal(vuelta.formato, 'propio')
  assert.equal(vuelta.regexPropia, b.regexPropia)
  assert.deepEqual(vuelta.pistas, b.pistas)
  assert.equal(deDef(aDef(base())).formato, 'clave-numero')
})

test('buscar de nuevo conserva los roles y las acciones de las herramientas que siguen', () => {
  const b = conHerramientas(base(), ['search_cards', 'create_card', 'nueva'])
  assert.deepEqual(roles(b), { search_cards: 'lista', create_card: 'nada', nueva: 'nada' })
  assert.deepEqual(b.acciones, {})
})

test('slugId arma un id válido a partir del nombre', () => {
  assert.equal(slugId('Trello Ñandú'), 'trello-nandu')
  assert.equal(slugId('  3D Tablero!! '), 'd-tablero')
  assert.equal(slugId('X'), 'conector-x')
  assert.equal(slugId(''), 'conector')
  assert.ok(slugId('a'.repeat(50)).length <= 32)
})
