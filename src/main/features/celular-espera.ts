import { ESPERA_MAX_MS } from './celular-terminal-core'

export type MotivoEspera = 'dato' | 'vencio' | 'soltada' | 'cancelada'

export interface Esperas {
  /** Resuelve con aviso (tras la coalescencia), al vencer `ms`, si otro pedido o `soltar` la suelta, o si se cancela. null: no hay cupo global. */
  esperar(id: string, ms: number, cancelar?: AbortSignal): Promise<MotivoEspera> | null
  avisar(id: string): void
  soltar(id: string): void
  soltarTodas(): void
  activas(): number
}

interface Entrada {
  terminar(motivo: MotivoEspera): void
  coalescencia: NodeJS.Timeout | null
}

export function crearEsperas(opts: { maxGlobal?: number; coalescenciaMs?: number } = {}): Esperas {
  const maxGlobal = opts.maxGlobal ?? 6
  const coalescenciaMs = opts.coalescenciaMs ?? 8
  const abiertas = new Map<string, Entrada>()

  return {
    esperar(id, ms, cancelar) {
      if (cancelar?.aborted) return Promise.resolve('cancelada')
      const previa = abiertas.get(id)
      if (!previa && abiertas.size >= maxGlobal) return null
      previa?.terminar('soltada')
      return new Promise<MotivoEspera>((resolve) => {
        const entrada: Entrada = { terminar, coalescencia: null }
        const vence = setTimeout(() => terminar('vencio'), Number.isFinite(ms) ? Math.min(Math.max(ms, 0), ESPERA_MAX_MS) : 0)
        vence.unref()
        const alAbortar = (): void => terminar('cancelada')
        function terminar(motivo: MotivoEspera): void {
          if (abiertas.get(id) !== entrada) return
          abiertas.delete(id)
          clearTimeout(vence)
          if (entrada.coalescencia) clearTimeout(entrada.coalescencia)
          cancelar?.removeEventListener('abort', alAbortar)
          resolve(motivo)
        }
        cancelar?.addEventListener('abort', alAbortar, { once: true })
        abiertas.set(id, entrada)
      })
    },
    avisar(id) {
      const e = abiertas.get(id)
      if (!e || e.coalescencia) return
      e.coalescencia = setTimeout(() => e.terminar('dato'), coalescenciaMs)
      e.coalescencia.unref()
    },
    soltar(id) {
      abiertas.get(id)?.terminar('soltada')
    },
    soltarTodas() {
      for (const e of [...abiertas.values()]) e.terminar('soltada')
    },
    activas: () => abiertas.size
  }
}
