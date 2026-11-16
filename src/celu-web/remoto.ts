import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'
import {
  EVENTOS,
  HOLA_CADA_MS,
  VIEJO_MS,
  abrir,
  aBase64url,
  claveCelu,
  leerEmparejamiento,
  sellar,
  topicCelu,
  type Clave,
  type DatoDecision,
  type DatoEstado,
  type DatoResultado,
  type Emparejamiento,
  type EventoCelu
} from '../shared/celu-remoto'
import type { EstadoCelular } from '../shared/celular'

declare global {
  interface Window {
    slothFetch?: (url: string, init?: RequestInit) => Promise<Response>
  }
}

const CLAVE_PAR = 'sloth-remoto'
const ESPERA_RESULTADO_MS = 8_000
const FALLOS_PARA_REESCANEAR = 2

const leer = (k: string): string | null => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const guardar = (k: string, v: string | null): void => {
  try {
    if (v === null) localStorage.removeItem(k)
    else localStorage.setItem(k, v)
  } catch {
    // Sin almacenamiento (modo privado): la página sigue, pero hay que escanear de nuevo cada vez.
  }
}

function emparejamientoActual(): Emparejamiento | null {
  const nuevo = leerEmparejamiento(location.hash)
  if (nuevo) {
    guardar(CLAVE_PAR, JSON.stringify(nuevo))
    history.replaceState(null, '', location.pathname)
    return nuevo
  }
  const guardado = leer(CLAVE_PAR)
  if (!guardado) return null
  try {
    const p = JSON.parse(guardado) as Emparejamiento
    // Se revalida con el mismo validador que el enlace: lo guardado es un dato de afuera.
    return leerEmparejamiento(`#p=${aBase64url(new TextEncoder().encode(JSON.stringify(p)))}`)
  } catch {
    return null
  }
}

interface Overlay {
  mostrar: (texto: string, principal?: { texto: string; accion: () => void }, salir?: boolean) => void
  ocultar: () => void
}

let cliente: SupabaseClient | null = null

async function cerrarSesion(): Promise<void> {
  try {
    await cliente?.auth.signOut()
  } catch {
    // Sin red igual se borra lo local: lo que importa es que este celu deje de tener la clave.
  }
  guardar(CLAVE_PAR, null)
  guardar('sloth-token', null)
  location.reload()
}

function crearOverlay(): Overlay {
  const raiz = document.createElement('div')
  raiz.id = 'remoto-login'
  raiz.setAttribute('role', 'dialog')
  raiz.setAttribute('aria-modal', 'true')
  raiz.setAttribute('aria-labelledby', 'remoto-login-texto')
  raiz.hidden = true
  const caja = document.createElement('div')
  caja.className = 'remoto-caja'
  const marca = document.createElement('span')
  marca.className = 'remoto-marca'
  marca.textContent = 'Sloth'
  const texto = document.createElement('p')
  texto.id = 'remoto-login-texto'
  const acciones = document.createElement('div')
  acciones.className = 'remoto-acciones'
  caja.append(marca, texto, acciones)
  raiz.append(caja)
  document.body.append(raiz)

  const boton = (t: string, clase: string, accion: () => void): HTMLButtonElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = clase
    b.textContent = t
    b.addEventListener('click', accion)
    return b
  }

  return {
    mostrar(t, principal, salir) {
      texto.textContent = t
      acciones.replaceChildren()
      if (principal) acciones.append(boton(principal.texto, 'remoto-btn', principal.accion))
      if (salir) acciones.append(boton('Salir', 'remoto-btn remoto-btn-sec', () => void cerrarSesion()))
      raiz.hidden = false
      acciones.querySelector('button')?.focus()
    },
    ocultar() {
      raiz.hidden = true
    }
  }
}

interface EstadoRecibido {
  estado: EstadoCelular
  recibido: number
}

const json = (status: number, cuerpo: unknown): Response => new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } })

