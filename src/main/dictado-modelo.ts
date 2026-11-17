import { createHash } from 'node:crypto'
import { dirname } from 'node:path'

/**
 * Bajada verificada del modelo de Whisper. Es un dato, nunca se ejecuta: se escribe en un .part,
 * se compara el SHA-256 y recién entonces se renombra, así el nombre final solo existe con el
 * contenido correcto. Las dependencias de red y disco se inyectan para poder probarlo.
 */

export interface RespuestaModelo {
  ok: boolean
  status: number
  body: ReadableStream<Uint8Array> | null
  headers: { get(nombre: string): string | null }
}

export interface ModeloDeps {
  fetch(url: string, init: { signal: AbortSignal; redirect: 'manual' }): Promise<RespuestaModelo>
  mkdir(dir: string): Promise<void>
  abrir(path: string): Promise<{ write(chunk: Uint8Array): Promise<void>; close(): Promise<void> }>
  rename(desde: string, hasta: string): Promise<void>
  rm(path: string): Promise<void>
  existe(path: string): Promise<boolean>
  sleep(ms: number): Promise<void>
}

export interface OpcionesModelo {
  url: string
  sha256: string
  destino: string
  hosts: readonly string[]
  /** Tope de bytes: lo que pase de acá se corta aunque el servidor siga mandando. */
  maxBytes: number
  /** Para el progreso cuando la respuesta no trae content-length. */
  bytesAprox: number
  intentos?: number
  /** Sin recibir un solo byte durante este tiempo, el intento se da por caído. */
  inactividadMs?: number
  onProgreso?(recibidos: number, total: number): void
}

export type ErrorModelo = 'sin-red' | 'hash' | 'disco' | 'escritura' | 'http'

export class ModeloError extends Error {
  tipo: ErrorModelo
  reintentable: boolean
  constructor(mensaje: string, tipo: ErrorModelo, reintentable = false) {
    super(mensaje)
    this.name = 'ModeloError'
    this.tipo = tipo
    this.reintentable = reintentable
  }
}

const MAX_SALTOS = 5
const ESPERAS_MS = [1000, 3000]

export function hostPermitido(url: string, hosts: readonly string[]): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  return u.protocol === 'https:' && u.port === '' && !u.username && !u.password && hosts.includes(u.hostname)
}

function hostDe(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return 'URL inválida'
  }
}

function esENOSPC(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOSPC'
}

async function pedir(url: string, o: OpcionesModelo, d: ModeloDeps, signal: AbortSignal): Promise<RespuestaModelo> {
  let actual = url
  for (let salto = 0; salto <= MAX_SALTOS; salto++) {
    if (!hostPermitido(actual, o.hosts)) throw new ModeloError(`Host no permitido para el modelo: ${hostDe(actual)}`, 'http')
    let res: RespuestaModelo
    try {
      res = await d.fetch(actual, { signal, redirect: 'manual' })
    } catch (e) {
      throw new ModeloError(`Sin conexión con ${hostDe(actual)}: ${e instanceof Error ? e.message : String(e)}`, 'sin-red', true)
    }
    if (res.status >= 300 && res.status < 400) {
      const destino = res.headers.get('location')
      if (!destino) throw new ModeloError(`Redirección sin destino desde ${hostDe(actual)}`, 'http')
      try {
        actual = new URL(destino, actual).href
      } catch {
        throw new ModeloError(`Redirección inválida desde ${hostDe(actual)}`, 'http')
      }
      continue
    }
    if (!res.ok) throw new ModeloError(`${hostDe(actual)} respondió ${res.status}`, 'http', res.status >= 500)
    return res
  }
  throw new ModeloError('Demasiadas redirecciones', 'http')
}

