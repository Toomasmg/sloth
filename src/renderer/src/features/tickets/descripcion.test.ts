import { test } from 'node:test'
import assert from 'node:assert/strict'
import { textoDescripcion } from './descripcion'

test('la descripción del detalle manda sobre la de la lista', () => {
  assert.equal(textoDescripcion({ descripcion: 'corta' }, { descripcion: 'larga' }, false, true, 'Gruv'), 'larga')
  assert.equal(textoDescripcion({ descripcion: 'corta' }, undefined, true, true, 'Gruv'), 'corta')
})

test('sin descripción no se culpa al conector: se carga o se manda a verla donde está', () => {
  assert.equal(textoDescripcion({}, undefined, true, true, 'Gruv'), 'Cargando la descripción…')
  assert.equal(textoDescripcion({}, undefined, false, true, 'Gruv'), 'La descripción se ve en Gruv.')
  assert.equal(textoDescripcion({}, {}, false, true, 'Gruv'), 'La descripción se ve en Gruv.')
  assert.equal(textoDescripcion({}, undefined, true, false, 'Linear'), 'La descripción se ve en Linear.')
})
