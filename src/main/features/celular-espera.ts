import { ESPERA_MAX_MS } from './celular-terminal-core'

export type MotivoEspera = 'dato' | 'vencio' | 'soltada' | 'cancelada'

export interface Esperas {
  /**
   * Resuelve con aviso (tras la coalescencia), al vencer `ms`, si otro pedido del mismo `dueno` o `soltar` la suelta, o si se cancela.
   * null: no hay cupo (global o de esa terminal). Dos celus en la misma terminal no se sueltan entre sí: cada uno es un `dueno`.
   */
  esperar(id: string, ms: number, cancelar?: AbortSignal, dueno?: string): Promise<MotivoEspera> | null
  avisar(id: string): void
  soltar(id: string): void
  soltarTodas(): void
  activas(): number
}

interface Entrada {
  id: string
  terminar(motivo: MotivoEspera): void
  coalescencia: NodeJS.Timeout | null
}

export function crearEsperas(opts: { maxGlobal?: number; maxPorTerminal?: number; coalescenciaMs?: number } = {}): Esperas {
  const maxGlobal = opts.maxGlobal ?? 6
  const maxPorTerminal = opts.maxPorTerminal ?? 2
  const coalescenciaMs = opts.coalescenciaMs ?? 8
  const abiertas = new Map<string, Entrada>()

  return {
    esperar(id, ms, cancelar, dueno = '') {
      if (cancelar?.aborted) return Promise.resolve('cancelada')
      const clave = id + '\u0000' + dueno
      const previa = abiertas.get(clave)
      if (!previa) {
        if (abiertas.size >= maxGlobal) return null
        if ([...abiertas.values()].filter((e) => e.id === id).length >= maxPorTerminal) return null
      }
      previa?.terminar('soltada')
      return new Promise<MotivoEspera>((resolve) => {
        const entrada: Entrada = { id, terminar, coalescencia: null }
        const vence = setTimeout(() => terminar('vencio'), Number.isFinite(ms) ? Math.min(Math.max(ms, 0), ESPERA_MAX_MS) : 0)
        vence.unref()
        const alAbortar = (): void => terminar('cancelada')
        function terminar(motivo: MotivoEspera): void {
          if (abiertas.get(clave) !== entrada) return
          abiertas.delete(clave)
          clearTimeout(vence)
          if (entrada.coalescencia) clearTimeout(entrada.coalescencia)
          cancelar?.removeEventListener('abort', alAbortar)
          resolve(motivo)
        }
        cancelar?.addEventListener('abort', alAbortar, { once: true })
        abiertas.set(clave, entrada)
      })
    },
    avisar(id) {
      for (const e of abiertas.values()) {
        if (e.id !== id || e.coalescencia) continue
        e.coalescencia = setTimeout(() => e.terminar('dato'), coalescenciaMs)
        e.coalescencia.unref()
      }
    },
    soltar(id) {
      for (const e of [...abiertas.values()]) if (e.id === id) e.terminar('soltada')
    },
    soltarTodas() {
      for (const e of [...abiertas.values()]) e.terminar('soltada')
    },
    activas: () => abiertas.size
  }
}
