import type { AgentState, AgentStatus } from '../shared/types'
import type { HookEventPayload, PendingPermission } from '../shared/daemon-protocol'

/**
 * La copia del estado que Rust le empuja a este proceso cuando Rust es el dueño (ver src/main/rust-features.ts y
 * docs/migracion-rust.md). Solo se lee; lo que se cambia acá se le pide a Rust, que responde con otra copia.
 */
export interface CopiaEstado {
  estado: Record<string, unknown> & { accounts: unknown[]; workspaces: unknown[]; openPanes: string[] }
  soloLectura: { motivo: string; archivo: string; causa: 'version-futura' | 'io' } | null
  confiable: boolean
}

const esObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function leerCopia(v: unknown): CopiaEstado | undefined {
  if (!esObj(v) || !esObj(v.estado)) return undefined
  const e = v.estado
  const lista = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])
  const solo = esObj(v.soloLectura) && typeof v.soloLectura.motivo === 'string' ? (v.soloLectura as unknown as CopiaEstado['soloLectura']) : null
  return {
    estado: { ...e, accounts: lista(e.accounts), workspaces: lista(e.workspaces), openPanes: lista(e.openPanes).filter((x): x is string => typeof x === 'string') },
    soloLectura: solo,
    confiable: v.confiable === true
  }
}

/** Las claves de un parche que quedaron en undefined: al guardar el JSON esos campos desaparecían. */
export function camposQuitados(patch: object): string[] {
  return Object.entries(patch)
    .filter(([, v]) => v === undefined)
    .map(([k]) => k)
}

/** Lo que el TypeScript hacía al guardar: mezclar y que lo `undefined` no quede. */
export function aplicarParche<T extends object>(obj: T, patch: object): T {
  Object.assign(obj, patch)
  for (const k of camposQuitados(patch)) delete (obj as Record<string, unknown>)[k]
  return obj
}

const ESTADOS: readonly AgentState[] = ['idle', 'working', 'waiting', 'done', 'exited', 'sleeping']

/** `rust.agente`: un estado nuevo o, con null, que se olvidó. Devuelve si cambió algo. */
export function aplicarAgente(m: Map<string, AgentStatus>, ws: unknown, st: unknown): boolean {
  if (typeof ws !== 'string') return false
  if (st === null) return m.delete(ws)
  if (!esObj(st) || !ESTADOS.includes(st.state as AgentState) || typeof st.at !== 'number') return false
  m.set(ws, { state: st.state as AgentState, at: st.at, ...(typeof st.detail === 'string' ? { detail: st.detail } : {}) })
  return true
}

/** Lo que este proceso sabe de las terminales que tiene Rust, armado con los eventos `rust.pty`. */
export class EspejoTerminales {
  readonly corriendo = new Set<string>()
  readonly permisos = new Map<string, PendingPermission>()
  hooks: Record<string, HookEventPayload> = {}
  readonly tam = new Map<string, { cols: number; rows: number }>()
  ajenas: string[] = []
  info: Record<string, unknown> = { mode: 'daemon' }

  /** Aplica el evento y devuelve el que corresponde avisar a los oyentes (como el EventEmitter del backend), si hay. */
  aplicar(ev: unknown[]): { nombre: string; args: unknown[] } | undefined {
    const [tipo, a, b, c] = ev
    const id = typeof a === 'string' ? a : undefined
    switch (tipo) {
      case 'data':
        return id ? { nombre: 'data', args: [id, b] } : undefined
      case 'exit':
        if (!id) return undefined
        this.corriendo.delete(id)
        return { nombre: 'exit', args: [id, b] }
      case 'hook': {
        if (!esObj(a) || typeof a.ws !== 'string') return undefined
        const p = a as unknown as HookEventPayload
        this.hooks[p.ws] = p
        return { nombre: 'hook', args: [p] }
      }
      case 'permission': {
        if (!esObj(a) || typeof a.id !== 'string') return undefined
        const r = a as unknown as PendingPermission
        this.permisos.set(r.id, r)
        return { nombre: 'permission', args: [r] }
      }
      case 'permission-resolved':
        if (!id) return undefined
        this.permisos.delete(id)
        return { nombre: 'permission-resolved', args: [id] }
      case 'write':
        return id && typeof b === 'string' ? { nombre: 'write', args: [id, b] } : undefined
      case 'tam':
        if (id && typeof b === 'number' && typeof c === 'number') this.tam.set(id, { cols: b, rows: c })
        return undefined
      case 'start':
        if (id) this.corriendo.add(id)
        return undefined
      case 'sesiones':
        this.corriendo.clear()
        for (const x of Array.isArray(a) ? a : []) if (typeof x === 'string') this.corriendo.add(x)
        this.ajenas = (Array.isArray(b) ? b : []).filter((x): x is string => typeof x === 'string')
        return undefined
      case 'ajenas':
        this.ajenas = (Array.isArray(a) ? a : []).filter((x): x is string => typeof x === 'string')
        return undefined
      case 'info':
        if (esObj(a)) this.info = a
        return { nombre: 'reconnect', args: [this.info] }
    }
    return undefined
  }
}
