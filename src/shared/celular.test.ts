import { test } from 'node:test'
import assert from 'node:assert/strict'
import { textoEvento } from './celular'

test('textoEvento dice qué hizo el celu y dónde, sin contenidos', () => {
  const base = { at: 1, celu: 'Android · Chrome', ip: '192.168.0.23' }
  assert.equal(textoEvento({ ...base, tipo: 'conecto' }), 'Se conectó')
  assert.equal(textoEvento({ ...base, tipo: 'aprobo', espacio: 'api' }), 'Aprobó un permiso en api')
  assert.equal(textoEvento({ ...base, tipo: 'rechazo', espacio: 'api' }), 'Rechazó un permiso en api')
  assert.equal(textoEvento({ ...base, tipo: 'abrio', espacio: 'web' }), 'Abrió la terminal de web')
  assert.equal(textoEvento({ ...base, tipo: 'escribio', espacio: 'web' }), 'Escribió en la terminal de web')
  assert.equal(textoEvento({ ...base, tipo: 'escribio', espacio: 'web', veces: 12 }), 'Escribió en la terminal de web (12 veces)')
})
