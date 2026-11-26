import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buttonClass } from './button-class'

const base = { variant: 'secondary', size: 'md' } as const

test('ui: las clases de siempre, con block, loading y className al final', () => {
  assert.equal(buttonClass({ ...base, look: 'ui' }), 'ui-btn ui-btn--secondary ui-btn--md')
  assert.equal(
    buttonClass({ look: 'ui', variant: 'primary', size: 'lg', block: true, loading: true, className: 'x' }),
    'ui-btn ui-btn--primary ui-btn--lg ui-btn--block is-loading x'
  )
})

test('classic: el secundario mediano es «btn» a secas', () => {
  assert.equal(buttonClass({ ...base, look: 'classic' }), 'btn')
  assert.equal(buttonClass({ ...base, look: 'classic', size: 'sm' }), 'btn sm')
  assert.equal(buttonClass({ look: 'classic', variant: 'primary', size: 'sm', className: 'f-set-add' }), 'btn sm primary f-set-add')
  assert.equal(buttonClass({ look: 'classic', variant: 'ghost', size: 'md', className: 'danger' }), 'btn ghost danger')
})

test('git: cada variante tiene su clase g-btn-*', () => {
  assert.equal(buttonClass({ ...base, look: 'git', variant: 'primary' }), 'g-btn-solid')
  assert.equal(buttonClass({ ...base, look: 'git' }), 'g-btn-plain')
  assert.equal(buttonClass({ ...base, look: 'git', variant: 'ghost' }), 'g-btn-ghost')
  assert.equal(buttonClass({ ...base, look: 'git', variant: 'danger', className: 'y' }), 'g-btn-danger y')
})
