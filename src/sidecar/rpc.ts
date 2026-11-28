/**
 * Protocolo entre el proceso de apoyo (Node, corre el main de Sloth sin Electron) y la cáscara de
 * Tauri (Rust). Una línea JSON por mensaje, por stdin/stdout.
 *
 * Rust -> apoyo:  invoke {id, channel, args} | send {channel, args} | native-result {id, ok, result|error}
 *                 | native-event {name, args}
 * apoyo -> Rust:  result {id, ok, result|error} | event {channel, args} | native {id, op, args}
 */

export type Entrada =
  | { k: 'invoke'; id: number; channel: string; args: unknown[] }
  | { k: 'send'; channel: string; args: unknown[] }
  | { k: 'native-result'; id: number; ok: boolean; result?: unknown; error?: string }
  | { k: 'native-event'; name: string; args: unknown[] }

export type Salida =
  | { k: 'result'; id: number; ok: boolean; result?: unknown; error?: string }
  | { k: 'event'; channel: string; args: unknown[] }
  | { k: 'native'; id: number; op: string; args: unknown[] }

/** Lo que ve un handler como `event` de ipcMain: el pedido solo puede venir de nuestra ventana. */
export interface EventoIpc {
  senderFrame: { url: string }
  sender: { send: (channel: string, ...args: unknown[]) => void }
  reply: (channel: string, ...args: unknown[]) => void
}

type Handler = (e: EventoIpc, ...args: unknown[]) => unknown
type Oyente = (e: EventoIpc, ...args: unknown[]) => void

export const ORIGEN_UI = 'app://ui/index.html'

export function mensajeDeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export class Rpc {
  private readonly handlers = new Map<string, Handler>()
  private readonly oyentes = new Map<string, Oyente[]>()
  private readonly pendientes = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>()
  private readonly nativos = new Map<string, ((...args: unknown[]) => void)[]>()
  private siguiente = 1
  private buf = ''
  /** Pedidos de la UI a canales que todavía no se registraron, mientras el main arranca (ver `retener`). */
  private retenidos: Entrada[] | null = null
  private readonly escribir: (linea: string) => void

  constructor(escribir: (linea: string) => void) {
    this.escribir = escribir
  }

  handle(channel: string, fn: Handler): void {
    this.handlers.set(channel, fn)
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }

  on(channel: string, fn: Oyente): void {
    this.oyentes.set(channel, [...(this.oyentes.get(channel) ?? []), fn])
  }

  /** Evento hacia la UI (lo que antes era webContents.send). */
  emitir(channel: string, ...args: unknown[]): void {
    this.salir({ k: 'event', channel, args })
  }

  /** Pide algo nativo a Rust (portapapeles, diálogos, ventana...). */
  nativo<T = unknown>(op: string, ...args: unknown[]): Promise<T> {
    const id = this.siguiente++
    return new Promise<T>((ok, fail) => {
      this.pendientes.set(id, { ok: ok as (v: unknown) => void, fail })
      this.salir({ k: 'native', id, op, args })
    })
  }

  /** Eventos que Rust avisa por su cuenta (ventana enfocada, batería, tema...). */
  alEventoNativo(name: string, fn: (...args: unknown[]) => void): void {
    this.nativos.set(name, [...(this.nativos.get(name) ?? []), fn])
  }

  /**
   * Hasta `soltar`, un pedido a un canal sin handler espera en vez de fallar. Con Rust como dueño del estado el main
   * registra sus canales recién cuando llega la copia, y la UI puede pedir antes.
   */
  retener(): void {
    if (this.retenidos === null) this.retenidos = []
  }

  soltar(): void {
    const r = this.retenidos ?? []
    this.retenidos = null
    for (const m of r) this.atender(m)
  }

  /** Alimenta con lo que llega por stdin (trozos de cualquier tamaño). */
  recibir(trozo: string): void {
    this.buf += trozo
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const linea = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      if (linea.trim()) this.procesar(linea)
    }
  }

  private salir(m: Salida): void {
    this.escribir(JSON.stringify(m) + '\n')
  }

  private evento(): EventoIpc {
    const send = (channel: string, ...args: unknown[]): void => this.emitir(channel, ...args)
    return { senderFrame: { url: ORIGEN_UI }, sender: { send }, reply: send }
  }

  private procesar(linea: string): void {
    let m: Entrada
    try {
      m = JSON.parse(linea) as Entrada
    } catch {
      return
    }
    if (!m || typeof m !== 'object') return
    this.atender(m)
  }

  private atender(m: Entrada): void {
    switch (m.k) {
      case 'invoke': {
        const args = Array.isArray(m.args) ? m.args : []
        const fn = this.handlers.get(m.channel)
        if (!fn && this.retenidos) {
          this.retenidos.push(m)
          return
        }
        if (!fn) {
          this.salir({ k: 'result', id: m.id, ok: false, error: `Sin handler para ${m.channel}` })
          return
        }
        Promise.resolve()
          .then(() => fn(this.evento(), ...args))
          .then(
            (result) => this.salir({ k: 'result', id: m.id, ok: true, result: result ?? null }),
            (e) => this.salir({ k: 'result', id: m.id, ok: false, error: mensajeDeError(e) })
          )
        return
      }
      case 'send': {
        const args = Array.isArray(m.args) ? m.args : []
        if (this.retenidos && !this.oyentes.has(m.channel)) {
          this.retenidos.push(m)
          return
        }
        for (const fn of this.oyentes.get(m.channel) ?? []) fn(this.evento(), ...args)
        return
      }
      case 'native-result': {
        const p = this.pendientes.get(m.id)
        if (!p) return
        this.pendientes.delete(m.id)
        if (m.ok) p.ok(m.result)
        else p.fail(new Error(m.error ?? 'falló la operación nativa'))
        return
      }
      case 'native-event':
        for (const fn of this.nativos.get(m.name) ?? []) fn(...(Array.isArray(m.args) ? m.args : []))
    }
  }
}
