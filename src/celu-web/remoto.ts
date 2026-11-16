import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'
import {
  EVENTOS,
  HOLA_CADA_MS,
  VIEJO_MS,
  abrir,
  aBase64url,
  claveCelu,
  estadoMasNuevo,
  leerEmparejamiento,
  mismoDestino,
  sellar,
  topicCelu,
  validarDestino,
  type Clave,
  type DatoDecision,
  type DatoEstado,
  type DatoResultado,
  type Destino,
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
const REINTENTO_CANAL_MS = 10_000
const IDB = 'sloth-celu'
const IDB_TABLA = 'claves'
const IDB_CLAVE = 'actual'

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

const host = (u: string): string => new URL(u).host

// El secreto del QR no se guarda: se guarda la clave AES ya derivada, como CryptoKey no exportable en
// IndexedDB. Otro script del mismo origen podría usarla mientras tenga la página, pero no copiarla.
function idb<T>(modo: IDBTransactionMode, op: (t: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolver, rechazar) => {
    const pedido = indexedDB.open(IDB, 1)
    pedido.onupgradeneeded = () => pedido.result.createObjectStore(IDB_TABLA)
    pedido.onerror = () => rechazar(pedido.error)
    pedido.onsuccess = () => {
      const db = pedido.result
      const r = op(db.transaction(IDB_TABLA, modo).objectStore(IDB_TABLA))
      r.onsuccess = () => {
        db.close()
        resolver(r.result)
      }
      r.onerror = () => {
        db.close()
        rechazar(r.error)
      }
    }
  })
}

let claveEnMemoria: Clave | null = null

async function guardarClave(c: Clave | null): Promise<void> {
  claveEnMemoria = c
  try {
    if (c) await idb('readwrite', (t) => t.put(c, IDB_CLAVE))
    else await idb('readwrite', (t) => t.delete(IDB_CLAVE))
  } catch {
    // Sin IndexedDB (modo privado): la clave vive mientras la página esté abierta.
  }
}

async function leerClave(): Promise<Clave | null> {
  if (claveEnMemoria) return claveEnMemoria
  try {
    const c = await idb<unknown>('readonly', (t) => t.get(IDB_CLAVE))
    return c instanceof CryptoKey ? c : null
  } catch {
    return null
  }
}

async function olvidar(): Promise<void> {
  guardar(CLAVE_PAR, null)
  await guardarClave(null)
}

function destinoGuardado(): Destino | null {
  const g = leer(CLAVE_PAR)
  if (!g) return null
  try {
    return validarDestino(JSON.parse(g))
  } catch {
    return null
  }
}

/** Una versión anterior guardaba el secreto en localStorage: se pasa a clave y se borra. */
function emparejamientoViejo(): Emparejamiento | null {
  const g = leer(CLAVE_PAR)
  if (!g || !g.includes('"s"')) return null
  return leerEmparejamiento(`#p=${aBase64url(new TextEncoder().encode(g))}`)
}

interface Accion {
  texto: string
  accion: () => void
  secundaria?: boolean
}

interface Overlay {
  mostrar: (texto: string, acciones?: Accion[]) => void
  preguntar: (texto: string, si: string, no: string) => Promise<boolean>
  ocultar: () => void
}

let cliente: SupabaseClient | null = null

async function cerrarSesion(): Promise<void> {
  try {
    // Solo este celu: un signOut global cerraría también la sesión del chat en la PC.
    await cliente?.auth.signOut({ scope: 'local' })
  } catch {
    // Sin red igual se borra lo local: lo que importa es que este celu deje de tener la clave.
  }
  await olvidar()
  guardar('sloth-token', null)
  location.reload()
}

const SALIR: Accion = { texto: 'Salir', accion: () => void cerrarSesion(), secundaria: true }

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

  const fondoInerte = (si: boolean): void => {
    for (const n of Array.from(document.body.children)) if (n !== raiz && n instanceof HTMLElement) n.inert = si
  }

  const mostrar = (t: string, lista: Accion[] = []): void => {
    texto.textContent = t
    acciones.replaceChildren(
      ...lista.map((a) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = a.secundaria ? 'remoto-btn remoto-btn-sec' : 'remoto-btn'
        b.textContent = a.texto
        b.addEventListener('click', a.accion)
        return b
      })
    )
    raiz.hidden = false
    fondoInerte(true)
    acciones.querySelector('button')?.focus()
  }
  const ocultar = (): void => {
    raiz.hidden = true
    fondoInerte(false)
  }

  return {
    mostrar,
    ocultar,
    preguntar: (t, si, no) =>
      new Promise((resolver) => {
        mostrar(t, [
          { texto: si, accion: () => resolver(true) },
          { texto: no, accion: () => resolver(false), secundaria: true }
        ])
      })
  }
}

