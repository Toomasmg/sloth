import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ayudaPrimerMensaje } from './primer-mensaje-texto'

test('Claude, o sin cuenta elegida, dice que se manda solo', () => {
  const claude = 'Se manda solo la primera vez que se abre el espacio.'
  assert.equal(ayudaPrimerMensaje(undefined), claude)
  assert.equal(ayudaPrimerMensaje({}), claude)
  assert.equal(ayudaPrimerMensaje({ proveedor: 'claude' }), claude)
})

test('Codex sigue con su texto de «no siempre»', () => {
  assert.equal(
    ayudaPrimerMensaje({ proveedor: 'codex' }),
    'Con Codex Sloth no siempre puede mandarlo solo (depende de cómo esté instalado y de la terminal). Si no puede, te avisa y lo escribís a mano.'
  )
})

test('Copilot nombra a Copilot y dice que siempre es a mano, sin hablar de Codex', () => {
  const t = ayudaPrimerMensaje({ proveedor: 'copilot' })
  assert.match(t, /^Con GitHub Copilot Sloth todavía no puede mandarlo solo/)
  assert.match(t, /lo escribís a mano/)
  assert.equal(t.includes('Codex'), false)
  assert.equal(t.includes('no siempre'), false)
})

test('un agente que esta versión no conoce no se hace pasar por otro', () => {
  const t = ayudaPrimerMensaje({ proveedor: 'otro-agente' })
  assert.match(t, /^Con Agente desconocido/)
  assert.equal(t.includes('Codex'), false)
})
