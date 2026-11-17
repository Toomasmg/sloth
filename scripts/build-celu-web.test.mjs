import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

test('npm run build:celu-web arma la página (Node a secas tiene que poder importar celular-pagina.ts)', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const r = spawnSync(pkg.scripts['build:celu-web'], { shell: true, cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(new URL('../out/celu-web/index.html', import.meta.url)))
})
