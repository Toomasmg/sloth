// Tipos mínimos a mano: el tsconfig de la app carga la lib DOM, que choca con la de webworker.
interface Evento {
  waitUntil: (p: Promise<unknown>) => void
}
interface EventoFetch {
  request: Request
  respondWith: (r: Promise<Response>) => void
}
interface Sw {
  registration: { scope: string }
  location: Location
  clients: { claim: () => Promise<void> }
  skipWaiting: () => Promise<void>
  addEventListener: ((tipo: 'install' | 'activate', f: (e: Evento) => void) => void) & ((tipo: 'fetch', f: (e: EventoFetch) => void) => void)
}
const sw = self as unknown as Sw
declare const __CELU_CACHE__: string

// Solo el shell estático. El estado de la PC llega por websocket y no pasa por acá; Supabase, las
// fuentes y el `?code=` del login quedan fuera: nunca se cachea nada del usuario.
const SHELL = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'remoto.js',
  'remoto.css',
  'manifest.webmanifest',
  'iconos/icono-192.png',
  'iconos/icono-512.png',
  'iconos/icono-maskable-512.png',
  'iconos/apple-touch-icon.png',
  'iconos/favicon-32.png'
]

const urlsDelShell = (): Set<string> => new Set(SHELL.map((p) => new URL(p, sw.registration.scope).href))

sw.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(__CELU_CACHE__)
      .then((c) => c.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' }))))
      .then(() => sw.skipWaiting())
  )
})

sw.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((nombres) => Promise.all(nombres.filter((n) => n.startsWith('sloth-celu-') && n !== __CELU_CACHE__).map((n) => caches.delete(n))))
      .then(() => sw.clients.claim())
  )
})

sw.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== sw.location.origin || url.search) return
  if (!urlsDelShell().has(url.href)) return
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copia = res.clone()
          void caches.open(__CELU_CACHE__).then((c) => c.put(req, copia))
        }
        return res
      })
      .catch(async () => (await caches.match(req)) ?? Response.error())
  )
})
