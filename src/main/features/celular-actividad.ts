import type { CeluConectado, EventoCelu, TipoEventoCelu } from '../../shared/celular'

/** Quién hizo un pedido: la IP y el user-agent que mandó el navegador del celu. */
export interface Quien {
  ip: string
  ua: string
  /** El celu con acceso cuya clave abrió el pedido; sin él, el pedido vino con la clave del QR. */
  celu?: string
}

/** «Android · Chrome», «iPhone · Safari»… Sirve para reconocerlo en el panel, no para identificarlo: el user-agent se puede falsear. */
export function dispositivoDe(ua: string): string {
  const so = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Otro'
  const nav = /EdgA?\//.test(ua) ? 'Edge' : /SamsungBrowser\//.test(ua) ? 'Samsung Internet' : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox' : /CriOS\/|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'navegador'
  return `${so} · ${nav}`
}

export interface OpcionesActividad {
  /** Sin pedidos en este tiempo, el celu deja de contar como conectado (la página consulta cada 1,5 s). */
  activoMs?: number
  /** Vuelve después de tanto tiempo: cuenta como conexión nueva (y avisa). */
  regresoMs?: number
  /** Escrituras seguidas en la misma terminal dentro de este tiempo se anotan como un solo evento. */
  juntarMs?: number
  maxEventos?: number
}

/**
 * Qué celus le hablan a la PC y qué hicieron: hora, celu, qué y en qué espacio; nunca lo que se escribió ni
 * el comando. Vive en memoria: se pierde al cerrar Sloth.
 */
export function crearActividad(o: OpcionesActividad = {}) {
  const activoMs = o.activoMs ?? 20_000
  const regresoMs = o.regresoMs ?? 10 * 60_000
  const juntarMs = o.juntarMs ?? 60_000
  const maxEventos = o.maxEventos ?? 100
  const celus = new Map<string, { ip: string; dispositivo: string; primero: number; ultimo: number }>()
  const eventos: EventoCelu[] = []

  const sumar = (ev: EventoCelu): void => {
    eventos.unshift(ev)
    if (eventos.length > maxEventos) eventos.length = maxEventos
  }

  return {
    /** Un pedido válido (pasó la clave). Devuelve true si es un celu nuevo o que vuelve tras un rato: hay que avisar. */
    visto(q: Quien, ahora: number): boolean {
      const dispositivo = dispositivoDe(q.ua)
      const id = `${q.ip}|${dispositivo}`
      const c = celus.get(id)
      const nuevo = !c || ahora - c.ultimo >= regresoMs
      if (c) c.ultimo = ahora
      else celus.set(id, { ip: q.ip, dispositivo, primero: ahora, ultimo: ahora })
      if (nuevo) sumar({ at: ahora, tipo: 'conecto', celu: dispositivo, ip: q.ip })
      return nuevo
    },
    /** Algo que hizo un celu. Devuelve false si se juntó con el evento anterior (solo sumó una vez más). */
    anotar(q: Quien, tipo: Exclude<TipoEventoCelu, 'conecto'>, espacio: string, ahora: number): boolean {
      const celu = dispositivoDe(q.ua)
      const previo = eventos[0]
      if ((tipo === 'escribio' || tipo === 'abrio') && previo && previo.tipo === tipo && previo.ip === q.ip && previo.celu === celu && previo.espacio === espacio && ahora - previo.at < juntarMs) {
        previo.at = ahora
        previo.veces = (previo.veces ?? 1) + 1
        return false
      }
      sumar({ at: ahora, tipo, celu, ip: q.ip, espacio })
      return true
    },
    conectados(ahora: number): CeluConectado[] {
      return [...celus.values()].filter((c) => ahora - c.ultimo < activoMs).map((c) => ({ dispositivo: c.dispositivo, ip: c.ip, desde: c.primero, ultimo: c.ultimo }))
    },
    eventos: (): EventoCelu[] => eventos.map((e) => ({ ...e })),
    /** Al regenerar el código: los celus de antes ya no entran. El registro queda. */
    olvidarCelus(): void {
      celus.clear()
    }
  }
}

export type Actividad = ReturnType<typeof crearActividad>
