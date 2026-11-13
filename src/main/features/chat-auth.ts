/**
 * Login con GitHub por Supabase Auth (PKCE) y servidor loopback del callback.
 *  - El servidor escucha SOLO en 127.0.0.1, en el primer puerto libre de la lista.
 *  - Acepta solo GET <path>. Todo lo demás responde 404.
 *  - Termina con el primer callback válido (con «code»), o al cancelar, o a los 5 minutos. Después se cierra.
 *  - La respuesta es HTML mínimo, sin recursos externos, con CSP `default-src 'none'`.
 *  - El código lo valida Supabase en `exchangeCodeForSession`: sin el code_verifier de PKCE que
 *    guarda nuestra sesión, el código no sirve. Un proceso local que pegue al callback con un code
 *    inventado solo hace fallar ese canje.
 *
 * Sin Electron: el navegador (`openExternal`) y el cliente llegan por parámetro, así se prueba con Node.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { SupabaseClient } from '@supabase/supabase-js'

const HOST = '127.0.0.1'
const CODE_RE = /^[A-Za-z0-9._~-]{1,512}$/
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

export type CallbackOutcome = { kind: 'code'; code: string } | { kind: 'error'; message: string } | { kind: 'cancelled' } | { kind: 'timeout' }

export interface CallbackServer {
  readonly port: number
  /** http://127.0.0.1:<port><path>: va como redirectTo en Supabase (tiene que estar en Redirect URLs). */
  readonly redirectTo: string
  /** Se resuelve una sola vez. Al resolverse, el servidor ya se cerró. */
  readonly outcome: Promise<CallbackOutcome>
  cancel(): void
}

export interface CallbackOptions {
  ports: readonly number[]
  path: string
  timeoutMs?: number
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function page(title: string, text: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><h1>${esc(title)}</h1><p>${esc(text)}</p></body></html>`
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    Connection: 'close'
  })
  res.end(body)
}

/** Intenta escuchar en un puerto. false si está ocupado; otro error se propaga. */
function tryListen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening)
      if (e.code === 'EADDRINUSE') resolve(false)
      else reject(e)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      resolve(true)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, HOST)
  })
}

/** Levanta el servidor del callback en el primer puerto libre. Tira Error si no hay ninguno. */
export async function startCallbackServer(opts: CallbackOptions): Promise<CallbackServer> {
  let server: Server | undefined
  let port = 0
  for (const p of opts.ports) {
    const candidate = createServer()
    if (await tryListen(candidate, p)) {
      server = candidate
      port = p
      break
    }
  }
  if (!server) throw new Error(`Los puertos ${opts.ports.join(', ')} están ocupados. Cerrá lo que los use y probá de nuevo.`)
  const srv = server

  let finished = false
  let resolveOutcome!: (o: CallbackOutcome) => void
  const outcome = new Promise<CallbackOutcome>((r) => (resolveOutcome = r))

  const finish = (o: CallbackOutcome): void => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    // Sin closeAllConnections: la respuesta ya va con «Connection: close», así que se entrega entera.
    srv.close()
    resolveOutcome(o)
  }

  const timer = setTimeout(() => finish({ kind: 'timeout' }), opts.timeoutMs ?? LOGIN_TIMEOUT_MS)

  srv.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (finished) {
      send(res, 404, page('No encontrado', 'Esta dirección ya no está activa.'))
      return
    }
    let url: URL
    try {
      url = new URL(req.url ?? '/', `http://${HOST}`)
    } catch {
      send(res, 400, page('Solicitud inválida', 'Probá iniciar sesión de nuevo desde Sloth.'))
      return
    }
    if (req.method !== 'GET' || url.pathname !== opts.path) {
      send(res, 404, page('No encontrado', 'Esta dirección no existe.'))
      return
    }
    const code = url.searchParams.get('code')
    const err = url.searchParams.get('error_description') ?? url.searchParams.get('error')
    if (code && CODE_RE.test(code)) {
      send(res, 200, page('Listo', 'Ya iniciaste sesión. Podés volver a Sloth.'))
      finish({ kind: 'code', code })
      return
    }
    if (err) {
      send(res, 400, page('No se pudo iniciar sesión', err.slice(0, 200)))
      finish({ kind: 'error', message: 'GitHub o Supabase devolvieron un error al iniciar sesión.' })
      return
    }
    // Un callback sin código no termina el login: se sigue esperando el bueno.
    send(res, 400, page('Falta el código', 'Probá iniciar sesión de nuevo desde Sloth.'))
  })

  return {
    port,
    redirectTo: `http://${HOST}:${port}${opts.path}`,
    outcome,
    cancel: () => finish({ kind: 'cancelled' })
  }
}

