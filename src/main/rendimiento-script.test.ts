import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SCRIPT_JOB, scriptCodificado } from './rendimiento-script'
import { entornoJob, limitesDe } from '../shared/rendimiento-core'

test('el script lee del entorno cada variable que arma entornoJob, y nada viene dentro del código', () => {
  const e = entornoJob({ nombre: 'x', raiz: 1, incluirRaiz: true, excluir: '', limites: limitesDe({ ramMB: 0, nucleos: 0 }, 1000, 4), dueno: 1 })
  for (const v of Object.keys(e)) assert.match(SCRIPT_JOB, new RegExp(`\\$env:${v}\\b`))
  assert.equal(Buffer.from(scriptCodificado(), 'base64').toString('utf16le'), SCRIPT_JOB)
})
