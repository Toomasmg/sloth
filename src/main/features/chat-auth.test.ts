import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import { GITHUB_DESHABILITADO, MAX_CANJES, githubEnSettings, startCallbackServer, startGithubLogin, type CallbackOutcome } from './chat-auth'

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

// Como auth-js 2.119: cada canje borra el verifier, salga bien o mal.
function clienteFalso(demoraMs = 0): { client: SupabaseClient; storage: Map<string, string>; salidas: number; canjes: string[] } {
  const storage = new Map<string, string>()
  const estado = { client: undefined as unknown as SupabaseClient, storage, salidas: 0, canjes: [] as string[] }
  estado.client = {
    auth: {
      signInWithOAuth: async () => {
        storage.set('sb-x-auth-token-code-verifier', 'v1')
        return { data: { url: 'https://x.supabase.co/auth/v1/authorize?provider=github' }, error: null }
      },
      exchangeCodeForSession: async (code: string) => {
        estado.canjes.push(code)
        const v = storage.get('sb-x-auth-token-code-verifier')
        await new Promise((r) => setTimeout(r, demoraMs))
        storage.delete('sb-x-auth-token-code-verifier')
        return v && code === 'bueno' ? { data: {}, error: null } : { data: {}, error: new Error('invalid') }
      },
      signOut: async () => {
        estado.salidas++
        return { error: null }
      }
    }
  } as unknown as SupabaseClient
  return estado
}

const preservar = (storage: Map<string, string>) => (): (() => void) => {
  const copia = [...storage].filter(([k]) => k.endsWith('-code-verifier'))
  return () => copia.forEach(([k, v]) => storage.set(k, v))
}

test('login: un code falso que llega antes no le quita el verifier al bueno', async () => {
  const f = clienteFalso()
  let fallidos = 0
  const l = await startGithubLogin({
    client: f.client,
    host: 'x.supabase.co',
    ports: [53721, 53722],
    path: '/auth/callback',
    openExternal: async () => undefined,
    preservarVerificador: preservar(f.storage),
    onCanjeFallido: () => fallidos++
  })
  assert.equal(await pegar(53721, '?code=falso'), 400)
  assert.equal(fallidos, 1)
  assert.equal(await pegar(53721, '?code=bueno'), 200)
  assert.deepEqual(await l.done, { kind: 'ok' })
})

test('login: un code que llega mientras se canjea otro se encola y no se pierde', async () => {
  const f = clienteFalso(60)
  const l = await startGithubLogin({
    client: f.client,
    host: 'x.supabase.co',
    ports: [53723, 53724],
    path: '/auth/callback',
    openExternal: async () => undefined,
    preservarVerificador: preservar(f.storage)
  })
  const [a, b] = await Promise.all([pegar(53723, '?code=falso'), new Promise((r) => setTimeout(r, 10)).then(() => pegar(53723, '?code=bueno'))])
  assert.deepEqual([a, b], [400, 200])
  assert.deepEqual(f.canjes, ['falso', 'bueno'])
  assert.deepEqual(await l.done, { kind: 'ok' })
})

test('login: un canje que termina después de cancelar cierra esa sesión', async () => {
  const f = clienteFalso(60)
  const l = await startGithubLogin({ client: f.client, host: 'x.supabase.co', ports: [53725, 53726], path: '/auth/callback', openExternal: async () => undefined })
  const r = pegar(53725, '?code=bueno')
  // En Windows la primera conexión puede tardar más que la demora del canje: se cancela recién con el canje en curso.
  while (f.canjes.length === 0) await new Promise((res) => setTimeout(res, 5))
  l.cancel()
  assert.deepEqual(await l.done, { kind: 'cancelled' })
  await r.catch(() => undefined)
  await new Promise((res) => setTimeout(res, 80))
  assert.equal(f.salidas, 1)
})

test('el callback: tras demasiados canjes fallidos termina el login', async () => {
  const srv = await startCallbackServer({ ports: [53727, 53728], path: '/auth/callback', canjear: async () => false })
  for (let i = 0; i < MAX_CANJES; i++) await pegar(srv.port, '?code=falso')
  assert.deepEqual(await srv.outcome, { kind: 'demasiados' })
})
