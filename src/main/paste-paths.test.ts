import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathsFromUriList } from './paste-paths'

const win = process.platform === 'win32'

test('pathsFromUriList decodifica, ignora comentarios y lo que no es file:', () => {
  const list = win
    ? '# copiado\r\nfile:///C:/Users/ana/mi%20foto.png\r\nhttps://ejemplo.com/x\r\nfile:///C:/tmp/c.zip'
    : '# copiado\nfile:///home/ana/mi%20foto.png\nhttps://ejemplo.com/x\nfile:///tmp/c.zip'
  const want = win ? ['C:\\Users\\ana\\mi foto.png', 'C:\\tmp\\c.zip'] : ['/home/ana/mi foto.png', '/tmp/c.zip']
  assert.deepEqual(pathsFromUriList(list), want)
})

test('pathsFromUriList saltea una URI mal formada y sigue', () => {
  const bad = win ? 'file://servidor%/x' : 'file://otro-host/x'
  const ok = win ? 'file:///C:/tmp/ok.txt' : 'file:///tmp/ok.txt'
  assert.deepEqual(pathsFromUriList(`${bad}\n${ok}`), [win ? 'C:\\tmp\\ok.txt' : '/tmp/ok.txt'])
})
