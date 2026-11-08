import { app, safeStorage, shell, type BrowserWindow } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Feature, FeatureContext } from './context'
import type { ChatAuth, ChatConfigView, ChatProfile, ChatSnapshot } from '../../shared/chat'
import { CHAT_CALLBACK_PATH, CHAT_CALLBACK_PORTS } from '../../shared/chat'
import { keyHash, keyPreview, parseChatServerConfig, type ChatServerConfig } from './chat-config'
import { createSessionStore, type SessionStore } from './chat-session'
import { startGithubLogin, type GithubLogin } from './chat-auth'
import { readTeamConfig, repoKey } from './team-config-core'
import { registerChatData, type ChatData, type ChatCoreHandle } from './chat-data'
import { writeJsonAtomic } from './tray-settings'

/**
 * Función «chat» (lado main): config de Supabase, login con GitHub (PKCE) y sesión cifrada.
 * Los datos (equipos, mensajes, realtime) son de chat-data.ts (T8). Contrato en src/shared/chat.ts.
 *
 * Reglas: los tokens nunca salen de main (la UI solo ve ChatSnapshot); la sesión va cifrada con
 * safeStorage; la service_role / secret key se rechaza; el navegador solo se abre a https://<host de la config>.
 *
 * Origen de la config: la de Configuración gana. Si no hay, la de `.sloth/team.json` de un espacio
 * solo se usa si el usuario la aceptó (repo + url + huella de la key). Si cambia, se corta la sesión.
 */

const OWNER_KEY = 'sloth:owner'
/** Tiempo máximo de la prueba de conexión. */
const TEST_TIMEOUT_MS = 8000

/** Resultado de «Probar conexión»: ok solo si el servidor acepta la clave y hay sesión de GitHub. */
export interface ChatTestResult {
  ok: boolean
  message: string
}

/** Cierre al salir de la app (lo arma register). */
let teardown: (() => void) | undefined

interface SavedFile {
  config?: ChatServerConfig
  accepted?: { repo: string; supabaseUrl: string; keyHash: string }
}

interface Active {
  cfg: ChatServerConfig
  source: 'settings' | 'team.json'
  repo?: string
  /** Para detectar cambios de config. */
  id: string
}

