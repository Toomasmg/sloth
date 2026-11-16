import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { EstadoCelular } from '../../shared/celular'
import { tokenIgual } from './celular-core'
import { manifiesto, PAGINA_CSS, PAGINA_HTML, PAGINA_JS } from './celular-pagina'

/** Lo que la PC le da a cualquier fuente: el estado y cómo responder un permiso. */
export interface ProveedorDeEstado {
  estado(): Promise<EstadoCelular>
  /** Lanza con un mensaje para el celu si no se pudo (venció, ya se respondió). */
  decidir(id: string, decision: 'allow' | 'deny'): void
  puedeAprobar(): boolean
  token(): string
  icono(): Buffer | null
}

/**
 * Por dónde le llega el estado al celu. Hoy, un servidor HTTP en el Wi-Fi de casa; cuando haya
 * cuentas, se suma una por Supabase realtime (como chat-realtime) que publique el mismo
 * EstadoCelular y reciba las mismas decisiones, así la página del celu no cambia.
 */
export interface FuenteDeEstado {
  readonly nombre: string
  iniciar(): Promise<void>
  detener(): Promise<void>
}

const MAX_CUERPO = 4096

const SEGURIDAD = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer'
}

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
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

const json = (res: ServerResponse, status: number, data: unknown): void => enviar(res, status, 'application/json; charset=utf-8', JSON.stringify(data))

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

/** El servidor del Wi-Fi. Las rutas de datos piden el token en `x-sloth-token`; sin él, 401 y nada más. */
export function crearFuenteWifi(o: OpcionesWifi): FuenteDeEstado & { puerto(): number } {
  let server: Server | null = null
  let puertoReal = o.puerto

  async function atender(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ruta = (req.url ?? '/').split('?')[0]
    const metodo = req.method ?? 'GET'
    const esGet = metodo === 'GET' || metodo === 'HEAD'

    if (ruta === '/api/estado' || ruta === '/api/permiso') {
      if (!tokenIgual(req.headers['x-sloth-token'], o.proveedor.token())) return enviar(res, 401, null)
      if (ruta === '/api/estado') {
        if (!esGet) return enviar(res, 405, null, undefined, { allow: 'GET' })
        return json(res, 200, await o.proveedor.estado())
      }
      if (metodo !== 'POST') return enviar(res, 405, null, undefined, { allow: 'POST' })
      if (!o.proveedor.puedeAprobar()) return json(res, 403, { error: 'Aprobar desde el celu está apagado en Sloth.' })
      const texto = await leerCuerpo(req)
      if (texto === null) return json(res, 413, { error: 'Pedido demasiado grande.' })
      let p: { id?: unknown; decision?: unknown }
      try {
        p = JSON.parse(texto) as { id?: unknown; decision?: unknown }
      } catch {
        return json(res, 400, { error: 'Pedido inválido.' })
      }
      if (!p || typeof p.id !== 'string' || p.id.length > 100 || (p.decision !== 'allow' && p.decision !== 'deny')) return json(res, 400, { error: 'Pedido inválido.' })
      try {
        o.proveedor.decidir(p.id, p.decision)
      } catch (e) {
        return json(res, 409, { error: (e as Error).message })
      }
      return json(res, 200, { ok: true })
    }

    if (!esGet) return enviar(res, 405, null, undefined, { allow: 'GET' })
    if (ruta === '/') return enviar(res, 200, 'text/html; charset=utf-8', PAGINA_HTML, { 'content-security-policy': CSP })
    if (ruta === '/app.css') return enviar(res, 200, 'text/css; charset=utf-8', PAGINA_CSS)
    if (ruta === '/app.js') return enviar(res, 200, 'text/javascript; charset=utf-8', PAGINA_JS)
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
      s.keepAliveTimeout = 5000
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
