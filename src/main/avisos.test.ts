import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { alAvisar, avisar, avisoArchivoApartado, tomarAvisos } from './avisos'

test('cada aviso se entrega una sola vez, sin repetidos, y avisa a los oyentes', () => {
  tomarAvisos()
  let llamadas = 0
  const soltar = alAvisar(() => llamadas++)
  avisar('uno')
  avisar('uno')
  avisoArchivoApartado(join('u', 'features', 'git.json'), join('u', 'features', 'git.json.corrupt-1'))
  soltar()
  avisar('dos')
  assert.equal(llamadas, 2)
  assert.deepEqual(tomarAvisos(), [
    'uno',
    'Encontré un archivo de configuración dañado (git.json); lo guardé como git.json.corrupt-1 y seguí con valores por defecto.',
    'dos'
  ])
  assert.deepEqual(tomarAvisos(), [])
})