export interface GithubLoginDeps {
  client: SupabaseClient
  /** Host de la configuración: el navegador solo se abre para ese host. */
  host: string
  ports: readonly number[]
  path: string
  /** Abre la URL en el navegador del sistema (shell.openExternal en chat.ts). */
  openExternal(url: string): Promise<void>
  /** Si el proyecto tiene GitHub habilitado; null cuando no se pudo saber (no frena el login). */
  githubHabilitado?(): Promise<boolean | null>
}

export const GITHUB_DESHABILITADO =
  'El login con GitHub no está habilitado en el Supabase del equipo. Quien administra ese proyecto tiene que activarlo en Authentication → Sign In / Providers → GitHub (con una OAuth App de GitHub) y sumar http://127.0.0.1:53682/auth/callback a las Redirect URLs.'

/** Lee `external.github` de GET /auth/v1/settings; null si la respuesta no tiene esa forma. */
export function githubEnSettings(settings: unknown): boolean | null {
  if (!settings || typeof settings !== 'object') return null
  const external = (settings as { external?: unknown }).external
  if (!external || typeof external !== 'object') return null
  const github = (external as { github?: unknown }).github
  return typeof github === 'boolean' ? github : null
}

export type LoginResult = { kind: 'ok' } | { kind: 'cancelled' } | { kind: 'failed'; message: string }

export interface GithubLogin {
  cancel(): void
  readonly done: Promise<LoginResult>
}

/**
 * Inicia el login con GitHub: levanta el callback, pide la URL a Supabase (PKCE, sin redirección
 * automática), la abre en el navegador y espera. Al recibir el code, lo canjea por sesión.
 */
export async function startGithubLogin(deps: GithubLoginDeps): Promise<GithubLogin> {
  // Sin esto, el navegador muestra el JSON crudo de Supabase («provider is not enabled»).
  if ((await deps.githubHabilitado?.()) === false) throw new Error(GITHUB_DESHABILITADO)
  const server = await startCallbackServer({ ports: deps.ports, path: deps.path })
  try {
    const { data, error } = await deps.client.auth.signInWithOAuth({
      provider: 'github',
      options: { redirectTo: server.redirectTo, skipBrowserRedirect: true, scopes: 'read:user' }
    })
    if (error || !data?.url) throw new Error('No se pudo iniciar el login con GitHub.')
    const u = new URL(data.url)
    if (u.protocol !== 'https:' || u.hostname !== deps.host) throw new Error('El login devolvió una dirección inesperada.')
    await deps.openExternal(u.toString())
  } catch (e) {
    server.cancel()
    throw e
  }
  const done = server.outcome.then(async (o): Promise<LoginResult> => {
    if (o.kind === 'cancelled') return { kind: 'cancelled' }
    if (o.kind === 'timeout') return { kind: 'failed', message: 'Se venció el tiempo del login (5 minutos). Probá de nuevo.' }
    if (o.kind === 'error') return { kind: 'failed', message: o.message }
    const { error } = await deps.client.auth.exchangeCodeForSession(o.code)
    return error ? { kind: 'failed', message: 'No se pudo completar el login. Probá de nuevo.' } : { kind: 'ok' }
  })
  return { cancel: () => server.cancel(), done }
}
