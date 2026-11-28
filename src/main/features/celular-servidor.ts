import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { EstadoCelular } from '../../shared/celular'
import { abrirPedido, crearRepetidos, derivarClaves, fechaValida, sellarRespuesta, type Claves, type Repetidos } from './celular-sello'
import { manifiesto, PAGINA_CSS, PAGINA_HTML, PAGINA_JS } from './celular-pagina'
import { crearConexiones } from './celular-conexiones'
import { crearLimite } from './celular-limite'
import { leerPedidoTerminal, type PedidoTerminal, type RespuestaTerminal } from './celular-terminal-core'
import type { Quien } from './celular-actividad'

/** Lo que la PC le da a cualquier fuente: el estado y cómo responder un permiso. */
export interface ProveedorDeEstado {
  /** `quien` llega solo por el Wi-Fi: la IP y el user-agent del pedido, ya con la clave verificada. */
  estado(quien?: Quien): Promise<EstadoCelular>
  /** Lanza con un mensaje para el celu si no se pudo (venció, ya se respondió). */
  decidir(id: string, decision: 'allow' | 'deny', quien?: Quien): void | Promise<void>
  /** Con `quien`, lo que deja el nivel de ese celu además del interruptor. */
  puedeAprobar(quien?: Quien): boolean
  /** La clave del QR: con ella solo se puede pedir entrar. */
  clave(): string
  /** Las claves de los celus que la PC dejó entrar. Las rutas de datos solo abren con una de estas. */
  celus?(): { id: string; clave: string }[]
  /** Un celu que escaneó el QR pide entrar (o pregunta cómo va su pedido). Sin esto, el QR da acceso directo, como en v1. */
  entrar?(cuerpo: unknown, quien: Quien): { status: number; data: unknown }
  /** Sin archivo, el de 192 px; si no, uno de ICONOS. */
  icono(archivo?: string): Buffer | null
  /** La terminal de un espacio, vista desde el celu. Con `error`, no se pudo (apagado, no existe, demasiadas esperas). `cancelar` salta si el celu cortó la conexión con el pedido abierto. */
  terminal(p: PedidoTerminal, cancelar?: AbortSignal, quien?: Quien): Promise<RespuestaTerminal | { status: 403 | 404 | 429; error: string }>
  /** xterm.js y su css, para que la página del celu dibuje la terminal. */
  xterm(): { js: string; css: string } | null
}

/**
 * Por dónde le llega el estado al celu. Hoy, un servidor HTTP en el Wi-Fi de casa con los cuerpos
 * sellados; la fuente por Supabase realtime (como chat-realtime) publica el mismo
 * EstadoCelular y recibe las mismas decisiones, así la página del celu no cambia.
 */
export interface FuenteDeEstado {
  readonly nombre: string
  iniciar(): Promise<void>
  detener(): Promise<void>
}

const MAX_CUERPO = 8192

/** Los íconos que pide el manifiesto: el de 192 y, para instalarla como app (por HTTPS), los de 512. */
const ICONOS: Record<string, string> = { '/icono.png': 'icono-192.png', '/icono-512.png': 'icono-512.png', '/icono-maskable.png': 'icono-maskable-512.png' }

const SEGURIDAD = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer'
}

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

function enviar(res: ServerResponse, status: number, tipo: string | null, cuerpo?: string | Buffer, extra: Record<string, string> = {}): void {
  const headers: Record<string, string> = { ...SEGURIDAD, ...extra }
  if (tipo) headers['content-type'] = tipo
  res.writeHead(status, headers).end(cuerpo)
}

// Los archivos de la página no cambian mientras corre la app: el celu los revalida con ETag y no los baja de nuevo en cada carga.
// La URL queda igual porque build-celu-web reemplaza esas rutas tal cual.
const etiquetas = new Map<string, { cuerpo: string | Buffer; etag: string }>()

function enviarEstatico(req: IncomingMessage, res: ServerResponse, ruta: string, tipo: string, cuerpo: string | Buffer): void {
  let e = etiquetas.get(ruta)
  if (e?.cuerpo !== cuerpo) {
    e = { cuerpo, etag: `"${createHash('sha256').update(cuerpo).digest('base64url').slice(0, 22)}"` }
    etiquetas.set(ruta, e)
  }
  const extra = { 'cache-control': 'no-cache', etag: e.etag }
  if (req.headers['if-none-match'] === e.etag) return enviar(res, 304, null, undefined, extra)
  enviar(res, 200, tipo, cuerpo, extra)
}

