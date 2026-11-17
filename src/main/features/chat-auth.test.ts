import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import { GITHUB_DESHABILITADO, githubEnSettings, startCallbackServer, startGithubLogin, type CallbackOutcome } from './chat-auth'

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

const pegar = async (port: number, query: string): Promise<number> => (await fetch(`http://127.0.0.1:${port}/auth/callback${query}`)).status
const pendiente = async (p: Promise<CallbackOutcome>): Promise<boolean> => (await Promise.race([p.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 80))]))

test('el callback: un error o un canje que falla no cortan el login, uno que funciona sí', async () => {
  const canjes: string[] = []
  const srv = await startCallbackServer({
    ports: [53711, 53712, 53713],
    path: '/auth/callback',
    canjear: async (c) => {
      canjes.push(c)
      return c === 'bueno'
    }
  })
  assert.equal(await pegar(srv.port, '?error=x'), 400)
  assert.equal(await pendiente(srv.outcome), true)
  assert.equal(await pegar(srv.port, '?code=falso'), 400)
  assert.equal(await pendiente(srv.outcome), true)
  assert.equal(await pegar(srv.port, '?code=bueno'), 200)
  assert.deepEqual(await srv.outcome, { kind: 'ok' })
  assert.deepEqual(canjes, ['falso', 'bueno'])
})

test('el callback: al vencer el tiempo informa el último error', async () => {
  const srv = await startCallbackServer({ ports: [53714, 53715], path: '/auth/callback', timeoutMs: 150, canjear: async () => false })
  await pegar(srv.port, '?code=falso')
  const o = await srv.outcome
  assert.equal(o.kind, 'timeout')
  assert.match(o.kind === 'timeout' ? (o.ultimoError ?? '') : '', /No se pudo completar/)
})

test('el callback: cancelar resuelve cancelled', async () => {
  const srv = await startCallbackServer({ ports: [53716, 53717], path: '/auth/callback', canjear: async () => true })
  srv.cancel()
  assert.deepEqual(await srv.outcome, { kind: 'cancelled' })
})
