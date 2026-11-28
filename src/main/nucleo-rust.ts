import { EventEmitter } from 'node:events'
import { avisar } from './avisos'
import { logger } from './logger-global'
import { alEventoDeRust, pedirAlNucleo, rustEsDueno } from './rust-features'
import { aplicarAgente, EspejoTerminales, leerCopia, type CopiaEstado } from './espejo-rust'
import type { BackendInfo, TerminalBackend } from './daemon-client'
import type { HookEventPayload, PendingPermission, SessionInfo, SpawnSpec } from '../shared/daemon-protocol'
import type { AgentStatus, PtyStartResult } from '../shared/types'

/**
 * En la cáscara de Tauri, con Rust como dueño del estado: la copia que Rust empuja (estado, Configuración, agentes,
 * terminales) y una terminal remota con la misma forma que el backend del daemon, que pide todo a Rust.
 */
let copia: CopiaEstado | undefined
const oyentesCopia = new Set<(c: CopiaEstado) => void>()
let ajustes: unknown
const oyentesAjustes = new Set<(s: unknown) => void>()

export const agentesRust = new Map<string, AgentStatus>()
export const terminalesRust = new EspejoTerminales()

const falla = (que: string) => (e: unknown): void => logger.error('rust', `${que}: ${e instanceof Error ? e.message : String(e)}`)

class TerminalRemota extends EventEmitter implements TerminalBackend {
  readonly mode = 'daemon' as const
  readonly hookUrl = ''
  readonly hookToken = ''

  info(): BackendInfo {
    const i = terminalesRust.info
    return { mode: 'daemon', pid: typeof i.pid === 'number' ? i.pid : undefined, version: typeof i.version === 'string' ? i.version : undefined }
  }
  async start(id: string, spawn: SpawnSpec): Promise<PtyStartResult> {
    const r = await pedirAlNucleo<PtyStartResult>('start', id, spawn)
    if (r.running) terminalesRust.corriendo.add(id)
    return r
  }
  /** Como el backend: escribe sin avisar a los oyentes de lo que escribe la persona. */
  write(id: string, data: string): void {
    pedirAlNucleo('write', id, data, true).catch(falla('escribir en la terminal'))
  }
  resize(id: string, cols: number, rows: number): void {
    pedirAlNucleo('resize', id, cols, rows).catch(falla('cambiar el tamaño de la terminal'))
  }
  async kill(id: string): Promise<void> {
    terminalesRust.corriendo.delete(id)
    delete terminalesRust.hooks[id]
    await pedirAlNucleo('kill', id)
  }
  async list(): Promise<SessionInfo[]> {
    const l = await pedirAlNucleo<SessionInfo[]>('list')
    terminalesRust.corriendo.clear()
    for (const s of l) if (s.running) terminalesRust.corriendo.add(s.id)
    return l
  }
  isRunning(id: string): boolean {
    return terminalesRust.corriendo.has(id)
  }
  async shutdown(): Promise<void> {
    await pedirAlNucleo('shutdown')
  }
  answerPermission(reqId: string, decision: object | null): void {
    pedirAlNucleo('answer', reqId, decision).catch(falla('responder el permiso'))
  }
  pendingPermissions(): PendingPermission[] {
    return [...terminalesRust.permisos.values()]
  }
  lastHookEvents(): Record<string, HookEventPayload> {
    return { ...terminalesRust.hooks }
  }
  /** La conexión con el daemon es de Rust: soltarla acá no hace nada. */
  dispose(): void {}
}

export const terminalRemota = new TerminalRemota()

if (rustEsDueno()) {
  alEventoDeRust('rust.estado', (v) => {
    const c = leerCopia(v)
    if (!c) return
    copia = c
    for (const f of oyentesCopia) f(c)
  })
  alEventoDeRust('rust.ajustes', (v) => {
    ajustes = v
    for (const f of oyentesAjustes) f(v)
  })
  alEventoDeRust('rust.agentes', (v) => {
    agentesRust.clear()
    if (typeof v === 'object' && v !== null) for (const [ws, st] of Object.entries(v)) aplicarAgente(agentesRust, ws, st)
  })
  alEventoDeRust('rust.agente', (ws, st) => aplicarAgente(agentesRust, ws, st))
  alEventoDeRust('rust.pty', (...ev) => {
    const r = terminalesRust.aplicar(ev)
    if (r) terminalRemota.emit(r.nombre, ...r.args)
  })
  alEventoDeRust('rust.avisos', (lista) => {
    if (Array.isArray(lista)) for (const t of lista) if (typeof t === 'string') avisar(t)
  })
}

export const copiaDeRust = (): CopiaEstado | undefined => copia

export function alCambiarCopia(f: (c: CopiaEstado) => void): void {
  oyentesCopia.add(f)
}

export const ajustesDeRust = (): unknown => ajustes

export function alCambiarAjustes(f: (s: unknown) => void): void {
  oyentesAjustes.add(f)
}