interface EstadoRecibido {
  estado: EstadoCelular
  recibido: number
}

const json = (status: number, cuerpo: unknown): Response => new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } })

/**
 * Un enlace de otro proyecto u otra cuenta no pisa el guardado sin preguntar: podría ser uno armado para
 * que entres con GitHub en un Supabase ajeno.
 */
async function resolverDestino(ui: Overlay): Promise<{ destino: Destino; clave: Clave } | null> {
  const delEnlace = leerEmparejamiento(location.hash)
  if (delEnlace) history.replaceState(null, '', location.pathname + location.search)
  const nuevo = delEnlace ?? emparejamientoViejo()
  const actual = destinoGuardado()
  if (nuevo) {
    const { s, ...destino } = nuevo
    const reemplaza =
      !actual ||
      mismoDestino(actual, destino) ||
      (await ui.preguntar(`Este enlace es de otro Sloth (${host(destino.u)}). ¿Lo usás en lugar del que tenías (${host(actual.u)})?`, 'Usar el nuevo', 'Dejar el anterior'))
    if (reemplaza) {
      const clave = await claveCelu(s, destino.id)
      await guardarClave(clave)
      guardar(CLAVE_PAR, JSON.stringify(destino))
      return { destino, clave }
    }
  }
  const clave = actual ? await leerClave() : null
  return actual && clave ? { destino: actual, clave } : null
}

