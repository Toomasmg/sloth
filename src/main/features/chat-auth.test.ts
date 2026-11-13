import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import { GITHUB_DESHABILITADO, githubEnSettings, startGithubLogin } from './chat-auth'

test('githubEnSettings lee external.github de /auth/v1/settings', () => {
  assert.equal(githubEnSettings({ external: { github: true, email: true } }), true)
  assert.equal(githubEnSettings({ external: { github: false, email: true } }), false)
  assert.equal(githubEnSettings({ external: { email: true } }), null)
  assert.equal(githubEnSettings({ external: 'x' }), null)
  assert.equal(githubEnSettings(null), null)
})

test('con GitHub deshabilitado no abre el navegador y explica qué activar', async () => {
  let abrio = false
  let pidioUrl = false
  const client = { auth: { signInWithOAuth: async () => ((pidioUrl = true), { data: null, error: null }) } } as unknown as SupabaseClient
  await assert.rejects(
    startGithubLogin({
      client,
      host: 'x.supabase.co',
      ports: [53699],
      path: '/auth/callback',
      openExternal: async () => {
        abrio = true
      },
      githubHabilitado: async () => false
    }),
    (e: unknown) => e instanceof Error && e.message === GITHUB_DESHABILITADO
  )
  assert.equal(abrio, false)
  assert.equal(pidioUrl, false)
})
