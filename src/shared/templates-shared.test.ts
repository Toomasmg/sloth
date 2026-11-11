import { test } from 'node:test'
import assert from 'node:assert/strict'
import { espacioDelTicket, mismaCarpeta, mismoTicket, normTicketId } from './templates-shared'

test('normTicketId: ABC-123 en mayúsculas y los ids de otros servicios tal cual', () => {
  assert.equal(normTicketId(' proj-12 '), 'PROJ-12')
  assert.equal(normTicketId('123'), '123')
  assert.equal(normTicketId('86c0abcd1'), '86c0abcd1')
  for (const malo of ['', ' ', '-1', '.x', 'a..b', 'a b', '/ticket', 'x;rm', 'a'.repeat(21), '#12']) assert.equal(normTicketId(malo), undefined, malo)
})

test('mismoTicket no distingue mayúsculas', () => {
  assert.equal(mismoTicket('86C0ABCD1', '86c0abcd1'), true)
  assert.equal(mismoTicket('PROJ-1', 'PROJ-1'), true)
  assert.equal(mismoTicket(undefined, 'PROJ-1'), false)
  assert.equal(mismoTicket('PROJ-1', 'PROJ-12'), false)
})

test('mismaCarpeta ignora barras, la barra final y mayúsculas', () => {
  assert.equal(mismaCarpeta('C:\\a', 'c:/a/'), true)
  assert.equal(mismaCarpeta('C:\\a\\', 'C:/a'), true)
  assert.equal(mismaCarpeta('C:\\a', 'C:\\ab'), false)
})

test('espacioDelTicket con gh exige la misma carpeta', () => {
  const ws = [{ id: 'w1', ticket: '12', repoPath: 'C:\\a' }]
  assert.equal(espacioDelTicket(ws, '12', 'c:/a/', true)?.id, 'w1')
  assert.equal(espacioDelTicket(ws, '12', 'C:\\b', true), undefined)
  assert.equal(espacioDelTicket(ws, '12', 'C:\\b', false)?.id, 'w1')
  assert.equal(espacioDelTicket(ws, '12', undefined, true), undefined)
  assert.equal(espacioDelTicket(ws, '13', 'C:\\a', true), undefined)
})