function iniciar(): void {
  void navigator.serviceWorker?.register('./sw.js').catch(() => undefined)
  const par = emparejamientoActual()
  if (!par) return
  guardar('sloth-token', 'remoto')

  const ui = crearOverlay()
  const sb = createClient(par.u, par.k, { auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true } })
  cliente = sb
  const topic = topicCelu(par.id)

  let clave: Clave | null = null
  let ultimo: EstadoRecibido | null = null
  let fallos = 0
  let fallosClave = false
  let ch: ReturnType<SupabaseClient['channel']> | null = null
  let suscripto = false
  const esperando = new Map<string, (r: DatoResultado) => void>()

  const entrar = (): void => {
    void sb.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: location.origin + location.pathname, scopes: 'read:user' } })
  }

  const hola = async (): Promise<void> => {
    if (!ch || !clave || document.visibilityState !== 'visible') return
    await ch.send({ type: 'broadcast', event: EVENTOS.hola, payload: await sellar(clave, topic, EVENTOS.hola, { at: Date.now() }) })
  }

  const alRecibir = (evento: EventoCelu, payload: unknown): void => {
    const k = clave
    if (!k) return
    void abrir(k, topic, evento, payload).then((dato) => {
      if (evento === EVENTOS.estado) {
        const d = dato as Partial<DatoEstado> | null
        const e = d?.estado
        if (!e || typeof e !== 'object' || typeof e.ahora !== 'number') {
          fallos++
          if (fallos >= FALLOS_PARA_REESCANEAR) fallosClave = true
          return
        }
        fallos = 0
        fallosClave = false
        ultimo = { estado: e, recibido: Date.now() }
      } else if (evento === EVENTOS.resultado) {
        const d = dato as Partial<DatoResultado> | null
        if (d && typeof d.id === 'string' && typeof d.ok === 'boolean') esperando.get(d.id)?.({ id: d.id, ok: d.ok, error: typeof d.error === 'string' ? d.error : undefined })
      }
    })
  }

  const suscribir = async (): Promise<void> => {
    suscripto = true
    clave = await claveCelu(par.s, par.id)
    await sb.realtime.setAuth()
    const canal = sb.channel(topic, { config: { private: true, broadcast: { self: false } } })
    ch = canal
    canal.on('broadcast', { event: EVENTOS.estado }, (m) => alRecibir(EVENTOS.estado, m.payload))
    canal.on('broadcast', { event: EVENTOS.resultado }, (m) => alRecibir(EVENTOS.resultado, m.payload))
    canal.subscribe((status) => {
      if (status === 'SUBSCRIBED') void hola()
    })
    setInterval(() => void hola(), HOLA_CADA_MS)
    document.addEventListener('visibilitychange', () => void hola())
  }

  const alSesion = (s: Session | null): void => {
    if (!s) {
      ui.mostrar('Entrá con GitHub para ver tu PC desde cualquier red.', { texto: 'Entrar con GitHub', accion: entrar })
      return
    }
    if (s.user.id.toLowerCase() !== par.id) {
      ui.mostrar('Entraste con otra cuenta de GitHub. Usá la misma que en Sloth.', undefined, true)
      return
    }
    ui.ocultar()
    if (!suscripto) void suscribir()
  }

  const decidir = async (cuerpo: string): Promise<Response> => {
    const k = clave
    if (!ch || !k) throw new Error('sin canal')
    const { id, decision } = JSON.parse(cuerpo) as { id?: unknown; decision?: unknown }
    if (typeof id !== 'string' || (decision !== 'allow' && decision !== 'deny')) throw new Error('pedido inválido')
    const dato: DatoDecision = { id, decision, at: Date.now(), nonce: aBase64url(crypto.getRandomValues(new Uint8Array(16))) }
    const respuesta = new Promise<DatoResultado>((resolver, rechazar) => {
      const t = setTimeout(() => {
        esperando.delete(id)
        rechazar(new Error('sin respuesta'))
      }, ESPERA_RESULTADO_MS)
      esperando.set(id, (r) => {
        clearTimeout(t)
        esperando.delete(id)
        resolver(r)
      })
    })
    await ch.send({ type: 'broadcast', event: EVENTOS.decision, payload: await sellar(k, topic, EVENTOS.decision, dato) })
    const r = await respuesta
    return r.ok ? json(200, { ok: true }) : json(409, { error: r.error ?? 'No se pudo responder.' })
  }

  window.slothFetch = (url, init) => {
    if (url === '/api/estado') {
      if (fallosClave) {
        guardar(CLAVE_PAR, null)
        return Promise.resolve(new Response('', { status: 401 }))
      }
      const u = ultimo
      if (!u || Date.now() - u.recibido > VIEJO_MS) return Promise.reject(new Error('sin pc'))
      return Promise.resolve(json(200, { ...u.estado, ahora: u.estado.ahora + (Date.now() - u.recibido) }))
    }
    if (url === '/api/permiso' && init?.method === 'POST') return decidir(String(init.body ?? ''))
    return Promise.reject(new Error('ruta desconocida'))
  }

  sb.auth.onAuthStateChange((_e, s) => alSesion(s))
  void sb.auth.getSession().then(({ data }) => alSesion(data.session))
}

iniciar()
