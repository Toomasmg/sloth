import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DICTADO_SCRIPT, dictadoArgs, errorDictado, limpiarTexto, parseLinea } from './dictado-core'

test('el script va codificado en UTF-16LE y vuelve igual', () => {
  const args = dictadoArgs()
  assert.equal(args[args.length - 2], '-EncodedCommand')
  assert.equal(Buffer.from(args[args.length - 1], 'base64').toString('utf16le'), DICTADO_SCRIPT)
  assert.ok(DICTADO_SCRIPT.includes("'IAsyncOperation`1'"))
})

test('parseLinea entiende los eventos del script', () => {
  assert.deepEqual(parseLinea('{"e":"escuchando"}'), { e: 'escuchando' })
  assert.deepEqual(parseLinea('{"e":"transcribiendo"}\r'), { e: 'transcribiendo' })
  assert.deepEqual(parseLinea('{"e":"fin"}'), { e: 'fin' })
  assert.deepEqual(parseLinea('{"t":"hola Claude","e":"texto"}'), { e: 'texto', t: 'hola Claude' })
  assert.deepEqual(parseLinea('{"code":"0x80045509","e":"error"}'), { e: 'error', code: '0x80045509' })
})

test('parseLinea ignora basura y textos vacíos', () => {
  assert.equal(parseLinea('#< CLIXML'), null)
  assert.equal(parseLinea('{"e":"otra"}'), null)
  assert.equal(parseLinea('{"e":"texto","t":"  "}'), null)
  assert.equal(parseLinea('null'), null)
})

test('el texto dictado no lleva caracteres de control: un \\r mandaría el mensaje', () => {
  assert.equal(limpiarTexto('hacé el\r\nticket\x1b[2J  ya '), 'hacé el ticket [2J ya')
  assert.equal(parseLinea(JSON.stringify({ e: 'texto', t: 'a\rb' }))?.e, 'texto')
  assert.deepEqual(parseLinea(JSON.stringify({ e: 'texto', t: 'a\rb' })), { e: 'texto', t: 'a b' })
})

test('errorDictado traduce los códigos de Windows', () => {
  assert.deepEqual(
    { tipo: errorDictado('0x80045509').tipo, ajustes: errorDictado('0x80045509').ajustes },
    { tipo: 'privacidad', ajustes: true }
  )
  assert.equal(errorDictado('MicrophoneUnavailable').tipo, 'microfono')
  assert.equal(errorDictado('0x80070005').tipo, 'microfono')
  assert.equal(errorDictado('TopicLanguageNotSupported').tipo, 'idioma')
  assert.equal(errorDictado('NetworkFailure').ajustes, false)
  assert.match(errorDictado('0x12345678').mensaje, /0x12345678/)
})
