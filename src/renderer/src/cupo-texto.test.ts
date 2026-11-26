import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calcularCupo } from '../../shared/cupo'
import { textoCupo } from './cupo-texto'

const H = 60 * 60 * 1000
const ahora = Date.UTC(2026, 10, 26, 21, 0)
const fmt = (n: number): string => `${n / 1000}k`

test('textoCupo: con tope muestra porcentaje, «est.» y hora de renovación', () => {
  const c = calcularCupo({ inicio: ahora - H, fin: ahora + 4 * H, tokens: 820_000 }, 1_000_000, ahora)
  const t = textoCupo(c, ahora, fmt, 'UTC')
  assert.equal(t.corto, '82 % est. · renueva mañana 01:00')
  assert.match(t.etiqueta, /uso estimado 82 por ciento.*se renueva mañana 01:00/)
  assert.match(t.largo, /820k de 1000k/)
  assert.match(t.largo, /estimación/)
})

test('textoCupo: sin uso no inventa porcentaje ni hora', () => {
  const t = textoCupo(calcularCupo(undefined, 1_000_000, ahora), ahora, fmt, 'UTC')
  assert.equal(t.corto, 'Sin uso en 5 h')
})

test('textoCupo: sin tope muestra los tokens y dice qué hacer', () => {
  const c = calcularCupo({ inicio: ahora - H, fin: ahora + 4 * H, tokens: 5000 }, 0, ahora)
  const t = textoCupo(c, ahora, fmt, 'UTC')
  assert.equal(t.corto, '5k · sin tope')
  assert.match(t.largo, /Configuración → Cuentas/)
})

test('textoCupo: al tope lo dice con palabras para el lector de pantalla', () => {
  const c = calcularCupo({ inicio: ahora, fin: ahora + 5 * H, tokens: 2_000_000 }, 1_000_000, ahora)
  assert.match(textoCupo(c, ahora, fmt, 'UTC').etiqueta, /al tope/)
})
