import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConectorMcp } from '../../../../main/features/tickets/conector'
import { jsonCanonico, validarPropio } from '../../../../main/features/tickets/propios'
import { aDef, argsPorDefecto, borradorNuevo, conHerramientas, deDef, revisarId, seEditaSinPerder, slugId, validarBorrador, type Borrador } from './borrador'

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

function externo(): ConectorMcp {
  return {
    id: 'mi-tracker',
    nombre: 'Mi Tracker',
    via: 'mcp',
    verificado: false,
    idRegex: '^trk-[0-9]{1,6}$',
    idMayusculas: false,
    personaId: '^[0-9a-f]{6}:[0-9a-f-]{8,40}$',
    ejemplo: { id: 'trk-12', estado: 'en_curso', prioridad: 'alta', proyecto: 'Web' },
    estados: [
      { clave: 'abierto', nombre: 'Abierto', categoria: 'pendiente' },
      { clave: 'en_curso', nombre: 'En curso', categoria: 'en_curso' },
      { clave: 'cerrado', nombre: 'Cerrado', categoria: 'hecho' }
    ],
    faltaConector: { clave: 'sin_tracker', mensaje: 'Esta cuenta no tiene Mi Tracker.' },
    herramientas: {
      prefijo: 'mcp__claude_ai_Tracker__',
      lista: ['get_me', 'search_issues'],
      detalle: ['get_issue', 'list_comments'],
      escritura: { estado: 'transition_issue', comentar: 'add_comment' },
      negar: ['delete_issue', 'create_issue'],
      apoyo: ['get_sites'],
      apoyoEn: { estado: ['get_transitions'], comentar: ['search_issues'] }
    },
    pistas: {
      yo: { conId: 'Sos {id}.', sinId: 'Sos el de get_me.' },
      lista: 'Traé los abiertos.',
      estados: 'Los estados salen de get_transitions.',
      detalle: [
        { herramienta: 'get_issue', args: { cloudId: 'abc', issueKey: '{ticket}' } },
        { herramienta: 'list_comments', args: { issue: { key: '{ticket}' }, max: 20 } },
        { herramienta: 'get_issue', args: { issueKey: '{ticket}', expand: 'changelog' } }
      ],
      apoyo: 'Sacá el sitio de {ticket} con get_sites.',
      acciones: {
        estado: { args: { issueKey: '{ticket}', transition: { id: '{estado}' }, notify: false, extra: null }, nota: 'Usá get_transitions antes.' },
        comentar: { args: { issueKey: '{ticket}', body: '{cuerpo}', cloudId: 'abc' } }
      }
    }
  }
}

test('un conector de afuera pasa por el asistente sin perder nada', () => {
  const def = validarPropio(externo())
  assert.equal(jsonCanonico(validarPropio(aDef(deDef(def as ConectorMcp)))), jsonCanonico(def))
  assert.equal(seEditaSinPerder(def as ConectorMcp), true)
})

test('editar con el asistente cambia solo lo que se tocó', () => {
  const b = deDef(externo())
  b.nombre = 'Otro nombre'
  b.acciones.comentar = { ...b.acciones.comentar!, args: { ticket: 'key', cuerpo: 'text' } }
  const d = aDef(b)
  assert.equal(d.personaId, externo().personaId)
  assert.deepEqual(d.herramientas.apoyoEn, externo().herramientas.apoyoEn)
  assert.deepEqual(d.pistas.acciones.comentar?.args, { cloudId: 'abc', key: '{ticket}', text: '{cuerpo}' })
  assert.deepEqual(d.pistas.acciones.estado, externo().pistas.acciones.estado)
  assert.deepEqual(d.pistas.detalle, externo().pistas.detalle)
  assert.equal(d.faltaConector.clave, 'sin_mi_tracker')
})

test('un conector con una herramienta en dos roles no se edita con el asistente', () => {
  const def = externo()
  def.herramientas.apoyo = ['search_issues']
  def.herramientas.apoyoEn = { estado: ['get_transitions'] }
  assert.equal(seEditaSinPerder(validarPropio(def) as ConectorMcp), false)
})
