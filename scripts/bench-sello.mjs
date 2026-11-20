// Banco del sello del celu: cuánto tarda el JS puro del navegador en sellar un pedido y abrir una respuesta.
// Corre en Node (no en un celu: en un celu lento da varias veces más). Uso:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/test-hooks.mjs scripts/bench-sello.mjs
import assert from 'node:assert/strict'
import { randomBytes, webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { SELLO_JS } from '../src/main/features/celular-sello-web.ts'
import { derivarClaves, sellarRespuesta } from '../src/main/features/celular-sello.ts'

const CALENTAMIENTO = 20
const MEDIDAS = 200
const TAMANOS_KB = [1, 20, 120]

function cargar() {
  const ventana = {}
  runInNewContext(SELLO_JS, { window: ventana, crypto: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) } })
  assert.ok(ventana.slothSello)
  return ventana.slothSello
}

export function percentil(xs, p) {
  const o = [...xs].sort((a, b) => a - b)
  return o[Math.max(0, Math.ceil(p * o.length) - 1)]
}

function medir(fn) {
  for (let i = 0; i < CALENTAMIENTO; i++) fn()
  const ms = []
  for (let i = 0; i < MEDIDAS; i++) {
    const t = performance.now()
    fn()
    ms.push(performance.now() - t)
  }
  const ms2 = (n) => Math.round(n * 100) / 100
  return { p50: ms2(percentil(ms, 0.5)), p95: ms2(percentil(ms, 0.95)) }
}

function jsonDe(kb) {
  const linea = 'x'.repeat(40) + '\\u001b[31m'
  let datos = ''
  while (datos.length < kb * 1024) datos += linea
  return JSON.stringify({ ok: true, viva: true, desde: 0, hasta: 1, datos: datos.slice(0, kb * 1024 - 60) })
}

const web = cargar()
const clave = randomBytes(32).toString('base64url')
const cw = web.abrirClave(clave)
const cn = derivarClaves(clave)
assert.ok(cw && cn)

const resultado = { nodo: process.version, sellarPedido80B: medir(() => web.sellarPedido(cw, '/api/terminal', { id: 'ws-web', desde: 123, escribir: 'a'.repeat(40) })), abrirRespuesta: {} }

for (const kb of TAMANOS_KB) {
  const json = jsonDe(kb)
  const iv = randomBytes(16)
  const sobre = sellarRespuesta(cn, iv, json)
  const ivWeb = new Uint8Array(iv)
  assert.equal(web.abrirRespuesta(cw, ivWeb, sobre), json, `lo abierto de ${kb} KB no iguala al original`)
  resultado.abrirRespuesta[`${kb}KB`] = { sobreBytes: sobre.length, ...medir(() => web.abrirRespuesta(cw, ivWeb, sobre)) }
}

console.log(JSON.stringify(resultado, null, 2))
