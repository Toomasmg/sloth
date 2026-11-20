import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { EstadoCelular } from '../../shared/celular'
import { abrirPedido, crearRepetidos, derivarClaves, fechaValida, sellarRespuesta } from './celular-sello'
import { manifiesto, PAGINA_CSS, PAGINA_HTML, PAGINA_JS } from './celular-pagina'
import { crearLimite } from './celular-limite'
import { leerPedidoTerminal, type PedidoTerminal, type RespuestaTerminal } from './celular-terminal-core'

/** Lo que la PC le da a cualquier fuente: el estado y cómo responder un permiso. */
export interface ProveedorDeEstado {
  estado(): Promise<EstadoCelular>
  /** Lanza con un mensaje para el celu si no se pudo (venció, ya se respondió). */
  decidir(id: string, decision: 'allow' | 'deny'): void
  puedeAprobar(): boolean
  clave(): string
  icono(): Buffer | null
  /** La terminal de un espacio, vista desde el celu. Con `error`, no se pudo (apagado, no existe, demasiadas esperas). `cancelar` salta si el celu cortó la conexión con el pedido abierto. */
  terminal(p: PedidoTerminal, cancelar?: AbortSignal): Promise<RespuestaTerminal | { status: 403 | 404 | 429; error: string }>
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

const SEGURIDAD = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer'
}

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
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
  log?: (...args: unknown[]) => void
}

/** El servidor del Wi-Fi. Las rutas de datos van con cuerpos sellados con la clave del QR; sin clave válida, 401 y nada más. */
export function crearFuenteWifi(o: OpcionesWifi): FuenteDeEstado & { puerto(): number } {
  let server: Server | null = null
  let puertoReal = o.puerto
  const repetidos = crearRepetidos()
  const limite = crearLimite()

  async function atender(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ruta = (req.url ?? '/').split('?')[0]
    const metodo = req.method ?? 'GET'
    const esGet = metodo === 'GET' || metodo === 'HEAD'

    if (ruta === '/api/estado' || ruta === '/api/permiso' || ruta === '/api/terminal') {
      // 401 a los GET para que una página vieja ya abierta (con x-sloth-token) pida volver a escanear en vez de quedar en «sin conexión».
      if (esGet) return enviar(res, 401, null)
      if (metodo !== 'POST') return enviar(res, 405, null, undefined, { allow: 'POST' })
      const claves = derivarClaves(o.proveedor.clave())
      if (!claves) return enviar(res, 500, null)
      const texto = await leerCuerpo(req)
      if (texto === null) return enviar(res, 413, null)
      const ab = abrirPedido(claves, ruta, texto)
      if (!ab) return enviar(res, 401, null)
      let sobre: { t?: unknown; b?: unknown } | null = null
      try {
        sobre = JSON.parse(ab.json) as { t?: unknown; b?: unknown } | null
      } catch {
        sobre = null
      }
      const sellado = (status: number, data: unknown): void => enviar(res, status, 'text/plain; charset=utf-8', sellarRespuesta(claves, ab.iv, JSON.stringify(data)))
      // El MAC ya pasó: la clave es buena. La hora corrida y el reenvío se contestan sellados (no 401) para que el celu no se desempareje.
      if (!sobre || typeof sobre !== 'object') return enviar(res, 401, null)
      if (!fechaValida(sobre.t, Date.now())) return sellado(409, { error: 'reloj' })
      if (repetidos.vistoAntes(ab.iv, Date.now())) return sellado(409, { error: 'repetido' })

      if (ruta === '/api/estado') return sellado(200, await o.proveedor.estado())
      if (ruta === '/api/terminal') {
        // Después del MAC y del anti-replay: quien no tiene la clave no le gasta el cupo al celu de verdad.
        if (!limite.permitir(req.socket.remoteAddress ?? '?', Date.now())) return enviar(res, 429, null)
        const p = leerPedidoTerminal(sobre.b)
        if (!p) return sellado(400, { error: 'Pedido inválido.' })
        const corte = new AbortController()
        res.once('close', () => corte.abort())
        const r = await o.proveedor.terminal(p, corte.signal)
        if (res.destroyed) return
        return 'error' in r ? sellado(r.status, { error: r.error }) : sellado(200, r)
      }
      if (!o.proveedor.puedeAprobar()) return sellado(403, { error: 'Aprobar desde el celu está apagado en Sloth.' })
      const p = sobre.b as { id?: unknown; decision?: unknown } | null
      if (!p || typeof p !== 'object' || typeof p.id !== 'string' || p.id.length > 100 || (p.decision !== 'allow' && p.decision !== 'deny')) return sellado(400, { error: 'Pedido inválido.' })
      try {
        o.proveedor.decidir(p.id, p.decision)
      } catch (e) {
        return sellado(409, { error: (e as Error).message })
      }
      return sellado(200, { ok: true })
    }

    if (!esGet) return enviar(res, 405, null, undefined, { allow: 'GET' })
    if (ruta === '/') return enviar(res, 200, 'text/html; charset=utf-8', PAGINA_HTML, { 'content-security-policy': CSP })
    if (ruta === '/app.css') return enviar(res, 200, 'text/css; charset=utf-8', PAGINA_CSS)
    if (ruta === '/app.js') return enviar(res, 200, 'text/javascript; charset=utf-8', PAGINA_JS)
    if (ruta === '/xterm.js' || ruta === '/xterm.css') {
      const x = o.proveedor.xterm()
      if (!x) return enviar(res, 404, null)
      return ruta === '/xterm.js' ? enviar(res, 200, 'text/javascript; charset=utf-8', x.js) : enviar(res, 200, 'text/css; charset=utf-8', x.css)
    }
    if (ruta === '/manifest.webmanifest') return enviar(res, 200, 'application/manifest+json; charset=utf-8', manifiesto())
    if (ruta === '/icono.png') {
      const png = o.proveedor.icono()
      return png ? enviar(res, 200, 'image/png', png) : enviar(res, 404, null)
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
      s.headersTimeout = 35_000
      s.maxConnections = 64
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
