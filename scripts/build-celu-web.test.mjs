import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PAGINA_HTML } from '../src/main/features/celular-pagina.ts'
import { armarIndex } from './build-celu-web.mjs'

test('armarIndex: rutas relativas, remoto.js antes de app.js y CSP', () => {
  const h = armarIndex(PAGINA_HTML)
  assert.ok(!h.includes('"/app.js"'))
  assert.ok(!/(?:href|src)="\//.test(h))
  assert.ok(h.indexOf('./remoto.js') > 0 && h.indexOf('./remoto.js') < h.indexOf('./app.js'))
  assert.match(h, /Content-Security-Policy" content="default-src 'none'; script-src 'self'/)
  assert.match(h, /href="\.\/remoto\.css"/)
  assert.match(h, /href="\.\/manifest\.webmanifest"/)
})

test('armarIndex falla si la página de Mateo cambió y no encuentra su texto', () => {
  assert.throws(() => armarIndex(PAGINA_HTML.replace('<script src="/app.js"></script>', '')), /app\.js/)
})
