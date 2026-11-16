import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canManageConv, dropExpired, isExpired, noticeFromRow, noticeText, parseRetention, retentionLabel, retentionOf } from './chat-retention'

const H = 3_600_000

test('retención: solo acepta los plazos permitidos o null', () => {
  assert.equal(parseRetention(null), null)
  assert.equal(parseRetention(24), 24)
  assert.equal(parseRetention(2160), 2160)
  for (const bad of [0, 1, 48, -24, 24.5, '24', undefined, NaN, {}]) {
    assert.throws(() => parseRetention(bad), /Plazo inválido/)
  }
  assert.equal(retentionOf(168), 168)
  assert.equal(retentionOf(null), undefined)
  assert.equal(retentionOf(12), undefined)
})

test('retención: vence justo al cumplirse el plazo', () => {
  const now = 1_000 * H
  assert.equal(isExpired(now - 24 * H, 24, now), true)
  assert.equal(isExpired(now - 24 * H + 1, 24, now), false)
  assert.equal(isExpired(0, undefined, now), false)
})

test('retención: dropExpired saca los vencidos y no copia si no hay', () => {
  const now = 1_000 * H
  const list = [{ createdAt: now - 200 * H }, { createdAt: now - 2 * H }]
  assert.deepEqual(dropExpired(list, 168, now), [{ createdAt: now - 2 * H }])
  assert.equal(dropExpired(list, 720, now), list)
  assert.equal(dropExpired(list, undefined, now), list)
})

test('retención: etiquetas', () => {
  assert.equal(retentionLabel(undefined), 'Nunca')
  assert.equal(retentionLabel(null), 'Nunca')
  assert.equal(retentionLabel(24), '24 horas')
  assert.equal(retentionLabel(168), '7 días')
  assert.equal(retentionLabel(720), '30 días')
  assert.equal(retentionLabel(2160), '90 días')
})

test('permisos: owner y admin en equipos, cualquiera en un DM', () => {
  assert.equal(canManageConv('team', 'owner'), true)
  assert.equal(canManageConv('team', 'admin'), true)
  assert.equal(canManageConv('team', 'member'), false)
  assert.equal(canManageConv('team', undefined), false)
  assert.equal(canManageConv('dm', undefined), true)
})

test('avisos: de la fila al texto', () => {
  assert.deepEqual(noticeFromRow('clear', 'clear'), { kind: 'clear' })
  assert.deepEqual(noticeFromRow('retention', '168'), { kind: 'retention', hours: 168 })
  assert.deepEqual(noticeFromRow('retention', '0'), { kind: 'retention', hours: null })
  assert.equal(noticeFromRow('retention', '5'), undefined)
  assert.equal(noticeFromRow('retention', 'x'), undefined)
  assert.equal(noticeFromRow('text', 'hola'), undefined)
  assert.equal(noticeFromRow(undefined, 'hola'), undefined)
  assert.equal(noticeText({ kind: 'clear' }, 'ana'), 'ana vació la conversación')
  assert.equal(noticeText({ kind: 'retention', hours: 168 }, 'ana'), 'ana activó el borrado automático: 7 días')
  assert.equal(noticeText({ kind: 'retention', hours: null }, 'ana'), 'ana desactivó el borrado automático')
})