function leerCuerpo(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const partes: Buffer[] = []
    let tam = 0
    let pasado = false
    req.on('data', (c: Buffer) => {
      tam += c.length
      if (tam > MAX_CUERPO) pasado = true
      else partes.push(c)
    })
    req.on('end', () => resolve(pasado ? null : Buffer.concat(partes).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}

export interface OpcionesWifi {
  host: string
  puerto: number
  proveedor: ProveedorDeEstado
  /** Conexiones simultáneas por cliente (16: un celu usa unas pocas, y tras recargar quedan las viejas hasta que vencen). */
  maxConexionesPorIp?: number
  /** Cuánto puede estar una conexión sin dar señales de vida antes de cortarla (sin un pedido completo no hay motivo para sostenerla). */
  ociosoMs?: number
  /** Compartido entre los servidores de la misma PC (Wi-Fi, Tailscale, 127.0.0.1): un sobre visto en uno no vale en otro. */
  repetidos?: Repetidos
  /** Cómo se muestra en la PC quien llega por este servidor, en vez de su IP (por `tailscale serve` todos llegan desde 127.0.0.1). */
  etiqueta?: string
  log?: (...args: unknown[]) => void
}

/** El servidor del Wi-Fi. Las rutas de datos van con cuerpos sellados con la clave del QR; sin clave válida, 401 y nada más. */
export function crearFuenteWifi(o: OpcionesWifi): FuenteDeEstado & { puerto(): number } {
  let server: Server | null = null
  let puertoReal = o.puerto
  const repetidos = o.repetidos ?? crearRepetidos()
  const limite = crearLimite()
  const conexiones = crearConexiones(o.maxConexionesPorIp)
  // Derivar una clave cuesta dos HMAC: se guarda por clave y se tira cuando deja de estar.
  let derivadas = new Map<string, Claves | null>()
  const derivar = (clave: string, nuevas: Map<string, Claves | null>): Claves | null => {
    const c = derivadas.has(clave) ? (derivadas.get(clave) ?? null) : derivarClaves(clave)
    nuevas.set(clave, c)
    return c
  }
  /** Primero las de los celus; la del QR, al final y sin id. */
  const llaves = (): { id: string | null; claves: Claves }[] => {
    const nuevas = new Map<string, Claves | null>()
    const out: { id: string | null; claves: Claves }[] = []
    for (const c of o.proveedor.celus?.() ?? []) {
      const k = derivar(c.clave, nuevas)
      if (k) out.push({ id: c.id, claves: k })
    }
    const qr = derivar(o.proveedor.clave(), nuevas)
    if (qr) out.push({ id: null, claves: qr })
    derivadas = nuevas
    return out
  }

  async function atender(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ruta = (req.url ?? '/').split('?')[0]
    const metodo = req.method ?? 'GET'
    const esGet = metodo === 'GET' || metodo === 'HEAD'

    if (ruta === '/api/estado' || ruta === '/api/permiso' || ruta === '/api/terminal' || ruta === '/api/emparejar') {
      // 401 a los GET para que una página vieja ya abierta (con x-sloth-token) pida volver a escanear en vez de quedar en «sin conexión».
      if (esGet) return enviar(res, 401, null)
      if (metodo !== 'POST') return enviar(res, 405, null, undefined, { allow: 'POST' })
      const texto = await leerCuerpo(req)
      if (texto === null) return enviar(res, 413, null)
      let claves: Claves | null = null
      let ab: ReturnType<typeof abrirPedido> = null
      let celu: string | undefined
      for (const l of llaves()) {
        ab = abrirPedido(l.claves, ruta, texto)
        if (ab) {
          claves = l.claves
          celu = l.id ?? undefined
          break
        }
      }
      if (!ab || !claves) return enviar(res, 401, null)
      const conQr = celu === undefined && !!o.proveedor.entrar
      let sobre: { t?: unknown; b?: unknown } | null = null
      try {
        sobre = JSON.parse(ab.json) as { t?: unknown; b?: unknown } | null
      } catch {
        sobre = null
      }
      const iv = ab.iv
      const sellar = claves
      const sellado = (status: number, data: unknown): void => enviar(res, status, 'text/plain; charset=utf-8', sellarRespuesta(sellar, iv, JSON.stringify(data)))
      // El MAC ya pasó: la clave es buena. La hora corrida y el reenvío se contestan sellados (no 401) para que el celu no se desempareje.
      if (!sobre || typeof sobre !== 'object') return enviar(res, 401, null)
      if (!fechaValida(sobre.t, Date.now())) return sellado(409, { error: 'reloj' })
      if (repetidos.vistoAntes(ab.iv, Date.now())) return sellado(409, { error: 'repetido' })
      // Con clave de celu, el cupo es de ese celu: por `tailscale serve` todos comparten 127.0.0.1 y uno no le gasta el cupo a otro.
      const cupo = celu !== undefined ? `celu:${celu}` : (req.socket.remoteAddress ?? '?')
      const quien: Quien = { ip: o.etiqueta ?? req.socket.remoteAddress ?? '?', ua: String(req.headers['user-agent'] ?? '').slice(0, 400), ...(celu !== undefined && { celu }) }

      if (ruta === '/api/emparejar') {
        // Ya tiene acceso: la página usa esa clave tal cual (un enlace guardado con la clave del celu, no la del QR).
        if (!conQr || !o.proveedor.entrar) return sellado(200, { ya: true })
        if (!limite.permitir(cupo, Date.now())) return enviar(res, 429, null)
        const r = o.proveedor.entrar(sobre.b, quien)
        return sellado(r.status, r.data)
      }
      // La clave del QR sola no deja ver ni hacer nada: primero hay que pedir entrar y que la PC diga que sí.
      if (conQr) return enviar(res, 401, null)

      if (ruta === '/api/estado') return sellado(200, await o.proveedor.estado(quien))
      if (ruta === '/api/terminal') {
        // Después del MAC y del anti-replay: quien no tiene la clave no le gasta el cupo al celu de verdad.
        if (!limite.permitir(cupo, Date.now())) return enviar(res, 429, null)
        const p = leerPedidoTerminal(sobre.b)
        if (!p) return sellado(400, { error: 'Pedido inválido.' })
        const corte = new AbortController()
        res.once('close', () => corte.abort())
        const r = await o.proveedor.terminal(p, corte.signal, quien)
        if (res.destroyed) return
        return 'error' in r ? sellado(r.status, { error: r.error }) : sellado(200, r)
      }
      if (!o.proveedor.puedeAprobar(quien)) return sellado(403, { error: 'Aprobar desde el celu está apagado en Sloth.' })
      const p = sobre.b as { id?: unknown; decision?: unknown } | null
      if (!p || typeof p !== 'object' || typeof p.id !== 'string' || p.id.length > 100 || (p.decision !== 'allow' && p.decision !== 'deny')) return sellado(400, { error: 'Pedido inválido.' })
      try {
        await o.proveedor.decidir(p.id, p.decision, quien)
      } catch (e) {
        return sellado(409, { error: (e as Error).message })
      }
      return sellado(200, { ok: true })
    }

    if (!esGet) return enviar(res, 405, null, undefined, { allow: 'GET' })
    if (ruta === '/') return enviar(res, 200, 'text/html; charset=utf-8', PAGINA_HTML, { 'content-security-policy': CSP })
    if (ruta === '/app.css') return enviarEstatico(req, res, ruta, 'text/css; charset=utf-8', PAGINA_CSS)
    if (ruta === '/app.js') return enviarEstatico(req, res, ruta, 'text/javascript; charset=utf-8', PAGINA_JS)
    if (ruta === '/xterm.js' || ruta === '/xterm.css') {
      const x = o.proveedor.xterm()
      if (!x) return enviar(res, 404, null)
      return ruta === '/xterm.js' ? enviarEstatico(req, res, ruta, 'text/javascript; charset=utf-8', x.js) : enviarEstatico(req, res, ruta, 'text/css; charset=utf-8', x.css)
    }
    if (ruta === '/manifest.webmanifest') return enviar(res, 200, 'application/manifest+json; charset=utf-8', manifiesto())
    if (Object.hasOwn(ICONOS, ruta)) {
      const png = o.proveedor.icono(ICONOS[ruta])
      return png ? enviarEstatico(req, res, ruta, 'image/png', png) : enviar(res, 404, null)
    }
    return enviar(res, 404, null)
  }

  return {
    nombre: 'wifi',
    puerto: () => puertoReal,
    async iniciar() {
      if (server) return
      const s = createServer((req, res) => {
        atender(req, res).catch((e: unknown) => {
          o.log?.('celular: error atendiendo', req.url, (e as Error).message)
          if (!res.headersSent) enviar(res, 500, null)
          else res.end()
        })
      })
      // El pedido de «mirar» queda abierto hasta 25 s: la conexión tiene que sobrevivir a eso y a la pausa entre pedidos.
      s.keepAliveTimeout = 30_000
      // Un pedido real (cabeceras y hasta 8 KB de cuerpo) llega en milisegundos: quien lo gotea no necesita 5 minutos.
      s.headersTimeout = 10_000
      s.requestTimeout = 10_000
      s.on('connection', (socket) => {
        const ip = socket.remoteAddress ?? '?'
        if (!conexiones.abrir(ip)) return void socket.destroy()
        socket.once('close', () => conexiones.cerrar(ip))
        socket.setTimeout(o.ociosoMs ?? 40_000, () => socket.destroy())
      })
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject)
        s.listen(o.puerto, o.host, () => {
          s.off('error', reject)
          resolve()
        })
      })
      const addr = s.address()
      if (addr && typeof addr === 'object') puertoReal = addr.port
      server = s
    },
    async detener() {
      const s = server
      server = null
      if (!s) return
      await new Promise<void>((resolve) => {
        s.close(() => resolve())
        s.closeAllConnections()
      })
    }
  }
}