async function descargar(o: OpcionesModelo, d: ModeloDeps, part: string): Promise<void> {
  const inactividadMs = o.inactividadMs ?? 60_000
  const ctl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const armar = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => ctl.abort(), inactividadMs)
  }
  armar()
  let archivo: Awaited<ReturnType<ModeloDeps['abrir']>> | null = null
  try {
    const res = await pedir(o.url, o, d, ctl.signal)
    if (!res.body) throw new ModeloError('La respuesta no trae contenido', 'sin-red', true)
    const declarado = Number(res.headers.get('content-length'))
    if (Number.isFinite(declarado) && declarado > o.maxBytes) throw new ModeloError('El archivo es más grande de lo esperado', 'http')
    const total = Number.isFinite(declarado) && declarado > 0 ? declarado : o.bytesAprox

    try {
      archivo = await d.abrir(part)
    } catch (e) {
      throw new ModeloError(`No se pudo crear ${part}`, esENOSPC(e) ? 'disco' : 'escritura')
    }

    const hash = createHash('sha256')
    const reader = res.body.getReader()
    let recibidos = 0
    for (;;) {
      let leido: ReadableStreamReadResult<Uint8Array>
      try {
        leido = await reader.read()
      } catch (e) {
        throw new ModeloError(`Se cortó la bajada: ${e instanceof Error ? e.message : String(e)}`, 'sin-red', true)
      }
      if (leido.done) break
      armar()
      recibidos += leido.value.byteLength
      if (recibidos > o.maxBytes) throw new ModeloError('El archivo es más grande de lo esperado', 'http')
      hash.update(leido.value)
      try {
        await archivo.write(leido.value)
      } catch (e) {
        throw new ModeloError(`No se pudo escribir ${part}`, esENOSPC(e) ? 'disco' : 'escritura')
      }
      o.onProgreso?.(recibidos, total)
    }
    if (Number.isFinite(declarado) && declarado > 0 && recibidos !== declarado) {
      throw new ModeloError(`Llegaron ${recibidos} de ${declarado} bytes`, 'sin-red', true)
    }

    const cerrando = archivo
    archivo = null
    try {
      await cerrando.close()
    } catch (e) {
      throw new ModeloError(`No se pudo cerrar ${part}`, esENOSPC(e) ? 'disco' : 'escritura')
    }
    if (hash.digest('hex') !== o.sha256) throw new ModeloError('El SHA-256 del modelo no coincide', 'hash', true)
  } finally {
    clearTimeout(timer)
    ctl.abort()
    // Si ya falló otra cosa, el error que importa es ese y no el del cierre.
    if (archivo) await archivo.close().catch(() => undefined)
  }
}

export async function asegurarModelo(o: OpcionesModelo, d: ModeloDeps): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(o.sha256)) throw new Error('El SHA-256 del modelo tiene que ser hexadecimal de 64 caracteres.')
  if (!hostPermitido(o.url, o.hosts)) throw new ModeloError(`Host no permitido para el modelo: ${hostDe(o.url)}`, 'http')
  if (await d.existe(o.destino)) return
  try {
    await d.mkdir(dirname(o.destino))
  } catch (e) {
    throw new ModeloError('No se pudo crear la carpeta del modelo', esENOSPC(e) ? 'disco' : 'escritura')
  }

  const part = `${o.destino}.part`
  const intentos = o.intentos ?? 3
  let ultimo: ModeloError | null = null
  for (let i = 0; i < intentos; i++) {
    if (i > 0) await d.sleep(ESPERAS_MS[i - 1] ?? ESPERAS_MS[ESPERAS_MS.length - 1])
    try {
      await descargar(o, d, part)
      try {
        await d.rename(part, o.destino)
      } catch (e) {
        throw new ModeloError(`No se pudo guardar el modelo: ${e instanceof Error ? e.message : String(e)}`, 'escritura')
      }
      return
    } catch (e) {
      await d.rm(part)
      if (!(e instanceof ModeloError)) throw e
      if (!e.reintentable) throw e
      ultimo = e
    }
  }
  throw ultimo ?? new ModeloError('No se pudo bajar el modelo', 'sin-red')
}