interface Offer {
  cfg: ChatServerConfig
  repo: string
  teamName: string
  /** Huella de la key que se le mostró al usuario: al aceptar, tiene que seguir igual. */
  hash: string
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const msg = (e: unknown): string => (e instanceof Error ? e.message : 'Algo salió mal.')

/** Solo los avatares de GitHub (la CSP lo permite; esto evita cualquier otra URL). */
const avatarOf = (v: unknown): string | undefined =>
  typeof v === 'string' && v.startsWith('https://avatars.githubusercontent.com/') && v.length < 500 ? v : undefined

const feature: Feature = {
  name: 'chat',
  register(ctx: FeatureContext) {
    const dir = join(app.getPath('userData'), 'features')
    const configFile = join(dir, 'chat.json')

    let saved: SavedFile = loadSaved()
    let active: Active | undefined
    let offer: Offer | undefined
    let client: SupabaseClient | undefined
    let me: ChatProfile | undefined
    let auth: ChatAuth = { status: 'unconfigured' }
    let login: GithubLogin | undefined
    let win: BrowserWindow | undefined
    let running = false

    const session: SessionStore = createSessionStore({
      file: join(dir, 'chat-session.bin'),
      crypto: safeStorage,
      log: (m) => ctx.log(m)
    })

    function loadSaved(): SavedFile {
      try {
        if (!existsSync(configFile)) return {}
        const raw = JSON.parse(readFileSync(configFile, 'utf8').replace(/^﻿/, '')) as unknown
        if (!isObj(raw)) return {}
        const out: SavedFile = {}
        if (raw.config !== undefined)
          try {
            out.config = parseChatServerConfig(raw.config)
          } catch {
            ctx.log('chat: la configuración guardada no es válida; se ignora.')
          }
        const a = raw.accepted
        if (isObj(a) && typeof a.repo === 'string' && typeof a.supabaseUrl === 'string' && typeof a.keyHash === 'string')
          out.accepted = { repo: a.repo, supabaseUrl: a.supabaseUrl, keyHash: a.keyHash }
        return out
      } catch {
        return {}
      }
    }

    const persist = (): void => writeJsonAtomic(configFile, saved)

    const snapshot = (): ChatSnapshot => ({ auth, ...data.part() })
    const emit = (): void => ctx.emit('snapshot', snapshot())

    /** Marca la sesión guardada con el proyecto al que pertenece; si es de otro, la borra. */
    function ensureOwner(cfg: ChatServerConfig): void {
      const id = `${cfg.supabaseUrl}|${keyHash(cfg.anonKey)}`
      if (session.storage.getItem(OWNER_KEY) === id) return
      session.clear()
      session.storage.setItem(OWNER_KEY, id)
    }

    function makeClient(cfg: ChatServerConfig): SupabaseClient {
      ensureOwner(cfg)
      const c = createClient(cfg.supabaseUrl, cfg.anonKey, {
        auth: {
          flowType: 'pkce',
          storage: session.storage,
          persistSession: true,
          autoRefreshToken: false,
          detectSessionInUrl: false
        },
        global: { headers: { 'X-Client-Info': `sloth/${app.getVersion()}` } }
      })
      c.auth.onAuthStateChange((event) => {
        if (c !== client) return
        if (event === 'SIGNED_OUT' && auth.status !== 'signingIn') {
          me = undefined
          auth = { status: 'signedOut' }
          stopRuntime()
          emit()
        }
      })
      return c
    }

    /** Carga el perfil de GitHub del usuario con sesión. Sin perfil, cierra la sesión: no es de GitHub. */
    async function loadMe(c: SupabaseClient): Promise<void> {
      const { data: u, error: ue } = await c.auth.getUser()
      if (ue || !u.user) throw new Error('No se pudo verificar tu sesión. Iniciá sesión de nuevo.')
      const { data: p, error: pe } = await c.from('profiles').select('id, login, name, avatar_url').eq('id', u.user.id).maybeSingle()
      if (pe) throw new Error('No se pudo leer tu perfil. Probá de nuevo.')
      if (!p || typeof p.login !== 'string') {
        await c.auth.signOut({ scope: 'local' }).catch(() => {})
        session.clear()
        if (active) ensureOwner(active.cfg)
        me = undefined
        auth = { status: 'error', message: 'Entrá con GitHub.' }
        return
      }
      me = {
        id: String(p.id),
        login: p.login,
        name: typeof p.name === 'string' ? p.name : undefined,
        avatarUrl: avatarOf(p.avatar_url)
      }
      auth = { status: 'signedIn', me }
    }

    /** Con sesión guardada, la recupera sin abrir el navegador. */
    async function restoreSession(c: SupabaseClient): Promise<void> {
      try {
        const { data } = await c.auth.getSession()
        if (c !== client || !data.session) return
        await loadMe(c)
      } catch (e) {
        if (c === client) auth = { status: 'error', message: msg(e) }
      }
      if (c === client) {
        emit()
        updateRuntime()
      }
    }

    const data: ChatData = registerChatData(
      ctx,
      {
        client: () => (auth.status === 'signedIn' ? client ?? null : null),
        me: () => me ?? null,
        auth: () => auth
      } satisfies ChatCoreHandle,
      emit
    )

    /** Autorrefresco y datos solo con sesión y ventana abierta. Una sola conexión realtime. */
    function updateRuntime(): void {
      const want = Boolean(client && auth.status === 'signedIn' && win && !win.isDestroyed())
      if (want && !running) {
        running = true
        client?.auth.startAutoRefresh().catch(() => {})
        data.start().catch((e) => ctx.log('chat: no se pudo conectar:', msg(e)))
      } else if (!want && running) stopRuntime()
    }

    function stopRuntime(): void {
      client?.auth.stopAutoRefresh().catch(() => {})
      if (!running) return
      running = false
      data.stop().catch(() => {})
    }

    /** Qué config vale ahora: la de Configuración, o la de un team.json aceptado; si no, una oferta. */
    function resolveConfig(): { active?: Active; offer?: Offer } {
      if (saved.config) {
        const cfg = saved.config
        return { active: { cfg, source: 'settings', id: `settings|${cfg.supabaseUrl}|${keyHash(cfg.anonKey)}` } }
      }
      let first: Offer | undefined
      const seen = new Set<string>()
      for (const ws of ctx.store.workspaces) {
        const repo = ws.repoPath
        if (!repo || seen.has(repoKey(repo))) continue
        seen.add(repoKey(repo))
        const r = readTeamConfig(repo)
        if (r.kind !== 'ok' || !r.config.chat) continue
        const cfg = r.config.chat
        const h = keyHash(cfg.anonKey)
        const acc = saved.accepted
        if (acc && acc.repo === repoKey(repo) && acc.supabaseUrl === cfg.supabaseUrl && acc.keyHash === h)
          return { active: { cfg, source: 'team.json', repo, id: `team|${repoKey(repo)}|${cfg.supabaseUrl}|${h}` } }
        first ??= { cfg, repo, teamName: r.config.equipo, hash: h }
      }
      return { offer: first }
    }

    /** Recalcula la config. Si cambió, corta el login y la sesión en curso y arma el cliente nuevo. */
    function refresh(): void {
      const r = resolveConfig()
      offer = r.offer
      if ((r.active?.id ?? '') === (active?.id ?? '')) return
      const hadActive = active !== undefined
      login?.cancel()
      login = undefined
      stopRuntime()
      client?.auth.stopAutoRefresh().catch(() => {})
      client = undefined
      me = undefined
      active = r.active
      // Si la config activa cambia, la sesión era de la anterior: se borra. Al arrancar (no había
      // config activa) la sesión se conserva, y makeClient la descarta si es de otro proyecto.
      if (hadActive || !active) session.clear()
      if (!active) {
        auth = { status: 'unconfigured' }
        emit()
        return
      }
      client = makeClient(active.cfg)
      auth = { status: 'signedOut' }
      void restoreSession(client)
      emit()
    }

    const view = (): ChatConfigView => ({
      active: active
        ? {
            supabaseUrl: active.cfg.supabaseUrl,
            keyPreview: keyPreview(active.cfg.anonKey),
            source: active.source,
            ...(active.repo ? { repo: active.repo } : {})
          }
        : undefined,
      offered: offer ? { supabaseUrl: offer.cfg.supabaseUrl, repo: offer.repo, teamName: offer.teamName } : undefined
    })

    async function signIn(): Promise<void> {
      if (!active || !client) throw new Error('Primero configurá el chat en Configuración → Equipo y datos.')
      if (auth.status === 'signedIn' || auth.status === 'signingIn') return
      const c = client
      auth = { status: 'signingIn', startedAt: Date.now() }
      emit()
      let l: GithubLogin
      try {
        l = await startGithubLogin({
          client: c,
          host: new URL(active.cfg.supabaseUrl).hostname,
          ports: CHAT_CALLBACK_PORTS,
          path: CHAT_CALLBACK_PATH,
          openExternal: (u) => shell.openExternal(u)
        })
      } catch (e) {
        auth = { status: 'error', message: msg(e) }
        emit()
        return
      }
      login = l
      void l.done.then(async (res) => {
        if (login !== l) return
        login = undefined
        if (res.kind === 'cancelled') auth = { status: 'signedOut' }
        else if (res.kind === 'failed') auth = { status: 'error', message: res.message }
        else if (c === client) {
          try {
            await loadMe(c)
          } catch (e) {
            auth = { status: 'error', message: msg(e) }
          }
        }
        emit()
        updateRuntime()
      })
    }

    function cancelSignIn(): void {
      if (!login && auth.status !== 'signingIn') return
      const l = login
      login = undefined
      l?.cancel()
      auth = { status: 'signedOut' }
      emit()
    }

    async function signOut(): Promise<void> {
      login?.cancel()
      login = undefined
      stopRuntime()
      await client?.auth.signOut({ scope: 'local' }).catch(() => {})
      session.clear()
      if (active) ensureOwner(active.cfg)
      me = undefined
      auth = active ? { status: 'signedOut' } : { status: 'unconfigured' }
      emit()
    }

    ctx.onWindow((w) => {
      win = w
      w.on('closed', () => {
        win = undefined
        updateRuntime()
      })
      updateRuntime()
    })

    ctx.handle('state', (): ChatSnapshot => {
      refresh()
      return snapshot()
    })

    ctx.handle('getConfig', (): ChatConfigView => {
      refresh()
      return view()
    })

    ctx.handle('setConfig', (input: unknown): ChatConfigView => {
      saved.config = input === null ? undefined : parseChatServerConfig(input)
      persist()
      refresh()
      return view()
    })

    ctx.handle('acceptTeamConfig', (repo: unknown): ChatConfigView => {
      if (typeof repo !== 'string' || !repo || repo.length > 1000) throw new Error('Carpeta inválida.')
      // Sin refresh() antes: se compara contra la oferta que vio el usuario, no contra el archivo de ahora.
      if (!offer || repoKey(offer.repo) !== repoKey(repo)) throw new Error('No hay una configuración de equipo pendiente para esa carpeta.')
      const r = readTeamConfig(offer.repo)
      if (r.kind !== 'ok' || !r.config.chat || r.config.chat.supabaseUrl !== offer.cfg.supabaseUrl || keyHash(r.config.chat.anonKey) !== offer.hash) {
        refresh() // la oferta vuelve a calcularse con el archivo nuevo, para que el usuario la vea
        throw new Error('El .sloth/team.json cambió desde que se ofreció. Revisalo y probá de nuevo.')
      }
      saved.accepted = { repo: repoKey(offer.repo), supabaseUrl: offer.cfg.supabaseUrl, keyHash: offer.hash }
      persist()
      refresh()
      return view()
    })

    /**
     * Prueba real: una consulta mínima (GET /auth/v1/health con la anon / publishable key guardada).
     * Nunca usa ni devuelve la service_role; redirect:'error' evita mandar la key a otro host.
     */
    async function testConnection(): Promise<ChatTestResult> {
      refresh()
      if (!active) return { ok: false, message: 'Primero guardá la URL y la clave publicable del proyecto.' }
      const { supabaseUrl, anonKey } = active.cfg
      const host = new URL(supabaseUrl).host
      let res: Response
      try {
        res = await fetch(`${supabaseUrl}/auth/v1/health`, {
          headers: { apikey: anonKey },
          redirect: 'error',
          signal: AbortSignal.timeout(TEST_TIMEOUT_MS)
        })
      } catch (e) {
        const name = e instanceof Error ? e.name : ''
        if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, message: 'Supabase no respondió en 8 segundos. Revisá la conexión a internet.' }
        return { ok: false, message: `Sin conexión: no se pudo llegar a ${host}. Revisá la red o la URL.` }
      }
      if (res.status === 401 || res.status === 403) return { ok: false, message: 'Supabase rechazó la clave. Revisá que sea la anon / publishable key del proyecto.' }
      if (res.status === 404) return { ok: false, message: `${host} no responde como un proyecto de Supabase. Revisá la URL.` }
      if (!res.ok) return { ok: false, message: `Supabase respondió con un error (código ${res.status}). Probá de nuevo en un rato.` }
      if (auth.status !== 'signedIn') {
        return { ok: false, message: `Conexión correcta con ${host}, pero falta la sesión de GitHub. Conectala para usar el chat.` }
      }
      return { ok: true, message: `Conexión correcta con ${host} · sesión de ${auth.me.login}.` }
    }

    ctx.handle('test', (): Promise<ChatTestResult> => testConnection())
    ctx.handle('signIn', (): Promise<void> => signIn())
    ctx.handle('cancelSignIn', (): void => cancelSignIn())
    ctx.handle('signOut', (): Promise<void> => signOut())

    refresh()

    teardown = () => {
      login?.cancel()
      login = undefined
      stopRuntime()
      client?.auth.stopAutoRefresh().catch(() => {})
      client?.removeAllChannels().catch(() => {})
    }
  },
  dispose() {
    // Al salir de la app: cancela un login pendiente, corta realtime y el autorrefresco.
    teardown?.()
  }
}

export default feature