function iniciar(): void {
  void navigator.serviceWorker?.register('./sw.js').catch(() => undefined)

  // Dentro de un iframe de otra página no arranca: Permitir quedaría expuesto a clickjacking.
  if (window.top !== window.self) {
    window.slothFetch = () => Promise.reject(new Error('dentro de otra página'))
    return
  }

  // app.js corre apenas termina este script y lee el token al arrancar: esto no puede esperar.
  guardar('sloth-token', leerEmparejamiento(location.hash) || leer(CLAVE_PAR) ? 'remoto' : null)

  const ui = crearOverlay()
  let sb: SupabaseClient | null = null
  let destino: Destino | null = null
  let clave: Clave | null = null
  let topic = ''
  let ultimo: EstadoRecibido | null = null
  let fallos = 0
  let reescanear = false
  let ch: ReturnType<SupabaseClient['channel']> | null = null
  let suscripto = false
  const esperando = new Map<string, (r: DatoResultado) => void>()

  // Lo que corre en segundo plano se repite solo (el hola cada HOLA_CADA_MS, el canal con su reintento).
  const enFondo = (p: Promise<unknown>): void => void p.catch(() => undefined)

  const entrar = (): void => {
    if (sb) enFondo(sb.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: location.origin + location.pathname, scopes: 'read:user' } }))
  }

  const hola = async (): Promise<void> => {
    const c = ch
    const k = clave
    if (!c || !k || document.visibilityState !== 'visible') return
    await c.send({ type: 'broadcast', event: EVENTOS.hola, payload: await sellar(k, topic, EVENTOS.hola, { at: Date.now() }) })
  }

  const alEstado = (dato: unknown): void => {
    const e = (dato as Partial<DatoEstado> | null)?.estado
    if (!e || typeof e !== 'object' || typeof e.ahora !== 'number') {
      fallos++
      // Otra PC de la misma cuenta publica en el mismo canal con su clave: solo se pide escanear de nuevo
      // si además hace rato que no llega un estado propio.
      const reciente = ultimo !== null && Date.now() - ultimo.recibido <= VIEJO_MS
      if (fallos >= FALLOS_PARA_REESCANEAR && !reciente && !reescanear) {
        reescanear = true
        enFondo(olvidar())
      }
      return
    }
    if (!estadoMasNuevo(ultimo && { ahora: ultimo.estado.ahora, recibido: ultimo.recibido }, e.ahora, Date.now())) return
    fallos = 0
    ultimo = { estado: e, recibido: Date.now() }
  }

  const alRecibir = (evento: EventoCelu, payload: unknown): void => {
    const k = clave
    if (!k) return
    enFondo(
      abrir(k, topic, evento, payload).then((dato) => {
        if (evento === EVENTOS.estado) return alEstado(dato)
        const d = dato as Partial<DatoResultado> | null
        if (d && typeof d.id === 'string' && typeof d.ok === 'boolean') esperando.get(d.id)?.({ id: d.id, ok: d.ok, error: typeof d.error === 'string' ? d.error : undefined })
      })
    )
  }

  const suscribir = async (): Promise<void> => {
    const cli = sb
    if (suscripto || !cli || !clave) return
    suscripto = true
    const reintentar = (): void => {
      ch = null
      suscripto = false
      setTimeout(() => enFondo(suscribir()), REINTENTO_CANAL_MS)
    }
    try {
      await cli.realtime.setAuth()
      const canal = cli.channel(topic, { config: { private: true, broadcast: { self: false } } })
      canal.on('broadcast', { event: EVENTOS.estado }, (m) => alRecibir(EVENTOS.estado, m.payload))
      canal.on('broadcast', { event: EVENTOS.resultado }, (m) => alRecibir(EVENTOS.resultado, m.payload))
      ch = canal
      canal.subscribe((status) => {
        if (ch !== canal) return
        if (status === 'SUBSCRIBED') enFondo(hola())
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          enFondo(cli.removeChannel(canal))
          reintentar()
        }
      })
    } catch {
      reintentar()
    }
  }

  const alSesion = (s: Session | null): void => {
    const d = destino
    if (!d) return
    if (!s) {
      ui.mostrar(`Entrá con GitHub para ver tu PC desde cualquier red. Se conecta a ${host(d.u)}.`, [{ texto: 'Entrar con GitHub', accion: entrar }, SALIR])
      return
    }
    if (s.user.id.toLowerCase() !== d.id) {
      ui.mostrar('Entraste con otra cuenta de GitHub. Usá la misma que en Sloth.', [SALIR])
      return
    }
    ui.ocultar()
    enFondo(suscribir())
  }

  const decidir = async (cuerpo: string): Promise<Response> => {
    const c = ch
    const k = clave
    if (!c || !k) throw new Error('sin canal')
    const { id, decision } = JSON.parse(cuerpo) as { id?: unknown; decision?: unknown }
    if (typeof id !== 'string' || (decision !== 'allow' && decision !== 'deny')) throw new Error('pedido inválido')
    const dato: DatoDecision = { id, decision, at: Date.now(), nonce: aBase64url(crypto.getRandomValues(new Uint8Array(16))) }
    let t: ReturnType<typeof setTimeout> | undefined
    // Se espera desde antes de mandar: la respuesta de la PC puede llegar antes que el ok del envío.
    const respuesta = new Promise<DatoResultado>((resolver, rechazar) => {
      t = setTimeout(() => {
        esperando.delete(id)
        rechazar(new Error('sin respuesta'))
      }, ESPERA_RESULTADO_MS)
      esperando.set(id, (r) => {
        clearTimeout(t)
        esperando.delete(id)
        resolver(r)
      })
    })
    try {
      const r = await c.send({ type: 'broadcast', event: EVENTOS.decision, payload: await sellar(k, topic, EVENTOS.decision, dato) })
      if (r !== 'ok') throw new Error(`no se pudo mandar (${r})`)
    } catch (e) {
      clearTimeout(t)
      esperando.delete(id)
      throw e
    }
    const r = await respuesta
    return r.ok ? json(200, { ok: true }) : json(409, { error: r.error ?? 'No se pudo responder.' })
  }

  window.slothFetch = (url, init) => {
    if (url === '/api/estado') {
      if (reescanear) return Promise.resolve(new Response('', { status: 401 }))
      const u = ultimo
      if (!u || Date.now() - u.recibido > VIEJO_MS) return Promise.reject(new Error('sin pc'))
      return Promise.resolve(json(200, { ...u.estado, ahora: u.estado.ahora + (Date.now() - u.recibido) }))
    }
    if (url === '/api/permiso' && init?.method === 'POST') return decidir(String(init.body ?? ''))
    return Promise.reject(new Error('ruta desconocida'))
  }

  setInterval(() => enFondo(hola()), HOLA_CADA_MS)
  document.addEventListener('visibilitychange', () => enFondo(hola()))

  const arrancar = async (): Promise<void> => {
    const r = await resolverDestino(ui)
    if (!r) {
      ui.ocultar()
      reescanear = true
      await olvidar()
      return
    }
    destino = r.destino
    clave = r.clave
    topic = topicCelu(r.destino.id)
    const cli = createClient(r.destino.u, r.destino.k, { auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true } })
    sb = cli
    cliente = cli
    cli.auth.onAuthStateChange((_e, s) => alSesion(s))
    const { data } = await cli.auth.getSession()
    alSesion(data.session)
  }
  arrancar().catch((e: unknown) => ui.mostrar(`No se pudo arrancar: ${e instanceof Error ? e.message : 'error desconocido'}. Recargá la página.`, [SALIR]))
}

iniciar()
