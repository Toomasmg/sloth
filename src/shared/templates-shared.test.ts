import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mismoTicket, normTicketId } from './templates-shared'

test('normTicketId: ABC-123 en mayúsculas y los ids de otros servicios tal cual', () => {
  assert.equal(normTicketId(' tck-12 '), 'TCK-12')
  assert.equal(normTicketId('123'), '123')
  assert.equal(normTicketId('86c0abcd1'), '86c0abcd1')
  for (const malo of ['', ' ', '-1', '.x', 'a..b', 'a b', '/ticket', 'x;rm', 'a'.repeat(21), '#12']) assert.equal(normTicketId(malo), undefined, malo)
})

test('mismoTicket no distingue mayúsculas', () => {
  assert.equal(mismoTicket('86C0ABCD1', '86c0abcd1'), true)
  assert.equal(mismoTicket('TCK-1', 'TCK-1'), true)
  assert.equal(mismoTicket(undefined, 'TCK-1'), false)
  assert.equal(mismoTicket('TCK-1', 'TCK-12'), false)
})
