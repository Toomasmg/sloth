import { test } from 'node:test'
import assert from 'node:assert/strict'
import { page } from './chat-auth'

test('la página de éxito muestra el ícono de ok y cómo seguir', () => {
  const html = page('Listo, ya iniciaste sesión', 'Tu cuenta quedó conectada.', 'ok')
  assert.match(html, /<main class="ok"/)
  assert.match(html, /Ya podés cerrar esta pestaña/)
  assert.match(html, /prefers-color-scheme:light/)
})

test('la página de error escapa el texto que viene del proveedor y no tiene scripts', () => {
  const html = page('No se pudo iniciar sesión', '<script>alert(1)</script>')
  assert.match(html, /<main class="bad"/)
  assert.doesNotMatch(html, /<script/)
  assert.match(html, /&#60;script&#62;/)
})
