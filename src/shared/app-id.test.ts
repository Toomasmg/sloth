import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { APP_ID } from './app-id'

test('APP_ID coincide con build.appId de package.json', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { build: { appId: string } }
  assert.equal(APP_ID, pkg.build.appId)
})
